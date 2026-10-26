
// Capture only at fixture setup, never from a later operation or a replacement store.
async function discoverScope(service){
 let body,responseHeader;
 const handled=await service.handle({url:'/api/local-asr/identity',method:'GET',headers:{}},
  (status,value)=>{assert.equal(status,200);body=value},
  (...args)=>assert.fail(JSON.stringify(args)),undefined,
  {setHeader(name,value){assert.equal(name,'x-transcription-store-id');responseHeader=value}});
 assert.equal(handled,true);assert.deepEqual(Object.keys(body),['transcriptionStoreId']);
 assert.equal(responseHeader,body.transcriptionStoreId);
 assert.match(body.transcriptionStoreId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 return Object.freeze({'x-transcription-store-id':body.transcriptionStoreId});
}
let scopeHeaders;
// Inert writers only: no audio decode, model import, browser or network.
import assert from 'node:assert/strict';
import {fork,spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {localTranscription} from './local-transcription.mjs';
import {acquireFence} from './worker-fence.mjs';
const workspace={get(){return null},list(){return []}};
const request=()=>Object.assign(Readable.from([Buffer.alloc(80)]),{url:'/api/local-asr/transcribe',method:'POST',headers:{...scopeHeaders,'content-type':'audio/wav','content-length':'80','x-audio-filename':'inert.wav'}});
const call=async(service,req=request())=>{let response;await service.handle(req,(status,body)=>response={status,body},(status,code)=>response={status,code});return response};
if(process.argv[2]==='service-child'){
 const service=localTranscription(process.argv[3],workspace);
 scopeHeaders=await discoverScope(service);
 process.send({ready:true});
 process.on('message',async m=>{if(m.start)process.send({response:await call(service)});if(m.close){await service.close();process.exit(0)}});
}else{
 const root=mkdtempSync(join(tmpdir(),'writer-fence-')),storage=join(root,'store'),alias=join(root,'alias'),worker=join(root,'inert-worker');mkdirSync(storage);symlinkSync(storage,alias);
 const saved={...process.env};let service,backend;const guardians=new Set();
 Object.assign(process.env,{PYTHONDONTWRITEBYTECODE:'1',YANYU_PYTHON:worker,ASR_MAX_SECONDS:'1',ASR_MAX_BYTES:'1024',ASR_DEADLINE_SECONDS:'120'});
 const modulePath=resolve(import.meta.dirname,'../local-asr');
 const descendant=`import os,time,json\nfrom pathlib import Path\np=Path(${JSON.stringify(root)})\n(p/'descendant.pid').write_text(str(os.getpid()))\nwhile True:\n with open(p/'descendant-writes','a') as f: f.write('x'); f.flush()\n time.sleep(.02)\n`;
 writeFileSync(worker,`#!/usr/bin/python3\nimport sys,os,subprocess,time,json\nsys.path.insert(0,${JSON.stringify(modulePath)})\nfrom worker_fence import validated_fds\nfds=validated_fds()\nfrom pathlib import Path\np=Path(${JSON.stringify(root)})\nchild=subprocess.Popen(['/usr/bin/python3','-c',${JSON.stringify(descendant)}],pass_fds=fds,start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n(p/'worker.pid').write_text(str(os.getpid()))\nwhile True:\n with open(p/'worker-writes','a') as f: f.write('x'); f.flush()\n time.sleep(.02)\n`,{mode:0o700});
 const wait=async(fn,label)=>{const deadline=Date.now()+8000;while(!fn()){if(Date.now()>deadline)throw Error('Timed out: '+label);await new Promise(r=>setTimeout(r,10))}};
 const pidGuard=async pid=>{
  const p=spawn('/usr/bin/python3',['-u','-c',`import os,signal,select,sys\nf=os.pidfd_open(int(sys.argv[1]))\nprint('ready',flush=True)\nsys.stdin.readline()\nsignal.pidfd_send_signal(f,signal.SIGKILL)\np=select.poll();p.register(f,select.POLLIN);p.poll()\nos.close(f)\nprint('dead',flush=True)`,String(pid)],{stdio:['pipe','pipe','inherit']});
  guardians.add(p);let out='';p.stdout.on('data',b=>out+=b);await wait(()=>out.includes('ready'),'pidfd ready');let killed=false;
  return async()=>{if(killed)return;killed=true;p.stdin.end('kill\n');await wait(()=>out.includes('dead'),'pidfd death');if(p.exitCode===null)await once(p,'exit');guardians.delete(p)};
 };
 const getWriters=async()=>{await wait(()=>existsSync(join(root,'worker.pid'))&&existsSync(join(root,'descendant.pid')),'writer startup');return {killWorker:await pidGuard(Number(readFileSync(join(root,'worker.pid')))),killDescendant:await pidGuard(Number(readFileSync(join(root,'descendant.pid'))))}};
 const clearWriters=()=>{for(const f of ['worker.pid','descendant.pid','worker-writes','descendant-writes'])rmSync(join(root,f),{force:true})};
 const snapshot=()=>{const db=new DatabaseSync(join(storage,'long-transcription.sqlite'));try{return JSON.stringify(db.prepare('SELECT * FROM transcription_jobs').all())}finally{db.close()}};
 try{
  service=localTranscription(storage,workspace);scopeHeaders=await discoverScope(service);assert.throws(()=>localTranscription(alias),/already owned/);await service.close();await service.close();service=null;
  process.env.ASR_MAX_BYTES='bad';assert.throws(()=>localTranscription(storage,workspace),/initialization unavailable/);process.env.ASR_MAX_BYTES='1024';service=localTranscription(storage,workspace);await service.close();service=null;
  console.log('PASS duplicate constructor/canonical alias, init failure release and idempotent close');
  backend=fork(import.meta.filename,['service-child',storage],{env:process.env,stdio:['ignore','ignore','inherit','ipc']});let messages=[];backend.on('message',m=>messages.push(m));await wait(()=>messages.some(m=>m.ready),'constructor ready');backend.send({start:true});await wait(()=>messages.some(m=>m.response),'upload accepted');const r=messages.find(m=>m.response).response;assert.equal(r.status,202);const dir=join(storage,'long-asr-temp',`job-${r.body.id}`),before=snapshot();const writers=await getWriters();
  const exited=once(backend,'exit');backend.kill('SIGKILL');await exited;
  for(let i=0;i<3;i++){assert.throws(()=>localTranscription(alias,workspace),/already owned/);assert.equal(snapshot(),before);assert(existsSync(join(dir,'input')))}
  const size=statSync(join(root,'descendant-writes')).size;await wait(()=>statSync(join(root,'descendant-writes')).size>size,'descendant keeps writing under fence');
  await writers.killWorker();assert.throws(()=>localTranscription(storage,workspace),/already owned/);assert.equal(snapshot(),before);assert(existsSync(dir));
  await writers.killDescendant();service=localTranscription(storage,workspace);const db=new DatabaseSync(join(storage,'long-transcription.sqlite'));assert.equal(db.prepare('SELECT status FROM transcription_jobs WHERE id=?').get(r.body.id).status,'interrupted');db.close();await service.close();service=null;
  console.log('PASS actual application backend SIGKILL: live worker and surviving descendant block recovery without mutation; final death permits recovery');
  clearWriters();service=localTranscription(storage,workspace);const live=await call(service);assert.equal(live.status,202);const liveDir=join(storage,'long-asr-temp',`job-${live.body.id}`),liveWriters=await getWriters();await liveWriters.killWorker();
  await wait(()=>statSync(join(root,'descendant-writes')).size>1,'live backend descendant writes');assert(existsSync(liveDir));assert.equal((await call(service)).status,409);
  let closed=false;const draining=service.close().then(()=>closed=true);assert.throws(()=>localTranscription(storage),/already owned/);assert(!closed);assert(existsSync(liveDir));await liveWriters.killDescendant();await draining;service=null;service=localTranscription(storage,workspace);await service.close();service=null;
  console.log('PASS immediate child death does not clean/reuse directory or release backend owner while descendant lives; graceful drain waits for last writer');
  // The real bootstrap fails before NumPy/ASR imports when either fd is missing.
  const owner=acquireFence(join(storage,'bootstrap-owner.lock')),lease=acquireFence(join(storage,'bootstrap-lease.lock'));
  try{
   const env={...process.env,PYTHONPATH:modulePath,YANYU_OWNER_FD:'3',YANYU_OWNER_ID:owner.identity,YANYU_LEASE_FD:'4',YANYU_LEASE_ID:lease.identity};
   const ok=spawnSync('/usr/bin/python3',['-c','from worker_fence import validated_fds; assert validated_fds()==(3,4)'],{env,stdio:['ignore','pipe','pipe',owner.fd,lease.fd]});assert.equal(ok.status,0,ok.stderr?.toString());
   for(const stdio of [['ignore','pipe','pipe'],['ignore','pipe','pipe',owner.fd]]){const bad=spawnSync('/usr/bin/python3',[join(modulePath,'recognize_long.py')],{env,stdio});assert.notEqual(bad.status,0);assert(!bad.stderr.toString().includes('numpy'));assert(bad.stderr.toString().includes('worker_fence'))}
   const wrong=spawnSync('/usr/bin/python3',['-c','from worker_fence import validated_fds; validated_fds()'],{env:{...env,YANYU_OWNER_ID:'wrong'},stdio:['ignore','pipe','pipe',owner.fd,lease.fd]});assert.notEqual(wrong.status,0);
  }finally{lease.close();owner.close()}
  console.log('PASS real Python bootstrap validates held lock identity; absent inheritance and wrong inode fail closed before native imports');
  clearWriters();service=localTranscription(storage,workspace);const originalSend=process.send;
  process.send=()=>{
   const ready=spawnSync('/usr/bin/python3',['-c',`import time,sys
from pathlib import Path
p=Path(sys.argv[1]);end=time.monotonic()+5
while not (p/'descendant.pid').exists():
 if time.monotonic()>end: sys.exit(1)
 time.sleep(.01)`,root],{timeout:6000});assert.equal(ready.status,0);throw Error('inert postspawn failpoint');
  };
  let failed;try{failed=await call(service)}finally{if(originalSend)process.send=originalSend;else delete process.send}assert.equal(failed.status,500);
  const killSurvivor=await pidGuard(Number(readFileSync(join(root,'descendant.pid'))));
  const failDB=new DatabaseSync(join(storage,'long-transcription.sqlite')),failedRow=failDB.prepare("SELECT * FROM transcription_jobs WHERE status='processing' ORDER BY created DESC LIMIT 1").get();failDB.close();assert(failedRow);
  const failedDir=join(storage,'long-asr-temp',`job-${failedRow.id}`);assert(existsSync(failedDir));assert.equal((await call(service)).status,409);
  await killSurvivor();await wait(()=>!existsSync(failedDir),'postspawn drain cleanup');await service.close();service=null;
  console.log('PASS postspawn IPC failure with actual live descendant retains job directory and BUSY state until kernel lease release');
  // Exercise both other launch routes with the same validating inert worker.
  for(const route of ['resume','retry']){
   clearWriters();service=localTranscription(storage,workspace);
   let req;
   if(route==='resume')req=Object.assign(Readable.from([]),{url:`/api/local-asr/jobs/${r.body.id}/resume`,method:'POST',headers:{...scopeHeaders,}});
   else{req=request();req.url=`/api/local-asr/jobs/${failedRow.id}/retry`}
   const launched=await call(service,req);assert.equal(launched.status,202,JSON.stringify(launched));const writers=await getWriters();await writers.killWorker();await writers.killDescendant();await wait(()=>!existsSync(join(storage,'long-asr-temp',`job-${launched.body.id}`)),route+' drain');await service.close();service=null;
  }
  console.log('PASS ordinary upload, resume and failed retry all pass validated store+job descriptors through prlimit/Python');
  // Abort a genuinely in-flight ordinary upload on close, with no launch.
  service=localTranscription(storage,workspace);const req=new Readable({read(){}});Object.assign(req,{url:'/api/local-asr/transcribe',method:'POST',headers:{...scopeHeaders,'content-type':'audio/wav','content-length':'80','x-audio-filename':'inert.wav'}});const response=call(service,req);req.push(Buffer.alloc(10));await new Promise(r=>setImmediate(r));await service.close();await response;service=null;
  console.log('PASS graceful close aborts/drains in-flight upload before DB/fence close');
  console.log(JSON.stringify({passed:true,realInference:false,network:false,platform:process.platform}));
 }finally{
  if(backend?.exitCode===null&&backend?.signalCode===null){const exit=once(backend,'exit');backend.kill('SIGKILL');await exit}
  for(const p of guardians){p.stdin.end('kill\n');if(p.exitCode===null)await once(p,'exit')}
  if(service)await service.close();for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);rmSync(root,{recursive:true,force:true});
 }
}
