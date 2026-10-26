// Real production-server loopback HTTP tests; fresh synthetic local stores only.
// Client response discard is an application-level simulation, not physical network loss.
import assert from 'node:assert/strict';
import {fork,spawnSync} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const here=import.meta.dirname,root=mkdtempSync(join(tmpdir(),'yanyu-upload-recovery-http-')),storage=join(root,'synthetic-store');mkdirSync(storage);
const hash=value=>createHash('sha256').update(value).digest('hex');
const checks=[],pids=[],origins=[],startedAt=new Date().toISOString();
const files=['server.mjs','research-documents.mjs','document-upload-operations.mjs','test-upload-recovery-http.mjs'];
const sourceSha256=()=>Object.fromEntries(files.map(file=>[file,hash(readFileSync(join(here,file)))]));
const initialSources=sourceSha256();
let child,origin,build,failure,scope,folderA,folderB,committed,committedOperation;
const text='\ufeff合成上传 😀 cafe\u0301\r\nLiteral <script>not executed</script>\r\n',bytes=Buffer.from(text);
const name='合成 cafe\u0301.TXT';
async function start(){
 let stderr='';await new Promise((resolve,reject)=>{
  child=fork(join(here,'server.mjs'),[build,storage,join(root,'synthetic-events.jsonl'),'0'],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH}});pids.push(child.pid);
  child.stdout.resume();child.stderr.on('data',chunk=>stderr+=chunk);
  const timer=setTimeout(()=>reject(Error('Server readiness timed out: '+stderr)),15000);
  child.once('message',message=>{clearTimeout(timer);origin=message.origin;origins.push(origin);resolve()});
  child.once('error',error=>{clearTimeout(timer);reject(error)});child.once('exit',code=>{clearTimeout(timer);reject(Error('Server exited '+code+': '+stderr))});
 });
}
async function stop(){
 if(child&&child.exitCode===null){const current=child;await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{current.kill('SIGKILL');reject(Error('Synthetic server failed to stop gracefully'))},15000);
  current.once('exit',()=>{clearTimeout(timer);resolve()});current.kill('SIGTERM');
 })}
}
async function call(method,path,data,headers={}){
 const response=await fetch(origin+path,{method,headers:{...(data===undefined?{}:{'Content-Type':Buffer.isBuffer(data)?'application/octet-stream':'application/json'}),...headers},...(data===undefined?{}:{body:Buffer.isBuffer(data)?data:JSON.stringify(data)}),signal:AbortSignal.timeout(10000)});
 return {status:response.status,body:await response.json(),headers:response.headers};
}
async function req(method,path,data,expected=200,headers={}){const result=await call(method,path,data,headers);assert.equal(result.status,expected,JSON.stringify(result.body));return result.body}
const uploadPath=(filename=name,association={})=>'/api/documents/upload?'+new URLSearchParams({name:filename,...association});
const operationPath=operationId=>'/api/documents/upload-operations/'+operationId;
function upload(operationId,filename=name,content=bytes,association={},headers={}){return call('POST',uploadPath(filename,association),content,{'X-Upload-Operation-Id':operationId,'X-Upload-Store-Id':scope,...headers})}
async function goodUpload(operationId,filename=name,content=bytes,association={},headers={}){const result=await upload(operationId,filename,content,association,headers);assert.equal(result.status,201,JSON.stringify(result.body));return result.body}
async function count(){return (await req('GET','/api/documents')).total}
async function check(title,fn){const start=performance.now();await fn();checks.push({name:title,passed:true,durationMs:Math.round(performance.now()-start)});console.log('PASS '+title)}
function expectedReceipt(result,operationId,filename=name,content=bytes,association={}){return {operationId,documentId:result.document.id,name:filename,format:filename.split('.').at(-1).toLowerCase(),bytes:content.length,sha256:hash(content),workspaceId:association.workspaceId??null,folderId:association.folderId??null,createdAt:result.document.createdAt}}
function rawCall(method,path,data,headers={}){return new Promise((resolve,reject)=>{
 const call=httpRequest(origin+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/octet-stream'}),...headers}},response=>{
  const parts=[];response.on('data',part=>parts.push(part));response.on('error',reject);response.on('end',()=>{try{resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(parts).toString('utf8'))})}catch(error){reject(error)}});
 });call.setTimeout(10000,()=>call.destroy(Error('Synthetic HTTP request timed out')));call.on('error',reject);call.end(data);
})}
function holdUpload(operationId,content){
 let resolveReady,rejectReady,resolveDone,rejectDone;
 const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject}),done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject});
 // An early rejection is still reported when awaited; attach immediately to avoid leakage.
 done.catch(()=>{});
 const call=httpRequest(origin+uploadPath('delayed-http.txt'),{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Length':content.length,Expect:'100-continue','X-Upload-Operation-Id':operationId,'X-Upload-Store-Id':scope}},response=>{
  const parts=[];response.on('data',part=>parts.push(part));response.on('error',rejectDone);response.on('end',()=>{try{const result={status:response.statusCode,body:JSON.parse(Buffer.concat(parts).toString('utf8'))};resolveDone(result);if(result.status!==201)rejectReady(Error('Held request rejected early: '+JSON.stringify(result)))}catch(error){rejectDone(error)}});
 });
 call.once('continue',()=>{call.write(content.subarray(0,1));resolveReady()});
 call.setTimeout(10000,()=>call.destroy(Error('Held synthetic upload timed out')));call.on('error',error=>{rejectReady(error);rejectDone(error)});call.flushHeaders();
 return {ready,done,release(){if(!call.writableEnded&&!call.destroyed)call.end(content.subarray(1))},abort(){call.destroy()}};
}

