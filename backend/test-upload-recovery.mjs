// Synthetic in-process upload protocol tests. No browser, network, accounts or private files.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {researchDocuments,DOCUMENT_LIMITS} from './research-documents.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceFiles=['research-documents.mjs','document-upload-operations.mjs','test-upload-recovery.mjs'];
const receiptKeys=['bytes','createdAt','documentId','folderId','format','name','operationId','sha256','workspaceId'];
const validSuccess=status=>status===200||status===201;
function syntheticWorkspace(){
 const present=new Map([['synthetic-a',{id:'synthetic-a',data:{name:'Synthetic A'}}],['synthetic-b',{id:'synthetic-b',data:{name:'Synthetic B'}}]]),denied=new Set();
 return {present,denied,get(kind,id){if(denied.has(id))throw Object.assign(Error('Synthetic access denied'),{status:403,code:'FORBIDDEN'});const result=present.get(id);if(!result)throw Object.assign(Error('Synthetic workspace missing'),{code:'NOT_FOUND'});return result},list(){return [...present.values()]}};
}
async function request(app,method,url,data,options={}){
 const bytes=Buffer.isBuffer(data)?data:Buffer.from(data===undefined?'':JSON.stringify(data));
 const req=options.stream??Readable.from([bytes]);
 Object.assign(req,{url,method,headers:{'content-type':Buffer.isBuffer(data)?'application/octet-stream':'application/json',...options.headers}});
 let result,calls=0;
 const record=value=>{calls++;if(!options.discardResponse)result=value};
 const handled=await app.handle(req,(status,body)=>record({status,body}),(status,code,message)=>record({status,body:{error:{code,message}}}),(filename,bytes,sha256)=>record({status:200,filename,bytes,sha256}),bytes=>record({status:200,bytes}));
 assert.equal(handled,true,`${method} ${url} was not handled`);
 assert.equal(calls,1,`${method} ${url} must complete exactly once`);
 return options.discardResponse?undefined:result;
}
function uploadUrl(name,scope={}){return '/api/documents/upload?'+new URLSearchParams({name,...Object.fromEntries(Object.entries(scope).filter(([,value])=>value!==null))})}
async function upload(app,operationId,name,bytes,scope={},options={}){
 const headers={...(operationId===undefined?{}:{'x-upload-operation-id':operationId}),...options.headers};
 return request(app,'POST',uploadUrl(name,scope),bytes,{...options,headers});
}
async function successfulUpload(app,operationId,name,bytes,scope={},options={}){
 const result=await upload(app,operationId,name,bytes,scope,options);
 assert(validSuccess(result.status),JSON.stringify(result));return result.body;
}
async function status(app,operationId){const result=await request(app,'GET',`/api/documents/upload-operations/${operationId}`);assert.equal(result.status,200,JSON.stringify(result));return result.body}
async function expectStatus(app,method,url,data,expected,options={}){const result=await request(app,method,url,data,options);assert.equal(result.status,expected,JSON.stringify(result));return result.body}
function readDb(root,fn,readOnly=true){const db=new DatabaseSync(join(root,'research-documents.sqlite'),{readOnly});try{return fn(db)}finally{db.close()}}
function totals(root){return readDb(root,db=>({...db.prepare('SELECT count(*) count,coalesce(sum(bytes),0) bytes,coalesce(sum(text_bytes),0) textBytes FROM research_documents').get(),operations:db.prepare('SELECT count(*) count FROM document_upload_operations').get().count}))}
function checkReceipt(result,{operationId,name,bytes,scope={}}){
 const {document,receipt}=result;assert(receipt,'Upload must return its durable receipt');assert.deepEqual(Object.keys(receipt).sort(),receiptKeys);
 assert.deepEqual(receipt,{operationId,documentId:document.id,name,format:/\.([^.]+)$/.exec(name)[1].toLowerCase(),bytes:bytes.length,sha256:hash(bytes),workspaceId:scope.workspaceId??null,folderId:scope.folderId??null,createdAt:document.createdAt});
 assert(Number.isFinite(Date.parse(receipt.createdAt)));assert.equal(document.sha256,receipt.sha256);assert.equal(document.bytes,receipt.bytes);return receipt;
}
function delayedBody(bytes){
 let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const stream=Readable.from((async function*(){entered();yield bytes.subarray(0,1);await gate;yield bytes.subarray(1)})());
 return {stream,started,release};
}
async function awaitBodyStarted(delayed,pending){await Promise.race([delayed.started,pending.then(result=>{throw Error('Upload returned before delayed body began: '+JSON.stringify(result))})])}

