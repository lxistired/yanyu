
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
// Only synthetic bytes, real temporary SQLite and inert fake workers. No audio decoding.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,writeFileSync,rmSync,readdirSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {randomUUID,createHash} from 'node:crypto';
import {localTranscription} from './local-transcription.mjs';
import {createUploadReceipt} from './upload-receipts.mjs';
const root=mkdtempSync(join(tmpdir(),'failed-retry-')),worker=join(root,'fake-worker'),calls=join(root,'worker-count');
const saved={...process.env};Object.assign(process.env,{YANYU_PYTHON:worker,ASR_MAX_SECONDS:'1',ASR_MAX_BYTES:'1024',ASR_DEADLINE_SECONDS:'2'});
const setWorker=(body='exit 1')=>writeFileSync(worker,`#!/bin/sh\necho x >> '${calls}'\n${body}\n`,{mode:0o700});setWorker();
const bytes=Buffer.from(Array.from({length:80},(_,i)=>i)),digest=createHash('sha256').update(bytes).digest('hex');
const receipt=createUploadReceipt({sha256:digest,byteLength:80,mime:'audio/wav',format:'wav',language:'zh',maxSeconds:1,maxBytes:1024,deadlineSeconds:2});
let service=localTranscription(root),db=new DatabaseSync(join(root,'long-transcription.sqlite'));const checks=[];
const scopeHeaders=await discoverScope(service);
const seed=(status='failed',raw=receipt)=>{const id=randomUUID();db.prepare('INSERT INTO transcription_jobs(id,filename,status,created,requested_language,original_upload_receipt) VALUES(?,?,?,?,?,?)').run(id,'parent.wav',status,new Date().toISOString(),'zh',raw);return id};
const req=(id,parts=[bytes],headers={})=>Object.assign(Readable.from(parts),{url:`/api/local-asr/jobs/${id}/retry`,method:'POST',headers:{...scopeHeaders,'content-type':'audio/wav','content-length':'80','x-audio-filename':'reselected.wav','x-audio-language':'zh',...headers}});
const call=async(request,svc=service)=>{let r;assert.equal(await svc.handle(request,(status,body)=>r={status,body},(status,code,message)=>r={status,body:{code,message}}),true);assert(!JSON.stringify(r).includes(digest));assert(!JSON.stringify(r).includes(root));return r};
const get=id=>call({url:`/api/local-asr/jobs/${id}/retry`,method:'GET',headers:scopeHeaders});
const row=id=>db.prepare('SELECT * FROM transcription_jobs WHERE id=?').get(id);
const links=id=>db.prepare('SELECT * FROM transcription_retries WHERE parent_id=?').all(id);
const terminal=async id=>{for(let i=0;i<150;i++){if(row(id).status!=='processing')return row(id);await new Promise(r=>setTimeout(r,20))}throw Error('fake worker timeout')};
const count=()=>existsSync(calls)?readFileSync(calls,'utf8').trim().split('\n').length:0;
const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name)};
try{
 await check('missing, deleted, nonfailed, legacy and malformed parents fail closed',async()=>{
  assert.equal((await call(req(randomUUID()))).status,404);
  for(const s of ['processing','interrupted','cancelled','completed'])assert.equal((await call(req(seed(s)))).body.code,'INVALID_STATE');
  for(const raw of [null,'{}','{','null',JSON.stringify({...JSON.parse(receipt),version:2})])assert.equal((await call(req(seed('failed',raw)))).body.code,'RECEIPT_UNAVAILABLE');
  const id=seed();db.prepare("UPDATE transcription_jobs SET deleted_at='now' WHERE id=?").run(id);assert.equal((await call(req(id))).status,404);
 });
 await check('all identity mismatches rejected without lineage or worker',async()=>{
  const id=seed();for(const headers of [{'content-type':'audio/mpeg'},{'x-audio-language':'en'},{'content-length':'81'},{'content-encoding':'gzip'}])assert.equal((await call(req(id,[bytes],headers))).body.code,'UPLOAD_MISMATCH');
  assert.equal((await call(req(id,[Buffer.alloc(80)]))).body.code,'UPLOAD_MISMATCH');
  const s=JSON.parse(receipt);s.settings.maxSeconds=2;assert.equal((await call(req(seed('failed',JSON.stringify(s))))).body.code,'SETTINGS_MISMATCH');assert.equal(links(id).length,0);assert.equal(count(),0);
 });
 await check('short oversized aborted streams clean staging without child',async()=>{const id=seed();for(const parts of [[bytes.subarray(0,50)],[Buffer.alloc(81)],(async function*(){yield bytes.subarray(0,20);throw Error('private diagnostics')})()])assert.equal((await call(req(id,parts))).status,400);assert.equal(links(id).length,0);assert.deepEqual(readdirSync(join(root,'long-asr-temp')),[])});
 let parent,child;
 await check('atomic new child and immutable lineage preserve parent and do not copy edits',async()=>{
  parent=seed();const before=row(parent);const result=await call(req(parent,[bytes.subarray(0,20),bytes.subarray(20)]));assert.equal(result.status,202);child=result.body.id;assert.notEqual(child,parent);assert.deepEqual(row(parent),before);assert.equal(links(parent)[0].child_id,child);assert.equal(row(child).original_upload_receipt,receipt);assert.equal(row(child).title,null);assert.equal(row(child).library_revision,0);assert.equal(db.prepare('SELECT count(*) n FROM transcript_corrections WHERE job_id=?').get(child).n,0);assert.equal(db.prepare('SELECT count(*) n FROM transcript_relationships WHERE job_id=?').get(child).n,0);await terminal(child);assert.equal(existsSync(join(root,'long-asr-temp',`job-${child}`)),false);
  assert.throws(()=>db.prepare('INSERT INTO transcription_retries VALUES(?,?,?)').run(parent,randomUUID(),'now'),/UNIQUE/);
  assert.throws(()=>db.prepare('DELETE FROM transcription_retries WHERE parent_id=?').run(parent),/immutable/);
 });
 await check('validated replay survives terminal status and restart without workers',async()=>{const n=count();assert.equal((await call(req(parent))).body.id,child);assert.equal((await call(req(parent,[Buffer.alloc(80)]))).status,409);await service.close();db.close();service=localTranscription(root);db=new DatabaseSync(join(root,'long-transcription.sqlite'));const r=await call(req(parent));assert.equal(r.status,200);assert.equal(r.body.id,child);assert.equal(r.body.replayed,true);assert.equal(count(),n);assert.equal((await get(parent)).body.state,'created')});
 await check('replay while another worker busy never spawns',async()=>{setWorker('sleep 1; exit 1');const other=await call(req(seed()));assert.equal(other.status,202);const n=count();assert.equal((await call(req(parent))).status,200);assert.equal((await call(req(seed()))).body.code,'BUSY');await terminal(other.body.id);setWorker();assert(count()<=n+1)});
 await check('concurrent complete bodies return a single child and spawn once',async()=>{
  const id=seed();let release;const gate=new Promise(r=>release=r);const slow=call(req(id,(async function*(){yield bytes.subarray(0,20);await gate;yield bytes.subarray(20)})()));await new Promise(r=>setTimeout(r,10));assert.equal((await get(id)).body.state,'pending');const fast=await call(req(id));release();const second=await slow;assert.equal(fast.status,202);assert.equal(second.status,200);assert.equal(fast.body.id,second.body.id);assert.equal(links(id).length,1);await terminal(fast.body.id);
 });
 await check('parent deletion during body is rechecked inside commit',async()=>{const id=seed();const r=await call(req(id,(async function*(){yield bytes.subarray(0,20);db.prepare("UPDATE transcription_jobs SET deleted_at='deleted' WHERE id=?").run(id);yield bytes.subarray(20)})()));assert.equal(r.status,404);assert.equal(links(id).length,0);assert.deepEqual(readdirSync(join(root,'long-asr-temp')),[])});
 await check('lineage insert SQL failure rolls back child and cleans staging',async()=>{const id=seed(),n=db.prepare('SELECT count(*) n FROM transcription_jobs').get().n;db.exec("CREATE TRIGGER reject_retry BEFORE INSERT ON transcription_retries BEGIN SELECT RAISE(ABORT,'private failure path'); END");try{assert.equal((await call(req(id))).status,500)}finally{db.exec('DROP TRIGGER reject_retry')}assert.equal(db.prepare('SELECT count(*) n FROM transcription_jobs').get().n,n);assert.equal(links(id).length,0);assert.deepEqual(readdirSync(join(root,'long-asr-temp')),[])});
 await check('postcommit spawn failure retains one failed child and replay does not spawn',async()=>{const id=seed(),old=process.send;process.send=()=>{throw Error('private IPC path')};try{assert.equal((await call(req(id))).status,500)}finally{if(old===undefined)delete process.send;else process.send=old}const c=links(id)[0].child_id;await terminal(c);assert.equal(row(c).status,'failed');const n=count();assert.equal((await call(req(id))).body.id,c);assert.equal(count(),n);assert.equal(existsSync(join(root,'long-asr-temp',`job-${c}`)),false)});
 await check('deleted child cannot be restored or replaced by replay',async()=>{db.prepare("UPDATE transcription_jobs SET deleted_at='deleted' WHERE id=?").run(child);assert.equal((await call(req(parent))).body.code,'RETRY_UNAVAILABLE');assert.equal((await get(parent)).body.code,'RETRY_UNAVAILABLE');assert.equal(links(parent)[0].child_id,child)});
 await check('failed child can be independently retried once',async()=>{const id=seed(),a=await call(req(id));await terminal(a.body.id);const b=await call(req(a.body.id));assert.equal(b.status,202);assert.notEqual(a.body.id,b.body.id);await terminal(b.body.id);assert.equal(links(a.body.id).length,1)});
 await check('duplicate owner rejects before recovery or live staging mutation',async()=>{const id=seed();let release;const gate=new Promise(r=>release=r);const pending=call(req(id,(async function*(){yield bytes.subarray(0,10);await gate;yield bytes.subarray(10)})()));await new Promise(r=>setTimeout(r,10));assert.throws(()=>localTranscription(root),/already owned/);assert.equal(readdirSync(join(root,'long-asr-temp')).filter(x=>x.startsWith('retry-')).length,1);release();const r=await pending;await terminal(r.body.id)});
 await check('restart missing pending input marks committed child failed without duplicate',async()=>{const id=seed();setWorker('sleep 3');const r=await call(req(id));await service.close();db.close();await new Promise(r=>setTimeout(r,30));rmSync(join(root,'long-asr-temp',`job-${r.body.id}`),{recursive:true,force:true});service=localTranscription(root);db=new DatabaseSync(join(root,'long-transcription.sqlite'));assert.equal(row(r.body.id).status,'failed');assert.equal((await call(req(id))).body.id,r.body.id);assert.equal(links(id).length,1);setWorker()});
 await check('ordinary upload honors outstanding retry capacity reservation',async()=>{await service.close();db.close();process.env.ASR_PENDING_QUOTA_BYTES='34000000';service=localTranscription(root);db=new DatabaseSync(join(root,'long-transcription.sqlite'));const id=seed();let release;const gate=new Promise(r=>release=r);const pending=call(req(id,(async function*(){yield bytes.subarray(0,10);await gate;yield bytes.subarray(10)})()));await new Promise(r=>setTimeout(r,10));const normal=req(id);normal.url='/api/local-asr/transcribe';assert.equal((await call(normal)).body.code,'DISK_LIMIT');release();const r=await pending;assert.equal(r.status,202);await terminal(r.body.id);delete process.env.ASR_PENDING_QUOTA_BYTES});
 console.log(JSON.stringify({passed:true,count:checks.length,checks}));
}finally{await service.close();db.close();for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);rmSync(root,{recursive:true,force:true})}
