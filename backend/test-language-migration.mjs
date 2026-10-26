
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
import {DatabaseSync} from 'node:sqlite';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';import {localTranscription} from './local-transcription.mjs';
const root=mkdtempSync(join(tmpdir(),'language-migration-'));
try{const db=new DatabaseSync(join(root,'long-transcription.sqlite'));db.exec("CREATE TABLE transcription_jobs(id TEXT PRIMARY KEY,filename TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL,result TEXT,error TEXT,progress TEXT); INSERT INTO transcription_jobs(id,filename,status,created,result) VALUES('legacy','old.wav','completed','2026-10-01','{\"language\":\"en\",\"text\":\"Saved text\"}')");db.close();let scopeHeaders;for(let i=0;i<2;i++){const service=localTranscription(root);if(i===0)scopeHeaders=await discoverScope(service);let body;await service.handle({url:'/api/local-asr/jobs',method:'GET',headers:scopeHeaders},(status,data)=>body=data,()=>assert.fail());assert.equal(body.jobs[0].requested_language,'en');assert.equal(body.jobs[0].result.text,'Saved text');assert.equal(body.model.defaultLanguage,'auto');service.close()}console.log('Legacy English migration and repeated initialization preserve saved text; new default is Auto')}finally{rmSync(root,{recursive:true,force:true})}