// Fresh OS process probe used below to verify recovery does not rely on module memory.
if(process.argv[2]==='--probe-operation'){
 const app=researchDocuments(process.argv[3],syntheticWorkspace());
 try{process.stdout.write(JSON.stringify(await status(app,process.argv[4]))+'\n')}finally{app.close()}
}else{
 const root=mkdtempSync(join(tmpdir(),'yanyu-upload-recovery-')),workspace=syntheticWorkspace(),checks=[],failures=[];
 const startedAt=new Date().toISOString(),evidence=new URL('../upload-recovery-evidence/BACKEND_RESULT.json',import.meta.url);
 let app=researchDocuments(root,workspace),folderA,folderA2,folderB,folderLocal,uploadScope;
 const bytes=Buffer.from('\ufeff合成上传 😀 cafe\u0301\r\nLiteral <script>not executed</script>\r\n');
 const scope=()=>({workspaceId:'synthetic-a',folderId:folderA.id});
 const fresh=(extra={})=>({operationId:randomUUID(),name:'合成 cafe\u0301.TXT',bytes,...extra});
 async function test(name,fn){const start=performance.now();try{await fn();checks.push({name,passed:true,durationMs:Math.round(performance.now()-start)});console.log('PASS '+name)}catch(error){const failure={name,message:error.message,stack:error.stack};failures.push(failure);checks.push({name,passed:false,durationMs:Math.round(performance.now()-start),failure:failure.message});console.error('FAIL '+name+'\n'+error.stack)}}
 async function fixture(input=fresh(),association={}){const result=await successfulUpload(app,input.operationId,input.name,input.bytes,association);checkReceipt(result,{...input,scope:association});return {input,result}}
 const stats=()=>totals(root);
 try{
  uploadScope=(await expectStatus(app,'GET','/api/documents/choices',undefined,200)).uploadScope;
  assert.match(uploadScope,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  folderA=(await expectStatus(app,'POST','/api/documents/folders',{name:'Synthetic A folder',workspaceId:'synthetic-a'},201)).folder;
  folderA2=(await expectStatus(app,'POST','/api/documents/folders',{name:'Synthetic A second folder',workspaceId:'synthetic-a'},201)).folder;
  folderB=(await expectStatus(app,'POST','/api/documents/folders',{name:'Synthetic B folder',workspaceId:'synthetic-b'},201)).folder;
  folderLocal=(await expectStatus(app,'POST','/api/documents/folders',{name:'Unassigned synthetic folder',workspaceId:null},201)).folder;

  await test('server receipt preserves exact UTF-8 bytes original Unicode name format scope and SHA-256',async()=>{
   const input=fresh(),before=stats(),result=await successfulUpload(app,input.operationId,input.name,input.bytes,scope());checkReceipt(result,{...input,scope:scope()});
   const downloaded=await request(app,'GET',`/api/documents/${result.document.id}/download`,undefined,{headers:{'x-document-store-id':uploadScope}});assert.deepEqual(downloaded.bytes,bytes);assert.equal(downloaded.sha256,hash(bytes));
   assert.deepEqual(stats(),{count:before.count+1,bytes:before.bytes+bytes.length,textBytes:before.textBytes+bytes.length,operations:before.operations+1});
   assert.equal((await expectStatus(app,'GET',`/api/documents/${result.document.id}`,undefined,200)).text,bytes.toString('utf8'));
  });
  await test('same operation and exact payload replay returns one identity receipt and unchanged quotas',async()=>{
   const {input,result}=await fixture(fresh(),scope()),before=stats();
   for(let i=0;i<4;i++)assert.deepEqual(await successfulUpload(app,input.operationId,input.name,input.bytes,scope()),result);
   assert.deepEqual(stats(),before);
  });
  await test('identical content and filename with independent new operations creates independent documents',async()=>{
   const a=fresh(),b={...a,operationId:randomUUID()},before=stats();
   const first=await successfulUpload(app,a.operationId,a.name,a.bytes,scope()),second=await successfulUpload(app,b.operationId,b.name,b.bytes,scope());
   assert.notEqual(first.document.id,second.document.id);assert.notEqual(first.receipt.operationId,second.receipt.operationId);assert.equal(first.document.sha256,second.document.sha256);
   assert.deepEqual(stats(),{count:before.count+2,bytes:before.bytes+2*bytes.length,textBytes:before.textBytes+2*bytes.length,operations:before.operations+2});
  });
  await test('same operation rejects changed exact name case normalization and format without mutation',async()=>{
   const {input,result}=await fixture(fresh(),scope()),before=stats();
   for(const name of ['different.txt',input.name.normalize('NFC'),input.name.toLowerCase(),input.name.replace(/TXT$/,'md')]){
    const retry=await upload(app,input.operationId,name,input.bytes,scope());assert.equal(retry.status,409,JSON.stringify(retry));
   }
   assert.deepEqual(stats(),before);assert.deepEqual((await status(app,input.operationId)).receipt,result.receipt);
  });
  await test('same operation rejects changed workspace folder and nullable destinations without mutation',async()=>{
   const {input}=await fixture(fresh(),scope()),before=stats();
   for(const association of [{workspaceId:'synthetic-a',folderId:folderA2.id},{workspaceId:'synthetic-a'}, {workspaceId:'synthetic-b',folderId:folderB.id},{folderId:folderLocal.id},{}]){
    const retry=await upload(app,input.operationId,input.name,input.bytes,association);assert.equal(retry.status,409,JSON.stringify(retry));
   }
   assert.deepEqual(stats(),before);
  });
  await test('same operation rejects changed byte length and same-length changed server hash',async()=>{
   const input=fresh({name:'byte-bound.txt',bytes:Buffer.from('synthetic A')}),{result}=await fixture(input),before=stats();
   for(const altered of [Buffer.from('synthetic B'),Buffer.from('synthetic A extra')]){
    const retry=await upload(app,input.operationId,input.name,altered);assert.equal(retry.status,409,JSON.stringify(retry));
   }
   assert.deepEqual(stats(),before);assert.deepEqual((await status(app,input.operationId)).receipt,result.receipt);
  });
  await test('lost successful response is recovered by operation query without file or another write',async()=>{
   const input=fresh(),before=stats();await upload(app,input.operationId,input.name,input.bytes,scope(),{discardResponse:true});
   const recovered=await status(app,input.operationId);assert.equal(recovered.outcome,'committed');assert.equal(recovered.operationId,input.operationId);checkReceipt(recovered,{...input,scope:scope()});
   assert.equal(stats().count,before.count+1);assert.deepEqual(await successfulUpload(app,input.operationId,input.name,input.bytes,scope()),{document:recovered.document,receipt:recovered.receipt});
   assert.equal(stats().count,before.count+1);
  });
  await test('absent is a nonterminal snapshot and the same operation later commits',async()=>{
   const input=fresh();assert.deepEqual(await status(app,input.operationId),{scope:uploadScope,operationId:input.operationId,outcome:'absent'});
   const first=await successfulUpload(app,input.operationId,input.name,input.bytes);const recovered=await status(app,input.operationId);
   assert.deepEqual(recovered,{scope:uploadScope,operationId:input.operationId,outcome:'committed',...first});
  });
  await test('query during delayed request is absent then committed after the same request finishes',async()=>{
   const input=fresh(),delayed=delayedBody(input.bytes),before=stats();const pending=upload(app,input.operationId,input.name,input.bytes,{}, {stream:delayed.stream});
   let result;try{await awaitBodyStarted(delayed,pending);assert.deepEqual(await status(app,input.operationId),{scope:uploadScope,operationId:input.operationId,outcome:'absent'})}finally{delayed.release();result=await pending}
   assert(validSuccess(result.status),JSON.stringify(result));assert.equal((await status(app,input.operationId)).document.id,result.body.document.id);assert.equal(stats().count,before.count+1);
  });
  await test('concurrent same-handler retries converge to one receipt after any transient busy response',async()=>{
   const input=fresh(),before=stats();const results=await Promise.all(Array.from({length:8},()=>upload(app,input.operationId,input.name,input.bytes)));
   assert(results.some(r=>validSuccess(r.status)));for(const result of results)assert(validSuccess(result.status)||result.status===429,JSON.stringify(result));
   const committed=await status(app,input.operationId);for(const result of results){const final=validSuccess(result.status)?result.body:await successfulUpload(app,input.operationId,input.name,input.bytes);assert.deepEqual(final,{document:committed.document,receipt:committed.receipt})}
   assert.deepEqual(stats(),{count:before.count+1,bytes:before.bytes+bytes.length,textBytes:before.textBytes+bytes.length,operations:before.operations+1});
  });
  await test('independent handlers racing the same operation commit one atomic document and receipt',async()=>{
   const second=researchDocuments(root,workspace),input=fresh(),before=stats();try{
    const results=await Promise.all([upload(app,input.operationId,input.name,input.bytes),upload(second,input.operationId,input.name,input.bytes)]);
    for(const result of results)assert(validSuccess(result.status),JSON.stringify(result));assert.deepEqual(results[0].body,results[1].body);
    assert.deepEqual(stats(),{count:before.count+1,bytes:before.bytes+bytes.length,textBytes:before.textBytes+bytes.length,operations:before.operations+1});
   }finally{second.close()}
  });
  await test('independent handlers racing one operation with different payloads have one winner and one conflict',async()=>{
   const second=researchDocuments(root,workspace),input=fresh({name:'race.txt',bytes:Buffer.from('race A')}),other=Buffer.from('race B'),before=stats();try{
    const results=await Promise.all([upload(app,input.operationId,input.name,input.bytes),upload(second,input.operationId,input.name,other)]);
    assert.deepEqual(results.map(r=>validSuccess(r.status)?201:r.status).sort(),[201,409]);const winner=results.find(r=>validSuccess(r.status));assert.equal((await status(app,input.operationId)).document.id,winner.body.document.id);assert.equal(stats().count,before.count+1);assert.equal(stats().operations,before.operations+1);
   }finally{second.close()}
  });
  await test('delayed original request reuses a receipt committed by another handler while its body was pending',async()=>{
   const second=researchDocuments(root,workspace),input=fresh(),delayed=delayedBody(input.bytes),before=stats(),pending=upload(app,input.operationId,input.name,input.bytes,{}, {stream:delayed.stream});
   let committed,result;try{
    try{await awaitBodyStarted(delayed,pending);committed=await successfulUpload(second,input.operationId,input.name,input.bytes)}finally{delayed.release();result=await pending}
    assert(validSuccess(result.status),JSON.stringify(result));assert.deepEqual(result.body,committed);assert.equal(stats().count,before.count+1);assert.equal(stats().operations,before.operations+1);
   }finally{second.close()}
  });
  await test('delayed conflicting request cannot overwrite an operation committed during body receipt',async()=>{
   const second=researchDocuments(root,workspace),input=fresh({name:'delayed.txt',bytes:Buffer.from('pending A')}),other=Buffer.from('pending B'),delayed=delayedBody(input.bytes),before=stats(),pending=upload(app,input.operationId,input.name,input.bytes,{}, {stream:delayed.stream});
   let committed,result;try{
    try{await awaitBodyStarted(delayed,pending);committed=await successfulUpload(second,input.operationId,input.name,other)}finally{delayed.release();result=await pending}
    assert.equal(result.status,409);assert.deepEqual((await status(app,input.operationId)).receipt,committed.receipt);assert.equal(stats().count,before.count+1);
   }finally{second.close()}
  });
  await test('rename and move preserve immutable upload receipt and replay returns current metadata',async()=>{
   const {input,result}=await fixture(fresh(),scope()),id=result.document.id;
   const changed=(await expectStatus(app,'PUT',`/api/documents/${id}/metadata`,{name:'Renamed display without extension',workspaceId:'synthetic-b',folderId:folderB.id,revision:result.document.revision},200)).document;
   const before=stats(),replay=await successfulUpload(app,input.operationId,input.name,input.bytes,scope()),recovered=await status(app,input.operationId);
   assert.deepEqual(replay,{receipt:result.receipt,document:changed});assert.deepEqual(recovered.document,changed);assert.deepEqual(recovered.receipt,result.receipt);assert.deepEqual(stats(),before);
  });
  await test('trash is never undone by replay or recovery and active document access stays blocked',async()=>{
   const {input,result}=await fixture(),id=result.document.id,trashed=(await expectStatus(app,'PUT',`/api/documents/${id}/trash`,{revision:0},200)).document,before=stats();
   const replay=await successfulUpload(app,input.operationId,input.name,input.bytes);assert.deepEqual(replay,{document:trashed,receipt:result.receipt});assert.deepEqual((await status(app,input.operationId)).document,trashed);
   await expectStatus(app,'GET',`/api/documents/${id}`,undefined,404);assert.deepEqual(stats(),before);assert(trashed.trashedAt);
  });
  await test('same-process close reopen preserves receipts and current renamed trashed metadata',async()=>{
   const {input,result}=await fixture(),id=result.document.id;
   await expectStatus(app,'PUT',`/api/documents/${id}/metadata`,{name:'Restart-safe synthetic label',workspaceId:null,folderId:null,revision:0},200);
   const trashed=(await expectStatus(app,'PUT',`/api/documents/${id}/trash`,{revision:1},200)).document,before=stats();app.close();app=researchDocuments(root,workspace);
   assert.deepEqual(await status(app,input.operationId),{scope:uploadScope,operationId:input.operationId,outcome:'committed',receipt:result.receipt,document:trashed});
   assert.deepEqual(await successfulUpload(app,input.operationId,input.name,input.bytes),{receipt:result.receipt,document:trashed});assert.deepEqual(stats(),before);
  });
  await test('fresh Node process recovers the committed operation without inherited memory',async()=>{
   const {input,result}=await fixture(),before=stats();app.close();
   try{const probe=spawnSync(process.execPath,[import.meta.filename,'--probe-operation',root,input.operationId],{encoding:'utf8',timeout:10000});assert.equal(probe.status,0,probe.stderr);assert.deepEqual(JSON.parse(probe.stdout),{scope:uploadScope,operationId:input.operationId,outcome:'committed',...result})}finally{app=researchDocuments(root,workspace)}
   assert.deepEqual(stats(),before);
  });
  await test('stale original workspace permits exact committed recovery but not a fresh operation',async()=>{
   const {input,result}=await fixture(fresh(),{workspaceId:'synthetic-a'}),saved=workspace.present.get('synthetic-a'),before=stats();workspace.present.delete('synthetic-a');
   try{const replay=await successfulUpload(app,input.operationId,input.name,input.bytes,{workspaceId:'synthetic-a'});assert.equal(replay.document.stale,true);assert.deepEqual(replay.receipt,result.receipt);assert.equal((await status(app,input.operationId)).document.stale,true);assert.equal((await upload(app,randomUUID(),input.name,input.bytes,{workspaceId:'synthetic-a'})).status,409);assert.deepEqual(stats(),before)}finally{workspace.present.set('synthetic-a',saved)}
  });
  await test('workspace access denial cannot be bypassed by receipt recovery or exact replay',async()=>{
   const {input}=await fixture(fresh(),{workspaceId:'synthetic-a'}),before=stats();workspace.denied.add('synthetic-a');
   try{await expectStatus(app,'GET',`/api/documents/upload-operations/${input.operationId}`,undefined,403);assert.equal((await upload(app,input.operationId,input.name,input.bytes,{workspaceId:'synthetic-a'})).status,403);assert.deepEqual(stats(),before)}finally{workspace.denied.delete('synthetic-a')}
  });
  await test('invalid operation headers and query UUIDs never create documents or durable receipts',async()=>{
   const before=stats();for(const operationId of ['', 'not-a-uuid','a'.repeat(36),randomUUID()+'x',randomUUID()+', '+randomUUID(),[randomUUID(),randomUUID()]])assert.equal((await upload(app,operationId,'invalid-op.txt',bytes)).status,400);
   for(const operationId of ['not-a-uuid','a'.repeat(36),randomUUID()+'x'])await expectStatus(app,'GET',`/api/documents/upload-operations/${operationId}`,undefined,400);
   assert.deepEqual(stats(),before);
  });
  await test('operation recovery rejects method query and route widening',async()=>{
   const operationId=randomUUID(),route=`/api/documents/upload-operations/${operationId}`,before=stats();
   for(const method of ['POST','PUT','DELETE'])await expectStatus(app,method,route,undefined,405);
   for(const suffix of ['?x=1','?name=x&name=x'])await expectStatus(app,'GET',route+suffix,undefined,400);
   await expectStatus(app,'GET',route+'/extra',undefined,404);assert.deepEqual(stats(),before);
  });
  await test('matching store scope permits upload and mismatched store scope rejects new and committed operations',async()=>{
   const input=fresh(),before=stats(),wrongScope=randomUUID();
   assert.equal((await upload(app,input.operationId,input.name,input.bytes,{}, {headers:{'x-upload-store-id':wrongScope}})).status,409);
   assert.deepEqual(stats(),before);assert.equal((await status(app,input.operationId)).outcome,'absent');
   const result=await successfulUpload(app,input.operationId,input.name,input.bytes,{}, {headers:{'x-upload-store-id':uploadScope}});checkReceipt(result,input);
   const committed=stats();assert.equal((await upload(app,input.operationId,input.name,input.bytes,{}, {headers:{'x-upload-store-id':wrongScope}})).status,409);assert.deepEqual(stats(),committed);
   assert.deepEqual(await successfulUpload(app,input.operationId,input.name,input.bytes,{}, {headers:{'x-upload-store-id':uploadScope}}),result);
  });
  await test('store scope is stable after restart and distinct stores cannot accept a pinned original-store upload',async()=>{
   const otherRoot=mkdtempSync(join(tmpdir(),'yanyu-upload-recovery-other-store-'));let other=researchDocuments(otherRoot,workspace);
   try{
    const input=fresh(),otherScope=(await expectStatus(other,'GET','/api/documents/choices',undefined,200)).uploadScope;
    assert.notEqual(otherScope,uploadScope);assert.equal((await status(other,input.operationId)).scope,otherScope);
    assert.equal((await upload(other,input.operationId,input.name,input.bytes,{}, {headers:{'x-upload-store-id':uploadScope}})).status,409);assert.equal(totals(otherRoot).count,0);
    other.close();other=researchDocuments(otherRoot,workspace);assert.equal((await expectStatus(other,'GET','/api/documents/choices',undefined,200)).uploadScope,otherScope);
    app.close();app=researchDocuments(root,workspace);assert.equal((await expectStatus(app,'GET','/api/documents/choices',undefined,200)).uploadScope,uploadScope);
    checkReceipt(await successfulUpload(other,input.operationId,input.name,input.bytes,{}, {headers:{'x-upload-store-id':otherScope}}),input);
   }finally{other.close()}
  });
  await test('legacy no-header uploads remain independent and do not invent operation receipts',async()=>{
   const before=stats(),a=await successfulUpload(app,undefined,'legacy.txt',bytes),b=await successfulUpload(app,undefined,'legacy.txt',bytes);
   assert.notEqual(a.document.id,b.document.id);assert.equal(a.document.sha256,b.document.sha256);assert(!a.receipt);assert(!b.receipt);
   assert.deepEqual(stats(),{count:before.count+2,bytes:before.bytes+2*bytes.length,textBytes:before.textBytes+2*bytes.length,operations:before.operations});
  });
  await test('invalid bodies have absent receipts and can be corrected with the same uncommitted operation',async()=>{
   for(const [invalid,expected] of [[Buffer.alloc(0),413],[Buffer.from([0xff]),422],[Buffer.from('bad\u0000control'),422]]){
    const input=fresh(),before=stats();assert.equal((await upload(app,input.operationId,input.name,invalid)).status,expected);assert.deepEqual(await status(app,input.operationId),{scope:uploadScope,operationId:input.operationId,outcome:'absent'});assert.deepEqual(stats(),before);
    const good=await successfulUpload(app,input.operationId,input.name,input.bytes);checkReceipt(good,input);
   }
  });
  await test('interrupted body leaves no partial document or receipt and releases the upload guard',async()=>{
   const input=fresh(),before=stats(),stream=Readable.from((async function*(){yield Buffer.from('partial');throw Object.assign(Error('Synthetic client interruption'),{code:'ECONNRESET'})})());
   const interrupted=await upload(app,input.operationId,input.name,input.bytes,{}, {stream});assert.equal(interrupted.status,503);assert.deepEqual(stats(),before);assert.deepEqual(await status(app,input.operationId),{scope:uploadScope,operationId:input.operationId,outcome:'absent'});
   checkReceipt(await successfulUpload(app,input.operationId,input.name,input.bytes),input);
  });
  await test('receipt insertion failure rolls back original bytes and leaves the operation reusable',async()=>{
   const input=fresh(),before=stats();readDb(root,db=>db.exec(`CREATE TRIGGER synthetic_fail_upload_receipt BEFORE INSERT ON document_upload_operations WHEN NEW.operation_id='${input.operationId}' BEGIN SELECT RAISE(ABORT,'Synthetic receipt persistence failure'); END`),false);
   try{assert.equal((await upload(app,input.operationId,input.name,input.bytes)).status,503);assert.deepEqual(stats(),before);assert.deepEqual(await status(app,input.operationId),{scope:uploadScope,operationId:input.operationId,outcome:'absent'})}finally{readDb(root,db=>db.exec('DROP TRIGGER synthetic_fail_upload_receipt'),false)}
   checkReceipt(await successfulUpload(app,input.operationId,input.name,input.bytes),input);
  });
  await test('SQLite prevents mutation and deletion of committed operation receipts',async()=>{
   const {input,result}=await fixture();readDb(root,db=>{assert.throws(()=>db.prepare('UPDATE document_upload_operations SET request_sha256=request_sha256 WHERE operation_id=?').run(input.operationId),/Immutable upload operation/);assert.throws(()=>db.prepare('DELETE FROM document_upload_operations WHERE operation_id=?').run(input.operationId),/Immutable upload operation/)},false);
   assert.deepEqual((await status(app,input.operationId)).receipt,result.receipt);
  });
  await test('full 250-document quota still permits exact replay including trash and restart without charging twice',async()=>{
   const quotaRoot=mkdtempSync(join(tmpdir(),'yanyu-upload-recovery-quota-'));let quotaApp=researchDocuments(quotaRoot,workspace);const input=fresh({name:'quota-origin.txt',bytes:Buffer.from('Synthetic quota origin')});
   try{
    const result=await successfulUpload(quotaApp,input.operationId,input.name,input.bytes);
    for(let i=1;i<DOCUMENT_LIMITS.count;i++)await successfulUpload(quotaApp,randomUUID(),'quota-'+i+'.txt',Buffer.from('Synthetic quota '+i));
    const before=totals(quotaRoot);assert.equal(before.count,250);assert.equal(before.operations,250);
    assert.deepEqual(await successfulUpload(quotaApp,input.operationId,input.name,input.bytes),result);
    const quotaScope=(await expectStatus(quotaApp,'GET','/api/documents/choices',undefined,200)).uploadScope;
    const rejectedId=randomUUID();assert.equal((await upload(quotaApp,rejectedId,'quota-exceeded.txt',bytes)).status,429);assert.deepEqual(await status(quotaApp,rejectedId),{scope:quotaScope,operationId:rejectedId,outcome:'absent'});
    assert.equal((await upload(quotaApp,undefined,'legacy-over-quota.txt',bytes)).status,429);
    const trashed=(await expectStatus(quotaApp,'PUT',`/api/documents/${result.document.id}/trash`,{revision:0},200)).document;
    quotaApp.close();quotaApp=researchDocuments(quotaRoot,workspace);
    assert.deepEqual(await successfulUpload(quotaApp,input.operationId,input.name,input.bytes),{receipt:result.receipt,document:trashed});assert.deepEqual((await status(quotaApp,input.operationId)).document,trashed);assert.deepEqual(totals(quotaRoot),before);
    const conflict=await upload(quotaApp,input.operationId,input.name,Buffer.from('Synthetic quota differ'));assert.equal(conflict.status,409);assert.deepEqual(totals(quotaRoot),before);
   }finally{quotaApp.close()}
  });
 }catch(error){failures.push({name:'test harness setup',message:error.message,stack:error.stack})}finally{
  app?.close();mkdirSync(new URL('../upload-recovery-evidence/',import.meta.url),{recursive:true});
  writeFileSync(evidence,JSON.stringify({passed:failures.length===0,count:checks.length,passedCount:checks.filter(c=>c.passed).length,checks,failures,runtime:process.version,startedAt,checkedAt:new Date().toISOString(),sourceSha256:Object.fromEntries(sourceFiles.map(name=>[name,hash(readFileSync(new URL('./'+name,import.meta.url)))])),storage:root,syntheticSha256:hash(bytes),transport:'In-process Node HTTP handlers and real SQLite, plus a fresh Node recovery process; no network listener or browser',fixtures:'Generated UTF-8 byte buffers, isolated synthetic workspaces and temporary databases only',retention:'Synthetic temporary directories retained; no existing application files or user data accessed or deleted',scope:'Upload operation binding, dropped-response lookup, nonterminal absent, concurrent commit/replay, immutable receipt, transactional rollback, metadata/trash retention, process restart, quota and legacy compatibility',limitations:['No real browser or network disconnect end-to-end check; response loss and body interruption are modeled at the handler boundary','PDF extraction is covered by the existing PDF/document suites; this independent suite uses UTF-8 text only']},null,2)+'\n');
 }
 if(failures.length){console.error(`FAIL ${failures.length} upload-recovery check(s); evidence saved`);process.exitCode=1}else console.log(`PASS ${checks.length} upload-recovery checks; evidence saved`);
}
