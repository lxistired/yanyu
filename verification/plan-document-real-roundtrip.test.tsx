import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {DomainStore,workspaceCommandRejection} from '../prepared-runtime/server/workspace-store.mjs';
import {WorkspaceDomain} from '../prepared-runtime/server/workspace-domain.mjs';
import {ManualPlanDomain} from '../prepared-runtime/server/manual-plan-domain.mjs';
import {researchDocuments} from '../backend/research-documents.mjs';
import {localTranscription} from '../backend/local-transcription.mjs';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {ManualPlanHost} from '../candidate/src/components/manual-plan-host';

// No document response DTO, service, source gate, plan host or reader is mocked.
// Unrelated hidden report UI is excluded. Only raster fetching is deliberately
// stopped after actual PdfPageReader admission/state; image quality is NOT tested.
vi.mock('../candidate/src/components/ServiceReportsEntry',()=>({ServiceReportsEntry:()=>null}));
const raster=vi.hoisted(()=>({selections:[] as unknown[]}));
vi.mock('../candidate/src/components/pdf-page-image',async importOriginal=>({
 ...await importOriginal<typeof import('../candidate/src/components/pdf-page-image')>(),
 fetchPdfPageImage:async(selection:unknown,_signal:AbortSignal,assertCurrent:()=>void)=>{
  assertCurrent();raster.selections.push(selection);
  throw Error('Test boundary: actual PDF raster conversion and browser decoding deliberately not run');
 },
}));
const evidence=resolve('document-shortcut-evidence/real-roundtrip');
mkdirSync(evidence,{recursive:true});
const documentId='20000000-0000-4000-8000-000000000002',decoyId='20000000-0000-4000-8000-000000000003';
const jobId='30000000-0000-4000-8000-000000000004';
const title='合成同名文档.pdf',renamed='真实服务更名后的当前文档.pdf',planTitle='文档真实服务合成验收计划';
const marker='独有文档检索标记_合成验收_1346';
const extracted='这是一份明确人工合成的提取文字夹具，不是 OCR 或模型输出。\n'+'甲'.repeat(4300)+'\n'+marker+'\n末尾文字必须由真实 researchDocuments detail handler 读取。';
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');

