// Generated fixtures, in-process requests and disposable SQLite stores only.
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {researchDocuments} from './research-documents.mjs';
import {validatePng} from './pdf-page-reader.mjs';
import {generatedPdf} from './synthetic-reader-pdf.mjs';
const roots=[0,1].map(()=>mkdtempSync(join(tmpdir(),'synthetic-pdf-scope-')));
const apps=roots.map(root=>researchDocuments(root,{get:()=>null,list:()=>[]}));
const id=randomUUID(),hash=b=>createHash('sha256').update(b).digest('hex'),original=generatedPdf(2),sha256=hash(original);
for(const root of roots){const db=new DatabaseSync(join(root,'research-documents.sqlite'));db.prepare('INSERT INTO research_documents(id,name,format,bytes,sha256,text_sha256,created,pages,original,text,search_value,text_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'synthetic.pdf','pdf',original.length,sha256,hash('synthetic'),'2026-10-21T00:00:00Z',2,original,'synthetic','synthetic',9);db.close();}
async function request(app,path,method='GET',scope,data,rawHeaders){
 let consumed=false,output,images=0;const req=Readable.from((async function*(){consumed=true;yield Buffer.from(JSON.stringify(data??{}));})());
 Object.assign(req,{url:path,method,headers:{'content-type':'application/json',...(scope===undefined?{}:{'x-document-store-id':scope})},rawHeaders});
 await app.handle(req,(status,body)=>output={status,body},(status,code,message)=>output={status,body:{error:{code,message}}},()=>assert.fail('No downloads'),bytes=>{images++;output={status:200,bytes};});
 return {...output,consumed,images};
}
const base=`/api/documents/${id}`,checks=[];
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
function snapshot(root){const db=new DatabaseSync(join(root,'research-documents.sqlite'));try{return {documents:db.prepare('SELECT * FROM research_documents ORDER BY id').all(),reader:db.prepare('SELECT * FROM document_reader_state ORDER BY document_id').all(),annotations:db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE '%annotation%' ORDER BY name").all().map(table=>({name:table.name,rows:db.prepare('SELECT * FROM '+table.name).all()}))};}finally{db.close();}}
async function rejected(app,path,method,scope,data,status=409,rawHeaders){
 const before=roots.map(snapshot);
 const prepare=DatabaseSync.prototype.prepare,queries=[];DatabaseSync.prototype.prepare=function(sql,...args){queries.push(sql);return prepare.call(this,sql,...args)};
 let result;try{result=await request(app,path,method,scope,data,rawHeaders);}finally{DatabaseSync.prototype.prepare=prepare;}
 assert.equal(result.status,status,JSON.stringify(result));assert.equal(result.consumed,false);assert.equal(result.images,0);assert.deepEqual(queries,[]);
 if(status===409)assert.equal(result.body.error.code,'DOCUMENT_STORE_MISMATCH');
 assert.deepEqual(roots.map(snapshot),before);
}
try{
 const scopes=await Promise.all(apps.map(async app=>(await request(app,'/api/documents')).body.storeScope));assert.notEqual(scopes[0],scopes[1]);
 const before=roots.map(snapshot);
 const position={page:2,bookmark:1,scale:100},note={sha256,revision:0,page:1,rect:null,comment:'synthetic note'};
 await check('identical document identities in distinct stores reject reader and annotation requests before SQL/body',async()=>{
  for(const [path,method,data] of [[base+'/reader','GET'],[base+'/reader','PUT',position],[base+'/annotations','GET'],[base+'/annotations','POST',note],[base+'/annotations/'+randomUUID(),'PUT',note]])await rejected(apps[1],path,method,scopes[0],data);
 });
 await check('malformed and repeated scope headers are rejected before lookup',async()=>{
  for(const path of [base+'/reader',base+'/annotations',base+'/page?page=1&scale=100']){
   for(const scope of ['',null,[],[scopes[0]],scopes[0].toUpperCase(),scopes[0]+', '+scopes[0],' '+scopes[0]])await rejected(apps[0],path,'GET',scope,undefined,400);
   await rejected(apps[0],path,'GET',scopes[0],undefined,400,['X-Document-Store-Id',scopes[0],'x-document-store-id',scopes[0]]);
  }
 });
 await check('page query is canonical, unique and independent of header; wrong pins cannot rasterize',async()=>{
  await rejected(apps[1],base+'/page?page=1&scale=100&storeScope='+scopes[0],'GET');
  for(const query of ['',scopes[0].toUpperCase(),'not-a-uuid',scopes[0]+'&storeScope='+scopes[0]])await rejected(apps[0],base+'/page?page=1&scale=100&storeScope='+query,'GET',undefined,undefined,400);
  await rejected(apps[0],base+'/page?page=1&scale=100&storeScope='+scopes[0],'GET',scopes[1]);
  await rejected(apps[0],base+'/page?page=1&scale=100&storeScope='+scopes[1],'GET',scopes[0]);
  for(const root of roots)assert.deepEqual(readdirSync(join(root,'pdf-page-cache')),[]);
 });
 await check('all rejected operations preserve both stores original bytes/text and state/revisions',async()=>{assert.deepEqual(roots.map(snapshot),before);});
 await check('correct scoped page query renders generated PDF without changing original or sidecar state',async()=>{const result=await request(apps[0],base+'/page?page=1&scale=100&storeScope='+scopes[0],'GET',scopes[0]);assert.equal(result.status,200);assert.equal(result.images,1);validatePng(result.bytes,1200);assert.deepEqual(roots.map(snapshot),before);});
 await check('scoped success carries scope and distinct stores retain independent state/revisions',async()=>{
  let result=await request(apps[0],base+'/reader','PUT',scopes[0],position);assert.equal(result.status,200);assert.equal(result.body.storeScope,scopes[0]);assert.equal(result.body.page,2);
  result=await request(apps[1],base+'/reader','GET',scopes[1]);assert.equal(result.body.page,1);assert.equal(result.body.storeScope,scopes[1]);
  result=await request(apps[0],base+'/annotations','POST',scopes[0],note);assert.equal(result.status,201);assert.equal(result.body.storeScope,scopes[0]);assert.equal(result.body.revision,1);
  result=await request(apps[1],base+'/annotations','GET',scopes[1]);assert.equal(result.body.revision,0);assert.deepEqual(result.body.notes,[]);assert.equal(result.body.storeScope,scopes[1]);
 });
 await check('ordinary stale annotation revision remains CONFLICT rather than scope mismatch',async()=>{const result=await request(apps[0],base+'/annotations','POST',scopes[0],note);assert.equal(result.status,409);assert.equal(result.body.error.code,'CONFLICT');});
 await check('legacy headerless reader and sidecar callers remain explicitly unbound',async()=>{for(const app of apps)for(const suffix of ['/reader','/annotations'])assert.equal((await request(app,base+suffix)).status,200);});
 assert.deepEqual(roots.map(snapshot).map(x=>x.documents),before.map(x=>x.documents));
 console.log(JSON.stringify({passed:true,checks,runtime:process.version,transport:'in-process; no listeners',fixtures:'two generated identical PDF identities, distinct SQLite stores'}));
}finally{for(const app of apps)app.close();}
