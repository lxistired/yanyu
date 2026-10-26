// Synthetic, in-process HTTP-handler/SQLite tests. No listener, browser or test-file cleanup.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {researchDocuments,DOCUMENT_LIMITS} from './research-documents.mjs';
import {generatedPdf} from './synthetic-reader-pdf.mjs';
import {validatePng} from './pdf-page-reader.mjs';

const root=mkdtempSync(join(tmpdir(),'yanyu-document-management-'));
const checks=[];
const evidence=new URL('../document-management-evidence/BACKEND_RESULT.json',import.meta.url);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const workspaces=new Map([['synthetic-a',{id:'synthetic-a',data:{name:'合成工作区 A'}}],['synthetic-b',{id:'synthetic-b',data:{name:'Synthetic B'}}]]);
const workspace={get(kind,id){const item=workspaces.get(id);if(!item)throw Object.assign(Error('missing synthetic workspace'),{code:'NOT_FOUND'});return item},list(){return [...workspaces.values()]}};
let app=researchDocuments(root,workspace);
let doc,folderA,folderB,folderLocal,originalDetail,originalStorage,originalNotes,originalReader,cachedImage,trashSnapshot;
const original=generatedPdf(3);
const textOriginal=Buffer.from('\ufeff合成 UTF-8 中文😀 cafe\u0301\r\nLiteral <script>not executed</script> 100%_needle\r\n');
let textDocument;
const route=(operation='',id=doc.id)=>`/api/documents/${id}${operation?'/'+operation:''}`;
const metadataDraft=(extra={})=>({name:doc.name,workspaceId:doc.workspaceId,folderId:doc.folderId,revision:doc.revision,...extra});
const dbRead=fn=>{const db=new DatabaseSync(join(root,'research-documents.sqlite'),{readOnly:true});try{return fn(db)}finally{db.close()}};
const row=()=>dbRead(db=>db.prepare('SELECT * FROM research_documents WHERE id=?').get(doc.id));
const immutable=()=>dbRead(db=>db.prepare('SELECT id,format,bytes,sha256,text_sha256,created,pages,original,text,text_bytes FROM research_documents WHERE id=?').get(doc.id));
const sidecars=()=>dbRead(db=>({notes:db.prepare('SELECT * FROM document_annotations WHERE document_id=? ORDER BY id').all(doc.id),revision:db.prepare('SELECT * FROM document_annotation_revisions WHERE document_id=?').get(doc.id),reader:db.prepare('SELECT * FROM document_reader_state WHERE document_id=?').get(doc.id)}));
const cacheSnapshot=()=>readdirSync(join(root,'pdf-page-cache')).sort().map(name=>({name,sha256:hash(readFileSync(join(root,'pdf-page-cache',name)))}));
let baselineSidecars;
async function request(method,url,data,headers={},target=app){
 if(url.split('?')[0].endsWith('/download')&&!Object.hasOwn(headers,'x-document-store-id'))headers={...headers,'x-document-store-id':(await request('GET','/api/documents/choices',undefined,{},target)).body.uploadScope};
 const bytes=Buffer.isBuffer(data)?data:Buffer.from(data===undefined?'':JSON.stringify(data));
 const req=Readable.from([bytes]);req.url=url;req.method=method;req.headers={'content-type':Buffer.isBuffer(data)?'application/octet-stream':'application/json',...headers};
 let result,calls=0;const record=value=>{calls++;result=value};
 assert.equal(await target.handle(req,(status,body)=>record({status,body}),(status,code,message)=>record({status,body:{error:{code,message}}}),(filename,bytes,sha)=>record({status:200,filename,bytes,sha}),bytes=>record({status:200,bytes})),true);
 assert.equal(calls,1,`${method} ${url} must complete exactly once`);return result;
}
async function expectStatus(method,url,data,status,headers={},target=app){const result=await request(method,url,data,headers,target);assert.equal(result.status,status,`${method} ${url}: ${JSON.stringify(result.body)}`);return result}
async function upload(name,bytes,association={},target=app){const query=new URLSearchParams({name,...association});return (await expectStatus('POST','/api/documents/upload?'+query,bytes,201,{},target)).body.document}
async function list(query={}){return (await expectStatus('GET','/api/documents?'+new URLSearchParams(query),undefined,200)).body}
async function test(name,fn){await fn();checks.push(name);console.log('PASS '+name)}
async function updateMetadata(extra={}){const previous=doc.revision;doc=(await expectStatus('PUT',route('metadata'),metadataDraft(extra),200)).body.document;assert.equal(doc.revision,previous+1);assert.equal(doc.trashedAt,null);assert.deepEqual(immutable(),originalStorage);if(baselineSidecars)assert.deepEqual(sidecars(),baselineSidecars);return doc}
async function assertRejectedUnchanged(method,url,data,status,headers={}){const before=row(),notes=sidecars();await expectStatus(method,url,data,status,headers);assert.deepEqual(row(),before);assert.deepEqual(sidecars(),notes)}
function persist(passed,error){writeFileSync(evidence,JSON.stringify({passed,count:checks.length,checks,syntheticSha256:hash(original),syntheticTextSha256:hash(textOriginal),runtime:process.version,checkedAt:new Date().toISOString(),sourceSha256:Object.fromEntries(['research-documents.mjs','pdf-page-reader.mjs','pdf-annotations.mjs','test-document-management.mjs'].map(name=>[name,hash(readFileSync(new URL('./'+name,import.meta.url)))])),transport:'In-process HTTP handlers and real SQLite; no network listeners or browser',fixtures:'Generated synthetic PDF and UTF-8 text only; no private or existing application data',retention:'Fresh synthetic temporary directories retained; tests perform no filesystem deletion or permanent-purge request',scope:'Backend management validation, concurrency, active/trash visibility, cache gating, restart/migration, sidecar retention, storage quota and content immutability',...(error?{failure:{message:error.message,stack:error.stack}}:{})},null,2)+'\n')}