try{
 // Same source-pinned runtime preparation as the existing real-HTTP suites.
 const frontierPath=join(here,'BACKEND_FRONTIER.json'),frontierBefore=readFileSync(frontierPath);
 const prep=spawnSync(process.execPath,[join(here,'prepare-backend.mjs')],{encoding:'utf8',timeout:30000});assert.equal(prep.status,0,prep.stderr);build=prep.stdout.trim();
 assert.deepEqual(readFileSync(frontierPath),frontierBefore,'Runtime preparation must not change the existing source frontier');
 await start();
 await check('production server exposes the built local UI with private provider absent',async()=>{
  await req('GET','/api/private-demo/companies',undefined,404);const response=await fetch(origin+'/?page=documents');assert.equal(response.status,200);await response.arrayBuffer();
  scope=(await req('GET','/api/documents/choices')).uploadScope;assert.match(scope,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
 });
 await check('real workspace and folder associations are created from synthetic data only',async()=>{
  for(const id of ['upload-http-a','upload-http-b'])await req('POST','/api/workspace/create',{kind:'workspace',id,idempotencyKey:randomUUID(),data:{name:'Synthetic '+id}});
  folderA=(await req('POST','/api/documents/folders',{name:'Synthetic upload A',workspaceId:'upload-http-a'},201)).folder;
  folderB=(await req('POST','/api/documents/folders',{name:'Synthetic upload B',workspaceId:'upload-http-b'},201)).folder;
 });
 await check('absent operation becomes committed with exact receipt and raw UTF-8 bytes across real HTTP',async()=>{
  committedOperation=randomUUID();assert.deepEqual(await req('GET',operationPath(committedOperation)),{scope,operationId:committedOperation,outcome:'absent'});
  const association={workspaceId:'upload-http-a',folderId:folderA.id};committed=await goodUpload(committedOperation,name,bytes,association);
  assert.deepEqual(committed.receipt,expectedReceipt(committed,committedOperation,name,bytes,association));
  assert.deepEqual(await req('GET',operationPath(committedOperation)),{scope,operationId:committedOperation,outcome:'committed',...committed});
  assert.equal((await req('GET',`/api/documents/${committed.document.id}`)).text,text);
  const original=await fetch(origin+`/api/documents/${committed.document.id}/download`,{headers:{'X-Document-Store-Id':scope}});assert.equal(original.headers.get('x-document-sha256'),hash(bytes));assert.deepEqual(Buffer.from(await original.arrayBuffer()),bytes);
 });
 await check('exact operation header retries return the same receipt and consume no new document slots',async()=>{
  const before=await count(),association={workspaceId:'upload-http-a',folderId:folderA.id};
  for(let i=0;i<3;i++)assert.deepEqual(await goodUpload(committedOperation,name,bytes,association),committed);
  assert.equal(await count(),before);
 });
 await check('same operation rejects changed filename Unicode normalization format scope length or same-length hash',async()=>{
  const before=await count(),association={workspaceId:'upload-http-a',folderId:folderA.id},sameLength=Buffer.from(bytes);sameLength[sameLength.length-3]=sameLength[sameLength.length-3]===65?66:65;
  for(const [filename,content,target] of [
   ['different.txt',bytes,association],[name.normalize('NFC'),bytes,association],[name.replace(/TXT$/,'md'),bytes,association],
   [name,bytes,{}],[name,bytes,{workspaceId:'upload-http-b',folderId:folderB.id}],
   [name,Buffer.concat([bytes,Buffer.from('extra')]),association],[name,sameLength,association],
  ]){const result=await upload(committedOperation,filename,content,target);assert.equal(result.status,409,JSON.stringify(result.body));assert.deepEqual(Object.keys(result.body),['error'])}
  assert.equal(await count(),before);assert.deepEqual((await req('GET',operationPath(committedOperation))).receipt,committed.receipt);
 });
 await check('new operations remain independent for identical TXT content and Markdown remains literal',async()=>{
  const before=await count(),a=await goodUpload(randomUUID(),'same.txt',bytes),b=await goodUpload(randomUUID(),'same.txt',bytes);assert.notEqual(a.document.id,b.document.id);assert.equal(a.document.sha256,b.document.sha256);
  const content=Buffer.from('# Synthetic heading\n'+text),operationId=randomUUID(),markdown=await goodUpload(operationId,'synthetic.md',content);assert.deepEqual(markdown.receipt,expectedReceipt(markdown,operationId,'synthetic.md',content));assert.equal((await req('GET',`/api/documents/${markdown.document.id}`)).text,content.toString('utf8'));assert.equal(await count(),before+3);
 });
 await check('discarding the committed HTTP response body still permits query-only recovery and exact replay',async()=>{
  const operationId=randomUUID(),before=await count();
  // Receiving response headers proves server commit occurred; the body is deliberately ignored.
  const response=await fetch(origin+uploadPath('discarded-response.txt'),{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Upload-Operation-Id':operationId,'X-Upload-Store-Id':scope},body:bytes,signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,201);await response.body.cancel();
  const recovered=await req('GET',operationPath(operationId));assert.equal(recovered.outcome,'committed');assert.deepEqual(recovered.receipt,expectedReceipt(recovered,operationId,'discarded-response.txt'));
  assert.equal(await count(),before+1);assert.deepEqual(await goodUpload(operationId,'discarded-response.txt'),{document:recovered.document,receipt:recovered.receipt});assert.equal(await count(),before+1);
 });
 await check('concurrent requests see busy 429 while a body is pending then retry the same ID without duplication',async()=>{
  const operationId=randomUUID(),before=await count(),held=holdUpload(operationId,bytes);let first;
  try{
   await held.ready;assert.deepEqual(await req('GET',operationPath(operationId)),{scope,operationId,outcome:'absent'});
   const busy=await Promise.all(Array.from({length:4},()=>upload(operationId,'delayed-http.txt')));for(const result of busy)assert.equal(result.status,429,JSON.stringify(result.body));
   assert.equal(await count(),before);
  }finally{held.release();first=await held.done}
  assert.equal(first.status,201,JSON.stringify(first.body));
  for(let i=0;i<4;i++)assert.deepEqual(await goodUpload(operationId,'delayed-http.txt'),first.body);
  assert.equal(await count(),before+1);assert.deepEqual((await req('GET',operationPath(operationId))).receipt,first.body.receipt);
 });
 await check('wrong pinned store scope blocks both fresh uploads and committed retries',async()=>{
  const before=await count(),operationId=randomUUID(),headers={'X-Upload-Store-Id':randomUUID()};
  assert.equal((await upload(operationId,'wrong-store.txt',bytes,{},headers)).status,409);
  assert.equal((await upload(committedOperation,name,bytes,{workspaceId:'upload-http-a',folderId:folderA.id},headers)).status,409);
  assert.deepEqual(await req('GET',operationPath(operationId)),{scope,operationId,outcome:'absent'});assert.equal(await count(),before);
 });
 await check('invalid UUID and duplicate operation headers are rejected at the real HTTP boundary',async()=>{
  const before=await count();for(const operationId of ['','invalid',randomUUID()+'x'])assert.equal((await upload(operationId,'invalid.txt')).status,400);
  const duplicate=await rawCall('POST',uploadPath('duplicate-header.txt'),bytes,{'X-Upload-Operation-Id':[randomUUID(),randomUUID()],'X-Upload-Store-Id':scope});assert.equal(duplicate.status,400,JSON.stringify(duplicate));
  await req('GET','/api/documents/upload-operations/invalid',undefined,400);assert.equal(await count(),before);
 });
 await check('Origin and cross-site guards reject new writes committed replays and recovery reads before exposing receipts',async()=>{
  const before=await count(),association={workspaceId:'upload-http-a',folderId:folderA.id};
  for(const headers of [{Origin:'https://invalid.example'},{'Sec-Fetch-Site':'cross-site'}]){
   for(const operationId of [randomUUID(),committedOperation]){
    const rejected=await upload(operationId,name,bytes,association,headers);assert.equal(rejected.status,403);assert.deepEqual(Object.keys(rejected.body),['error']);assert(!JSON.stringify(rejected.body).includes(committed.document.id));
   }
   const recovered=await req('GET',operationPath(committedOperation),undefined,403,headers);assert.deepEqual(Object.keys(recovered),['error']);assert(!JSON.stringify(recovered).includes(committed.document.id));
  }
  assert.deepEqual(await goodUpload(committedOperation,name,bytes,association,{Origin:origin,'Sec-Fetch-Site':'same-origin'}),committed);assert.equal(await count(),before);
 });
 await check('literal foreign Host is rejected for both committed upload replay and operation recovery',async()=>{
  const before=await count();
  for(const [method,path,data,headers] of [
   ['POST',uploadPath(name,{workspaceId:'upload-http-a',folderId:folderA.id}),bytes,{'X-Upload-Operation-Id':committedOperation,'X-Upload-Store-Id':scope}],
   ['GET',operationPath(committedOperation),undefined,{}],
  ]){const result=await rawCall(method,path,data,{...headers,Host:'foreign.invalid'});assert.equal(result.status,403);assert.deepEqual(Object.keys(result.body),['error']);assert(!JSON.stringify(result.body).includes(committed.document.id))}
  assert.equal(await count(),before);
 });
 await check('metadata rename and trash remain current through HTTP recovery and replay',async()=>{
  let document=(await req('PUT',`/api/documents/${committed.document.id}/metadata`,{name:'Synthetic renamed display',workspaceId:'upload-http-b',folderId:folderB.id,revision:0})).document;
  document=(await req('PUT',`/api/documents/${document.id}/trash`,{revision:document.revision})).document;
  const replay=await goodUpload(committedOperation,name,bytes,{workspaceId:'upload-http-a',folderId:folderA.id});assert.deepEqual(replay,{document,receipt:committed.receipt});committed={document,receipt:committed.receipt};
  assert.deepEqual((await req('GET',operationPath(committedOperation))).document,document);await req('GET',`/api/documents/${document.id}`,undefined,404);
 });
 await check('legacy requests without operation or store headers remain independent new uploads',async()=>{
  const before=await count(),a=await req('POST',uploadPath('legacy.txt'),bytes,201),b=await req('POST',uploadPath('legacy.txt'),bytes,201);assert.notEqual(a.document.id,b.document.id);assert(!a.receipt);assert(!b.receipt);assert.equal(await count(),before+2);
 });
 const countBeforeRestart=await count();await stop();await start();
 await check('separate production server restart preserves store identity committed receipt and current trash state',async()=>{
  assert.notEqual(pids[0],pids[1]);assert.equal((await req('GET','/api/documents/choices')).uploadScope,scope);
  assert.deepEqual(await req('GET',operationPath(committedOperation)),{scope,operationId:committedOperation,outcome:'committed',...committed});
  assert.deepEqual(await goodUpload(committedOperation,name,bytes,{workspaceId:'upload-http-a',folderId:folderA.id}),committed);
  assert.equal(await count(),countBeforeRestart);await req('GET',`/api/documents/${committed.document.id}`,undefined,404);
 });
 await check('tested production and test sources stay unchanged throughout the run',async()=>{assert.deepEqual(sourceSha256(),initialSources)});
}catch(error){failure={message:error.message,stack:error.stack};console.error(error.stack);process.exitCode=1}finally{
 try{await stop()}catch(error){failure??={message:error.message,stack:error.stack};process.exitCode=1}
 mkdirSync(new URL('../upload-recovery-evidence/',import.meta.url),{recursive:true});
 writeFileSync(new URL('../upload-recovery-evidence/HTTP_RESULT.json',import.meta.url),JSON.stringify({passed:!failure,count:checks.length,checks,runtime:process.version,startedAt,checkedAt:new Date().toISOString(),pids,origins,storage,sourceSha256:initialSources,currentSourceSha256:sourceSha256(),syntheticSha256:hash(bytes),transport:'Real 127.0.0.1 HTTP using the production server, built UI and source-pinned backend runtime; two distinct server processes and real SQLite',fixtures:'Generated UTF-8 TXT/Markdown, fresh synthetic workspaces and retained temporary storage only',scope:'Raw upload headers and exact binding, operation recovery, real busy 429 and same-ID retries, store scope, Origin/Host/cross-site guards, response-body discard and separate-process restart',limitations:['Response loss is simulated by ignoring the successful HTTP response body after headers; no physical network disconnection','No browser, user device, credentials, private provider, model call or external service is used'],...(failure?{failure}:{})},null,2)+'\n');
}
if(!failure)console.log(`PASS ${checks.length} real-HTTP upload-recovery checks; evidence saved`);
