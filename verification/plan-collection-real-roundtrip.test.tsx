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
import {effectiveManualPlanLinks,type ManualPlanSourceLink} from '../candidate/shared/manual-plans';

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
const evidence=resolve('plan-collection-evidence/real-roundtrip');
mkdirSync(evidence,{recursive:true});
const legacyDocumentId='20000000-0000-4000-8000-000000000001';
const documentIds=['20000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000003'];
const legacyJobId='30000000-0000-4000-8000-000000000001';
const jobIds=['30000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000003'];
const documentTitle='同名合成资料.pdf',transcriptTitle='同名合成转写',planTitle='混合资料集合真实服务合成验收计划';
const documentTexts=documentIds.map((id,index)=>`明确人工合成的 PDF 提取文字 ${index+1}，不是解析器、OCR 或模型输出。\n`+'甲'.repeat(4300)+`\n精确文档结尾 ${id}`);
const transcriptTexts=jobIds.map((id,index)=>`明确人工合成的转写结果 ${index+1}，没有运行音频或模型。\n`+'乙'.repeat(4300)+`\n精确转写结尾 ${id}`);
const correctedText='已保存人工合成校订，不是模型结果。\n'+transcriptTexts[0];
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
const handlerIdentity={sourceRoot:process.cwd(),serverSha256:sha(serverSource),routeDeclarationSha256:sha(routeDeclaration),callbackSha256:sha(callback),researchDocumentsSha256:sha(readFileSync(resolve('backend/research-documents.mjs'))),localTranscriptionSha256:sha(readFileSync(resolve('backend/local-transcription.mjs'))),preparedDomainSha256:sha(readFileSync(resolve('prepared-runtime/server/manual-plan-domain.mjs'))),mode:'Exact production callback and real researchDocuments/localTranscription/current prepared domain runtime, in-process request streams only'};

