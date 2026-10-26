// Generated UTF-8 fixtures and disposable SQLite stores only. No device or remote service.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {researchDocuments} from './research-documents.mjs';

const root=mkdtempSync(join(tmpdir(),'yanyu-document-download-'));
const otherRoot=mkdtempSync(join(tmpdir(),'yanyu-document-download-other-'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytes=Buffer.from('\ufeff合成原件 😀 cafe\u0301\r\nLiteral <script>not executed</script>\r\n');
const checks=[],denied=new Set(),missing=new Set(),accesses=[];
const workspace={get(_kind,id){accesses.push(id);if(denied.has(id))throw Object.assign(Error('Synthetic workspace denied'),{code:'FORBIDDEN'});if(missing.has(id))throw Object.assign(Error('Synthetic workspace missing'),{code:'NOT_FOUND'});return {id,data:{name:'Synthetic '+id}}},list(){return []}};
let app=researchDocuments(root,workspace),otherApp=researchDocuments(otherRoot,workspace),doc,scope;
async function request(method,url,data,options={}){
 const req=Readable.from([Buffer.isBuffer(data)?data:Buffer.from(data===undefined?'':JSON.stringify(data))]);
 Object.assign(req,{method,url,headers:{'content-type':Buffer.isBuffer(data)?'application/octet-stream':'application/json',...options.headers},...(options.rawHeaders?{rawHeaders:options.rawHeaders}:{})});
 let result,calls=0;const record=value=>{calls++;result=value};
 const handled=await (options.app??app).handle(req,(status,body)=>record({status,body}),(status,code,message)=>record({status,body:{error:{code,message}}}),options.legacyCallback?(filename,content,sha256)=>record({status:200,filename,bytes:content,sha256}):(filename,content,sha256,storeScope)=>record({status:200,filename,bytes:content,sha256,storeScope}));
 assert.equal(handled,true);assert.equal(calls,1,'Each request completes exactly once');
 if(options.status!==undefined)assert.equal(result.status,options.status,JSON.stringify(result));
 return result;
}
const get=(url,options={})=>request('GET',url,undefined,options);
const download=(options={})=>get(`/api/documents/${doc.id}/download`,{headers:{'x-document-store-id':scope},...options});
const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name)};
function database(store,fn){const db=new DatabaseSync(join(store,'research-documents.sqlite'));try{return fn(db)}finally{db.close()}}
async function observed(fn){const original=DatabaseSync.prototype.prepare,queries=[];DatabaseSync.prototype.prepare=function(sql,...args){queries.push(sql);return original.call(this,sql,...args)};try{return {result:await fn(),queries}}finally{DatabaseSync.prototype.prepare=original}}
function noOriginal(queries){assert(!queries.some(sql=>/SELECT\s+(?:\*|original\b)/i.test(sql)&&/research_documents/i.test(sql)),JSON.stringify(queries))}
function rejected(result,status){assert.equal(result.status,status);assert.deepEqual(Object.keys(result.body),['error']);assert.equal(result.bytes,undefined);for(const secret of [bytes.toString(),scope,doc.id])assert(!JSON.stringify(result.body).includes(secret))}
try{
 doc=(await request('POST','/api/documents/upload?name=synthetic.txt&workspaceId=source',bytes,{status:201})).body.document;
 await check('document list exposes the existing durable SQLite upload scope and preserves old fields',async()=>{
  const choices=(await get('/api/documents/choices',{status:200})).body;
  const list=(await get('/api/documents',{status:200})).body;scope=list.storeScope;
  assert.match(scope,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);assert.equal(scope,choices.uploadScope);
  assert.equal(scope,database(root,db=>db.prepare('SELECT scope FROM document_upload_identity WHERE singleton=1').get().scope));
  assert.deepEqual(list,{storeScope:scope,documents:[doc],total:1,offset:0,limit:10});
  assert.deepEqual((await get('/api/documents',{status:200,headers:{'x-document-store-id':scope}})).body,list);
  assert.equal((await get(`/api/documents/${doc.id}`,{status:200})).body.text,bytes.toString());
 });
 await check('missing download scope fails before document lookup or original byte read',async()=>{
  for(const path of [`/api/documents/${doc.id}/download`,`/api/documents/${randomUUID()}/download`]){
   const {result,queries}=await observed(()=>get(path));rejected(result,400);assert.equal(queries.length,0);
  }
 });
 await check('malformed arrays combined values and duplicate raw scope headers reject before lookup',async()=>{
  for(const path of ['/api/documents',`/api/documents/${doc.id}/download`]){
   for(const value of ['',null,42,[scope],[scope,scope],'not-a-uuid',scope.toUpperCase(),scope+'\n',' '+scope,scope+', '+scope]){
    const {result,queries}=await observed(()=>get(path,{headers:{'x-document-store-id':value}}));rejected(result,400);assert.equal(queries.length,0);
   }
   const {result,queries}=await observed(()=>get(path,{headers:{'x-document-store-id':scope},rawHeaders:['X-Document-Store-Id',scope,'x-document-store-id',scope]}));rejected(result,400);assert.equal(queries.length,0);
  }
 });
 await check('wrong valid store UUID rejects lists existing IDs and unknown IDs before lookup',async()=>{
  for(const path of ['/api/documents',`/api/documents/${doc.id}/download`,`/api/documents/${randomUUID()}/download`]){
   const {result,queries}=await observed(()=>get(path,{headers:{'x-document-store-id':randomUUID()}}));rejected(result,409);assert.equal(queries.length,0);
  }
 });
 await check('successful download carries exact bytes hash stable scope and safe immutable filename',async()=>{
  const result=await download({status:200});assert.deepEqual(result,{status:200,filename:doc.id+'.txt',bytes,sha256:hash(bytes),storeScope:scope});
  const legacy=await download({status:200,legacyCallback:true});assert.deepEqual(legacy,{status:200,filename:doc.id+'.txt',bytes,sha256:hash(bytes)});
 });
 await check('current workspace denial blocks original reads even with the correct store scope',async()=>{
  denied.add('source');const {result,queries}=await observed(()=>download());rejected(result,403);noOriginal(queries);denied.clear();
  const rejectedList=await get('/api/documents',{headers:{'x-document-store-id':randomUUID()}});rejected(rejectedList,409);
 });
 await check('rename and workspace move preserve immutable identity and use the current workspace',async()=>{
  doc=(await request('PUT',`/api/documents/${doc.id}/metadata`,{name:'../synthetic renamed.pdf',workspaceId:'destination',folderId:null,revision:doc.revision},{status:200})).body.document;
  assert.equal(doc.revision,1);denied.add('source');accesses.length=0;
  const result=await download({status:200});assert.deepEqual(result.bytes,bytes);assert.equal(result.sha256,hash(bytes));assert.equal(result.filename,doc.id+'.txt');assert.deepEqual(accesses,['destination']);
  denied.add('destination');const blocked=await observed(()=>download());rejected(blocked.result,403);noOriginal(blocked.queries);denied.clear();
  missing.add('destination');assert.deepEqual((await download({status:200})).bytes,bytes);missing.clear();
 });
 await check('trash blocks original reads and restore retains the same content and scope',async()=>{
  doc=(await request('PUT',`/api/documents/${doc.id}/trash`,{revision:doc.revision},{status:200})).body.document;
  const {result,queries}=await observed(()=>download());rejected(result,404);noOriginal(queries);
  doc=(await request('PUT',`/api/documents/${doc.id}/restore`,{revision:doc.revision},{status:200})).body.document;
  assert.deepEqual((await download({status:200})).bytes,bytes);
 });
 await check('another SQLite store rejects the old scope even for the identical UUID bytes and hash',async()=>{
  const source=database(root,db=>db.prepare('SELECT * FROM research_documents WHERE id=?').get(doc.id));
  database(otherRoot,db=>db.prepare(`INSERT INTO research_documents(${Object.keys(source).join(',')}) VALUES(${Object.keys(source).map(()=>'?').join(',')})`).run(...Object.values(source)));
  const otherScope=(await get('/api/documents',{app:otherApp,status:200})).body.storeScope;assert.notEqual(otherScope,scope);
  const {result,queries}=await observed(()=>download({app:otherApp}));rejected(result,409);assert.equal(queries.length,0);
  const other=await download({app:otherApp,headers:{'x-document-store-id':otherScope},status:200});assert.deepEqual(other.bytes,bytes);assert.equal(other.storeScope,otherScope);
 });
 await check('original length and same-length content corruption both fail the independent byte integrity check',async()=>{
  const sameLength=Buffer.from(bytes);sameLength[sameLength.length-1]^=1;
  for(const corrupt of [Buffer.concat([bytes,Buffer.from('extra')]),sameLength]){
   database(root,db=>{db.exec('DROP TRIGGER document_immutable_update');db.prepare('UPDATE research_documents SET original=? WHERE id=?').run(corrupt,doc.id)});
   rejected(await download(),409);
   database(root,db=>db.prepare('UPDATE research_documents SET original=? WHERE id=?').run(bytes,doc.id));
   app.close();app=researchDocuments(root,workspace);
  }
  assert.deepEqual((await download({status:200})).bytes,bytes);
 });
 await check('close and reopen retains store scope and original identity through metadata-only revisions',async()=>{
  app.close();app=researchDocuments(root,workspace);
  assert.equal((await get('/api/documents',{status:200})).body.storeScope,scope);
  assert.deepEqual((await download({status:200})).bytes,bytes);
  database(root,db=>assert.throws(()=>db.prepare('UPDATE research_documents SET original=? WHERE id=?').run(Buffer.from('blocked'),doc.id),/Immutable document content/));
 });
 console.log(JSON.stringify({passed:true,count:checks.length,checks,runtime:process.version,fixtures:'Generated UTF-8 bytes and two disposable real SQLite stores only'}));
}finally{app.close();otherApp.close()}
