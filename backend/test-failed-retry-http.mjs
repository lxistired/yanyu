let scopeHeaders;
// Production loopback server, synthetic store and inert worker only.
import assert from 'node:assert/strict';
import {fork,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {createUploadReceipt} from './upload-receipts.mjs';
const root=mkdtempSync(join(tmpdir(),'retry-http-')),storage=join(root,'store'),worker=join(root,'fake-worker');mkdirSync(storage);writeFileSync(worker,'#!/bin/sh\nexit 1\n',{mode:0o700});
let child,db,build,origin;const bytes=Buffer.alloc(80,7),hash=createHash('sha256').update(bytes).digest('hex'),id=randomUUID();
try{
 const prep=spawnSync(process.execPath,[join(import.meta.dirname,'prepare-backend.mjs')],{encoding:'utf8'});assert.equal(prep.status,0,prep.stderr);build=prep.stdout.trim();
 await new Promise((resolve,reject)=>{child=fork(join(import.meta.dirname,'server.mjs'),[build,storage,join(root,'events'),'0'],{stdio:['ignore','ignore','pipe','ipc'],env:{PATH:process.env.PATH,YANYU_PYTHON:worker,ASR_MAX_SECONDS:'1',ASR_MAX_BYTES:'1024',ASR_DEADLINE_SECONDS:'2'}});let errors='';child.stderr.on('data',p=>errors+=p);const timer=setTimeout(()=>reject(Error(errors||'Server readiness timeout')),10000);child.on('message',m=>{if(m.origin){origin=m.origin;clearTimeout(timer);resolve()}});child.once('exit',()=>{clearTimeout(timer);reject(Error(errors))})});

// Discover once for this synthetic store; retain the captured scope across restarts.
const identityResponse=await fetch(origin+'/api/local-asr/identity');
assert.equal(identityResponse.status,200);
const identityBody=await identityResponse.json();
assert.deepEqual(Object.keys(identityBody),['transcriptionStoreId']);
assert.equal(identityResponse.headers.get('x-transcription-store-id'),identityBody.transcriptionStoreId);
assert.match(identityBody.transcriptionStoreId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
scopeHeaders=Object.freeze({'X-Transcription-Store-Id':identityBody.transcriptionStoreId});
 db=new DatabaseSync(join(storage,'long-transcription.sqlite'));db.prepare('INSERT INTO transcription_jobs(id,filename,status,created,requested_language,original_upload_receipt) VALUES(?,?,?,?,?,?)').run(id,'synthetic.wav','failed','2026','zh',createUploadReceipt({sha256:hash,byteLength:80,mime:'audio/wav',format:'wav',language:'zh',maxSeconds:1,maxBytes:1024,deadlineSeconds:2}));
 const url=origin+`/api/local-asr/jobs/${id}/retry`,post=()=>fetch(url,{method:'POST',headers:{...scopeHeaders,'Content-Type':'audio/wav','X-Audio-Language':'zh','X-Audio-Filename':'synthetic.wav'},body:bytes});
 const before=await(await fetch(url,{headers:scopeHeaders})).json();assert.equal(before.state,'uncommitted');assert.equal(before.reconciliationFinal,false);
 const a=await post();assert.equal(a.status,202);const created=await a.json();assert.equal(created.parentId,id);
 const b=await post();assert.equal(b.status,200);const replay=await b.json();assert.equal(replay.id,created.id);assert.equal(replay.replayed,true);
 const r=await fetch(url,{headers:scopeHeaders});assert.equal(r.status,200);const state=await r.json();assert.equal(state.state,'created');assert.equal(state.child.id,created.id);assert.equal(state.reconciliationFinal,true);assert(!JSON.stringify([created,replay,state]).includes(hash));
 const denied=await fetch(url,{method:'POST',headers:{...scopeHeaders,Origin:'https://untrusted.example','Content-Type':'audio/wav','X-Audio-Language':'zh'},body:bytes});assert.equal(denied.status,403);
 assert.equal(db.prepare('SELECT count(*) n FROM transcription_retries WHERE parent_id=?').get(id).n,1);
 console.log('PASS production HTTP routing, browser-style content length, exact replay, read reconciliation, no digest DTO and origin rejection');
}finally{db?.close();if(child&&child.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM')});if(build)rmSync(join(build,'..'),{recursive:true,force:true});rmSync(root,{recursive:true,force:true})}
