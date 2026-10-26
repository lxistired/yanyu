// Direct handler tests; no server/network, real inference, or user data.
import {localTranscription} from './backend/local-transcription.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {Readable} from 'node:stream';import assert from 'node:assert/strict';
const root=mkdtempSync(join(import.meta.dirname,'owned-lifecycle-')),storage=join(root,'store');mkdirSync(storage);
const fake=join(root,'synthetic-worker');writeFileSync(fake,`#!/usr/bin/python3
import json,sys,time
from pathlib import Path
p=Path(sys.argv[2]).parent
print(json.dumps({'type':'result','text':'synthetic','segments':[]}),flush=True)
(p/'result-emitted').write_text('synthetic')
time.sleep(.4)
`,{mode:0o700});
process.env.YANYU_PYTHON=fake;process.env.ASR_MAX_SECONDS='1';let service,db,checks=0;
function start(){service=localTranscription(storage,{get(){return null},list(){return []}});db=new DatabaseSync(join(storage,'long-transcription.sqlite'));}
function stop(){service.close();db.close();}
function row(id){return db.prepare('SELECT * FROM transcription_jobs WHERE id=?').get(id)}
function fixture(status='interrupted',options={}){const id=randomUUID(),d=join(storage,'long-asr-temp',`job-${id}`);mkdirSync(d);const expiry=Date.now()+30000;writeFileSync(join(d,'pending.json'),JSON.stringify({id,format:'wav',language:'en',maximum:1,byteLimit:268435456,sourceHash:'synthetic',expiresAt:options.manifestExpiry??expiry}));writeFileSync(join(d,'input'),'owned synthetic');db.prepare('INSERT INTO transcription_jobs(id,filename,status,created,result,requested_language,pending_expires_at) VALUES(?,?,?,?,?,?,?)').run(id,'synthetic.wav',status,new Date().toISOString(),status==='completed'?'{"text":"immutable"}':null,'en',options.dbExpiry??expiry);return {id,d}}
async function call(url,body=null){let response;const req=Readable.from(body?[body]:[]);Object.assign(req,{url,method:'POST',headers:body?{'content-type':'audio/wav','content-length':String(body.length),'x-audio-filename':'synthetic.wav','x-audio-language':'en'}:{}});await service.handle(req,(status,value)=>response={status,value},(status,code,message)=>response={status,code,message});return response}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await sleep(20)}throw Error('timeout')}
function pass(name){checks++;console.log('PASS '+name)}
try{
 start();let f=fixture('completed');stop();start();assert(!existsSync(f.d));assert.equal(row(f.id).result,'{"text":"immutable"}');pass('Crash after final commit: startup removes leftover audio, preserves transcript');
 assert.equal((await call(`/api/local-asr/jobs/${f.id}/resume`)).status,409);assert.equal((await call(`/api/local-asr/jobs/${f.id}/cancel`)).value.status,'completed');assert.equal(row(f.id).result,'{"text":"immutable"}');pass('Completed resume/cancel protect immutable result');
 for(const [label,opts] of [['extended-manifest',{dbExpiry:Date.now()-1,manifestExpiry:Date.now()+30000}],['mismatched-future',{dbExpiry:Date.now()+10000,manifestExpiry:Date.now()+30000}],['matching-expired',{dbExpiry:1,manifestExpiry:1}]]){f=fixture('processing',opts);stop();start();assert.equal(row(f.id).status,'failed');assert(!existsSync(f.d));pass(label+' fails closed and removes owned pending data')}
 f=fixture('processing');stop();start();assert.equal(row(f.id).status,'interrupted');await sleep(50);assert.equal(row(f.id).status,'interrupted');pass('Restart never auto-resumes valid pending job');
 assert.equal((await call(`/api/local-asr/jobs/${f.id}/cancel`)).value.status,'cancelled');assert(!existsSync(f.d));assert.equal((await call(`/api/local-asr/jobs/${f.id}/resume`)).status,409);pass('Interrupted cancellation is durable and not resumable');
 let r=await call('/api/local-asr/transcribe',Buffer.alloc(80));assert.equal(r.status,202);let id=r.value.id,d=join(storage,'long-asr-temp',`job-${id}`);await until(()=>existsSync(join(d,'result-emitted')));await call(`/api/local-asr/jobs/${id}/cancel`);await until(()=>row(id).status!=='processing');assert.equal(row(id).status,'cancelled');assert.equal(row(id).result,null);assert(!existsSync(d));pass('Cancellation after result emission but before child close wins without transcript');
 r=await call('/api/local-asr/transcribe',Buffer.alloc(80));assert.equal(r.status,202);id=r.value.id;assert.equal((await call('/api/local-asr/transcribe',Buffer.alloc(80))).status,409);await until(()=>row(id).status==='completed');assert.equal(JSON.parse(row(id).result).text,'synthetic');assert(!existsSync(join(storage,'long-asr-temp',`job-${id}`)));pass('Single-process worker exclusivity and successful final commit cleanup');
 f=fixture();stop();process.env.ASR_PENDING_QUOTA_BYTES='44';start();assert.equal((await call(`/api/local-asr/jobs/${f.id}/resume`)).status,507);assert(existsSync(f.d));assert.equal(row(f.id).status,'interrupted');pass('Quota rejection retains valid resumable job');
 console.log(JSON.stringify({passed:checks,realInference:false,network:false}));
}finally{stop();await sleep(100);rmSync(root,{recursive:true,force:true})}