try{
 await test('synthetic imports start active at revision zero with exact immutable bytes and hashes',async()=>{
  folderA=(await expectStatus('POST','/api/documents/folders',{name:'合成资料 A',workspaceId:'synthetic-a'},201)).body.folder;
  folderB=(await expectStatus('POST','/api/documents/folders',{name:'Synthetic B folder',workspaceId:'synthetic-b'},201)).body.folder;
  folderLocal=(await expectStatus('POST','/api/documents/folders',{name:'Unassigned synthetic folder',workspaceId:null},201)).body.folder;
  doc=await upload('original-only-name.pdf',original,{workspaceId:'synthetic-a',folderId:folderA.id});
  textDocument=await upload('synthetic-text.txt',textOriginal);
  assert.equal(doc.revision,0);assert.equal(doc.trashedAt,null);assert.equal(doc.sha256,hash(original));assert.equal(doc.pages,3);
  originalDetail=(await expectStatus('GET',route(),undefined,200)).body;originalStorage=immutable();
  assert.match(originalDetail.text,/Synthetic PDF page 3 needle/);assert.equal(doc.textSha256,hash(Buffer.from(originalDetail.text)));
  assert.equal((await expectStatus('GET',route('',textDocument.id),undefined,200)).body.text,textOriginal.toString('utf8'));
  assert.equal((await list()).total,2);assert.equal((await list({view:'trash'})).total,0);
 });
 await test('seed independent Unicode annotations reader state and a real bounded raster cache',async()=>{
  const note={sha256:doc.sha256,revision:0,page:2,rect:{x:.15,y:.2,width:.35,height:.25},comment:'合成注释 🌿 <script>literal</script>\n第二行'};
  await expectStatus('POST',route('annotations'),note,201);
  await expectStatus('POST',route('annotations'),{...note,revision:1,page:3,rect:null,comment:'Page-only synthetic note'},201);
  originalNotes=(await expectStatus('GET',route('annotations'),undefined,200)).body;
  originalReader=(await expectStatus('PUT',route('reader'),{page:2,bookmark:3,scale:150},200)).body;
  cachedImage=(await expectStatus('GET',route('page')+'?page=1&scale=100',undefined,200)).bytes;validatePng(cachedImage,1200);
  assert.equal(cacheSnapshot().length,1);baselineSidecars=sidecars();assert.equal(row().revision,0);
 });
 await test('metadata requires exact keys and safe nonnegative integer revisions atomically',async()=>{
  for(const revision of [-1,1.5,'0',null,Number.MAX_SAFE_INTEGER+1])await assertRejectedUnchanged('PUT',route('metadata'),metadataDraft({revision}),400);
  for(const value of [null,[],true,1,'name',{}, {...metadataDraft(),extra:true}, {name:doc.name,revision:doc.revision}, {name:doc.name,revision:doc.revision,workspaceId:null}])await assertRejectedUnchanged('PUT',route('metadata'),value,400);
 });
 await test('metadata rejects every ASCII control empty names and invalid Unicode',async()=>{
  for(const name of ['', ' \t ',null,[],5,...Array.from({length:32},(_,i)=>'synthetic'+String.fromCharCode(i)+'.pdf'),'synthetic\u007f.pdf'])await assertRejectedUnchanged('PUT',route('metadata'),metadataDraft({name}),400);
  for(const name of ['\ud800','\udfff','🌿'.repeat(129),'a'.repeat(513)])await assertRejectedUnchanged('PUT',route('metadata'),metadataDraft({name}),422);
 });
 await test('512-byte Unicode display names are accepted without changing PDF format or content',async()=>{
  await updateMetadata({name:'🌿'.repeat(128)});assert.equal(Buffer.byteLength(doc.name),512);assert.equal(doc.format,'pdf');
 });
 await test('display-name separators and extension changes never become original download paths',async()=>{
  for(const name of ['../synthetic-display.txt','folder/name.md','folder\\name.pdf']){
   await updateMetadata({name});assert.equal(doc.name,name);assert.equal(doc.format,'pdf');
   const downloaded=await expectStatus('GET',route('download'),undefined,200);assert.equal(downloaded.filename,doc.id+'.pdf');assert.deepEqual(downloaded.bytes,original);
  }
 });
 await test('literal markup and decomposed Unicode survive rename and normalized name search',async()=>{
  const name='研究 🌿 <b>literal</b> <img onerror="literal"> CAFE\u0301 100%_rename.pdf';await updateMetadata({name});assert.equal(doc.name,name);
  for(const q of ['CAFÉ','研究 🌿','<b>literal</b>','<img onerror="literal">','100%_rename']){const result=await list({q,workspaceId:'synthetic-a'});assert.equal(result.total,1);assert.equal(result.documents[0].id,doc.id)}
  assert.equal((await list({q:'original-only-name'})).total,0);assert.equal((await list({q:'Synthetic PDF page 3 needle'})).total,1);
  assert.equal((await list({q:"' OR 1=1 --"})).total,0);assert.deepEqual((await expectStatus('GET',route('annotations'),undefined,200)).body,originalNotes);
 });
 await test('cross-workspace missing and malformed associations are rejected without partial rename',async()=>{
  for(const extra of [{workspaceId:'synthetic-b',folderId:folderA.id},{workspaceId:'synthetic-a',folderId:folderB.id},{workspaceId:null,folderId:folderA.id},{workspaceId:'synthetic-a',folderId:folderLocal.id},{workspaceId:'missing-synthetic',folderId:null},{workspaceId:'synthetic-a',folderId:randomUUID()}])await assertRejectedUnchanged('PUT',route('metadata'),metadataDraft({...extra,name:'Must never commit'}),409);
  for(const extra of [{workspaceId:5},{workspaceId:''},{workspaceId:'../workspace'},{workspaceId:'a'.repeat(161)},{folderId:'bad'},{folderId:5},{folderId:''},{folderId:[folderA.id]},{workspaceId:['synthetic-a']},{folderId:{value:folderA.id}}])await assertRejectedUnchanged('PUT',route('metadata'),metadataDraft(extra),400);
 });
 await test('moves update workspace folder filters live labels and nullable associations only',async()=>{
  await updateMetadata({workspaceId:'synthetic-b',folderId:folderB.id});assert.equal(doc.workspaceName,'Synthetic B');assert.equal(doc.folderName,folderB.name);
  assert.equal((await list({workspaceId:'synthetic-a'})).total,0);assert.equal((await list({workspaceId:'synthetic-b',folderId:folderB.id})).total,1);assert.equal((await list({folderId:folderA.id})).total,0);
  await updateMetadata({folderId:null});assert.equal(doc.folderName,null);assert.equal((await list({folderId:folderB.id})).total,0);
  await updateMetadata({workspaceId:null,folderId:folderLocal.id});assert.equal(doc.workspaceName,null);assert.equal(doc.folderName,folderLocal.name);
  await updateMetadata({folderId:null});assert.equal(doc.workspaceId,null);assert.equal(doc.folderId,null);
  await updateMetadata({workspaceId:'synthetic-a',folderId:folderA.id});assert.equal((await list({workspaceId:'synthetic-a',folderId:folderA.id})).total,1);
 });
 await test('stale metadata trash and restore revisions cannot overwrite newer state',async()=>{
  for(const operation of ['metadata','trash','restore'])await assertRejectedUnchanged('PUT',route(operation),operation==='metadata'?metadataDraft({revision:doc.revision-1,name:'stale'}):{revision:doc.revision-1},409);
  await assertRejectedUnchanged('PUT',route('metadata'),metadataDraft({revision:doc.revision+1}),409);
 });
 await test('concurrent same-revision metadata writes have exactly one winner',async()=>{
  const revision=doc.revision;const results=await Promise.all(['Concurrent winner A','Concurrent winner B'].map(name=>request('PUT',route('metadata'),metadataDraft({name,revision}))));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);doc=results.find(r=>r.status===200).body.document;assert.equal(doc.revision,revision+1);assert.deepEqual(row().name,doc.name);assert.deepEqual(immutable(),originalStorage);assert.deepEqual(sidecars(),baselineSidecars);
  await updateMetadata({name:'最终合成研究 🌿 café.pdf'});
 });
 await test('management methods routes queries media encoding and JSON limits reject safely',async()=>{
  for(const operation of ['metadata','trash','restore']){
   const payload=operation==='metadata'?metadataDraft():{revision:doc.revision};
   for(const method of ['GET','POST','PATCH'])await assertRejectedUnchanged(method,route(operation),payload,405);
   for(const suffix of ['?q=x','?revision=1&revision=1'])await assertRejectedUnchanged('PUT',route(operation)+suffix,payload,400);
   await assertRejectedUnchanged('PUT',route(operation),payload,415,{'content-type':'text/plain'});
   await assertRejectedUnchanged('PUT',route(operation),payload,415,{'content-encoding':'gzip'});
   await assertRejectedUnchanged('PUT',route(operation),payload,413,{'content-length':'4097'});
   await assertRejectedUnchanged('PUT',route(operation),Buffer.from(' '.repeat(4097)),413,{'content-type':'application/json'});
   for(const bytes of [Buffer.from('{'),Buffer.from([0xff]),Buffer.alloc(0)])await assertRejectedUnchanged('PUT',route(operation),bytes,400,{'content-type':'application/json'});
   await expectStatus('PUT',route(operation,randomUUID()),payload,404);
   await expectStatus('PUT','/api/documents/'+'-'.repeat(36)+'/'+operation,payload,404);
  }
  await assertRejectedUnchanged('PUT',route('metadata/extra'),metadataDraft(),404);
  for(const query of [{view:'deleted'},{view:''}])await expectStatus('GET','/api/documents?'+new URLSearchParams(query),undefined,400);
  await expectStatus('GET','/api/documents?view=active&view=trash',undefined,400);
 });
 await test('trash and restore require only revision and reject invalid bodies atomically',async()=>{
  for(const operation of ['trash','restore'])for(const payload of [null,[],true,1,'revision',{}, {revision:-1},{revision:1.25},{revision:'0'},{revision:null},{revision:Number.MAX_SAFE_INTEGER+1},{revision:doc.revision,name:'extra'}])await assertRejectedUnchanged('PUT',route(operation),payload,400);
  await assertRejectedUnchanged('PUT',route('restore'),{revision:doc.revision},409);
 });
 await test('active renderer blocks trash with 409 and leaves complete document state untouched',async()=>{
  const before=row(),sidecarBefore=sidecars();const rendering=request('GET',route('page')+'?page=2&scale=150');
  try{const blocked=await expectStatus('PUT',route('trash'),{revision:doc.revision},409);assert.match(blocked.body.error.message,/rendering is active/i);assert.deepEqual(row(),before);assert.deepEqual(sidecars(),sidecarBefore)}finally{const result=await rendering;assert.equal(result.status,200,JSON.stringify(result.body));validatePng(result.bytes,1800)}
 });
 await test('trash increments revision once and removes document from active search filters and counts',async()=>{
  const before=await list(),revision=doc.revision;doc=(await expectStatus('PUT',route('trash'),{revision},200)).body.document;
  assert.equal(doc.revision,revision+1);assert(Number.isFinite(Date.parse(doc.trashedAt)));assert.equal((await list()).total,before.total-1);assert.equal((await list({view:'active'})).total,before.total-1);
  for(const query of [{q:'最终合成研究'},{q:'Synthetic PDF page 3 needle'},{workspaceId:'synthetic-a'},{folderId:folderA.id},{workspaceId:'synthetic-a',folderId:folderA.id}]){const result=await list(query);assert.equal(result.total,0);assert.deepEqual(result.documents,[])}
  const active=await list({limit:'1',offset:'0'});assert.equal(active.total,1);assert.equal(active.documents[0].id,textDocument.id);assert.deepEqual((await list({offset:'1',limit:'1'})).documents,[]);
  const trash=await list({view:'trash',q:'CAFÉ',workspaceId:'synthetic-a',folderId:folderA.id});assert.equal(trash.total,1);assert.deepEqual(trash.documents[0],doc);
  assert.equal((await list({view:'trash',workspaceId:'synthetic-b'})).total,0);assert.deepEqual(immutable(),originalStorage);assert.deepEqual(sidecars(),baselineSidecars);trashSnapshot=row();
 });
 await test('trashed direct text download annotations reader state and cached or new pages are inaccessible',async()=>{
  const cacheBefore=cacheSnapshot();assert(cacheBefore.length>=2);
  for(const endpoint of ['', 'download','annotations','reader','page?page=1&scale=100','page?page=2&scale=150','page?page=3&scale=75'])await expectStatus('GET',route(endpoint),undefined,404);
  await expectStatus('PUT',route('reader'),{page:1,bookmark:null,scale:75},404);
  const note={sha256:doc.sha256,revision:originalNotes.revision,page:1,rect:null,comment:'Must not write while trashed'};
  await expectStatus('POST',route('annotations'),note,404);await expectStatus('PUT',route('annotations/'+originalNotes.notes[0].id),note,404);
  await assertRejectedUnchanged('PUT',route('metadata'),metadataDraft({name:'Must not rename trash'}),409);
  await assertRejectedUnchanged('PUT',route('trash'),{revision:doc.revision},409);
  assert.deepEqual(cacheSnapshot(),cacheBefore);assert.deepEqual(row(),trashSnapshot);assert.deepEqual(sidecars(),baselineSidecars);
  assert.equal((await expectStatus('GET',route('',textDocument.id),undefined,200)).body.text,textOriginal.toString('utf8'));
 });
 await test('restart preserves trash exclusion cached-page gating revisions content and sidecars',async()=>{
  const cacheBefore=cacheSnapshot();app.close();app=researchDocuments(root,workspace);
  assert.deepEqual(row(),trashSnapshot);assert.deepEqual(immutable(),originalStorage);assert.deepEqual(sidecars(),baselineSidecars);assert.deepEqual(cacheSnapshot(),cacheBefore);
  assert.equal((await list()).total,1);assert.deepEqual((await list({view:'trash'})).documents,[doc]);
  await expectStatus('GET',route(),undefined,404);await expectStatus('GET',route('page')+'?page=1&scale=100',undefined,404);
  await assertRejectedUnchanged('PUT',route('restore'),{revision:doc.revision-1},409);
 });
 await test('concurrent restores have one winner and preserve exact identity content annotations and reader state',async()=>{
  const revision=doc.revision;const results=await Promise.all([request('PUT',route('restore'),{revision}),request('PUT',route('restore'),{revision})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  doc=results.find(r=>r.status===200).body.document;assert.equal(doc.revision,revision+1);assert.equal(doc.trashedAt,null);assert.equal(doc.id,originalDetail.document.id);
  assert.equal((await list()).total,2);assert.equal((await list({view:'trash'})).total,0);assert.equal((await list({q:'最终合成研究'})).documents[0].id,doc.id);
  assert.deepEqual(immutable(),originalStorage);assert.deepEqual(sidecars(),baselineSidecars);
  assert.deepEqual((await expectStatus('GET',route('annotations'),undefined,200)).body,originalNotes);assert.deepEqual((await expectStatus('GET',route('reader'),undefined,200)).body,originalReader);
  assert.deepEqual((await expectStatus('GET',route('page')+'?page=1&scale=100',undefined,200)).bytes,cachedImage);
 });
 await test('same-value metadata writes still advance revision without changing immutable data',async()=>{
  const previous=doc;await updateMetadata();assert.deepEqual({...doc,revision:previous.revision},previous);
 });
 await test('missing workspaces reject metadata but retain recoverable trash and restore associations',async()=>{
  const saved=workspaces.get('synthetic-a');workspaces.delete('synthetic-a');
  try{
   assert.equal((await expectStatus('GET',route(),undefined,200)).body.document.stale,true);
   await assertRejectedUnchanged('PUT',route('metadata'),metadataDraft({name:'Must reject stale target'}),409);
   doc=(await expectStatus('PUT',route('trash'),{revision:doc.revision},200)).body.document;assert.equal(doc.stale,true);
   doc=(await expectStatus('PUT',route('restore'),{revision:doc.revision},200)).body.document;assert.equal(doc.stale,true);assert.equal(doc.workspaceId,'synthetic-a');assert.equal(doc.folderId,folderA.id);
   await updateMetadata({workspaceId:null,folderId:null});assert.equal(doc.stale,false);
  }finally{workspaces.set('synthetic-a',saved)}
  await updateMetadata({workspaceId:'synthetic-a',folderId:folderA.id});assert.equal(doc.stale,false);
 });
 await test('workspace label changes are live and do not alter metadata or annotation revisions',async()=>{
  const saved=workspaces.get('synthetic-a');workspaces.set('synthetic-a',{...saved,data:{name:'Renamed synthetic workspace'}});
  const current=(await expectStatus('GET',route(),undefined,200)).body.document;assert.equal(current.workspaceName,'Renamed synthetic workspace');assert.equal(current.revision,doc.revision);assert.deepEqual(sidecars(),baselineSidecars);workspaces.set('synthetic-a',saved);
 });
 await test('TXT metadata trash restore and restart preserve exact BOM CRLF Unicode bytes and format',async()=>{
  let current=(await expectStatus('PUT',route('metadata',textDocument.id),{name:'合成 <b> CAFE\u0301.md',workspaceId:'synthetic-b',folderId:folderB.id,revision:0},200)).body.document;
  assert.equal(current.format,'txt');assert.equal(current.sha256,hash(textOriginal));
  current=(await expectStatus('PUT',route('trash',current.id),{revision:current.revision},200)).body.document;await expectStatus('GET',route('download',current.id),undefined,404);
  app.close();app=researchDocuments(root,workspace);current=(await expectStatus('PUT',route('restore',current.id),{revision:current.revision},200)).body.document;
  const result=await expectStatus('GET',route('download',current.id),undefined,200);assert.deepEqual(result.bytes,textOriginal);assert.equal(result.sha,hash(textOriginal));assert.equal(result.filename,current.id+'.txt');
  assert.equal((await expectStatus('GET',route('',current.id),undefined,200)).body.text,textOriginal.toString('utf8'));assert.equal(current.textSha256,hash(textOriginal));textDocument=current;
 });
 await test('SQLite rejects updates to every immutable content identity and extraction column',async()=>{
  const db=new DatabaseSync(join(root,'research-documents.sqlite'));try{
   const changes={id:randomUUID(),format:'txt',bytes:1,sha256:'0'.repeat(64),text_sha256:'0'.repeat(64),created:'2000-01-01T00:00:00.000Z',pages:1,original:Buffer.from('changed'),text:'changed',text_bytes:1};
   for(const [column,value] of Object.entries(changes))assert.throws(()=>db.prepare(`UPDATE research_documents SET ${column}=? WHERE id=?`).run(value,doc.id),/Immutable document content/);
   assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='document_immutable_delete'").get().sql,/BEFORE DELETE/);
  }finally{db.close()}
  assert.deepEqual(immutable(),originalStorage);assert.deepEqual(sidecars(),baselineSidecars);
 });
 await test('restore and final restart retain exact SHA download text annotations reader state and cache',async()=>{
  const cacheBefore=cacheSnapshot();app.close();app=researchDocuments(root,workspace);
  const detail=(await expectStatus('GET',route(),undefined,200)).body;assert.deepEqual(detail.document,doc);assert.equal(detail.text,originalDetail.text);
  const downloaded=await expectStatus('GET',route('download'),undefined,200);assert.deepEqual(downloaded.bytes,original);assert.equal(downloaded.sha,hash(original));assert.equal(downloaded.filename,doc.id+'.pdf');
  assert.equal(detail.document.textSha256,hash(Buffer.from(detail.text)));assert.deepEqual((await expectStatus('GET',route('annotations'),undefined,200)).body,originalNotes);assert.deepEqual((await expectStatus('GET',route('reader'),undefined,200)).body,originalReader);
  assert.deepEqual((await expectStatus('GET',route('page')+'?page=1&scale=100',undefined,200)).bytes,cachedImage);assert.deepEqual(cacheSnapshot(),cacheBefore);
 });
 await test('independent fresh process reopens restored bytes metadata text annotations reader and cache',async()=>{
  const expected={detail:(await expectStatus('GET',route(),undefined,200)).body,notes:originalNotes,reader:originalReader,download:{filename:doc.id+'.pdf',base64:original.toString('base64'),sha256:hash(original)},imageSha256:hash(cachedImage),activeTotal:(await list()).total,trashTotal:0};app.close();app=null;
  const code=`import {researchDocuments} from ${JSON.stringify(new URL('./research-documents.mjs',import.meta.url).href)};import {Readable} from 'node:stream';import {createHash} from 'node:crypto';const workspaces=new Map(${JSON.stringify([...workspaces])});const app=researchDocuments(${JSON.stringify(root)},{get(kind,id){const w=workspaces.get(id);if(!w)throw Object.assign(Error('missing'),{code:'NOT_FOUND'});return w},list(){return [...workspaces.values()]}});const id=${JSON.stringify(doc.id)};async function get(path){const req=Readable.from([]);req.url='/api/documents'+path;req.method='GET';req.headers=path.endsWith('/download')?{'x-document-store-id':(await get('/choices')).uploadScope}:{};let out;const ok=await app.handle(req,(status,body)=>out={status,body},(status,code,message)=>out={status,body:{code,message}},(filename,bytes,sha256)=>out={status:200,body:{filename,base64:bytes.toString('base64'),sha256}},bytes=>out={status:200,body:createHash('sha256').update(bytes).digest('hex')});if(!ok||out.status!==200)throw Error(JSON.stringify(out));return out.body}try{console.log(JSON.stringify({detail:await get('/'+id),notes:await get('/'+id+'/annotations'),reader:await get('/'+id+'/reader'),download:await get('/'+id+'/download'),imageSha256:await get('/'+id+'/page?page=1&scale=100'),activeTotal:(await get('')).total,trashTotal:(await get('?view=trash')).total}))}finally{app.close()}`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:15000});assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),expected);app=researchDocuments(root,workspace);
 });
 await test('legacy immutable schema migrates metadata revision and trash without rewriting content',async()=>{
  const legacyRoot=mkdtempSync(join(tmpdir(),'yanyu-document-management-legacy-')),id=randomUUID(),bytes=Buffer.from('Synthetic legacy text 🌿\r\n'),created='2020-01-01T00:00:00.000Z';
  const db=new DatabaseSync(join(legacyRoot,'research-documents.sqlite'));
  db.exec(`CREATE TABLE document_folders(id TEXT PRIMARY KEY,name TEXT NOT NULL,workspace_id TEXT,created TEXT NOT NULL);CREATE TABLE research_documents(id TEXT PRIMARY KEY,name TEXT NOT NULL,format TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,text_sha256 TEXT NOT NULL,created TEXT NOT NULL,pages INTEGER,workspace_id TEXT,folder_id TEXT REFERENCES document_folders(id),original BLOB NOT NULL,text TEXT NOT NULL,search_value TEXT NOT NULL,text_bytes INTEGER NOT NULL);CREATE TRIGGER document_immutable_update BEFORE UPDATE ON research_documents BEGIN SELECT RAISE(ABORT,'Immutable documents'); END;CREATE TRIGGER document_immutable_delete BEFORE DELETE ON research_documents BEGIN SELECT RAISE(ABORT,'Immutable documents'); END;`);
  db.prepare('INSERT INTO research_documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'legacy.txt','txt',bytes.length,hash(bytes),hash(bytes),created,null,null,null,bytes,bytes.toString(),('legacy.txt\n'+bytes).normalize('NFC').toLowerCase(),bytes.length);db.close();
  let legacy=researchDocuments(legacyRoot,workspace);try{
   let current=(await expectStatus('GET',route('',id),undefined,200,{},legacy)).body.document;assert.equal(current.revision,0);assert.equal(current.trashedAt,null);
   current=(await expectStatus('PUT',route('metadata',id),{name:'Renamed legacy.txt',workspaceId:null,folderId:null,revision:0},200,{},legacy)).body.document;
   current=(await expectStatus('PUT',route('trash',id),{revision:current.revision},200,{},legacy)).body.document;legacy.close();legacy=researchDocuments(legacyRoot,workspace);
   await expectStatus('GET',route('',id),undefined,404,{},legacy);current=(await expectStatus('PUT',route('restore',id),{revision:current.revision},200,{},legacy)).body.document;
   assert.equal(current.revision,3);assert.equal(current.createdAt,created);assert.equal(current.sha256,hash(bytes));assert.deepEqual((await expectStatus('GET',route('download',id),undefined,200,{},legacy)).bytes,bytes);
   assert.equal((await expectStatus('GET',route('',id),undefined,200,{},legacy)).body.text,bytes.toString());
  }finally{legacy.close()}
 });
 await test('trashed documents retain row and byte totals and cannot evade the 250-document quota',async()=>{
  const quotaRoot=mkdtempSync(join(tmpdir(),'yanyu-document-management-quota-'));let quotaApp=researchDocuments(quotaRoot,workspace);let first;
  try{
   for(let i=0;i<DOCUMENT_LIMITS.count;i++){const current=await upload('synthetic-quota-'+i+'.txt',Buffer.from('Synthetic quota '+i),{},quotaApp);if(i===0)first=current}
   const query=()=>{const db=new DatabaseSync(join(quotaRoot,'research-documents.sqlite'),{readOnly:true});try{return db.prepare('SELECT count(*) count,sum(bytes) bytes,sum(text_bytes) textBytes FROM research_documents').get()}finally{db.close()}};const before=query();
   first=(await expectStatus('PUT',route('trash',first.id),{revision:first.revision},200,{},quotaApp)).body.document;assert.deepEqual(query(),before);
   assert.equal((await expectStatus('GET','/api/documents',undefined,200,{},quotaApp)).body.total,249);assert.equal((await expectStatus('GET','/api/documents?view=trash',undefined,200,{},quotaApp)).body.total,1);
   for(let i=0;i<2;i++){await expectStatus('POST','/api/documents/upload?name=over-quota.txt',Buffer.from('Must not insert'),429,{},quotaApp);quotaApp.close();quotaApp=researchDocuments(quotaRoot,workspace)}
   await expectStatus('PUT',route('restore',first.id),{revision:first.revision},200,{},quotaApp);assert.deepEqual(query(),before);assert.equal((await expectStatus('GET','/api/documents',undefined,200,{},quotaApp)).body.total,250);
  }finally{quotaApp.close()}
 });
 persist(true);
 console.log(`PASS ${checks.length} document-management checks; evidence saved`);
}catch(error){persist(false,error);throw error}finally{app?.close()}
