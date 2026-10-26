import {initializeTranscriptionOrigin} from './transcription-origin.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {mkdirSync,openSync,writeSync,closeSync,writeFileSync,renameSync,rmSync,readdirSync,statSync,statfsSync} from 'node:fs';
import {createUploadReceipt,uploadReceiptAvailable} from './upload-receipts.mjs';

const inFlight=new Map(),staging=new Set(),capacity=new Map();
export const retryReservedBytes=tmp=>capacity.get(tmp)?.reserved??0;
// A parent is the idempotency key. Tombstones deliberately retain lineage.
export function failedTranscriptionRetry({db,tmp,storage,maxSeconds,maxBytes,deadlineSeconds,retentionSeconds,pendingQuota,pendingBytes,getActive,start}){
 initializeTranscriptionOrigin(db);
 db.exec(`CREATE TABLE IF NOT EXISTS transcription_retries(parent_id TEXT PRIMARY KEY REFERENCES transcription_jobs(id),child_id TEXT NOT NULL UNIQUE REFERENCES transcription_jobs(id),created TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS transcription_retry_immutable_update BEFORE UPDATE ON transcription_retries BEGIN SELECT RAISE(ABORT,'Retry lineage is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS transcription_retry_immutable_delete BEFORE DELETE ON transcription_retries BEGIN SELECT RAISE(ABORT,'Retry lineage is immutable'); END;`);
 // These directories were never committed. Startup never launches a worker.
 for(const name of readdirSync(tmp))if(/^retry-[a-f0-9-]{36}$/.test(name)&&!staging.has(join(tmp,name)))rmSync(join(tmp,name),{recursive:true,force:true});
 const budget=capacity.get(tmp)??{uploads:0,reserved:0};capacity.set(tmp,budget);
 const problem=(status,code,message)=>Object.assign(Error(message),{status,code});
 function parent(id){
  const row=db.prepare('SELECT status,deleted_at,requested_language,original_upload_receipt FROM transcription_jobs WHERE id=?').get(id);
  if(!row||row.deleted_at!==null)throw problem(404,'NOT_FOUND','Retry parent unavailable');
  if(row.status!=='failed')throw problem(409,'INVALID_STATE','Only failed jobs can be retried');
  if(!uploadReceiptAvailable(row.original_upload_receipt,row.requested_language))throw problem(409,'RECEIPT_UNAVAILABLE','Original upload identity unavailable');
  return JSON.parse(row.original_upload_receipt);
 }
 function existing(id){
  const link=db.prepare('SELECT child_id FROM transcription_retries WHERE parent_id=?').get(id);if(!link)return null;
  const child=db.prepare('SELECT id,status,deleted_at FROM transcription_jobs WHERE id=?').get(link.child_id);
  if(!child||child.deleted_at!==null)throw problem(409,'RETRY_UNAVAILABLE','Existing retry unavailable');
  return {id:child.id,status:child.status,parentId:id,replayed:true};
 }
 return async function handle(req,send,fail){
  const match=/^\/api\/local-asr\/jobs\/([a-f0-9-]{36})\/retry$/.exec(req.url);if(!match)return false;
  let directory,fd=null,transaction=false,reservation=0,admitted=false,flightKey;
  const cleanup=()=>{if(fd!==null){try{closeSync(fd)}catch{}fd=null}if(directory){staging.delete(directory);rmSync(directory,{recursive:true,force:true});}};
  try{
   if(!['POST','GET'].includes(req.method))throw problem(405,'INVALID_REQUEST','GET or POST required');
   const parentId=match[1],receipt=parent(parentId),originalOrigin=db.prepare('SELECT original_upload_origin FROM transcription_jobs WHERE id=?').get(parentId).original_upload_origin,prior=existing(parentId);
   flightKey=join(storage,parentId);
   if(req.method==='GET'){
    const pending=(inFlight.get(flightKey)??0)>0,settings=receipt.settings;
    send(200,{parentId,state:prior?'created':pending?'pending':'uncommitted',reconciliationFinal:!!prior,child:prior?{id:prior.id,status:prior.status}:null,eligible:!prior&&!pending&&settings.maxSeconds===maxSeconds&&settings.maxBytes===maxBytes&&settings.deadlineSeconds===deadlineSeconds});return true;
   }
   const mime=req.headers['content-type'],language=req.headers['x-audio-language']??'auto',length=Number(req.headers['content-length']);
   if(req.headers['content-encoding']||mime!==receipt.declaredMime||language!==receipt.language||!Number.isSafeInteger(length)||length!==receipt.byteLength)throw problem(409,'UPLOAD_MISMATCH','Reselect the original file with its original format and language');
   const settings=receipt.settings;
   if(settings.maxSeconds!==maxSeconds||settings.maxBytes!==maxBytes||settings.deadlineSeconds!==deadlineSeconds)throw problem(409,'SETTINGS_MISMATCH','Original requested settings do not match this service');
   let filename;try{filename=decodeURIComponent(req.headers['x-audio-filename']||'audio.wav')}catch{throw problem(400,'INVALID_REQUEST','Invalid filename')}
   if(filename.length>180||/[\x00-\x1f/\\]/.test(filename)||!filename.toLowerCase().endsWith({wav:'.wav',mp3:'.mp3',mov:'.m4a',ogg:'.ogg'}[receipt.acceptedFormat]))throw problem(400,'INVALID_REQUEST','Invalid filename or extension');
   if(budget.uploads>=2)throw problem(409,'BUSY','Retry upload capacity reached');
   if(!prior){
    if(getActive())throw problem(409,'BUSY','Local model busy');
    if(db.prepare('SELECT COUNT(*) n FROM transcription_jobs').get().n>=1000||statSync(join(storage,'long-transcription.sqlite')).size>117440512)throw problem(507,'HISTORY_LIMIT','Local job history quota reached');
    reservation=length+maxSeconds*32000+33554432;
    const fs=statfsSync(tmp);if(pendingBytes()+reservation>pendingQuota||fs.bavail*fs.bsize<budget.reserved+length+maxSeconds*32000+268435456)throw problem(507,'DISK_LIMIT','Insufficient upload quota or free space');
   }
   budget.uploads++;budget.reserved+=reservation;admitted=true;inFlight.set(flightKey,(inFlight.get(flightKey)??0)+1);
   const id=randomUUID(),hash=createHash('sha256');let size=0;
   if(!prior){directory=join(tmp,`retry-${id}`);staging.add(directory);mkdirSync(directory,{mode:0o700});fd=openSync(join(directory,'input'),'wx',0o600)}
   const timer=setTimeout(()=>req.destroy(),120000);
   try{for await(const p of req){size+=p.length;if(size>length)throw Error();hash.update(p);if(fd!==null){let offset=0;while(offset<p.length){const written=writeSync(fd,p,offset,p.length-offset);if(written<=0)throw Error();offset+=written}}}if(size!==length)throw Error()}
   catch{throw problem(400,'INVALID_REQUEST','Incomplete or oversized upload')}
   finally{clearTimeout(timer)}
   if(fd!==null){closeSync(fd);fd=null}
   const sha256=hash.digest('hex');if(sha256!==receipt.sha256)throw problem(409,'UPLOAD_MISMATCH','Reselect the original file');
   // The complete body is verified before acquiring the SQLite write lock.
   db.exec('BEGIN IMMEDIATE');transaction=true;
   const current=parent(parentId);if(JSON.stringify(current)!==JSON.stringify(receipt)||db.prepare('SELECT original_upload_origin FROM transcription_jobs WHERE id=?').get(parentId).original_upload_origin!==originalOrigin)throw problem(409,'RECEIPT_UNAVAILABLE','Original upload identity changed');
   const replay=existing(parentId);
   if(replay){db.exec('COMMIT');transaction=false;cleanup();send(200,replay);return true}
   if(getActive())throw problem(409,'BUSY','Local model busy');
   if(db.prepare('SELECT COUNT(*) n FROM transcription_jobs').get().n>=1000)throw problem(507,'HISTORY_LIMIT','Local job history quota reached');
   const fs=statfsSync(tmp);if(pendingBytes()>pendingQuota||fs.bavail*fs.bsize<maxSeconds*32000+268435456)throw problem(507,'DISK_LIMIT','Insufficient upload quota or free space');
   const expiresAt=Date.now()+retentionSeconds*1000,created=new Date().toISOString();
   const childReceipt=createUploadReceipt({sha256,byteLength:size,mime,format:receipt.acceptedFormat,language,maxSeconds,maxBytes,deadlineSeconds});
   writeFileSync(join(directory,'pending.json'),JSON.stringify({id,format:receipt.acceptedFormat,language,maximum:maxSeconds,byteLimit:maxBytes,sourceHash:sha256,expiresAt}),{mode:0o600});
   const committedDirectory=join(tmp,`job-${id}`);renameSync(directory,committedDirectory);staging.delete(directory);directory=committedDirectory;
   // Retry retains the original declaration, not the route used to reselect bytes.
   const origin=db.prepare('SELECT original_upload_origin FROM transcription_jobs WHERE id=?').get(parentId).original_upload_origin;
   db.prepare('INSERT INTO transcription_jobs(id,filename,status,created,requested_language,pending_expires_at,original_upload_receipt,original_upload_origin) VALUES(?,?,?,?,?,?,?,?)').run(id,filename,'processing',created,language,expiresAt,childReceipt,origin);
   db.prepare('INSERT INTO transcription_retries(parent_id,child_id,created) VALUES(?,?,?)').run(parentId,id,created);
   db.exec('COMMIT');transaction=false;
   const owned=directory;directory=null;
   // No external process exists before the durable job + lineage commit.
   if(!start({id,child:null,reason:null},owned,receipt.acceptedFormat,language)){fail(500,'UNAVAILABLE','Local worker unavailable');return true}
   send(202,{id,status:'processing',parentId,replayed:false});return true;
  }catch(error){if(transaction){try{db.exec('ROLLBACK')}catch{}}cleanup();fail(error.status??500,error.code??'UNAVAILABLE',error.status?error.message:'Local retry storage unavailable');return true}
  finally{if(admitted){budget.uploads--;budget.reserved-=reservation;const n=inFlight.get(flightKey)-1;if(n)inFlight.set(flightKey,n);else inFlight.delete(flightKey)}}
 };
}
