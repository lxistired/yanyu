
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
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {publicTranscriptionError,workerErrorCode} from '../backend/transcription-errors.mjs';
import {localTranscription} from '../backend/local-transcription.mjs';
const secret='SYNTHETIC_SECRET_SENTINEL /private/synthetic/path exception-detail';
const safe=body=>assert.equal(JSON.stringify(body).includes('SYNTHETIC_SECRET_SENTINEL'),false);
const request=(scopeHeaders,url,body,method='POST',headers={'content-type':'application/json'})=>Object.assign(Readable.from([typeof body==='string'?Buffer.from(body):body]),{url,method,headers:{...scopeHeaders,...headers}});
test('closed error vocabulary rejects unknown, non-string, prototype and message injection',()=>{
 for(const value of [secret,{},[],42,false,'',new String('ASR_DEADLINE'),'constructor','__proto__']){
  assert.deepEqual(publicTranscriptionError(value),{error:'Local recognition failed; re-upload required',error_code:'ASR_FAILED'});
 }
 for(const code of [secret,{},[],null,'constructor','__proto__'])assert.equal(workerErrorCode({error_code:code,error:secret}),'ASR_FAILED');
 assert.equal(workerErrorCode({error_code:'ASR_DEADLINE',error:secret}),'ASR_DEADLINE');
 assert.deepEqual(publicTranscriptionError(null),{error:null,error_code:null});
 assert.equal(publicTranscriptionError('Job deadline exceeded').error_code,'ASR_DEADLINE');
});
test('real temporary SQLite: legacy rows safe across list, rename, trash, restore; source unchanged',async()=>{
 const root=mkdtempSync(join(tmpdir(),'yanyu-errors-db-'));let app,db;
 try{
  app=localTranscription(root,{});db=new DatabaseSync(join(root,'long-transcription.sqlite'));
  const scopeHeaders=await discoverScope(app);
  const id='12345678-1234-1234-1234-123456789012';
  db.prepare('INSERT INTO transcription_jobs(id,filename,status,created,error) VALUES(?,?,?,?,?)').run(id,'synthetic.wav','failed','2026-01-01',secret);
  let response;const send=(status,body)=>{assert.equal(status,200);safe(body);response=body};const fail=(...args)=>assert.fail(JSON.stringify(args));
  const list=async url=>{await app.handle({url,method:'GET',headers:scopeHeaders},send,fail);assert.equal(response.jobs[0].error_code,'ASR_FAILED');assert.equal(response.jobs[0].status,'failed');};
  await list('/api/local-asr/jobs');
  for(const [revision,action,extra] of [[0,'rename',{title:'Synthetic renamed'}],[1,'trash',{}],[2,'restore',{}]]){
   await app.handle(request(scopeHeaders,`/api/local-asr/jobs/${id}/${action}`,JSON.stringify({expectedRevision:revision,...extra})),send,fail);
   assert.equal(response.job.error_code,'ASR_FAILED');assert.equal(response.job.library_revision,revision+1);
   await list(`/api/local-asr/jobs?scope=${action==='trash'?'trash':'active'}`);
   assert.equal(db.prepare('SELECT error FROM transcription_jobs WHERE id=?').get(id).error,secret);
  }
  db.prepare('UPDATE transcription_jobs SET error=? WHERE id=?').run(Buffer.from(secret),id);await list('/api/local-asr/jobs');
 }finally{db?.close();app?.close();rmSync(root,{recursive:true,force:true});assert.equal(existsSync(root),false)}
});
test('real subprocess simulator and SQLite: no ASR, safe ingestion, failure/deadline/cancel/success semantics',async()=>{
 const root=mkdtempSync(join(tmpdir(),'yanyu-errors-worker-'));let app,db;
 const old={python:process.env.YANYU_PYTHON,deadline:process.env.ASR_DEADLINE_SECONDS};
 try{
  const stub=join(root,'synthetic-worker.py');
  writeFileSync(stub,`#!/usr/bin/python3\nimport json,sys,time\nmode=open(sys.argv[2],'rb').read(1).decode()\nsentinel=${JSON.stringify(secret)}\nif mode=='K': print(json.dumps({'type':'error','error_code':'ASR_AUDIO_INVALID','error':sentinel}),flush=True)\nelif mode=='U': print(json.dumps({'type':'error','error_code':sentinel,'error':sentinel}),flush=True)\nelif mode=='O': print(json.dumps({'type':'error','error':{'detail':sentinel}}),flush=True)\nelif mode=='M': print(sentinel,flush=True); time.sleep(10)\nelif mode=='E': sys.stderr.write(sentinel*2000); sys.stderr.flush(); time.sleep(10)\nelif mode=='B': sys.stdout.write('X'*17000000); sys.stdout.flush(); time.sleep(10)\nelif mode=='H': time.sleep(10)\nelif mode=='S': print(json.dumps({'type':'result','text':'synthetic success','duration_seconds':1,'language':'en'}),flush=True); sys.exit(0)\nsys.exit(1)\n`,{mode:0o700});
  process.env.YANYU_PYTHON=stub;process.env.ASR_DEADLINE_SECONDS='1';
  app=localTranscription(root,{});db=new DatabaseSync(join(root,'long-transcription.sqlite'));
  const scopeHeaders=await discoverScope(app);
  const fail=(...args)=>assert.fail(JSON.stringify(args));
  for(const [mode,expected,status] of [['K','ASR_AUDIO_INVALID','failed'],['U','ASR_FAILED','failed'],['O','ASR_FAILED','failed'],['N','ASR_FAILED','failed'],['B','ASR_OUTPUT_LIMIT','failed'],['M','ASR_WORKER_OUTPUT','failed'],['E','ASR_DIAGNOSTICS_LIMIT','failed'],['H','ASR_DEADLINE','failed'],['H','ASR_CANCELLED','cancelled'],['S',null,'completed']]){
   // Keep the dedicated deadline/cancel cases at one second. The 17 MB output
   // case needs its own budget under contention; its expected code and the
   // original five-second outer bound remain unchanged.
   const deadline=mode==='B'?'3':'1';
   if(process.env.ASR_DEADLINE_SECONDS!==deadline){await app.close();process.env.ASR_DEADLINE_SECONDS=deadline;app=localTranscription(root,{})}
   let id;await app.handle(request(scopeHeaders,'/api/local-asr/transcribe',Buffer.from(mode.repeat(44)),'POST',{'content-type':'audio/wav','content-length':'44','x-audio-filename':'synthetic.wav'}),(code,body)=>{assert.equal(code,202);id=body.id},fail);
   if(status==='cancelled')await app.handle({url:`/api/local-asr/jobs/${id}/cancel`,method:'POST',headers:scopeHeaders},()=>{},fail);
   const end=Date.now()+5000;let row;
   do{row=db.prepare('SELECT * FROM transcription_jobs WHERE id=?').get(id);if(row.status!=='processing')break;await new Promise(resolve=>setTimeout(resolve,20))}while(Date.now()<end);
   assert.equal(row.status,status);assert.equal(row.error,expected);safe(row);
   await app.handle({url:`/api/local-asr/jobs?jobId=${id}`,method:'GET',headers:scopeHeaders},(code,body)=>{assert.equal(code,200);safe(body);assert.equal(body.jobs[0].error_code,expected)},fail);
   assert.equal(existsSync(join(root,'long-asr-temp',`job-${id}`)),false);
  }
 }finally{await app?.close();db?.close();for(const [key,value] of [['YANYU_PYTHON',old.python],['ASR_DEADLINE_SECONDS',old.deadline]]){if(value===undefined)delete process.env[key];else process.env[key]=value}rmSync(root,{recursive:true,force:true});assert.equal(existsSync(root),false)}
});
