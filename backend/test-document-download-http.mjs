// Production-server 127.0.0.1 HTTP with generated content and fresh synthetic SQLite.
// Uses the already-built local UI. No browser, device, credentials, AI or private provider.
import assert from 'node:assert/strict';
import {fork,spawnSync} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {researchDocuments} from './research-documents.mjs';
import {generatedPdf} from './synthetic-reader-pdf.mjs';

const here=import.meta.dirname,root=mkdtempSync(join(tmpdir(),'yanyu-download-http-'));
const primary=join(root,'primary'),other=join(root,'other');mkdirSync(primary);mkdirSync(other);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytes=Buffer.from('\ufeff合成原件 HTTP 😀 cafe\u0301\r\nLiteral <script>not executed</script>\r\n');
const checks=[],pids=[],origins=[];let child,origin,build,scope,doc;
async function start(storage){
 let stderr='';await new Promise((resolve,reject)=>{
  child=fork(join(here,'server.mjs'),[build,storage,join(root,'synthetic-events.jsonl'),'0'],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH}});pids.push(child.pid);
  child.stdout.resume();child.stderr.on('data',chunk=>stderr+=chunk);
  const timer=setTimeout(()=>reject(Error('Production server readiness timed out: '+stderr)),15000);
  child.once('message',message=>{clearTimeout(timer);origin=message.origin;assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);origins.push(origin);resolve()});
  child.once('error',error=>{clearTimeout(timer);reject(error)});child.once('exit',code=>{clearTimeout(timer);reject(Error('Production server exited '+code+': '+stderr))});
 });
}
async function stop(){if(child&&child.exitCode===null){const current=child;await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>{current.kill('SIGKILL');reject(Error('Synthetic server failed to stop gracefully'))},15000);
 current.once('exit',()=>{clearTimeout(timer);resolve()});current.kill('SIGTERM');
})}}
async function call(method,path,data,headers={}){
 const response=await fetch(origin+path,{method,headers:{...(data===undefined?{}:{'Content-Type':Buffer.isBuffer(data)?'application/octet-stream':'application/json'}),...headers},...(data===undefined?{}:{body:Buffer.isBuffer(data)?data:JSON.stringify(data)}),signal:AbortSignal.timeout(10000)});
 return {status:response.status,headers:response.headers,bytes:Buffer.from(await response.arrayBuffer())};
}
async function json(method,path,data,status=200,headers={}){const result=await call(method,path,data,headers);assert.equal(result.status,status,result.bytes.toString());return JSON.parse(result.bytes.toString())}
function raw(path,headers={}){return new Promise((resolve,reject)=>{
 const req=httpRequest(origin+path,{method:'GET',headers},response=>{const parts=[];response.on('data',part=>parts.push(part));response.on('error',reject);response.on('end',()=>resolve({status:response.statusCode,headers:new Headers(response.headers),bytes:Buffer.concat(parts)}))});
 req.setTimeout(10000,()=>req.destroy(Error('Synthetic HTTP request timed out')));req.on('error',reject);req.end();
})}
const downloadPath=()=>`/api/documents/${doc.id}/download`;
const download=(headers={})=>call('GET',downloadPath(),undefined,{'X-Document-Store-Id':scope,...headers});
const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name)};
function rejection(result,status){assert.equal(result.status,status,result.bytes.toString());const body=JSON.parse(result.bytes.toString());assert.deepEqual(Object.keys(body),['error']);assert.equal(result.headers.get('x-document-store-id'),null);assert.equal(result.headers.get('x-document-sha256'),null);assert.equal(result.headers.get('content-disposition'),null);for(const secret of [bytes.toString(),scope,doc.id])assert(!result.bytes.toString().includes(secret))}
function original(result,expected=bytes,expectedScope=scope,id=doc.id,format='txt'){
 assert.equal(result.status,200,result.bytes.toString());assert.equal(result.headers.get('content-type'),'application/octet-stream');assert.equal(result.headers.get('content-disposition'),`attachment; filename="${id}.${format}"`);
 assert.equal(result.headers.get('x-document-store-id'),expectedScope);assert.equal(result.headers.get('x-document-sha256'),hash(expected));assert.equal(result.headers.get('content-length'),String(expected.length));
 assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(result.headers.get('x-content-type-options'),'nosniff');assert.equal(result.headers.get('content-security-policy'),"default-src 'none'; sandbox");assert.deepEqual(result.bytes,expected);
}
function database(storage,fn){const db=new DatabaseSync(join(storage,'research-documents.sqlite'));try{return fn(db)}finally{db.close()}}
try{
 const frontier=join(here,'BACKEND_FRONTIER.json'),before=existsSync(frontier)?readFileSync(frontier):null;
 const prep=spawnSync(process.execPath,[join(here,'prepare-backend.mjs')],{encoding:'utf8',timeout:30000});assert.equal(prep.status,0,prep.stderr);build=prep.stdout.trim();if(before)assert.deepEqual(readFileSync(frontier),before,'Preparation must retain the existing source frontier');
 await start(primary);
 await check('real production server serves the built UI and exposes one existing durable document scope',async()=>{
  assert.equal((await call('GET','/?page=documents')).status,200);await json('GET','/api/private-demo/companies',undefined,404);
  const list=await json('GET','/api/documents'),choices=await json('GET','/api/documents/choices');scope=list.storeScope;assert.equal(scope,choices.uploadScope);assert.match(scope,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(database(primary,db=>db.prepare('SELECT scope FROM document_upload_identity WHERE singleton=1').get().scope),scope);
  for(const id of ['download-source','download-destination'])await json('POST','/api/workspace/create',{kind:'workspace',id,data:{name:'Synthetic '+id},idempotencyKey:randomUUID()});
  doc=(await json('POST','/api/documents/upload?name=synthetic.txt&workspaceId=download-source',bytes,201,{'X-Upload-Store-Id':scope})).document;
 });
 await check('exact Unicode BOM CRLF original bytes are bound to response scope SHA-256 and Content-Length',async()=>{
  original(await download());const list=await json('GET','/api/documents',undefined,200,{'X-Document-Store-Id':scope});assert.equal(list.storeScope,scope);assert.deepEqual(list.documents,[doc]);
 });
 await check('Markdown and generated PDF preserve their exact original bytes and immutable format',async()=>{
  for(const [name,content,format] of [['synthetic.md',Buffer.from('# Synthetic Markdown\n'+bytes),'md'],['synthetic.pdf',generatedPdf(2),'pdf']]){
   const record=(await json('POST','/api/documents/upload?'+new URLSearchParams({name}),content,201,{'X-Upload-Store-Id':scope})).document;
   original(await call('GET',`/api/documents/${record.id}/download`,undefined,{'X-Document-Store-Id':scope}),content,scope,record.id,format);
  }
 });
 await check('missing malformed combined and raw duplicate download scope headers reject without original metadata',async()=>{
  rejection(await call('GET',downloadPath()),400);
  for(const value of ['', 'not-a-uuid',scope.toUpperCase(),scope+', '+scope])rejection(await raw(downloadPath(),{'X-Document-Store-Id':value}),400);
  for(const path of ['/api/documents',downloadPath()]){
   rejection(await raw(path,{'X-Document-Store-Id':[scope,scope]}),400);
   rejection(await raw(path,{'X-Document-Store-Id':[scope,randomUUID()]}),400);
  }
 });
 await check('wrong valid scope fails existing unknown and filtered-list requests while unpinned lists remain compatible',async()=>{
  const wrong=randomUUID();for(const path of [downloadPath(),`/api/documents/${randomUUID()}/download`,'/api/documents?workspaceId=download-source'])rejection(await raw(path,{'X-Document-Store-Id':wrong}),409);
  rejection(await raw(`/api/documents/${randomUUID()}/download`),400);
  assert.equal((await json('GET','/api/documents')).storeScope,scope);
  assert.equal((await json('GET',`/api/documents/${doc.id}`)).text,bytes.toString());
 });
 await check('Host Origin and cross-site guards still reject pinned downloads and lists',async()=>{
  for(const path of [downloadPath(),'/api/documents'])for(const headers of [{Host:'foreign.invalid'},{Origin:'https://invalid.example'},{'Sec-Fetch-Site':'cross-site'}])rejection(await raw(path,{'X-Document-Store-Id':scope,...headers}),403);
  original(await download({Origin:origin,'Sec-Fetch-Site':'same-origin'}));
 });
 await check('metadata rename and workspace move leave original content binding valid over real HTTP',async()=>{
  doc=(await json('PUT',`/api/documents/${doc.id}/metadata`,{name:'../synthetic display.pdf',workspaceId:'download-destination',folderId:null,revision:doc.revision})).document;
  assert.equal(doc.revision,1);assert.equal(doc.format,'txt');assert.equal(doc.sha256,hash(bytes));original(await download());
 });
 await check('trash rejects original download and restore returns the same bound bytes',async()=>{
  doc=(await json('PUT',`/api/documents/${doc.id}/trash`,{revision:doc.revision})).document;rejection(await download(),404);
  doc=(await json('PUT',`/api/documents/${doc.id}/restore`,{revision:doc.revision})).document;original(await download());
 });
 await check('same-length byte corruption and wrong original length fail before sending attachment headers',async()=>{
  const corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]^=1;
  database(primary,db=>db.exec('DROP TRIGGER document_immutable_update'));
  try{for(const value of [corrupt,Buffer.concat([bytes,Buffer.from('extra')])]){database(primary,db=>db.prepare('UPDATE research_documents SET original=? WHERE id=?').run(value,doc.id));rejection(await download(),409)}}
  finally{database(primary,db=>db.prepare('UPDATE research_documents SET original=? WHERE id=?').run(bytes,doc.id))}
  original(await download());
 });
 await stop();
 await check('a separate store with identical document UUID bytes and hash refuses the previous store scope',async()=>{
  const source=database(primary,db=>db.prepare('SELECT * FROM research_documents WHERE id=?').get(doc.id));
  const setup=researchDocuments(other,{get(){throw Object.assign(Error('Synthetic missing workspace'),{code:'NOT_FOUND'})},list(){return []}});setup.close();
  database(other,db=>db.prepare(`INSERT INTO research_documents(${Object.keys(source).join(',')}) VALUES(${Object.keys(source).map(()=>'?').join(',')})`).run(...Object.values(source)));
  await start(other);const otherScope=(await json('GET','/api/documents')).storeScope;assert.notEqual(otherScope,scope);
  rejection(await download(),409);rejection(await raw('/api/documents',{'X-Document-Store-Id':scope}),409);
  original(await download({'X-Document-Store-Id':otherScope}),bytes,otherScope);await stop();
 });
 await start(primary);
 await check('returning to the original SQLite store in another process retains scope bytes and metadata revisions',async()=>{
  assert.equal(new Set(pids).size,3);assert.equal((await json('GET','/api/documents')).storeScope,scope);original(await download());
  const detail=await json('GET',`/api/documents/${doc.id}`);assert.deepEqual(detail.document,doc);assert.equal(detail.text,bytes.toString());
  database(primary,db=>assert.throws(()=>db.prepare('UPDATE research_documents SET original=? WHERE id=?').run(Buffer.from('blocked'),doc.id),/Immutable document content/));
 });
 console.log(JSON.stringify({passed:true,count:checks.length,checks,runtime:process.version,pids,origins,storage:root,transport:'Real production server bound to 127.0.0.1; three processes and two fresh SQLite stores',fixtures:'Generated UTF-8 TXT/Markdown and PDF only',limitations:['No browser or device test','No AI, credentials, original reverse-engineering materials or private provider']}));
}finally{await stop()}