// Minimal structurally valid two-page synthetic PDF. Extraction and rasterization
// are not claimed: both the original and extracted text are explicit fixture data.
function syntheticPdf(){
 const objects=[
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R >>',
  '<< /Length 0 >>\nstream\n\nendstream',
 ];
 let source='%PDF-1.4\n';const offsets=[0];
 objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(source));source+=`${index+1} 0 obj\n${object}\nendobj\n`;});
 const xref=Buffer.byteLength(source);source+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
 for(const offset of offsets.slice(1))source+=`${String(offset).padStart(10,'0')} 00000 n \n`;
 return Buffer.from(source+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
const pdf=syntheticPdf();
const serverSource=readFileSync(resolve('backend/server.mjs'),'utf8');
const routeDeclaration=serverSource.slice(serverSource.indexOf('const routes='),serverSource.indexOf('\nconst dist='));
const callback=serverSource.slice(serverSource.indexOf('const server=createServer(')+'const server=createServer('.length,serverSource.indexOf('\nserver.requestTimeout=')-2);
if(!callback.startsWith('async(req,res)=>{')||!callback.endsWith('}'))throw Error('Exact production handler extraction failed');
const handlerIdentity={sourceRoot:process.cwd(),serverSha256:sha(serverSource),routeDeclarationSha256:sha(routeDeclaration),callbackSha256:sha(callback),researchDocumentsSha256:sha(readFileSync(resolve('backend/research-documents.mjs'))),mode:'Exact production callback and real researchDocuments/localTranscription/current prepared domain runtime, in-process request streams only'};

type Call={generation:number;path:string;method:string;requestHeaders:Record<string,string>;input:any;status:number;payload:any};
function createRealHarness(){
 const storage=mkdtempSync(join(evidence,'synthetic-storage-'));
 const principal={tenantId:'synthetic-document-roundtrip-tenant',subjectId:'synthetic-document-roundtrip-owner',collectionIds:[]};
 const context=()=>({principal,requestId:'synthetic-real-document-roundtrip',signal:new AbortController().signal});
 let store:any,app:any,handler:any,documents:any,transcription:any,generation=0,closed=true;
 const calls:Call[]=[],logs:unknown[]=[],lifecycle:unknown[]=[];
 const open=()=>{
  store=new DomainStore(storage);app={context,workspace:new WorkspaceDomain(store),manualPlans:new ManualPlanDomain(store),workspaceCommandRejection};
  const workspace={get:(kind:string,id:string)=>app.workspace.get(context(),{kind,id}),list:(kind:string)=>{const rows:any[]=[];let offset:number|null=0;do{const page=app.workspace.list(context(),{kind,offset,limit:200});rows.push(...page.items);offset=page.nextOffset;}while(offset!==null);return rows;}};
  documents=researchDocuments(storage,workspace);transcription=localTranscription(storage,workspace);
  const pass={handle:async()=>false};
  handler=new Function('app','port','origin','assets','inventoryRoutes','handlePrivateDemo','privateDemo','inventory','documents','transcription','publishPdfImage','event','Buffer',`${routeDeclaration}\nreturn (${callback});`)(app,12345,'http://127.0.0.1:12345',new Map(),pass,async()=>false,null,pass,documents,transcription,()=>{throw Error('Raster publication out of scope');},(value:unknown)=>logs.push(value),Buffer);
  closed=false;lifecycle.push({action:'opened-all-stores',generation:++generation});
 };
 open();
 const fetcher:typeof fetch=async(input,init={})=>{
  if(closed)throw Error('Harness closed');
  const path=String(input),method=init.method??'GET';
  const permitted=method==='POST'&&/^\/api\/manual-plans\/(create|get|list|setSessionLink|setMaterialLink|setDocumentLink)$/.test(path)
   ||method==='POST'&&/^\/api\/workspace\/(create|get|list)$/.test(path)
   ||method==='GET'&&/^\/api\/documents(?:\/choices|\?.*|\/[a-f0-9-]{36}(?:\/(?:reader|annotations|citations))?)$/.test(path)
   ||method==='PUT'&&/^\/api\/documents\/[a-f0-9-]{36}\/metadata$/.test(path)
   ||method==='GET'&&/^\/api\/local-asr\/(?:identity|jobs\?.*)$/.test(path);
  if(!permitted)throw Error('Out-of-scope transport '+method+' '+path);
  const req:any=Readable.from([Buffer.from(String(init.body??''))]);req.url=path;req.method=method;
  req.headers={host:'127.0.0.1:12345',origin:'http://127.0.0.1:12345',...Object.fromEntries(new Headers(init.headers))};req.rawHeaders=Object.entries(req.headers).flat();
  let status=0,headers:Record<string,string>={},body:any;
  await handler(req,{setHeader(name:string,value:string){headers[name]=value;},writeHead(s:number,h:Record<string,string>){status=s;headers={...headers,...h};},end(value:any){body=value;}});
  if(!status||body===undefined)throw Error('Production handler response unfinished');
  const payload=JSON.parse(String(body));calls.push({generation,path,method,requestHeaders:req.headers,input:JSON.parse(String(init.body??'{}')),status,payload});
  return new Response(body,{status,headers});
 };
 const request=async(path:string,input?:unknown,method=input===undefined?'GET':'POST')=>{
  const result=await fetcher(path,{method,...(input===undefined?{}:{body:JSON.stringify(input),headers:{'Content-Type':'application/json'}})});
  const value=await result.json();if(result.status!==200)throw Error('Fixture route rejected '+JSON.stringify({path,status:result.status,value}));return value;
 };
 const inspect=()=>{
  const db=new DatabaseSync(join(storage,'research-documents.sqlite'),{readOnly:true});
  const trans=new DatabaseSync(join(storage,'long-transcription.sqlite'),{readOnly:true});
  try{
   const documentTables=['research_documents','document_folders','document_upload_identity','document_upload_operations','document_reader_state','document_citations','document_citation_operations','document_annotation_revisions','document_annotations'];
   const transcriptionTables=['transcription_jobs','transcript_corrections','transcript_versions','transcript_relationships','transcript_relationship_ops','transcription_store_identity'];
   return {documents:Object.fromEntries(documentTables.map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),transcriptions:Object.fromEntries(transcriptionTables.map(table=>[table,trans.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))};
  }finally{db.close();trans.close();}
 };
 const close=async()=>{if(closed)return;await transcription.close();documents.close();store.close();closed=true;lifecycle.push({action:'closed-all-stores',generation});};
 return {fetcher,request,calls,lifecycle,storage,context,get store(){return store;},post:(group:string,op:string,input:unknown)=>request(`/api/${group}/${op}`,input),
  seed(){
   const db=new DatabaseSync(join(storage,'research-documents.sqlite'));const trans=new DatabaseSync(join(storage,'long-transcription.sqlite'));
   try{
    for(const [id,text] of [[documentId,extracted],[decoyId,'同名的另一份合成文档，不是所选目标。']])db.prepare('INSERT INTO research_documents(id,name,format,bytes,sha256,text_sha256,created,pages,workspace_id,folder_id,original,text,search_value,text_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,title,'pdf',pdf.length,sha(pdf),sha(text),'2026-10-23T00:00:00.000Z',2,null,null,pdf,text,(title+'\n'+text).normalize('NFC').toLowerCase(),Buffer.byteLength(text));
    db.prepare('INSERT INTO document_reader_state VALUES(?,?,?,?,?)').run(documentId,sha(pdf),2,null,100);
    trans.prepare('INSERT INTO transcription_jobs(id,filename,title,status,created,result,requested_language) VALUES(?,?,?,?,?,?,?)').run(jobId,'synthetic-no-audio.wav','应保留的独立转写快捷入口','failed','2026-10-23T00:00:00.000Z',null,'zh');
   }finally{db.close();trans.close();}
   writeFileSync(join(evidence,'synthetic-original.pdf'),pdf);
   writeFileSync(join(evidence,'synthetic-fixture.json'),JSON.stringify({provenance:'Direct synthetic SQLite fixture insertion; original PDF bytes and extracted text authored here. No upload, parser, audio, ASR or AI execution.',documentId,decoyId,jobId,title,pdfSha256:sha(pdf),textSha256:sha(extracted),extracted,initialReaderPage:2},null,2)+'\n');
  },inspect,snapshot(name:string){const value=inspect();writeFileSync(join(evidence,name+'.json'),JSON.stringify(value,null,2)+'\n');return value;},
  async reopen(){await close();open();},close,persist(){writeFileSync(join(evidence,'route-trace.json'),JSON.stringify({handlerIdentity,storage,lifecycle,calls,logs,rasterSelections:raster.selections},null,2)+'\n');},
 };
}
let harness:ReturnType<typeof createRealHarness>|undefined;
const hosts:ManualPlanHost[]=[];
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name,exact:true}));
const snapshot=(name:string)=>writeFileSync(join(evidence,name+'.html'),document.body.innerHTML);
function mount(){
 const host=new ManualPlanHost(harness!.fetcher);hosts.push(host);host.activate();host.setAuthority('a'.repeat(64),true);
 history.replaceState(null,'','/?page=planner');render(<OrdinaryNavigationShell lifetime={new OrdinaryRequestLifetime()} manualPlanHost={host} identityScope={'a'.repeat(64)}/>);return host;
}
async function openPlan(){fireEvent.click(await screen.findByRole('button',{name:planTitle,exact:true}));await screen.findByLabelText('计划编辑器');click('管理单份文档快捷入口');}
const panel=()=>screen.getByRole('region',{name:'计划文档快捷入口'});
const panelTitle=async(name:string)=>{if(!screen.queryByRole('region',{name:'计划文档快捷入口'}))click('管理单份文档快捷入口');return within(panel()).findByRole('heading',{name,exact:true});};
afterEach(async()=>{snapshot('last-render');cleanup();hosts.splice(0).forEach(host=>host.dispose());if(harness){await harness.close();harness.persist();harness=undefined;}vi.restoreAllMocks();raster.selections.length=0;localStorage.clear();sessionStorage.clear();history.replaceState(null,'','/');});

