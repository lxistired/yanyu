import {transcriptionStoreDispatch} from './transcription-store-dispatch.mjs';
import {initializeTranscriptionStoreIdentity} from './transcription-store-identity.mjs';
import {parseUploadOrigin} from './transcription-origin.mjs';
import {assertStorageNotRetired} from './disposable-storage.mjs';
import {acquireFence,awaitFenceRelease} from './worker-fence.mjs';
import {failedTranscriptionRetry,retryReservedBytes} from './failed-transcription-retry.mjs';
import {createUploadReceipt,uploadReceiptAvailable,parseUploadOperationId} from './upload-receipts.mjs';
import {workerErrorCode} from './transcription-errors.mjs';
import {transcriptRelationships} from './transcript-relationships.mjs';
import {transcriptionLibrary} from './transcription-library.mjs';
import {transcriptManagement} from './transcript-management.mjs';
import {DatabaseSync} from 'node:sqlite';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {realpathSync,mkdirSync,readdirSync,rmSync,statfsSync,statSync,openSync,writeSync,closeSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
function bounded(name,fallback,min,max){const n=Number(process.env[name]??fallback);if(!Number.isInteger(n)||n<min||n>max)throw Error(`Invalid ${name}`);return n}
export function localTranscription(storage,workspace,externalOwner){
 storage=realpathSync(storage);let main,closing;
 const owner=externalOwner??acquireFence(join(storage,'local-transcription-owner.lock'));
 const releaseOwner=()=>{if(!externalOwner)owner.close()};
 try{
  assertStorageNotRetired(storage,owner);
  const service=createLocalTranscription(storage,workspace,value=>main=value,owner);
  return {handle:service.handle,close(){if(closing)return closing;const result=service.close();if(result?.then){closing=result.then(releaseOwner);return closing}releaseOwner();closing=Promise.resolve();return closing}};
 }catch(error){try{main?.close()}catch{}releaseOwner();throw Error('Local transcription initialization unavailable',{cause:error})}
}
function createLocalTranscription(storage,workspace,onDatabase,owner){
 const maxSeconds=bounded('ASR_MAX_SECONDS',7200,1,14400),maxBytes=bounded('ASR_MAX_BYTES',268435456,44,536870912),deadlineSeconds=bounded('ASR_DEADLINE_SECONDS',14400,1,28800);
 const tmp=join(storage,'long-asr-temp');mkdirSync(tmp,{recursive:true,mode:0o700});
 const db=new DatabaseSync(join(storage,'long-transcription.sqlite'));onDatabase(db);
 // Explicit startup migration, before job reconciliation or request admission.
 initializeTranscriptionStoreIdentity(db);
 db.exec(`CREATE TABLE IF NOT EXISTS transcription_jobs(id TEXT PRIMARY KEY,filename TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL,result TEXT,error TEXT,progress TEXT); UPDATE transcription_jobs SET status='interrupted',error='服务中断；请明确继续识别，或取消以删除临时音频' WHERE status='processing'`);
 if(!db.prepare('PRAGMA table_info(transcription_jobs)').all().some(c=>c.name==='requested_language'))db.exec("ALTER TABLE transcription_jobs ADD COLUMN requested_language TEXT NOT NULL DEFAULT 'en'");
 if(!db.prepare('PRAGMA table_info(transcription_jobs)').all().some(c=>c.name==='pending_expires_at'))db.exec('ALTER TABLE transcription_jobs ADD COLUMN pending_expires_at INTEGER');
 const management=transcriptManagement(db);
 const relationships=transcriptRelationships(db,workspace);
 const library=transcriptionLibrary(db,relationships);
 let active=null,closed=false,closePromise,replayUploads=0;const workers=new Set(),handlers=new Set(),requests=new Set();
 const leases=join(storage,'local-transcription-leases');mkdirSync(leases,{recursive:true,mode:0o700});
 const retentionSeconds=bounded('ASR_PENDING_TTL_SECONDS',86400,1,604800),pendingQuota=bounded('ASR_PENDING_QUOTA_BYTES',1073741824,44,4294967296);
 const model={retentionSeconds,pendingQuota,name:'faster-whisper-small',device:'CPU int8',offline:true,languages:['auto','zh','en'],defaultLanguage:'auto',languagePolicy:'Auto detects the first chunk and fixes that language for the job; not code-switching detection',maxSeconds,maxBytes,chunkSeconds:30,overlapSeconds:1,deadlineSeconds};
 const kill=child=>{if(!child||child.exitCode!==null||child.signalCode!==null)return;try{process.kill(-child.pid,'SIGKILL')}catch{}};
 function clean(id){rmSync(join(tmp,`job-${id}`),{recursive:true,force:true})}
 function sweep(){
  for(const name of readdirSync(tmp))if(/^job-[a-f0-9-]{36}$/.test(name)){
   const id=name.slice(4);if(active?.id===id)continue;
   const row=db.prepare('SELECT status,pending_expires_at FROM transcription_jobs WHERE id=?').get(id);
   let valid=false;try{const m=JSON.parse(readFileSync(join(tmp,name,'pending.json'),'utf8'));valid=m.id===id&&Number.isFinite(m.expiresAt)&&Number.isFinite(row?.pending_expires_at)&&m.expiresAt===row.pending_expires_at&&Date.now()<m.expiresAt}catch{}
   if(!row||!['processing','interrupted'].includes(row.status)||!valid){clean(id);if(row&&['processing','interrupted'].includes(row.status))db.prepare("UPDATE transcription_jobs SET status='failed',error='Pending audio expired or unavailable; re-upload required' WHERE id=?").run(id)}
  }
  for(const row of db.prepare("SELECT id FROM transcription_jobs WHERE status='interrupted'").all())if(!existsSync(join(tmp,`job-${row.id}`,'pending.json')))db.prepare("UPDATE transcription_jobs SET status='failed',error='Pending audio unavailable; re-upload required' WHERE id=?").run(row.id);
 }
 function pendingBytes(){let n=retryReservedBytes(tmp);for(const d of readdirSync(tmp))if(/^(?:job|retry)-[a-f0-9-]{36}$/.test(d))for(const f of readdirSync(join(tmp,d)))n+=statSync(join(tmp,d,f)).size;return n}
 function run(job,directory,format,language){
  if(closed)throw Error('Service closing');
  const id=job.id,path=join(directory,'input');
  const py=process.env.YANYU_PYTHON || resolve(import.meta.dirname,'../.venv/bin/python');
  // A per-launch lease proves ALL inherited writers have exited, even if Python
  // dies before its decoder. Keep these stable inodes; never unlink or unlock.
  const leasePath=join(leases,`${id}-${randomUUID()}.lock`),lease=acquireFence(leasePath);
  let child,output='',result=null,error=null,bytes=0,stderr=0,timer,finished=false;
  try{
   child=spawn('/usr/bin/prlimit',['--as=8589934592',`--cpu=${deadlineSeconds}`,'--nofile=128','--',py,resolve(import.meta.dirname,'../local-asr/recognize_long.py'),path,format,String(maxSeconds),String(maxBytes),language],{detached:true,stdio:['ignore','pipe','pipe',owner.fd,lease.fd,'pipe'],env:{PYTHONDONTWRITEBYTECODE:'1',PATH:process.env.PATH,YANYU_MODEL_DIR:process.env.YANYU_MODEL_DIR,YANYU_LIVENESS_FD:'5',YANYU_OWNER_FD:'3',YANYU_OWNER_ID:owner.identity,YANYU_LEASE_FD:'4',YANYU_LEASE_ID:lease.identity,HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',UCX_VFS_ENABLE:'n',OPENBLAS_NUM_THREADS:'1'}});
  }catch(error){lease.close();throw error}
  job.child=child;workers.add(job);
  job.done=new Promise((resolve,reject)=>{
   child.once('close',async(code)=>{
    if(finished)return;finished=true;clearTimeout(timer);
    try{
     await awaitFenceRelease(leasePath);
     if(!closed){
      try{db.prepare('UPDATE transcription_jobs SET status=?,result=?,error=? WHERE id=?').run(job.reason==='cancelled'?'cancelled':code===0&&!job.reason&&result?'completed':'failed',code===0&&!job.reason&&result?JSON.stringify(result):null,job.reason==='cancelled'?'ASR_CANCELLED':job.reason==='deadline'?'ASR_DEADLINE':code===0&&result&&!job.reason?null:error||'ASR_FAILED',id)}
      catch{closed=true;clearInterval(sweepTimer)}
      // Lease release already proved quiescence; storage failure must not skip
      // raw-input cleanup. Explicit close/restart can reconcile the durable row.
      try{rmSync(directory,{recursive:true,force:true})}catch{closed=true;clearInterval(sweepTimer)}
     }
     if(active===job)active=null;workers.delete(job);resolve();
    }catch(e){closed=true;clearInterval(sweepTimer);reject(e)}
   });
  });
  // A failed drain remains fenced and unavailable; close() must not release it.
  job.done.catch(()=>{});
  child.on('error',()=>{error='ASR_FAILED'});
  try{
   lease.close();
   child.stdout.on('data',p=>{bytes+=p.length;if(bytes>16777216){error='ASR_OUTPUT_LIMIT';kill(child);return}output+=p.toString();let at;while((at=output.indexOf('\n'))>=0){const line=output.slice(0,at);output=output.slice(at+1);try{const value=JSON.parse(line);if(value.type==='progress'&&!closed)db.prepare('UPDATE transcription_jobs SET progress=? WHERE id=?').run(JSON.stringify(value),id);else if(value.type==='result')result=value;else if(value.type==='error')error=workerErrorCode(value)}catch{error='ASR_WORKER_OUTPUT';kill(child)}}});
   child.stderr.on('data',p=>{stderr+=p.length;if(stderr>65536){error='ASR_DIAGNOSTICS_LIMIT';kill(child)}});
   const remaining=JSON.parse(readFileSync(join(directory,'pending.json'),'utf8')).expiresAt-Date.now();
   timer=setTimeout(()=>{job.reason='deadline';kill(child)},Math.max(1,Math.min(deadlineSeconds*1000,remaining)));
   process.send?.({event:'local-asr-worker',jobId:id,pid:child.pid});
  }catch(e){job.reason='startup-failed';kill(child);throw e}
 }
 function failedStart(job){
  job.reason='startup-failed';
  if(job.child){kill(job.child);return} // close + lease release owns cleanup.
  if(active===job)active=null;
  db.prepare("UPDATE transcription_jobs SET status='failed',error='ASR_FAILED' WHERE id=?").run(job.id);clean(job.id);
 }
 const retry=failedTranscriptionRetry({db,tmp,storage,maxSeconds,maxBytes,deadlineSeconds,retentionSeconds,pendingQuota,pendingBytes,getActive:()=>active,start(job,directory,format,language){active=job;try{run(job,directory,format,language);return true}catch{failedStart(job);return false}}});
 function uploadOperation(operationId,replayed=false){
  const row=db.prepare('SELECT id,status,deleted_at,requested_language,original_upload_receipt,original_upload_origin,original_upload_operation_filename FROM transcription_jobs WHERE original_upload_operation_id=?').get(operationId);
  if(!row)return null;
  if(!uploadReceiptAvailable(row.original_upload_receipt,row.requested_language)||typeof row.original_upload_operation_filename!=='string'||!['processing','interrupted','completed','cancelled','failed'].includes(row.status)||!['unknown','file-selection','recording-draft'].includes(row.original_upload_origin))throw Error('Original upload operation receipt unavailable');
  return {operationId,state:'committed',reconciliationFinal:true,id:row.id,status:row.status,filename:row.original_upload_operation_filename,uploadOrigin:row.original_upload_origin,receipt:JSON.parse(row.original_upload_receipt),deleted:row.deleted_at!==null,replayed};
 }
 const matchesUpload=(prior,{sha256,length,mime,format,language,filename,origin})=>prior.receipt.sha256===sha256&&prior.receipt.byteLength===length&&prior.receipt.declaredMime===mime&&prior.receipt.acceptedFormat===format&&prior.receipt.language===language&&prior.filename===filename&&prior.uploadOrigin===origin;
 sweep();const sweepTimer=setInterval(sweep,1000);sweepTimer.unref();
 async function handleInner(req,send,fail,download){
  if(await retry(req,send,fail))return true;
  if(await relationships.handle(req,send,fail))return true;
  if(await library.handle(req,send,fail))return true;
  if(await management.handle(req,send,fail,download))return true;
  if(req.url.split('?')[0]==='/api/local-asr/jobs'&&req.method==='GET'){library.list(req.url,send,fail,model);return true;}
  if(!req.url.startsWith('/api/local-asr/'))return false;
  const resume=/^\/api\/local-asr\/jobs\/([a-f0-9-]{36})\/resume$/.exec(req.url);
  if(resume&&req.method==='POST'){
   sweep();const id=resume[1],row=db.prepare('SELECT status,requested_language FROM transcription_jobs WHERE id=?').get(id);
   if(!row){fail(404,'NOT_FOUND','Task not found');return true}
   if(row.status!=='interrupted'){fail(409,'INVALID_STATE','Only interrupted jobs can resume; otherwise re-upload');return true}
   if(active){fail(409,'BUSY','Local model busy');return true}
   const directory=join(tmp,`job-${id}`);let m;
   try{m=JSON.parse(readFileSync(join(directory,'pending.json'),'utf8'));if(m.id!==id||m.maximum!==maxSeconds||m.byteLimit!==maxBytes||m.language!==row.requested_language)throw Error()}catch{clean(id);db.prepare("UPDATE transcription_jobs SET status='failed',error='Checkpoint settings invalid; re-upload required' WHERE id=?").run(id);fail(409,'CHECKPOINT_INVALID','Checkpoint invalid; re-upload required');return true}
   const fs=statfsSync(tmp);if(pendingBytes()>pendingQuota||fs.bavail*fs.bsize<268435456){fail(507,'DISK_LIMIT','Insufficient pending quota or free space; cancel pending jobs or free disk');return true}
   const job={id,child:null,reason:null};active=job;db.prepare("UPDATE transcription_jobs SET status='processing',error=NULL WHERE id=?").run(id);try{run(job,directory,m.format,m.language)}catch{failedStart(job);fail(500,'UNAVAILABLE','Local worker unavailable');return true}send(202,{id,status:'processing'});return true;
  }
  const cancel=/^\/api\/local-asr\/jobs\/([a-f0-9-]{36})\/cancel$/.exec(req.url);
  if(cancel&&req.method==='POST'){
   const row=db.prepare('SELECT status FROM transcription_jobs WHERE id=?').get(cancel[1]);
   if(!row){fail(404,'NOT_FOUND','Task not found');return true}
   if(row.status==='interrupted'){clean(cancel[1]);db.prepare("UPDATE transcription_jobs SET status='cancelled',error='已取消' WHERE id=?").run(cancel[1]);send(200,{id:cancel[1],status:'cancelled'});return true}
   if(active?.id===cancel[1]&&active.child){active.reason='cancelled';kill(active.child)}
   send(200,{id:cancel[1],status:row.status==='processing'?'cancelling':row.status});return true;
  }
  if(req.method==='GET'&&req.url.startsWith('/api/local-asr/transcribe?')){
   const match=/^\/api\/local-asr\/transcribe\?operationId=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(req.url);
   if(!match||match[0]!==req.url){fail(400,'INVALID_REQUEST','One canonical upload operation required');return true}
   try{send(200,uploadOperation(match[1])??{operationId:match[1],state:'unconfirmed',reconciliationFinal:false})}
   catch{fail(409,'RECEIPT_UNAVAILABLE','Original upload operation receipt unavailable')}
   return true;
  }
  if(req.url!=='/api/local-asr/transcribe'){fail(404,'NOT_FOUND','Route not admitted');return true;}
  if(req.method!=='POST'){fail(405,'INVALID_REQUEST','POST required');return true;}
  const operationId=parseUploadOperationId(req.headers,req.rawHeaders);
  if(operationId===null){fail(400,'INVALID_REQUEST','Invalid or repeated upload operation');return true}
  const format={'audio/wav':'wav','audio/mpeg':'mp3','audio/mp4':'mov','audio/ogg':'ogg'}[req.headers['content-type']];
  if(!format||req.headers['content-encoding']){fail(415,'INVALID_REQUEST','Only unencoded WAV, MP3, M4A or Ogg accepted');return true;}
  const language=req.headers['x-audio-language']??'auto';
  if(typeof language!=='string'||!['auto','zh','en'].includes(language)){fail(400,'INVALID_REQUEST','Language must be auto, zh or en');return true;}
  const origin=parseUploadOrigin(req.headers,req.rawHeaders);
  if(origin===null){fail(400,'INVALID_REQUEST','Invalid or repeated audio origin');return true;}
  let prior;
  try{prior=operationId===undefined?null:uploadOperation(operationId,true)}catch{fail(409,'RECEIPT_UNAVAILABLE','Original upload operation receipt unavailable');return true}
  if(active&&!prior){fail(409,'BUSY','本地模型正在处理另一段音频');return true;}
  const length=Number(req.headers['content-length']);
  if(!Number.isInteger(length)||length<44||length>maxBytes){fail(413,'INVALID_REQUEST',`Audio must be 44–${maxBytes} bytes`);return true;}
  let filename;try{filename=decodeURIComponent(req.headers['x-audio-filename']||'audio.wav')}catch{fail(400,'INVALID_REQUEST','Invalid filename');return true;}
  if(filename.length>180||/[\x00-\x1f/\\]/.test(filename)){fail(400,'INVALID_REQUEST','Invalid filename');return true;}
  if(!filename.toLowerCase().endsWith({wav:'.wav',mp3:'.mp3',mov:'.m4a',ogg:'.ogg'}[format])){fail(400,'INVALID_REQUEST','Filename extension does not match MIME');return true;}
  if(prior){
   // Replays need no history/decode slot, disk reservation or worker. They still
   // read and hash the entire bounded body, never trust client digest metadata.
   if(replayUploads>=2){fail(409,'BUSY','Upload replay capacity reached');return true}
   replayUploads++;let size=0;const hash=createHash('sha256'),timer=setTimeout(()=>req.destroy(),120000);
   try{
    for await(const p of req){size+=p.length;if(size>length||size>maxBytes)throw Error();hash.update(p)}
    if(closed||size!==length)throw Error();
   }catch{fail(400,'INVALID_REQUEST','Incomplete or oversized upload');return true}
   finally{replayUploads--;clearTimeout(timer)}
   if(!matchesUpload(prior,{sha256:hash.digest('hex'),length,mime:req.headers['content-type'],format,language,filename,origin})){fail(409,'UPLOAD_MISMATCH','Upload operation is already bound to different bytes or options');return true}
   try{send(200,uploadOperation(operationId,true))}catch{fail(409,'RECEIPT_UNAVAILABLE','Original upload operation receipt unavailable')}
   return true;
  }
  if(db.prepare('SELECT COUNT(*) AS n FROM transcription_jobs').get().n>=1000||statSync(join(storage,'long-transcription.sqlite')).size>117440512){fail(507,'HISTORY_LIMIT','Local job history quota reached; retain/export records before maintenance');return true;}
  sweep();if(pendingBytes()+length+maxSeconds*32000+33554432>pendingQuota){fail(507,'DISK_LIMIT','Pending audio quota reached; cancel pending jobs or increase configured quota');return true}
  const fs=statfsSync(tmp);if(fs.bavail*fs.bsize<length+maxSeconds*32000+268435456){fail(507,'DISK_LIMIT','Insufficient free space for bounded decode');return true;}
  const id=randomUUID(),directory=join(tmp,`job-${id}`);mkdirSync(directory,{mode:0o700});const path=join(directory,'input');
  const job={id,child:null,reason:null};active=job;let size=0,fd=null;const uploadHash=createHash('sha256');const uploadTimer=setTimeout(()=>req.destroy(),120000);
  try{fd=openSync(path,'wx',0o600);for await(const p of req){size+=p.length;if(size>maxBytes||size>length)throw Error('Upload too large');let offset=0;while(offset<p.length){const written=writeSync(fd,p,offset,p.length-offset);if(written<=0)throw Error('Incomplete write');offset+=written}uploadHash.update(p)}if(closed||size!==length)throw Error('Incomplete upload');closeSync(fd);fd=null}
  catch{if(fd!==null){try{closeSync(fd)}catch{}fd=null}active=null;rmSync(directory,{recursive:true,force:true});fail(400,'INVALID_REQUEST','Incomplete or oversized upload');return true}
  finally{clearTimeout(uploadTimer)}
  const expiresAt=Date.now()+retentionSeconds*1000;
  try{
   const sha256=uploadHash.digest('hex');
   // Recheck at the commit point; the durable UNIQUE index is the final guard.
   const committed=operationId===undefined?null:uploadOperation(operationId,true);
   if(committed){
    active=null;clean(id);
    if(!matchesUpload(committed,{sha256,length,mime:req.headers['content-type'],format,language,filename,origin}))fail(409,'UPLOAD_MISMATCH','Upload operation is already bound to different bytes or options');
    else send(200,committed);
    return true;
   }
   const receipt=createUploadReceipt({sha256,byteLength:size,mime:req.headers['content-type'],format,language,maxSeconds,maxBytes,deadlineSeconds});
   writeFileSync(join(directory,'pending.json'),JSON.stringify({id,format,language,maximum:maxSeconds,byteLimit:maxBytes,sourceHash:sha256,expiresAt}),{mode:0o600});
   // One SQLite statement commits job and receipt together. No legacy backfill.
   db.prepare('INSERT INTO transcription_jobs(id,filename,status,created,requested_language,pending_expires_at,original_upload_receipt,original_upload_origin,original_upload_operation_id,original_upload_operation_filename) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,filename,'processing',new Date().toISOString(),language,expiresAt,receipt,origin,operationId??null,operationId===undefined?null:filename);
  }catch{active=null;clean(id);fail(500,'UNAVAILABLE','Local upload storage unavailable');return true}
  try{run(job,directory,format,language)}catch{failedStart(job);if(operationId===undefined){fail(500,'UNAVAILABLE','Local worker unavailable');return true}}
  send(202,operationId===undefined?{id,status:'processing'}:uploadOperation(operationId));return true;

 }
 function handle(req,send,fail,download){
  if(closed){fail(503,'UNAVAILABLE','Local transcription closing');return Promise.resolve(true)}
  requests.add(req);const pending=handleInner(req,send,fail,download);handlers.add(pending);
  pending.finally(()=>{requests.delete(req);handlers.delete(pending)}).catch(()=>{});return pending;
 }
 return {handle:transcriptionStoreDispatch(db,handle),close(){
  if(closePromise)return closePromise;
  closed=true;clearInterval(sweepTimer);
  for(const req of requests)req.destroy?.();for(const job of workers)kill(job.child);
  if(!handlers.size&&!workers.size){db.close();return}
  closePromise=(async()=>{await Promise.allSettled([...handlers]);for(const job of workers)kill(job.child);await Promise.all([...workers].map(job=>job.done));db.close()})();return closePromise;
 }};
}
