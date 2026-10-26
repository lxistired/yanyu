// Synthetic bytes and disposable SQLite only. No worker, listener or media device.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {randomUUID,createHash} from 'node:crypto';
import {initializeTranscriptionOrigin,parseUploadOrigin,publicUploadOrigin} from '../backend/transcription-origin.mjs';
import {initializeUploadReceipts,createUploadReceipt,uploadReceiptAvailable} from '../backend/upload-receipts.mjs';
import {failedTranscriptionRetry} from '../backend/failed-transcription-retry.mjs';
test('closed header vocabulary, omission and duplicate rejection',()=>{
 assert.equal(parseUploadOrigin({}),'unknown');
 for(const origin of ['file-selection','recording-draft']) assert.equal(parseUploadOrigin({'x-audio-origin':origin}),origin);
 for(const origin of ['unknown','','file-selection, recording-draft','File-selection',' file-selection',[],null,1,'10','__proto__'])assert.equal(parseUploadOrigin({'x-audio-origin':origin}),null);
 assert.equal(parseUploadOrigin({'x-audio-origin':'file-selection'},['X-Audio-Origin','file-selection','x-audio-origin','file-selection']),null);
 for(const raw of [null,undefined,'10','__proto__'])assert.deepEqual(publicUploadOrigin(raw),{uploadOrigin:'unknown',uploadOriginAssurance:'unknown'});
 assert.deepEqual(publicUploadOrigin('recording-draft'),{uploadOrigin:'recording-draft',uploadOriginAssurance:'client-declared'});
});
function database(path=':memory:') {const db=new DatabaseSync(path);db.exec('CREATE TABLE transcription_jobs(id TEXT PRIMARY KEY, filename TEXT, status TEXT, created TEXT, requested_language TEXT, pending_expires_at INTEGER, deleted_at TEXT)');return db}
test('additive idempotent legacy migration and immutable declaration, independent of strict receipts',()=>{
 const db=database();try{db.prepare('INSERT INTO transcription_jobs(id,filename) VALUES(?,?)').run('legacy','recording.wav');initializeTranscriptionOrigin(db);initializeTranscriptionOrigin(db);initializeUploadReceipts(db);
 assert.equal(db.prepare('SELECT original_upload_origin FROM transcription_jobs').get().original_upload_origin,'unknown');
 for(const value of ['file-selection','recording-draft',null])assert.throws(()=>db.prepare('UPDATE transcription_jobs SET original_upload_origin=?').run(value));
 db.exec("UPDATE transcription_jobs SET original_upload_origin='unknown',filename='new.mp3',status='completed'");
 for(const origin of ['file-selection','recording-draft']){db.prepare('INSERT INTO transcription_jobs(id,original_upload_origin) VALUES(?,?)').run(origin,origin);for(const value of ['unknown',null,origin==='file-selection'?'recording-draft':'file-selection'])assert.throws(()=>db.prepare('UPDATE transcription_jobs SET original_upload_origin=? WHERE id=?').run(value,origin));}
 assert.throws(()=>db.prepare('INSERT INTO transcription_jobs(id,original_upload_origin) VALUES(?,?)').run('bad','10'));
 }finally{db.close()}
});
test('synthetic retry inherits first declaration, concurrent replay and reconciliation cannot replace it',async()=>{
 const root=mkdtempSync(join(tmpdir(),'origin-only-'));const db=database(join(root,'long-transcription.sqlite'));const tmp=join(root,'temp');mkdirSync(tmp);initializeUploadReceipts(db);initializeTranscriptionOrigin(db);
 const bytes=Buffer.alloc(80,7),receipt=createUploadReceipt({sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:80,mime:'audio/wav',format:'wav',language:'auto',maxSeconds:1,maxBytes:1024,deadlineSeconds:2});let starts=0;
 const handle=failedTranscriptionRetry({db,tmp,storage:root,maxSeconds:1,maxBytes:1024,deadlineSeconds:2,retentionSeconds:60,pendingQuota:1e9,pendingBytes:()=>0,getActive:()=>null,start:()=>{starts++;return true}});
 const seed=origin=>{const id=randomUUID();db.prepare('INSERT INTO transcription_jobs(id,filename,status,requested_language,original_upload_receipt,original_upload_origin) VALUES(?,?,?,?,?,?)').run(id,'same.wav','failed','auto',receipt,origin);return id};
 const call=async(id,parts=[bytes],method='POST')=>{const req=Object.assign(Readable.from(parts),{url:`/api/local-asr/jobs/${id}/retry`,method,headers:{'content-type':'audio/wav','content-length':'80','x-audio-language':'auto','x-audio-origin':'file-selection'}});let answer;await handle(req,(status,body)=>answer={status,body},(status,code)=>answer={status,code});return answer};
 const row=id=>db.prepare('SELECT * FROM transcription_jobs WHERE id=?').get(id);
 try{
 for(const origin of ['unknown','file-selection','recording-draft']){
 const id=seed(origin);let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 const slow=call(id,(async function*(){yield bytes.subarray(0,20);entered();await gate;yield bytes.subarray(20)})());await ready;
 assert.throws(()=>db.prepare('UPDATE transcription_jobs SET original_upload_origin=? WHERE id=?').run(origin==='recording-draft'?'file-selection':'recording-draft',id));
 const fast=await call(id);release();const replay=await slow;assert.equal(fast.status,202);assert.equal(replay.status,200);assert.equal(replay.body.id,fast.body.id);assert.equal(row(fast.body.id).original_upload_origin,origin);assert.equal(row(id).original_upload_origin,origin);assert.equal(uploadReceiptAvailable(row(fast.body.id).original_upload_receipt,'auto'),true);assert.equal(row(fast.body.id).original_upload_receipt,receipt);
 const before=row(fast.body.id);assert.equal((await call(id,[],'GET')).body.child.id,fast.body.id);assert.deepEqual(row(fast.body.id),before);
 }
 assert.equal(starts,3);
 }finally{db.close();rmSync(root,{recursive:true,force:true})}
});
