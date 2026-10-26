
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
// Owner exclusion only. SIGKILL test has NO worker and does not prove orphan fencing.
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,mkdirSync,symlinkSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {localTranscription} from './local-transcription.mjs';
if(process.argv[2]==='owner-child'){
 const s=localTranscription(process.argv[3]);process.send({ready:true});process.on('message',async()=>{await s.close();process.exit(0)});
}else{
 const root=mkdtempSync(join(tmpdir(),'transcription-owner-')),storage=join(root,'store'),alias=join(root,'alias');mkdirSync(storage);symlinkSync(storage,alias);let child,service;const saved={...process.env};
 try{
  service=localTranscription(storage);assert.throws(()=>localTranscription(alias),/already owned/);await service.close();await service.close();service=null;
  process.env.ASR_MAX_BYTES='bad';assert.throws(()=>localTranscription(storage),/initialization unavailable/);delete process.env.ASR_MAX_BYTES;service=localTranscription(storage);await service.close();service=null;console.log('PASS canonical alias exclusion, idempotent close and failed initialization release');
  const launch=()=>new Promise((resolve,reject)=>{child=fork(import.meta.filename,['owner-child',storage],{stdio:['ignore','ignore','inherit','ipc']});child.once('message',resolve);child.once('error',reject)});
  await launch();assert.throws(()=>localTranscription(alias),/already owned/);await new Promise(resolve=>{child.once('exit',resolve);child.send({close:true})});service=localTranscription(storage);await service.close();service=null;console.log('PASS real process exclusive owner and graceful release');
  await launch();await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGKILL')});service=localTranscription(storage);await service.close();service=null;console.log('PASS Inherited flock auto-release after owner SIGKILL without worker; NOT worker crash fencing');
  const worker=join(root,'fake-worker');writeFileSync(worker,'#!/bin/sh\nsleep 10\n',{mode:0o700});Object.assign(process.env,{YANYU_PYTHON:worker,ASR_MAX_SECONDS:'1',ASR_MAX_BYTES:'1024',ASR_DEADLINE_SECONDS:'20'});service=localTranscription(storage);
  const scopeHeaders=await discoverScope(service);
  const req=Object.assign(Readable.from([Buffer.alloc(80)]),{url:'/api/local-asr/transcribe',method:'POST',headers:{...scopeHeaders,'content-type':'audio/wav','content-length':'80','x-audio-filename':'fake.wav'}});let response;await service.handle(req,(status,body)=>response={status,body},()=>assert.fail('upload failed'));assert.equal(response.status,202);
  const closing=service.close();assert.throws(()=>localTranscription(storage),/already owned/);await closing;service=localTranscription(storage);await service.close();service=null;console.log('PASS graceful close retains exclusive owner until fake detached worker exits');
  console.log('PASS permanent flock inode remains reusable; inherited-worker crash coverage is in test-worker-fence.mjs');
 }finally{if(service)await service.close();if(child?.exitCode===null)child.kill('SIGKILL');for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);rmSync(root,{recursive:true,force:true})}
}