type Call={generation:number;path:string;method:string;requestHeaders:Record<string,string>;input:any;status:number;payload:any};
function createRealHarness(){
 const storage=mkdtempSync(join(evidence,'synthetic-storage-'));
 const principal={tenantId:'synthetic-collection-roundtrip-tenant',subjectId:'synthetic-collection-roundtrip-owner',collectionIds:[]};
 const context=()=>({principal,requestId:'synthetic-real-collection-roundtrip',signal:new AbortController().signal});
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
  const permitted=method==='POST'&&/^\/api\/manual-plans\/(create|get|list|setSessionLink|setMaterialLink|setDocumentLink|addMaterialLinks|removeMaterialLink)$/.test(path)
   ||method==='POST'&&/^\/api\/workspace\/(create|get|list)$/.test(path)
   ||method==='GET'&&/^\/api\/documents(?:\/choices|\?.*|\/[a-f0-9-]{36}(?:\/(?:reader|annotations|citations))?)$/.test(path)
   ||method==='GET'&&/^\/api\/local-asr\/(?:identity|jobs\?.*|jobs\/[a-f0-9-]{36}\/transcript)$/.test(path);
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
    // Page 1 contains selected PDF A and nine harmless fillers. PDF B and the
    // pre-existing legacy PDF are on page 2. Selected PDFs deliberately share a title.
    const rows=[
     {id:legacyDocumentId,name:'旧单文档入口.pdf',text:'明确人工合成的旧单文档，保持不变。',created:'2026-10-20T00:00:00.000Z'},
     ...documentIds.map((id,index)=>({id,name:documentTitle,text:documentTexts[index],created:index?'2026-10-21T00:00:00.000Z':'2026-10-23T00:00:00.000Z'})),
     ...Array.from({length:9},(_,index)=>({id:`20000000-0000-4000-8000-${String(20+index).padStart(12,'0')}`,name:`仅用于分页的合成资料-${index}.pdf`,text:`未选择的分页合成资料 ${index}`,created:`2026-10-22T${String(index).padStart(2,'0')}:00:00.000Z`})),
    ];
    for(const {id,name,text,created} of rows)db.prepare('INSERT INTO research_documents(id,name,format,bytes,sha256,text_sha256,created,pages,workspace_id,folder_id,original,text,search_value,text_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,name,'pdf',pdf.length,sha(pdf),sha(text),created,2,null,null,pdf,text,(name+'\n'+text).normalize('NFC').toLowerCase(),Buffer.byteLength(text));
    for(const id of [legacyDocumentId,...documentIds])db.prepare('INSERT INTO document_reader_state VALUES(?,?,?,?,?)').run(id,sha(pdf),2,1,100);
    db.prepare('INSERT INTO document_annotation_revisions VALUES(?,?,?)').run(documentIds[0],sha(pdf),1);
    db.prepare('INSERT INTO document_annotations VALUES(?,?,?,?,?,?,?,?)').run('40000000-0000-4000-8000-000000000001',documentIds[0],sha(pdf),2,null,'应保留的人工合成批注','2026-10-23T00:00:00.000Z','2026-10-23T00:00:00.000Z');
    db.prepare('INSERT INTO document_citations VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('40000000-0000-4000-8000-000000000002',documentIds[1],sha(pdf),sha(documentTexts[1]),0,4,documentTexts[1].slice(0,4),sha(documentTexts[1].slice(0,4)),'应保留的人工合成引用',documentTitle,'2026-10-23T00:00:00.000Z');
    trans.prepare('INSERT INTO transcription_jobs(id,filename,title,status,created,result,requested_language) VALUES(?,?,?,?,?,?,?)').run(legacyJobId,'legacy-synthetic-no-audio.wav','旧单转写入口','failed','2026-10-20T00:00:00.000Z',null,'zh');
    for(const [index,id] of jobIds.entries())trans.prepare('INSERT INTO transcription_jobs(id,filename,title,status,created,result,requested_language) VALUES(?,?,?,?,?,?,?)').run(id,`collection-transcript-${index?'B':'A'}-synthetic-no-audio.wav`,transcriptTitle,'completed','2026-10-23T00:00:00.000Z',JSON.stringify({text:transcriptTexts[index],duration_seconds:1,inference_seconds:0,language:'zh',language_source:'user-selected',boundaries:[]}), 'zh');
    // Both current correction and archived version are explicit fixtures, so
    // opening the actual service does not create a migration delta on reopen.
    trans.prepare('INSERT INTO transcript_corrections VALUES(?,?,?,?)').run(jobIds[0],1,correctedText,'2026-10-23T00:00:00.000Z');
    trans.prepare('INSERT INTO transcript_versions VALUES(?,?,?,?,?,?)').run(jobIds[0],1,correctedText,'2026-10-23T00:00:00.000Z','correction',null);
   }finally{db.close();trans.close();}
   writeFileSync(join(evidence,'synthetic-original.pdf'),pdf);
   writeFileSync(join(evidence,'synthetic-fixture.json'),JSON.stringify({provenance:'Direct synthetic SQLite insertion. PDF bytes, extracted text, transcript results, correction/history, reader state, citation and annotation are authored fixtures. No upload, parser, OCR, audio, ASR or AI execution.',legacyDocumentId,documentIds,legacyJobId,jobIds,documentTitle,transcriptTitle,pdfSha256:sha(pdf),documentTexts,transcriptTexts,correctedText,initialReaderPage:2},null,2)+'\n');
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
async function openPlan(){fireEvent.click(await screen.findByRole('button',{name:planTitle,exact:true}));await screen.findByLabelText('计划编辑器');}
const collection=()=>screen.getByRole('region',{name:'计划资料集合'});
const savedRows=()=>within(collection()).getAllByRole('listitem').filter(row=>row.getAttribute('aria-label')?.startsWith('已保存资料 '));
const sourceId=(link:ManualPlanSourceLink)=>link.kind==='document'?link.documentId:link.jobId;
const savedRow=(link:ManualPlanSourceLink)=>within(collection()).getByLabelText(`已保存资料 ${link.kind} ${link.kind==='document'?link.documentStoreId:link.transcriptStoreId} ${sourceId(link)}`);
const backToPlan=async()=>{
 await act(async()=>{click('后退');await new Promise(resolve=>setTimeout(resolve,100));});
 await screen.findByRole('button',{name:'为此计划查找本地资料',exact:true});
 expect(new URL(location.href).searchParams.get('page')).toBe('planner');
 expect(screen.queryByLabelText('文档查询')).toBeNull();expect(screen.queryByLabelText('转写查询')).toBeNull();
};
afterEach(async()=>{snapshot('last-render');cleanup();hosts.splice(0).forEach(host=>host.dispose());if(harness){await harness.close();harness.persist();harness=undefined;}vi.restoreAllMocks();raster.selections.length=0;localStorage.clear();sessionStorage.clear();history.replaceState(null,'','/');});

it('continuous real-service mixed collection: UI selection across pages/queries/tabs, one atomic save, all-store/host reopen, exact current PDF and transcript opening, middle removal and durable preservation',async()=>{
 const f=harness=createRealHarness();vi.spyOn(globalThis,'fetch').mockImplementation(f.fetcher);const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
 f.seed();const documentStoreId=(await f.request('/api/documents/choices')).uploadScope,transcriptStoreId=(await f.request('/api/local-asr/identity')).transcriptionStoreId;
 const targets=f.snapshot('01-synthetic-sources');
 const documentLinks=documentIds.map(documentId=>({kind:'document' as const,documentStoreId,documentId}));
 const transcriptLinks=jobIds.map(jobId=>({kind:'transcript' as const,transcriptStoreId,jobId}));
 const legacyDocument={kind:'document' as const,documentStoreId,documentId:legacyDocumentId};
 const legacyTranscript={kind:'transcript' as const,transcriptStoreId,jobId:legacyJobId};
 const additions=[...documentLinks,...transcriptLinks],allLinks=[legacyTranscript,legacyDocument,...additions];
 const w=await f.post('workspace','create',{kind:'workspace',id:'collection-real-workspace',idempotencyKey:'seed-workspace',data:{name:'应保留的普通工作区'}});
 const s=await f.post('workspace','create',{kind:'session',id:'collection-real-session',idempotencyKey:'seed-session',data:{workspaceId:w.id,title:'应保留的普通会话'}});
 const plan=await f.post('manual-plans','create',{idempotencyKey:'seed-plan',title:planTitle,objective:'私有计划目标禁止自动检索',notes:'原备注保持不变',targetDate:'2026-10-31'});
 const got=await f.post('manual-plans','get',{id:plan.id});
 const sessionLinked=await f.post('manual-plans','setSessionLink',{id:plan.id,expectedRevision:1,idempotencyKey:'seed-session-link',scope:got.storeScope,sessionLink:{workspaceId:w.id,workspaceRevision:1,sessionId:s.id,sessionRevision:1}});
 await f.post('manual-plans','setMaterialLink',{id:plan.id,expectedRevision:2,idempotencyKey:'seed-transcript-link',scope:got.storeScope,materialLink:legacyTranscript});
 const seeded=await f.post('manual-plans','setDocumentLink',{id:plan.id,expectedRevision:3,idempotencyKey:'seed-document-link',scope:got.storeScope,documentLink:legacyDocument});
 expect(seeded.data).not.toHaveProperty('materialLinks');
 let host=mount();await openPlan();expect(savedRows()).toHaveLength(2);
 const initialMaterialReads=f.calls.filter(call=>/^\/api\/documents\/[a-f0-9-]{36}$/.test(call.path)||call.path.includes('jobId='));
 expect(initialMaterialReads).toHaveLength(0);snapshot('02-legacy-union-lazy');

 // The exact same title occurs in page 1 and page 2. Identity is obtained only
 // from accepted current production search rows, never inferred from title.
 click('为此计划查找本地资料');await screen.findByText(/文档匹配：12 条/);
 fireEvent.click(screen.getByRole('button',{name:`选择文档：${documentTitle}`,exact:true}));
 await screen.findByRole('button',{name:'添加所选 1 份资料',exact:true});
 click(`取消选择文档：${documentTitle}`);click(`选择文档：${documentTitle}`);
 expect(within(screen.getByRole('region',{name:'待添加资料'})).getAllByRole('listitem')).toHaveLength(1);
 const docSearch=()=>screen.getByRole('region',{name:'本地文档搜索'});
 fireEvent.click(within(docSearch()).getByRole('button',{name:'下一页',exact:true}));
 await within(docSearch()).findByText('第 2 页');
 fireEvent.click(await within(docSearch()).findByRole('button',{name:`选择文档：${documentTitle}`,exact:true}));
 await screen.findByRole('button',{name:'添加所选 2 份资料',exact:true});
 fireEvent.click(within(docSearch()).getByRole('button',{name:'上一页',exact:true}));
 await within(docSearch()).findByRole('button',{name:`取消选择文档：${documentTitle}`,exact:true});
 // Returning to the already-selected exact result retains one selection, not a duplicate.
 expect(within(screen.getByRole('region',{name:'待添加资料'})).getAllByRole('listitem')).toHaveLength(2);
 click('转写');await screen.findByText(/转写匹配：3 条/);
 for(const [index,query] of ['collection-transcript-A','collection-transcript-B'].entries()){
  fireEvent.change(screen.getByLabelText('转写查询'),{target:{value:query}});click('搜索转写');
  await screen.findByText(`转写匹配：1 条（查询：${query}）。按本地创建时间倒序，非相关性排名。`);
  click(`选择转写：${transcriptTitle}`);await screen.findByRole('button',{name:`添加所选 ${index+3} 份资料`,exact:true});
 }
 click('文档');await within(docSearch()).findByRole('button',{name:`取消选择文档：${documentTitle}`,exact:true});
 expect(within(screen.getByRole('region',{name:'待添加资料'})).getAllByRole('listitem')).toHaveLength(4);
 expect(host.session!.hasUnsaved()).toBe(true);expect(host.session!.editor!.record!.revision).toBe(4);
 expect(f.calls.filter(call=>call.path.endsWith('/addMaterialLinks'))).toHaveLength(0);
 const docPages=f.calls.filter(call=>call.path.startsWith('/api/documents?'));
 expect(docPages.some(call=>call.payload.offset===0&&call.payload.documents.some((item:any)=>item.id===documentIds[0]))).toBe(true);
 expect(docPages.some(call=>call.payload.offset===10&&call.payload.documents.some((item:any)=>item.id===documentIds[1]))).toBe(true);
 expect(docPages.every(call=>call.requestHeaders['x-document-store-id']===documentStoreId)).toBe(true);
 snapshot('03-four-pointer-basket');

 click('添加所选 4 份资料');await waitFor(()=>expect(host.session!.editor!.record!.revision).toBe(5));
 const saved=host.session!.editor!.record!;
 expect(saved.data.materialLinks).toEqual(additions);expect(effectiveManualPlanLinks(saved.data)).toEqual(allLinks);
 expect(saved.data.materialLink).toEqual(legacyTranscript);expect(saved.data.documentLink).toEqual(legacyDocument);
 expect(saved.data.sessionLink).toEqual(sessionLinked.data.sessionLink);expect(host.session!.pending).toBeNull();expect(host.session!.hasUnsaved()).toBe(false);
 expect(savedRows()).toHaveLength(6);expect(screen.queryByRole('button',{name:'添加所选 4 份资料',exact:true})).toBeNull();
 const writes=f.calls.filter(call=>call.path.endsWith('/addMaterialLinks'));expect(writes).toHaveLength(1);
 expect(writes[0].input).toMatchObject({scope:saved.storeScope,expectedRevision:4,materialLinks:additions});
 expect(f.calls.slice(f.calls.indexOf(writes[0])+1).some(call=>call.path==='/api/manual-plans/get'&&call.input.scope===saved.storeScope&&call.payload.revision===5)).toBe(true);
 expect(f.calls.filter(call=>call.path.endsWith('/setMaterialLink'))).toHaveLength(1);expect(f.calls.filter(call=>call.path.endsWith('/setDocumentLink'))).toHaveLength(1);
 expect(f.snapshot('04-one-batch-saved-sources-intact')).toEqual(targets);snapshot('04-saved-six-effective-pointers');

 // Dispose the UI owner and every real SQLite-backed service, then reconstruct
 // each against the same directory. No in-memory plan or service survives.
 cleanup();host.dispose();await f.reopen();const beforeReopen=f.calls.length;host=mount();await openPlan();
 expect(host.session!.editor!.record).toEqual(saved);expect(savedRows()).toHaveLength(6);
 expect(f.calls.slice(beforeReopen).filter(call=>/^\/api\/documents\/[a-f0-9-]{36}$/.test(call.path)||call.path.includes('jobId='))).toHaveLength(0);
 expect((await f.request('/api/documents/choices')).uploadScope).toBe(documentStoreId);
 expect((await f.request('/api/local-asr/identity')).transcriptionStoreId).toBe(transcriptStoreId);
 expect(f.snapshot('05-all-stores-and-host-reopened')).toEqual(targets);snapshot('05-lazy-reopened-collection');

 for(const [index,link] of documentLinks.entries()){
  const before=f.calls.length;fireEvent.click(within(savedRow(link)).getByRole('button',{name:`查看当前资料：${link.documentId}`,exact:true}));
  const detail=await screen.findByRole('region',{name:'计划文档资料详情'});
  await within(detail).findByRole('heading',{name:documentTitle,exact:true});
  expect(within(detail).getByLabelText('文档提取文字').querySelector('pre')?.textContent).toBe(documentTexts[index]);
  const fresh=f.calls.slice(before),exact=fresh.find(call=>call.path===`/api/documents/${link.documentId}`);
  expect(exact).toMatchObject({generation:2,method:'GET',requestHeaders:{'x-citation-store-id':documentStoreId},payload:{storeScope:documentStoreId,document:{id:link.documentId,name:documentTitle},text:documentTexts[index]}});
  expect(fresh.filter(call=>/^\/api\/documents\/[a-f0-9-]{36}$/.test(call.path))).toHaveLength(1);
  expect(fresh.some(call=>call.path==='/api/documents/choices'&&call.payload.uploadScope===documentStoreId)).toBe(true);
  const beforeOpen=f.calls.length;click('打开已保存的当前 PDF');
  const reader=await screen.findByRole('region',{name:'PDF 页面阅读器'});await screen.findByText('第 2 / 2 页 · 缩放 100%');
  await screen.findByText('页面图片加载失败，阅读位置尚未更新。');expect(within(reader).queryByRole('img')).toBeNull();
  const admission=f.calls.slice(beforeOpen);expect(admission.filter(call=>call.path===`/api/documents/${link.documentId}`)).toHaveLength(1);
  expect(admission.some(call=>call.path==='/api/documents/choices'&&call.payload.uploadScope===documentStoreId)).toBe(true);
  expect(admission.find(call=>call.path===`/api/documents/${link.documentId}/reader`)).toMatchObject({generation:2,method:'GET',requestHeaders:{'x-document-store-id':documentStoreId},payload:{storeScope:documentStoreId,sha256:sha(pdf),pages:2,page:2,scale:100,bookmark:1}});
  expect(raster.selections[index]).toEqual({storeScope:documentStoreId,documentId:link.documentId,sha256:sha(pdf),pages:2,page:2,scale:100});
  snapshot(`06-current-pdf-${index+1}-actual-reader-raster-stopped`);await backToPlan();
 }

 for(const [index,link] of transcriptLinks.entries()){
  const before=f.calls.length;fireEvent.click(within(savedRow(link)).getByRole('button',{name:`查看当前资料：${link.jobId}`,exact:true}));
  const detail=await screen.findByRole('region',{name:'计划转写资料详情'});
  await within(detail).findByText(`当前转写：${transcriptTitle} · 转写完成。内容与状态可能继续变化。`);
  const fresh=f.calls.slice(before),lookup=fresh.find(call=>call.path.startsWith('/api/local-asr/jobs?')&&new URL(call.path,'http://local').searchParams.get('jobId')===link.jobId);
  expect(lookup?.requestHeaders['x-transcription-store-id']).toBe(transcriptStoreId);expect(lookup?.generation).toBe(2);expect(lookup?.payload.jobs.map((job:any)=>job.id)).toEqual([link.jobId]);
  const beforeOpen=f.calls.length;click('打开已保存的当前转写');
  await screen.findByRole('heading',{name:'转写资料库',exact:true});const textarea=await screen.findByLabelText('校对文本');
  expect(textarea).toHaveProperty('value',index?transcriptTexts[index]:correctedText);
  const route=new URL(location.href);expect(route.searchParams.get('page')).toBe('files');expect(route.searchParams.get('transcriptJob')).toBe(link.jobId);expect(route.searchParams.get('transcriptStoreId')).toBe(transcriptStoreId);
  const opened=f.calls.slice(beforeOpen),body=opened.find(call=>call.path===`/api/local-asr/jobs/${link.jobId}/transcript`);
  expect(body).toMatchObject({generation:2,method:'GET',requestHeaders:{'x-transcription-store-id':transcriptStoreId},payload:{raw:transcriptTexts[index],corrected:index?null:correctedText,revision:index?0:1}});
  const exactList=opened.find(call=>call.path.startsWith('/api/local-asr/jobs?'));
  expect(new URL(exactList!.path,'http://local').searchParams.get('jobId')).toBe(link.jobId);expect(exactList?.payload.jobs.map((job:any)=>job.id)).toEqual([link.jobId]);
  expect(opened.filter(call=>/\/api\/local-asr\/jobs\/[^/]+\/transcript$/.test(call.path))).toHaveLength(1);
  click('查看正文');await screen.findByText('本次已通过按钮打开正文');expect(document.activeElement).toBe(textarea);
  snapshot(`07-current-transcript-${index+1}-actual-full-body`);await backToPlan();
 }
 expect(f.snapshot('08-all-four-opened-no-source-mutation')).toEqual(targets);
 expect(raster.selections).toHaveLength(2);expect(f.calls.some(call=>call.path.includes('/page?'))).toBe(false);

 // PDF B is a middle supplemental item. Its same-title sibling and every
 // transcript/legacy/session/authored field must remain exactly unchanged.
 const removed=documentLinks[1],remaining=allLinks.filter(link=>sourceId(link)!==removed.documentId);
 fireEvent.click(within(savedRow(removed)).getByRole('button',{name:`移除资料：${removed.documentId}`,exact:true}));
 expect(confirm).toHaveBeenCalled();expect(confirm.mock.calls.at(-1)?.[0]).toContain(removed.documentId);
 await waitFor(()=>expect(host.session!.editor!.record!.revision).toBe(6));
 const afterRemove=host.session!.editor!.record!;
 expect(effectiveManualPlanLinks(afterRemove.data)).toEqual(remaining);expect(savedRows()).toHaveLength(5);
 expect(afterRemove.data).toEqual({...saved.data,materialLinks:[documentLinks[0],...transcriptLinks]});
 const removals=f.calls.filter(call=>call.path.endsWith('/removeMaterialLink'));expect(removals).toHaveLength(1);
 expect(removals[0].input).toMatchObject({scope:saved.storeScope,expectedRevision:5,materialLink:removed});
 expect(f.snapshot('09-middle-removed-all-source-records-intact')).toEqual(targets);snapshot('09-only-middle-pointer-removed');
 cleanup();host.dispose();await f.reopen();host=mount();await openPlan();
 const final=host.session!.editor!.record!;expect(final).toEqual(afterRemove);expect(effectiveManualPlanLinks(final.data)).toEqual(remaining);expect(savedRows()).toHaveLength(5);
 expect(final.data.materialLink).toEqual(legacyTranscript);expect(final.data.documentLink).toEqual(legacyDocument);expect(final.data.sessionLink).toEqual(sessionLinked.data.sessionLink);
 for(const field of ['title','objective','notes','targetDate','state'] as const)expect(final.data[field]).toEqual(plan.data[field]);
 expect(await f.post('workspace','get',{kind:'workspace',id:w.id})).toEqual(w);expect(await f.post('workspace','get',{kind:'session',id:s.id})).toEqual(s);expect(f.store.read(f.context(),(tx:any)=>tx.list('message'))).toEqual([]);
 expect(f.snapshot('10-final-all-stores-and-host-reopened')).toEqual(targets);snapshot('10-final-five-pointers');
 expect(f.calls.every(call=>call.status===200)).toBe(true);expect(f.calls.filter(call=>call.path.endsWith('/addMaterialLinks'))).toHaveLength(1);
 expect(f.calls.filter(call=>call.path.startsWith('/api/documents')&&call.method!=='GET')).toEqual([]);expect(f.calls.filter(call=>call.path.startsWith('/api/local-asr')&&call.method!=='GET')).toEqual([]);
 expect(JSON.stringify(f.calls.filter(call=>call.method==='GET'))).not.toContain(plan.data.objective);expect(JSON.stringify(f.calls.filter(call=>call.method==='GET'))).not.toContain(plan.data.notes);
 writeFileSync(join(evidence,'continuous-result.json'),JSON.stringify({result:'PASS',continuousScenarios:1,handlerIdentity,storage:f.storage,planId:plan.id,planScope:saved.storeScope,documentStoreId,transcriptStoreId,legacyDocument,legacyTranscript,additions,remaining,syntheticPrincipal:true,fixtureProvenance:'All original PDF bytes, extracted text, transcript results and nonempty correction/history/citation/annotation fixtures were inserted directly into actual service SQLite. No upload, parser, OCR, ASR or AI execution.',actualServices:'Current researchDocuments/localTranscription, fresh prepared ManualPlanDomain, WorkspaceDomain and DomainStore; exact current backend callback over in-process request streams.',selectionAcrossDocumentPages:true,selectionAcrossTranscriptQueriesAndSourceTabs:true,duplicateTitlesResolvedToExactIds:true,repeatSelectionVisibleWithoutDuplication:true,oneAtomicScopeBoundBatch:true,effectiveCountAfterSave:6,noEagerMaterialDetailFanout:true,allStoresAndHostReopenedTwice:true,eachSelectedPdfFreshPinnedDetailAndSecondAdmission:true,eachSelectedTranscriptExactSourceJobAndFullCurrentBody:true,sourceRowsBytesMetadataReaderStateCitationsAnnotationsCorrectionsHistoryUnchanged:true,rasterBoundary:'fetchPdfPageImage deliberately throws after actual PdfPageReader admission and state read. No image response or visual success fabricated.',removedOnlyMiddlePointer:true,legacySinglesSessionAuthoredFieldsAndOtherLinksPreserved:true,noTargetDeletes:true,noWorkspaceMessages:true,network:false,listener:false,browserDevice:false,ai:false,audio:false,microphone:false,fullProductAcceptance:false},null,2)+'\n');
},30000);
