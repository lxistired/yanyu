import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {transcriptionStoreDispatch} from './transcription-store-dispatch.mjs';
import {initializeTranscriptionStoreIdentity, transcriptionStoreHeader as header} from './transcription-store-identity.mjs';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const job = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const base = `/api/local-asr/jobs/${job}`;
// Bodies intentionally are never supplied/read: downstream handlers are inert
// spies, not audio/ASR. Same ID and revision collide across two synthetic DBs.
const routes = [
 ['GET','/api/local-asr/identity?'], ['GET','/api/local-asr/identity?x=1'], ['GET','/api/local-asr/identity/'], ['GET','/api/local-asr/%69dentity'], ['HEAD','/api/local-asr/identity'], ['POST','/api/local-asr/identity'],
 ['GET','/api/local-asr/jobs'], ['GET','/api/local-asr/jobs?limit=1&offset=1'],
 ['GET',`/api/local-asr/jobs?jobId=${job}`], ['GET',`${base}/transcript`],
 ['POST',`${base}/transcript`], ['POST',`${base}/transcript-restore`],
 ['GET',`${base}/history`], ['GET',`${base}/history/1`],
 ['GET',`${base}/export`], ['POST',`${base}/export`],
 ...['rename','trash','restore','cancel','resume'].map(x=>['POST',`${base}/${x}`]),
 ['GET','/api/local-asr/relationships'], ['GET',`${base}/relationship`],
 ['POST',`${base}/relationship`], ['GET',`${base}/retry`], ['POST',`${base}/retry`],
 ['POST','/api/local-asr/transcribe'], ['DELETE','/api/local-asr/unknown'],
 ['POST','/api/local-asr/jobs/not-a-job/cancel'], ['GET','/api/local-asr/'],
];
function fixture(id) {
 const db = new DatabaseSync(':memory:'); initializeTranscriptionStoreIdentity(db);
 db.prepare('UPDATE transcription_store_identity SET store_id=?').run(id);
 db.exec('CREATE TABLE synthetic_jobs(id TEXT, revision INTEGER, content TEXT)');
 db.prepare('INSERT INTO synthetic_jobs VALUES(?,1,?)').run(job, id === A ? 'synthetic A' : 'synthetic B');
 return db;
}
const snapshot = db => JSON.stringify({rows:db.prepare('SELECT * FROM synthetic_jobs').all(), identity:db.prepare('SELECT * FROM transcription_store_identity').all(), changes:db.prepare('SELECT total_changes() AS n').get()});
function request(method,url,headers={},rawHeaders=[]) {
 return {method,url,headers,rawHeaders,get body(){throw Error('body read before admission')},
  [Symbol.asyncIterator](){throw Error('body consumed before admission')}};
}
function harness(db) {
 const seen={dispatch:0,log:0,body:0,sweep:0,replay:0,jobReads:0,mutation:0};
 const output=[]; const responseHeaders={};
 const dispatch=transcriptionStoreDispatch(db,(req,send,fail,download)=>{
  seen.dispatch++; // All route-side activities below are inert witnesses.
  seen.sweep++;seen.replay++;seen.jobReads++;seen.mutation++;
  if(req.url.endsWith('/export'))download('synthetic.txt',Buffer.from('synthetic'),1);
  else send(200,{ok:true});return true;
 });
 return {seen,output,responseHeaders,call:req=>dispatch(req,
  (...args)=>output.push(['send',...args]),(...args)=>output.push(['fail',...args]),
  (...args)=>output.push(['download',...args]),
  {setHeader:(key,value)=>{responseHeaders[key]=value},onAdmitted:()=>seen.log++})};
}
const scoped=id=>[{[header]:id},['X-Transcription-Store-Id',id]];
const invalidCases=[
 [{[header]:''},[header,'']], [{[header]:'bogus'},[header,'bogus']],
 [{[header]:A+'\n'},[header,A+'\n']], [{[header]:A.toUpperCase()},[header,A.toUpperCase()]],
 [{[header]:[A]},[header,A]], [{[header]:A+', '+A},[header,A,header,A]],
 [{[header]:A},[header,A,header,A]], [{[header]:A,'X-Transcription-Store-Id':A},[header,A]],
 [{},[header,A]], [{[header]:A},[]], [{[header]:A},[header,B]],
 [{},['unrelated']], [{},[42,'value']], [[],[]], [null,[]],
];
test('every local-asr route rejects explicit invalid or foreign identity before any downstream action',async()=>{
 const db=fixture(B);try {
  const before=snapshot(db);
  for(const [method,url] of [...routes,['GET','/api/local-asr/identity']])for(const [headers,raw] of [...invalidCases,scoped(A)]){
   const h=harness(db);assert.equal(await h.call(request(method,url,headers,raw)),true);
   assert.deepEqual(Object.values(h.seen),[0,0,0,0,0,0,0]);
   assert.equal(h.output[0][0],'fail');assert.equal(h.output[0][1],headers?.[header]===A && raw?.length===2 && raw[1]===A && Object.keys(headers).length===1 ? 409:400);
   assert.equal(h.responseHeaders[header],B);assert.equal(snapshot(db),before);
  }
 }finally{db.close()}
});
test('matching scope delegates all record routes and exposes response identity',async()=>{
 for(const id of [A,B]){const db=fixture(id);try{
  const before=snapshot(db);
  for(const [method,url]of routes)for(const [headers,raw]of [scoped(id)]){
   const h=harness(db);const req=request(method,url,headers,raw);if(raw===undefined)delete req.rawHeaders;
   assert.equal(await h.call(req),true);assert.equal(h.seen.dispatch,1);assert.equal(h.seen.log,1);
   assert.equal(h.responseHeaders[header],id);assert.equal(h.output[0][0],url.endsWith('/export')?'download':'send');
   assert.equal(snapshot(db),before);
  }
 }finally{db.close()}}
});
test('other namespaces never read identity, delegate or expose transcription header',async()=>{
 const db=fixture(A);const h=harness(db);db.close();
 for(const url of ['/api/local-asr','/api/local-asr-other/jobs','/api/local-asrX/jobs','/api/documents','/api/workspace/list','/x?next=/api/local-asr/jobs']){
  assert.equal(await h.call(request('GET',url,...scoped(B))),false);
 }
 assert.deepEqual(h.output,[]);assert.deepEqual(h.responseHeaders,{});assert.equal(h.seen.dispatch,0);
});
test('persisted identity corruption or rotation fails closed even for headerless requests',async()=>{
 for(const sql of ['DELETE FROM transcription_store_identity',`UPDATE transcription_store_identity SET store_id='${B}'`,"UPDATE transcription_store_identity SET store_id='bad'"]){
  const db=fixture(A);try{const h=harness(db);db.exec(sql);const before=snapshot(db);
   for(const args of [[{},[]],scoped(A),scoped(B)]){
    assert.equal(await h.call(request('POST','/api/local-asr/transcribe',...args)),true);
    assert.equal(h.output.at(-1)[1],503);assert.equal(h.output.at(-1)[2],'STORE_IDENTITY_UNAVAILABLE');
    assert.equal(h.seen.dispatch,0);assert.equal(h.seen.log,0);assert.deepEqual(h.responseHeaders,{});assert.equal(snapshot(db),before);
   }
  }finally{db.close()}
 }
});
test('static production wiring keeps the gate around all route logic and moves logging after admission',()=>{
 const runtime=readFileSync(new URL('./local-transcription.mjs',import.meta.url),'utf8');
 const server=readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
 assert(runtime.includes('return {handle:transcriptionStoreDispatch(db,handle),close(){'));
 assert(runtime.includes('return {handle:service.handle,close()'));
 assert(runtime.includes('requests.add(req);const pending=handleInner(req,send,fail,download)'));
 const call=server.split('\n').find(line=>line.includes('if(await transcription.handle('));
 assert(call.includes('setHeader:(name,value)=>res.setHeader(name,value)'));
 assert(call.includes("onAdmitted:()=>{if(raw==='/api/local-asr/relationships')event("));
 assert.equal(server.split("event({module:'transcript-relationships'").length-1,1);
 assert(call.includes("'X-Transcript-Revision':String(revision)"));
 // The test never imports either live runtime module or opens a server/storage.
});

test('every record route rejects absent scope before body/log/SQL; only exact identity GET discovers',async()=>{
 const db=fixture(A);try{
  const before=snapshot(db);
  for(const [method,url] of routes)for(const raw of [[],undefined]){
   const h=harness(db),req=request(method,url,{},raw);if(raw===undefined)delete req.rawHeaders;
   await h.call(req);assert.deepEqual(h.output,[['fail',428,'STORE_SCOPE_REQUIRED','Transcription source identity required; upgrade or reload the client and explicitly select a source']]);
   assert.deepEqual(Object.values(h.seen),[0,0,0,0,0,0,0]);assert.equal(snapshot(db),before);
  }
  for(const args of [[{},[]],scoped(A)]){
   const h=harness(db);await h.call(request('GET','/api/local-asr/identity',...args));
   assert.deepEqual(h.output,[['send',200,{transcriptionStoreId:A}]]);assert.equal(h.responseHeaders[header],A);
   assert.deepEqual(Object.values(h.seen),[0,0,0,0,0,0,0]);assert.equal(snapshot(db),before);
  }
 }finally{db.close()}
});
