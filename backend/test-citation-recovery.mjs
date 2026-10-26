// Generated Unicode fixtures and temporary real SQLite only. No user files or services.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {researchDocuments} from './research-documents.mjs';
import {documentCitations} from './document-citations.mjs';

const root=mkdtempSync(join(tmpdir(),'yanyu-citation-recovery-'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const keys=['documentRevision','documentSha256','end','note','operationId','quote','quoteSha256','rangeUnit','start','textSha256'];
const fingerprint=data=>hash(JSON.stringify(keys.map(key=>[key,data[key]])));
const sources=['backend/document-citations.mjs','backend/research-documents.mjs','backend/test-citation-recovery.mjs'];
const sourceSha256=()=>Object.fromEntries(sources.map(path=>[path,hash(readFileSync(new URL('../'+path,import.meta.url)))]));
const initialSources=sourceSha256(),checks=[];
const denied=new Set(),missing=new Set();
const workspace={get(_kind,id){if(denied.has(id))throw Object.assign(Error('Synthetic denied workspace'),{code:'FORBIDDEN'});if(missing.has(id))throw Object.assign(Error('Synthetic missing workspace'),{code:'NOT_FOUND'});return {id,data:{name:'Synthetic '+id}}},list(){return []}};
let app=researchDocuments(root,workspace),otherApp,failure;
async function request(method,url,data,status=200,headers={},service=app){
 const req=Readable.from([Buffer.isBuffer(data)?data:Buffer.from(data===undefined?'':JSON.stringify(data))]);
 Object.assign(req,{method,url,headers:{'content-type':Buffer.isBuffer(data)?'application/octet-stream':'application/json',...headers}});
 let result;await service.handle(req,(status,body)=>result={status,body},(status,code,message)=>result={status,body:{error:{code,message}}},()=>{});
 assert.equal(result?.status,status,JSON.stringify(result));return result.body;
}
const check=async(name,run)=>{await run();checks.push(name);console.log('PASS',name)};
const text='\ufeff合成😀 cafe\u0301\r\n重复 quote\r\n重复 quote\n<script>literal</script>尾';
let doc,base,draft,citation,scope,receipt;
try{
 doc=(await request('POST','/api/documents/upload?name=synthetic.txt&workspaceId=source',Buffer.from(text),201)).document;
 base=`/api/documents/${doc.id}`;
 const start=text.lastIndexOf('重复 quote'),quote='重复 quote';
 draft={operationId:randomUUID(),documentRevision:doc.revision,documentSha256:doc.sha256,textSha256:doc.textSha256,start,end:start+quote.length,quote,quoteSha256:hash(quote),rangeUnit:'utf16-code-unit',note:'人工判断 😀'};
 const lookup=(id=draft.operationId)=>`${base}/citation-operations/${id}`;
 await check('list exposes the existing durable upload-store scope and keeps all old fields',async()=>{
  scope=(await request('GET','/api/documents/choices')).uploadScope;
  assert.match(scope,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.deepEqual(await request('GET',base+'/citations'),{storeScope:scope,citations:[],documentName:'synthetic.txt',trashed:false});
 });
 await check('source detail binds the original text to its store before citation-list lookup and rejects a wrong pinned scope',async()=>{
  const expected={storeScope:scope,document:doc,text};
  assert.deepEqual(await request('GET',base),expected);assert.deepEqual(await request('GET',base,undefined,200,{'x-citation-store-id':scope}),expected);
  const rejected=await request('GET',base,undefined,409,{'x-citation-store-id':randomUUID()});assert.deepEqual(Object.keys(rejected),['error']);
  for(const secret of [doc.id,text,scope])assert(!JSON.stringify(rejected).includes(secret));
 });
 await check('new operation lookup is exact read-only absence with no document or quote leakage',async()=>{
  assert.deepEqual(await request('GET',lookup(),undefined,200,{'x-citation-store-id':scope}),{storeScope:scope,operationId:draft.operationId,outcome:'absent'});
  for(const suffix of ['?','?extra=1','?operationId='+draft.operationId])await request('GET',lookup()+suffix,undefined,400);
  for(const suffix of ['\n','\r\n'])await request('GET',lookup()+suffix,undefined,404);
  await request('GET',lookup()+'#fragment',undefined,404);await request('POST',lookup(),{},405);await request('GET',lookup('invalid'),undefined,404);
 });
 await check('create and recovery bind the original operation to the unchanged canonical request hash',async()=>{
  const result=await request('POST',base+'/citations',draft,201,{'x-citation-store-id':scope});citation=result.citation;
  assert.deepEqual(result,{storeScope:scope,outcome:'committed',operationId:draft.operationId,requestSha256:fingerprint(draft),citation});
  receipt={...result,outcome:'committed'};
  assert.deepEqual(await request('GET',lookup(),undefined,200,{'x-citation-store-id':scope}),receipt);
  const db=new DatabaseSync(join(root,'research-documents.sqlite'));
  assert.equal(db.prepare('SELECT request_sha256 FROM document_citation_operations WHERE operation_id=?').get(draft.operationId).request_sha256,fingerprint(draft));db.close();
 });
 await check('close and reopen preserves scope, original citation ID, receipt and repeated idempotent submits',async()=>{
  app.close();app=researchDocuments(root,workspace);
  assert.deepEqual(await request('GET',lookup()),receipt);
  for(let i=0;i<4;i++)assert.deepEqual(await request('POST',base+'/citations',Object.fromEntries(Object.entries(draft).reverse()),201),receipt);
  assert.deepEqual((await request('GET',base+'/citations')).citations,[citation]);
 });
 await check('wrong, malformed and duplicated pinned scopes reject list reopen create and recovery without exposing data',async()=>{
  for(const wrongScope of [randomUUID(),'not-a-uuid','',scope+', '+scope,[scope,scope]])for(const [method,path,data] of [['GET',base],['GET',base+'/citations'],['GET',base+'/citations/'+citation.id],['POST',base+'/citations',draft],['GET',lookup()],['GET',lookup(randomUUID())]]){
   const result=await request(method,path,data,409,{'x-citation-store-id':wrongScope});assert.deepEqual(Object.keys(result),['error']);assert(!JSON.stringify(result).includes(citation.id));assert(!JSON.stringify(result).includes(scope));
  }
 });
 await check('a distinct documents database rejects the old scope before document or operation lookup',async()=>{
  const store=mkdtempSync(join(tmpdir(),'yanyu-citation-other-store-'));otherApp=researchDocuments(store,workspace);
  const otherScope=(await request('GET','/api/documents/choices',undefined,200,{},otherApp)).uploadScope;assert.notEqual(otherScope,scope);
  for(const [method,path,data] of [['GET',base],['GET',base+'/citations'],['GET',base+'/citations/'+citation.id],['POST',base+'/citations',draft],['GET',lookup()]])await request(method,path,data,409,{'x-citation-store-id':scope},otherApp);
  await request('GET',lookup(),undefined,404,{'x-citation-store-id':otherScope},otherApp);
 });
 await check('cross-document operation lookup and replay reject rather than bind to another source',async()=>{
  const other=(await request('POST','/api/documents/upload?name=other.txt',Buffer.from(text),201)).document,foreign=`/api/documents/${other.id}`;
  for(const [method,path,data] of [['GET',foreign+'/citation-operations/'+draft.operationId],['POST',foreign+'/citations',draft]]){
   const result=await request(method,path,data,409,{'x-citation-store-id':scope});assert.deepEqual(Object.keys(result),['error']);assert(!JSON.stringify(result).includes(citation.id));
  }
  assert.deepEqual((await request('GET',foreign+'/citations')).citations,[]);
 });
 await check('current workspace denial rejects even committed and absent reads, lists, reopens and replays',async()=>{
  denied.add('source');
  for(const [method,path,data] of [['GET',base],['GET',lookup()],['GET',lookup(randomUUID())],['GET',base+'/citations'],['GET',base+'/citations/'+citation.id],['POST',base+'/citations',draft]]){
   const result=await request(method,path,data,403,{'x-citation-store-id':scope});assert.deepEqual(Object.keys(result),['error']);assert(!JSON.stringify(result).includes(citation.id));
  }
  denied.clear();
 });
 await check('a delayed committed replay rechecks current workspace access after its request body arrives',async()=>{
  const raceDoc=(await request('POST','/api/documents/upload?name=race.txt&workspaceId=race-source',Buffer.from(text),201)).document;
  const raceBase=`/api/documents/${raceDoc.id}`,raceDraft={...draft,operationId:randomUUID(),documentRevision:0};
  const saved=await request('POST',raceBase+'/citations',raceDraft,201);
  let begin,release;const began=new Promise(resolve=>begin=resolve),gate=new Promise(resolve=>release=resolve);
  const req=Readable.from((async function*(){begin();await gate;yield Buffer.from(JSON.stringify(raceDraft))})());
  Object.assign(req,{method:'POST',url:raceBase+'/citations',headers:{'content-type':'application/json','x-citation-store-id':scope}});
  let result;const pending=app.handle(req,(status,body)=>result={status,body},(status,code,message)=>result={status,body:{error:{code,message}}},()=>{});
  await began;await request('PUT',raceBase+'/metadata',{name:'Moved while pending',workspaceId:'race-destination',folderId:null,revision:0});denied.add('race-destination');
  release();await pending;assert.equal(result.status,403);assert(!JSON.stringify(result.body).includes(saved.citation.id));denied.clear();
  assert.deepEqual(await request('GET',raceBase+'/citation-operations/'+raceDraft.operationId),saved);assert.deepEqual((await request('GET',raceBase+'/citations')).citations,[saved.citation]);
 });
 await check('the locked replay row is reauthorized even when moved after the caller fetched its initial row',async()=>{
  const db=new DatabaseSync(join(root,'research-documents.sqlite')),api=documentCitations(db),before=db.prepare('SELECT * FROM research_documents WHERE id=?').get(doc.id);
  db.prepare('UPDATE research_documents SET workspace_id=? WHERE id=?').run('locked-denied',doc.id);
  let checked;
  assert.throws(()=>api.create(before,draft,()=>assert.fail('Replay cannot be treated as new association'),current=>{checked=current.workspace_id;throw Object.assign(Error('Synthetic locked access denied'),{status:403})}),error=>error.status===403);
  assert.equal(checked,'locked-denied');db.prepare('UPDATE research_documents SET workspace_id=? WHERE id=?').run(before.workspace_id,doc.id);db.close();
  assert.deepEqual(await request('GET',lookup()),receipt);
 });
 await check('metadata rename and workspace movement retain the original receipt and use current source access',async()=>{
  doc=(await request('PUT',base+'/metadata',{name:'Renamed synthetic',workspaceId:'destination',folderId:null,revision:doc.revision})).document;
  denied.add('source');assert.deepEqual(await request('GET',lookup()),receipt);denied.clear();
  denied.add('destination');await request('GET',lookup(),undefined,403);await request('POST',base+'/citations',draft,403);denied.clear();
  assert.deepEqual((await request('POST',base+'/citations',draft,201)).citation,citation);
  assert.equal((await request('GET',base+'/citations')).documentName,'Renamed synthetic');assert.equal(citation.labelAtCreation,'synthetic.txt');
 });
 await check('missing association still allows only exact committed receipts, with no duplicate citation',async()=>{
  missing.add('destination');assert.deepEqual(await request('GET',lookup()),receipt);assert.deepEqual((await request('POST',base+'/citations',draft,201)).citation,citation);
  await request('POST',base+'/citations',{...draft,operationId:randomUUID(),documentRevision:doc.revision},409);missing.clear();
 });
 await check('trash allows immutable receipt checks and exact replay while blocking new citations and reopening',async()=>{
  doc=(await request('PUT',base+'/trash',{revision:doc.revision})).document;
  assert.deepEqual(await request('GET',lookup()),receipt);assert.deepEqual((await request('POST',base+'/citations',draft,201)).citation,citation);
  assert.equal((await request('GET',base+'/citations')).trashed,true);await request('GET',base+'/citations/'+citation.id,undefined,409);
  await request('POST',base+'/citations',{...draft,operationId:randomUUID(),documentRevision:doc.revision},409);
  app.close();app=researchDocuments(root,workspace);assert.deepEqual(await request('GET',lookup()),receipt);
  doc=(await request('PUT',base+'/restore',{revision:doc.revision})).document;
  assert.deepEqual((await request('GET',base+'/citations/'+citation.id)).citation,citation);
 });
 await check('every original request field remains bound and altered retries do not replace committed evidence',async()=>{
  for(const change of [{documentRevision:doc.revision},{documentSha256:'0'.repeat(64)},{textSha256:'0'.repeat(64)},{start:draft.start-1},{end:draft.end-1},{quote:'different'},{quoteSha256:'0'.repeat(64)},{note:'changed'}])await request('POST',base+'/citations',{...draft,...change},409);
  await request('POST',base+'/citations',{...draft,rangeUnit:'codepoint'},400);await request('POST',base+'/citations',{...draft,extra:true},400);
  assert.deepEqual(await request('GET',lookup()),receipt);assert.deepEqual((await request('GET',base+'/citations')).citations,[citation]);
 });
 await check('surrogate boundaries and unpaired Unicode reject, while whole emoji and original combining form recover exactly',async()=>{
  const emoji=text.indexOf('😀'),combining=text.indexOf('cafe');
  for(const [start,end] of [[emoji,emoji+1],[emoji+1,emoji+2]]){
   const quote=text.slice(start,end),bad={...draft,operationId:randomUUID(),documentRevision:doc.revision,start,end,quote,quoteSha256:hash(quote)};
   await request('POST',base+'/citations',bad,422);assert.equal((await request('GET',lookup(bad.operationId))).outcome,'absent');
  }
  await request('POST',base+'/citations',{...draft,operationId:randomUUID(),documentRevision:doc.revision,note:'\ud800'},422);
  for(const [start,end] of [[emoji,emoji+2],[combining,combining+5]]){
   const quote=text.slice(start,end),good={...draft,operationId:randomUUID(),documentRevision:doc.revision,start,end,quote,quoteSha256:hash(quote)};
   const committed=await request('POST',base+'/citations',good,201),recovered=await request('GET',lookup(good.operationId));
   assert.equal(recovered.requestSha256,fingerprint(good));assert.deepEqual(recovered.citation,committed.citation);assert.equal(recovered.citation.quote,quote);
  }
 });
 await check('retained receipts and absent outcomes reject independent source-byte text-length and hash corruption',async()=>{
  const db=new DatabaseSync(join(root,'research-documents.sqlite')),api=documentCitations(db),r=db.prepare('SELECT * FROM research_documents WHERE id=?').get(doc.id);
  for(const change of [{original:Buffer.from('changed')},{text:r.text+'changed'},{bytes:r.bytes+1},{text_bytes:r.text_bytes+1},{sha256:'0'.repeat(64)},{text_sha256:'0'.repeat(64)}])for(const operationId of [draft.operationId,randomUUID()])assert.throws(()=>api.recover({...r,...change},operationId),/integrity mismatch/);
  assert.throws(()=>db.exec('UPDATE document_citation_operations SET request_sha256=request_sha256'),/Immutable citation operation/);
  assert.throws(()=>db.exec('UPDATE document_citations SET note=note'),/Immutable citation/);db.close();
 });
 await check('tampered stored quote range and cross-document citation pointers never produce committed receipts',async()=>{
  const db=new DatabaseSync(join(root,'research-documents.sqlite')),api=documentCitations(db),r=db.prepare('SELECT * FROM research_documents WHERE id=?').get(doc.id),saved=db.prepare('SELECT * FROM document_citations WHERE id=?').get(citation.id);
  for(const change of [{start:text.indexOf('😀'),end:text.indexOf('😀')+1},{quote:'tampered'},{quote_sha256:'0'.repeat(64)},{document_sha256:'0'.repeat(64)}]){
   const malformed={...saved,id:randomUUID(),...change},operationId=randomUUID();
   db.prepare('INSERT INTO document_citations VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(malformed.id,malformed.document_id,malformed.document_sha256,malformed.text_sha256,malformed.start,malformed.end,malformed.quote,malformed.quote_sha256,malformed.note,malformed.label_at_creation,malformed.created);
   db.prepare('INSERT INTO document_citation_operations VALUES(?,?,?,?)').run(operationId,r.id,fingerprint(draft),malformed.id);
   assert.throws(()=>api.recover(r,operationId),error=>[409,422].includes(error.status));
  }
  const foreign=db.prepare('SELECT * FROM research_documents WHERE id<>? LIMIT 1').get(r.id),operationId=randomUUID();
  db.prepare('INSERT INTO document_citation_operations VALUES(?,?,?,?)').run(operationId,foreign.id,fingerprint(draft),citation.id);
  assert.throws(()=>api.recover(foreign,operationId),/integrity mismatch/);db.close();
 });
 await check('tested implementation and fixture sources remain unchanged throughout execution',async()=>assert.deepEqual(sourceSha256(),initialSources));
}catch(error){failure={message:error.message,stack:error.stack};console.error(error.stack);process.exitCode=1}finally{
 app.close();otherApp?.close();mkdirSync(new URL('../citation-recovery-evidence/',import.meta.url),{recursive:true});
 writeFileSync(new URL('../citation-recovery-evidence/BACKEND_RESULT.json',import.meta.url),JSON.stringify({passed:!failure,count:checks.length,checks,runtime:process.version,checkedAt:new Date().toISOString(),storage:root,sourceSha256:initialSources,currentSourceSha256:sourceSha256(),transport:'In-process production document handler and real temporary SQLite',scope:'Generated fixtures only; no browser, user device, credentials, private provider, model calls or external services',...(failure?{failure}:{})},null,2)+'\n');
}
if(!failure)console.log(`PASS ${checks.length} citation recovery backend checks`);