it('one continuous actual document-service/plan-SQLite scenario: exact result save, all-store/host reopen, real current rename/text/PDF admission, Back, clear and reopen with transcript/session intact',async()=>{
 const f=harness=createRealHarness();vi.spyOn(globalThis,'fetch').mockImplementation(f.fetcher);const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
 f.seed();const documentStoreId=(await f.request('/api/documents/choices')).uploadScope,transcriptStoreId=(await f.request('/api/local-asr/identity')).transcriptionStoreId;
 const targets=f.snapshot('01-synthetic-targets');
 const w=await f.post('workspace','create',{kind:'workspace',id:'document-real-workspace',idempotencyKey:'seed-workspace',data:{name:'应保留工作区'}});
 const s=await f.post('workspace','create',{kind:'session',id:'document-real-session',idempotencyKey:'seed-session',data:{workspaceId:w.id,title:'应保留会话'}});
 const plan=await f.post('manual-plans','create',{idempotencyKey:'seed-plan',title:planTitle,objective:'私有计划目标禁止自动检索',notes:'原备注保持不变',targetDate:'2026-10-31'});
 const got=await f.post('manual-plans','get',{id:plan.id});
 const sessionLinked=await f.post('manual-plans','setSessionLink',{id:plan.id,expectedRevision:1,idempotencyKey:'seed-session-link',scope:got.storeScope,sessionLink:{workspaceId:w.id,workspaceRevision:1,sessionId:s.id,sessionRevision:1}});
 const materialLinked=await f.post('manual-plans','setMaterialLink',{id:plan.id,expectedRevision:2,idempotencyKey:'seed-transcript-link',scope:got.storeScope,materialLink:{kind:'transcript',transcriptStoreId,jobId}});
 let host=mount();await openPlan();click('为此计划查找本地资料');await screen.findByText(/文档匹配：2 条/);
 fireEvent.change(screen.getByLabelText('文档查询'),{target:{value:marker}});click('搜索文档');await screen.findByText(/文档匹配：1 条/);
 const result=await screen.findByRole('button',{name:`保存此文档快捷入口：${title}`,exact:true});
 const search=f.calls.find(call=>call.path.startsWith('/api/documents?')&&new URL(call.path,'http://local').searchParams.get('q')===marker);
 expect(search?.status).toBe(200);expect(search?.payload.documents.map((document:any)=>document.id)).toEqual([documentId]);
 expect(search?.requestHeaders['x-document-store-id']).toBe(documentStoreId);expect(f.calls.filter(call=>call.path.endsWith('/setDocumentLink'))).toHaveLength(0);snapshot('02-exact-result');
 fireEvent.click(result);await waitFor(()=>expect(host.session!.editor!.record!.revision).toBe(4));await panelTitle(title);
 const saved=host.session!.editor!.record!;
 expect(saved.data.documentLink).toEqual({kind:'document',documentStoreId,documentId});
 expect(saved.data.materialLink).toEqual(materialLinked.data.materialLink);expect(saved.data.sessionLink).toEqual(sessionLinked.data.sessionLink);expect(saved.data.notes).toBe(plan.data.notes);expect(saved.data.targetDate).toBe(plan.data.targetDate);expect(host.session!.pending).toBeNull();
 const writes=f.calls.filter(call=>call.path.endsWith('/setDocumentLink'));expect(writes).toHaveLength(1);
 expect(writes[0].input).toMatchObject({scope:saved.storeScope,expectedRevision:3,documentLink:{kind:'document',documentStoreId,documentId}});
 expect(f.calls.slice(f.calls.indexOf(writes[0])+1).some(call=>call.path.endsWith('/get')&&call.input.scope===saved.storeScope&&call.payload.revision===4)).toBe(true);
 expect(f.snapshot('03-after-save')).toEqual(targets);snapshot('03-saved-current-preview');

 cleanup();host.dispose();await f.reopen();host=mount();await openPlan();await panelTitle(title);
 expect(host.session!.editor!.record!.data.documentLink).toEqual(saved.data.documentLink);expect(host.session!.editor!.record!.data.materialLink).toEqual(materialLinked.data.materialLink);expect(host.session!.editor!.record!.data.sessionLink).toEqual(sessionLinked.data.sessionLink);
 expect((await f.request('/api/documents/choices')).uploadScope).toBe(documentStoreId);expect(f.snapshot('04-all-stores-reopened')).toEqual(targets);snapshot('04-reopened-plan');
 // Rename through the actual existing metadata handler AFTER reopening, not a mock variable.
 const renamedResponse=await f.request(`/api/documents/${documentId}/metadata`,{name:renamed,revision:0,workspaceId:null,folderId:null},'PUT');
 expect(renamedResponse.document).toMatchObject({id:documentId,name:renamed,revision:1,sha256:sha(pdf),textSha256:sha(extracted)});
 const beforeRefresh=f.calls.length;click('重新核验文档快捷入口');await panelTitle(renamed);
 const fresh=f.calls.slice(beforeRefresh);expect(fresh.some(call=>call.path==='/api/documents/choices'&&call.payload.uploadScope===documentStoreId)).toBe(true);
 const freshDetail=fresh.find(call=>call.path===`/api/documents/${documentId}`);expect(freshDetail).toMatchObject({generation:2,method:'GET',requestHeaders:{'x-citation-store-id':documentStoreId},payload:{storeScope:documentStoreId,document:{id:documentId,name:renamed,revision:1},text:extracted}});
 expect(within(panel()).getByLabelText('文档提取文字').querySelector('pre')?.textContent).toBe(extracted);
 const currentTargets=f.snapshot('05-renamed-current-document');
 const expectedTargets={...targets,documents:{...targets.documents,research_documents:targets.documents.research_documents.map((row:any)=>row.id===documentId?{...row,name:renamed,revision:1,search_value:(renamed+'\n'+extracted).normalize('NFC').toLowerCase()}:row)}};
 expect(currentTargets).toEqual(expectedTargets);snapshot('05-current-text');

 const beforeOpen=f.calls.length;click('打开已保存的当前 PDF');await screen.findByRole('region',{name:'PDF 页面阅读器'});await screen.findByText('第 2 / 2 页 · 缩放 100%');await screen.findByText('尚无批注');
 const reader=screen.getByRole('region',{name:'PDF 页面阅读器'});expect(within(reader).getByRole('heading',{name:renamed,exact:true})).toBeTruthy();expect(new URL(location.href).searchParams.get('page')).toBe('documents');
 const admission=f.calls.slice(beforeOpen),admissionDetail=admission.filter(call=>call.path===`/api/documents/${documentId}`);
 expect(admission.some(call=>call.path==='/api/documents/choices'&&call.payload.uploadScope===documentStoreId)).toBe(true);
 expect(admissionDetail).toHaveLength(1);expect(admissionDetail[0]).toMatchObject({generation:2,method:'GET',requestHeaders:{'x-citation-store-id':documentStoreId},payload:{storeScope:documentStoreId,document:{id:documentId,name:renamed,revision:1},text:extracted}});
 const readerReads=admission.filter(call=>call.path===`/api/documents/${documentId}/reader`);expect(readerReads).toHaveLength(1);expect(readerReads[0]).toMatchObject({generation:2,method:'GET',requestHeaders:{'x-document-store-id':documentStoreId},payload:{storeScope:documentStoreId,sha256:sha(pdf),pages:2,page:2,scale:100,bookmark:null}});
 await waitFor(()=>expect(raster.selections).toEqual([{storeScope:documentStoreId,documentId,sha256:sha(pdf),pages:2,page:2,scale:100}]));
 expect(within(reader).queryByRole('img')).toBeNull();await screen.findByText('页面图片加载失败，阅读位置尚未更新。');
 expect(f.calls.some(call=>call.path.includes('/page?'))).toBe(false);expect(f.snapshot('06-reader-admitted-no-raster')).toEqual(currentTargets);snapshot('06-actual-reader-raster-skipped');

 await act(async()=>{click('后退');await new Promise(resolve=>setTimeout(resolve,100));});await screen.findByRole('button',{name:'为此计划查找本地资料',exact:true});await panelTitle(renamed);
 expect(new URL(location.href).searchParams.get('page')).toBe('planner');expect(screen.queryByLabelText('文档查询')).toBeNull();expect(screen.queryByRole('region',{name:'PDF 页面阅读器'})).toBeNull();snapshot('07-back-to-plan-no-fabricated-search');
 click('清除文档快捷入口');expect(confirm).toHaveBeenCalledWith('是否清除此计划保存的文档快捷入口？不会删除文档，转写快捷入口及会话关联保持不变。');
 await waitFor(()=>expect(host.session!.editor!.record!.revision).toBe(5));expect(host.session!.editor!.record!.data.documentLink).toBeNull();expect(host.session!.editor!.record!.data.materialLink).toEqual(materialLinked.data.materialLink);expect(host.session!.editor!.record!.data.sessionLink).toEqual(sessionLinked.data.sessionLink);
 expect(f.snapshot('08-cleared-targets-intact')).toEqual(currentTargets);snapshot('08-cleared');
 cleanup();host.dispose();await f.reopen();const final=await f.post('manual-plans','get',{id:plan.id,scope:saved.storeScope});
 expect(final.data.documentLink).toBeNull();expect(final.data.materialLink).toEqual(materialLinked.data.materialLink);expect(final.data.sessionLink).toEqual(sessionLinked.data.sessionLink);expect(final.data.title).toBe(plan.data.title);expect(final.data.objective).toBe(plan.data.objective);expect(final.data.notes).toBe(plan.data.notes);expect(final.data.targetDate).toBe(plan.data.targetDate);
 expect(await f.post('workspace','get',{kind:'workspace',id:w.id})).toEqual(w);expect(await f.post('workspace','get',{kind:'session',id:s.id})).toEqual(s);expect(f.store.read(f.context(),(tx:any)=>tx.list('message'))).toEqual([]);
 expect(f.snapshot('09-final-all-stores-reopened')).toEqual(currentTargets);host=mount();await openPlan();await screen.findByText('未保存文档快捷入口。可在下方本地资料检索的文档结果中明确保存一个，不会替换转写快捷入口。');snapshot('09-reopened-cleared-plan');
 expect(f.calls.every(call=>call.status===200)).toBe(true);expect(f.calls.filter(call=>call.path.endsWith('/setDocumentLink'))).toHaveLength(2);
 expect(f.calls.filter(call=>call.path.startsWith('/api/documents')&&call.method!=='GET').map(call=>call.path)).toEqual([`/api/documents/${documentId}/metadata`]);expect(f.calls.filter(call=>call.path.startsWith('/api/local-asr')&&call.method!=='GET')).toEqual([]);
 expect(JSON.stringify(f.calls.filter(call=>call.method==='GET'))).not.toContain(plan.data.objective);
 writeFileSync(join(evidence,'continuous-result.json'),JSON.stringify({result:'PASS',continuousScenarios:1,handlerIdentity,storage:f.storage,documentStoreId,documentId,planId:plan.id,planScope:saved.storeScope,syntheticPrincipal:true,fixtureProvenance:'Synthetic original PDF, extracted text and transcript row inserted directly into actual service SQLite; no upload/parser/ASR executed.',actualServices:'Current real researchDocuments/localTranscription plus prepared ManualPlanDomain, WorkspaceDomain, DomainStore. Exact current backend callback, in-process transport only.',exactDuplicateTitleSelection:true,saveSurvivedAllStoresAndHostReopen:true,renamedViaActualDocumentMetadataAfterReopen:true,currentTitleAndFullExtractedText:true,freshPinnedPanelRead:true,secondLocalDocumentsAdmission:true,actualPdfPageReaderStateRead:true,resumedPersistedPage:2,rasterBoundaryStub:'fetchPdfPageImage throws deliberately; no image DTO, bytes response or visual success fabricated. Real reader admitted and showed its bounded raster-failure state.',backWithoutFabricatedSearchContext:true,clearSurvivedAllStoresAndHostReopen:true,materialLinkAndSessionLinkPreserved:true,documentBytesTextOtherMetadataStateCitationsAnnotationsPreserved:true,transcriptRowsAndWorkspaceSessionUnchanged:true,noTargetDeletes:true,network:false,listener:false,browserDevice:false,ai:false,audio:false,fullProductAcceptance:false},null,2)+'\n');
});
