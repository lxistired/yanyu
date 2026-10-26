// Real loopback HTTP and separate backend processes; generated UTF-8 fixtures only.
import assert from 'node:assert/strict';
import {fork,spawnSync} from 'node:child_process';
import {request} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
const here=import.meta.dirname,prep=spawnSync(process.execPath,[join(here,'prepare-backend.mjs')],{encoding:'utf8'});
assert.equal(prep.status,0,prep.stderr);
const root=mkdtempSync(join(tmpdir(),'yanyu-citations-http-')),storage=join(root,'synthetic-store');mkdirSync(storage);
const checks=[],pids=[];let child,origin,failure;
const hash=s=>createHash('sha256').update(s).digest('hex');
async function start(){
 let stderr='';await new Promise((resolve,reject)=>{
  child=fork(join(here,'server.mjs'),[prep.stdout.trim(),storage,join(root,'synthetic-events.jsonl'),'0'],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH}});
  pids.push(child.pid);child.stderr.on('data',data=>stderr+=data);
  const timer=setTimeout(()=>reject(Error('Server readiness timed out: '+stderr)),15000);
  child.once('message',message=>{clearTimeout(timer);origin=message.origin;resolve();});
  child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(Error(stderr));});
 });
}
async function stop(){if(child&&child.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});}
async function req(method,path,data,status=200,headers={}){
 const response=await fetch(origin+path,{method,headers:{...(data===undefined?{}:{'Content-Type':Buffer.isBuffer(data)?'application/octet-stream':'application/json'}),...headers},...(data===undefined?{}:{body:Buffer.isBuffer(data)?data:JSON.stringify(data)})});
 const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;
}
async function check(name,fn){await fn();checks.push(name);console.log('PASS',name);}
const text='\ufeff合成😀 cafe\u0301\r\n重复 quote\r\n重复 quote\n<script>literal</script>尾';
let doc,citation,draft,url,markdown,removedWorkspace,staleDoc,staleDraft,staleCitation,staleUrl,foreignDoc;
try{
 await start();
 await check('production server starts with private provider absent and literal UI bundle available',async()=>{
  await req('GET','/api/private-demo/companies',undefined,404);
  assert.equal((await fetch(origin+'/?page=documents')).status,200);
 });
 await check('generated UTF-8 TXT and Markdown upload and exact text survive the real HTTP boundary',async()=>{
  doc=(await req('POST','/api/documents/upload?name=synthetic.txt',Buffer.from(text),201)).document;
  markdown=(await req('POST','/api/documents/upload?name=synthetic.md',Buffer.from('# Synthetic\n'+text),201)).document;
  url=`/api/documents/${doc.id}`;assert.equal((await req('GET',url)).text,text);
  assert.equal((await req('GET',`/api/documents/${markdown.id}`)).text,'# Synthetic\n'+text);
 });
 await check('second repeated occurrence saves its exact range, human note and hashes',async()=>{
  const start=text.lastIndexOf('重复 quote'),quote='重复 quote';draft={operationId:randomUUID(),documentRevision:doc.revision,documentSha256:doc.sha256,textSha256:doc.textSha256,start,end:start+quote.length,quote,quoteSha256:hash(quote),rangeUnit:'utf16-code-unit',note:'Synthetic separate note 😀'};
  citation=(await req('POST',url+'/citations',draft,201)).citation;
  assert.equal(citation.start,start);assert.equal(citation.page,null);assert.equal(citation.quoteSha256,hash(quote));
 });
 await check('exact same-operation retry returns the first committed citation without a duplicate',async()=>{
  assert.deepEqual((await req('POST',url+'/citations',{...draft},201)).citation,citation);
  assert.equal((await req('GET',url+'/citations')).citations.length,1);
 });
 await check('an operation ID cannot be reused with changed payload or another document',async()=>{
  await req('POST',url+'/citations',{...draft,note:'different'},409);
  await req('POST',`/api/documents/${markdown.id}/citations`,{...draft,documentSha256:markdown.sha256,textSha256:markdown.textSha256},409);
  await req('POST',url+'/citations',{...draft,operationId:'invalid'},400);
  assert.equal((await req('GET',url+'/citations')).citations.length,1);
 });
 await check('origin and cross-site guards cover citation writes',async()=>{
  await req('POST',url+'/citations',{...draft,operationId:randomUUID()},403,{Origin:'https://invalid.example'});
  await req('POST',url+'/citations',{...draft,operationId:randomUUID()},403,{'Sec-Fetch-Site':'cross-site'});
 });
 await check('rename updates the live label and preserves saved original label and committed retry result',async()=>{
  doc=(await req('PUT',url+'/metadata',{revision:doc.revision,name:'Renamed synthetic',workspaceId:null,folderId:null})).document;
  const reopened=await req('GET',url+'/citations/'+citation.id);assert.equal(reopened.document.name,doc.name);assert.deepEqual(reopened.citation,citation);
  assert.deepEqual((await req('POST',url+'/citations',draft,201)).citation,citation);
  await req('POST',url+'/citations',{...draft,operationId:randomUUID()},409);
 });
 await check('recoverable trash retains the same citation and blocks new save or reopening',async()=>{
  doc=(await req('PUT',url+'/trash',{revision:doc.revision})).document;
  const list=await req('GET',url+'/citations');assert.equal(list.trashed,true);assert.deepEqual(list.citations,[citation]);
  await req('GET',url+'/citations/'+citation.id,undefined,409);
  await req('POST',url+'/citations',{...draft,operationId:randomUUID(),documentRevision:doc.revision},409);
 });
 await check('restoration keeps original IDs, range and hashes',async()=>{
  doc=(await req('PUT',url+'/restore',{revision:doc.revision})).document;
  const reopened=await req('GET',url+'/citations/'+citation.id);assert.deepEqual(reopened.citation,citation);assert.equal(reopened.text,text);
 });
 await check('a citation commits with a real synthetic workspace and folder association',async()=>{
  removedWorkspace=await req('POST','/api/workspace/create',{kind:'workspace',id:'citation-workspace',idempotencyKey:'citation-workspace-create',data:{name:'Synthetic citation workspace'}});
  const otherWorkspace=await req('POST','/api/workspace/create',{kind:'workspace',id:'other-citation-workspace',idempotencyKey:'other-citation-workspace-create',data:{name:'Other synthetic workspace'}});
  const folder=(await req('POST','/api/documents/folders',{name:'Synthetic folder',workspaceId:removedWorkspace.id},201)).folder;
  staleDoc=(await req('POST',`/api/documents/upload?name=stale-association.txt&workspaceId=${removedWorkspace.id}&folderId=${folder.id}`,Buffer.from(text),201)).document;
  foreignDoc=(await req('POST',`/api/documents/upload?name=foreign-workspace.txt&workspaceId=${otherWorkspace.id}`,Buffer.from(text),201)).document;
  staleUrl=`/api/documents/${staleDoc.id}/citations`;
  staleDraft={...draft,operationId:randomUUID(),documentRevision:staleDoc.revision,documentSha256:staleDoc.sha256,textSha256:staleDoc.textSha256};
  staleCitation=(await req('POST',staleUrl,staleDraft,201)).citation;
 });
 await check('workspace removal permits only exact committed retries and retains one citation',async()=>{
  await req('POST','/api/workspace/remove',{kind:'workspace',id:removedWorkspace.id,expectedRevision:removedWorkspace.revision,idempotencyKey:'citation-workspace-remove'});
  assert.deepEqual((await req('POST',staleUrl,staleDraft,201)).citation,staleCitation);
  await req('POST',staleUrl,{...staleDraft,operationId:randomUUID()},409);
  assert.deepEqual((await req('GET',staleUrl)).citations,[staleCitation]);
  const opened=await req('GET',staleUrl+'/'+staleCitation.id);assert.equal(opened.document.stale,true);assert.deepEqual(opened.citation,staleCitation);
 });
 await check('stale-association receipts cannot disclose another document or accept altered payloads',async()=>{
  for(const [path,body,status] of [
   [staleUrl,{...staleDraft,note:'changed'},409],
   [staleUrl,{...staleDraft,documentRevision:1},409],
   [staleUrl,{...staleDraft,documentSha256:'0'.repeat(64)},409],
   [staleUrl,{...staleDraft,principal:{subjectId:'other'}},400],
   [`/api/documents/${foreignDoc.id}/citations`,staleDraft,409],
   [`/api/documents/${randomUUID()}/citations`,staleDraft,404],
  ]){const rejected=await req('POST',path,body,status);assert.deepEqual(Object.keys(rejected),['error']);assert(!JSON.stringify(rejected).includes(staleCitation.id));}
  assert.deepEqual((await req('GET',`/api/documents/${foreignDoc.id}/citations`)).citations,[]);
 });
 await check('origin host and cross-site checks run before even a committed stale-association replay',async()=>{
  for(const headers of [{Origin:'https://invalid.example'},{'Sec-Fetch-Site':'cross-site'}]){
   const rejected=await req('POST',staleUrl,staleDraft,403,headers);assert.deepEqual(Object.keys(rejected),['error']);assert(!JSON.stringify(rejected).includes(staleCitation.id));
  }
  // Fetch owns the Host header; use node:http to exercise a literal foreign host.
  await new Promise((resolve,reject)=>{
   const call=request(origin+staleUrl,{method:'POST',headers:{Host:'foreign.invalid','Content-Type':'application/json'}},response=>{
    let body='';response.setEncoding('utf8');response.on('data',chunk=>body+=chunk);response.on('error',reject);response.on('end',()=>{try{assert.equal(response.statusCode,403);assert.deepEqual(Object.keys(JSON.parse(body)),['error']);assert(!body.includes(staleCitation.id));resolve();}catch(error){reject(error)}});
   });call.on('error',reject);call.end(JSON.stringify(staleDraft));
  });
  assert.deepEqual((await req('POST',staleUrl,staleDraft,201)).citation,staleCitation);
 });
 await stop();await start();
 await check('separate backend process restart preserves citations and the persisted operation ledger',async()=>{
  assert.notEqual(pids[0],pids[1]);assert.deepEqual((await req('GET',url+'/citations')).citations,[citation]);
  assert.deepEqual((await req('POST',staleUrl,staleDraft,201)).citation,staleCitation);
  assert.deepEqual((await req('GET',staleUrl)).citations,[staleCitation]);
  await req('POST',staleUrl,{...staleDraft,operationId:randomUUID()},409);
  assert.deepEqual((await req('POST',url+'/citations',draft,201)).citation,citation);
  assert.deepEqual((await req('GET',url+'/citations/'+citation.id)).citation,citation);
  assert.equal((await req('GET',url+'/citations')).citations.length,1);
 });
}catch(error){failure=error;throw error;}finally{
 await stop();writeFileSync(new URL('../integration-evidence/CITATIONS_HTTP.json',import.meta.url),JSON.stringify({passed:!failure,count:checks.length,checks,runtime:process.version,transport:'Real loopback HTTP; two distinct backend processes; real SQLite',pids,storage,fixtures:'Generated TXT/Markdown only',scope:'No browser/device/model/provider/private-database validation',...(failure?{failure:failure.message}:{})},null,2)+'\n');
}
