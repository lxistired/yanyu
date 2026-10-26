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
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {ManualPlanHost} from '../candidate/src/components/manual-plan-host';
import {WorkspaceWriteHost} from '../candidate/src/components/workspace-write-host';
import {captureWorkspaceCommand} from '../candidate/src/components/workspace-write-session';
import {workspaceApi} from '../candidate/src/adapters/workspace';
import {effectiveManualPlanLinks} from '../candidate/shared/manual-plans';

// Only the unrelated, hidden report panel is excluded. The production shell,
// plan owner, viewer, clients, exact handler and fresh SQLite domains are real.
vi.mock('../candidate/src/components/ServiceReportsEntry',()=>({ServiceReportsEntry:()=>null}));
const evidence=resolve('linked-session-evidence/real-roundtrip');
mkdirSync(evidence,{recursive:true});
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const scope='a'.repeat(64),planTitle='精确关联会话只读连续合成验收';
const workspaceTitle='故意同名的工作区',sessionTitle='故意同名的会话';
const targetWorkspace='linked-target-workspace',targetSession='linked-target-session';
const otherWorkspace='linked-other-workspace',otherSession='linked-other-session';
const documentIds=Array.from({length:12},(_,index)=>`21000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`);
const messageText=(index:number)=>`目标会话人工保存消息 ${String(index).padStart(2,'0')}，仅合成记录，未调用模型。`;
const unrelatedText='绝不能显示的同名其他会话消息';
function extract(file:string){
 const source=readFileSync(file,'utf8');
 const routes=source.slice(source.indexOf('const routes='),source.indexOf('\nconst dist='));
 const callback=source.slice(source.indexOf('const server=createServer(')+'const server=createServer('.length,source.indexOf('\nserver.requestTimeout=')-2);
 if(!callback.startsWith('async(req,res)=>{')||!callback.endsWith('}'))throw Error('Exact handler extraction failed');
 return {source,routes,callback};
}
const current=extract(resolve('backend/server.mjs'));
const historical=JSON.parse(readFileSync(resolve('verification/fixtures/v79-session-open-handler.json'),'utf8')) as {provenance:{serverSha256:string;routeDeclarationSha256:string;callbackSha256:string};routes:string;callback:string};
if(sha(historical.routes)!==historical.provenance.routeDeclarationSha256||sha(historical.callback)!==historical.provenance.callbackSha256)throw Error('Historical handler fixture hash mismatch');
const handlerIdentity={sourceRoot:process.cwd(),serverSha256:sha(current.source),routeDeclarationSha256:sha(current.routes),callbackSha256:sha(current.callback),historicalServerSha256:historical.provenance.serverSha256,historicalUnsupportedCallbackSha256:sha(historical.callback),historicalRoutesSha256:sha(historical.routes),preparedDomainSha256:sha(readFileSync(resolve('prepared-runtime/server/manual-plan-domain.mjs'))),mode:'Exact current production callback and fresh real SQLite domain, no HTTP listener or network'};
type Call={generation:number;path:string;method:string;input:any;status:number;payload:any;historical:boolean};
function createHarness(name:string){
 const output=join(evidence,name);mkdirSync(output,{recursive:true});
 const storage=mkdtempSync(join(output,'sqlite-'));
 const principal={tenantId:'synthetic-linked-read-tenant',subjectId:'synthetic-linked-read-owner',collectionIds:[]};
 const context=()=>({principal,requestId:'synthetic-linked-session-read',signal:new AbortController().signal});
 let store:any,app:any,documents:any,handler:any,oldHandler:any,generation=0,closed=true,older=false;
 let holdNext=false,release:(()=>void)|null=null;
 const calls:Call[]=[],logs:unknown[]=[],lifecycle:unknown[]=[],unexpected:{path:string;method:string}[]=[];
 const open=()=>{
  store=new DomainStore(storage);app={context,workspace:new WorkspaceDomain(store),manualPlans:new ManualPlanDomain(store),workspaceCommandRejection};
  const workspace={get:(kind:string,id:string)=>app.workspace.get(context(),{kind,id}),list:(kind:string)=>app.workspace.list(context(),{kind,limit:200}).items};
  documents=researchDocuments(storage,workspace);
  const pass={handle:async()=>false};
  const compile=(source:{routes:string;callback:string})=>new Function('app','port','origin','assets','inventoryRoutes','handlePrivateDemo','privateDemo','inventory','documents','transcription','publishPdfImage','event','Buffer',`${source.routes}\nreturn (${source.callback});`)(app,12345,'http://127.0.0.1:12345',new Map(),pass,async()=>false,null,pass,documents,pass,()=>{throw Error('Unrelated PDF raster route');},(value:unknown)=>logs.push(value),Buffer);
  handler=compile(current);oldHandler=compile(historical);closed=false;lifecycle.push({action:'opened-domain-and-document-stores',generation:++generation});
 };
 open();
 const fetcher:typeof fetch=async(url,init={})=>{
  if(closed)throw Error('Harness closed');const path=String(url),method=init.method??'GET';
  const permitted=method==='POST'&&/^\/api\/(?:workspace\/(?:create|update|get|list)|manual-plans\/(?:create|get|list|setSessionLink|addMaterialLinks|linkedSession))$/.test(path)
   ||method==='GET'&&/^\/api\/documents(?:\/choices|\?.*)$/.test(path);
  if(!permitted){unexpected.push({path,method});throw Error('Out-of-scope transport '+method+' '+path);}
  const req:any=Readable.from([Buffer.from(String(init.body??''))]);req.url=path;req.method=method;
  req.headers={host:'127.0.0.1:12345',origin:'http://127.0.0.1:12345',...Object.fromEntries(new Headers(init.headers))};req.rawHeaders=Object.entries(req.headers).flat();
  let status=0,headers:Record<string,string>={},body:any;const old=older&&path.endsWith('/linkedSession');
  await (old?oldHandler:handler)(req,{setHeader(name:string,value:string){headers[name]=value;},writeHead(value:number,next:Record<string,string>){status=value;headers={...headers,...next};},end(value:any){body=value;}});
  if(!status||body===undefined)throw Error('Exact callback response unfinished');
  const payload=JSON.parse(String(body));calls.push({generation,path,method,input:JSON.parse(String(init.body??'{}')),status,payload,historical:old});
  // The actual server response is already complete. Deliberately ignore abort
  // during delivery to prove the UI fences a late successful response itself.
  if(path.endsWith('/linkedSession')&&holdNext){holdNext=false;await new Promise<void>(resolve=>{release=resolve;});release=null;}
  return new Response(body,{status,headers});
 };
 const post=async(group:string,op:string,input:any)=>{const response=await fetcher(`/api/${group}/${op}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});const value=await response.json();if(response.status!==200)throw Error('Fixture route rejected '+JSON.stringify({op,status:response.status,value}));return value;};
 const close=()=>{if(closed)return;documents.close();store.close();closed=true;lifecycle.push({action:'closed-domain-and-document-stores',generation});};
 const inspect=()=>({domainSha256:sha(readFileSync(join(storage,'data/local-workspace.sqlite'))),documentSha256:sha(readFileSync(join(storage,'research-documents.sqlite'))),records:store.read(context(),(tx:any)=>Object.fromEntries(['workspace','session','message','manual-research-plan'].map(kind=>[kind,tx.list(kind)])))});
 return {output,storage,fetcher,post,calls,unexpected,context,get store(){return store;},get app(){return app;},get held(){return release!==null;},
  hold(){holdNext=true;},release(){release?.();},older(value:boolean){older=value;},close,reopen(){close();open();},inspect,
  snapshot(name:string){const value=inspect();writeFileSync(join(output,name+'.json'),JSON.stringify(value,null,2)+'\n');return value;},
  persist(){writeFileSync(join(output,'route-trace.json'),JSON.stringify({handlerIdentity,storage,lifecycle,calls,logs,unexpected},null,2)+'\n');},
  seedDocuments(){const db=new DatabaseSync(join(storage,'research-documents.sqlite'));try{for(const [index,id] of documentIds.entries()){
   const name=`已提交查询资料-${String(index+1).padStart(2,'0')}.txt`,text=`人工合成 TXT 资料 ${index+1}`;const bytes=Buffer.from(text);
   db.prepare('INSERT INTO research_documents(id,name,format,bytes,sha256,text_sha256,created,pages,workspace_id,folder_id,original,text,search_value,text_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,name,'txt',bytes.length,sha(bytes),sha(text),`2026-10-23T${String(index).padStart(2,'0')}:00:00.000Z`,null,null,null,bytes,text,(name+'\n'+text).normalize('NFC').toLowerCase(),bytes.length);
  }}finally{db.close();}},
  // Explicit synthetic adversary fixture only, never a production read/write path.
  copyRecordsFrom(source:any,sourceScope:string){
   const records=source.store.read(source.context(),(tx:any)=>['workspace','session','message','manual-research-plan'].flatMap(kind=>tx.list(kind)));
   close();const db=new DatabaseSync(join(storage,'data/local-workspace.sqlite'));
   try{const identity=String((db.prepare('SELECT store_scope FROM manual_inventory_feature WHERE singleton=1').get() as any).store_scope);const destinationScope=sha(JSON.stringify(['manual-plan-session-v1',identity,principal.tenantId,principal.subjectId]));
    for(const row of records){const data=structuredClone(row.data);if(row.kind==='manual-research-plan'&&data.sessionLink?.scope===sourceScope)data.sessionLink.scope=destinationScope;
     db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)').run(principal.tenantId,principal.subjectId,row.kind,row.id,row.revision,row.createdAt,row.updatedAt,row.deletedAt,JSON.stringify(data));
    }
   }finally{db.close();open();}
  },
 };
}
type Harness=ReturnType<typeof createHarness>;
const harnesses:Harness[]=[],hosts:ManualPlanHost[]=[],workspaceHosts:WorkspaceWriteHost[]=[];
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name,exact:true}));
const viewer=()=>screen.getByRole('region',{name:'已关联会话只读查看'});
const linkedCalls=(f:Harness)=>f.calls.filter(call=>call.path==='/api/manual-plans/linkedSession');
const noFallback=(calls:Call[])=>expect(calls.filter(call=>call.path.startsWith('/api/workspace/'))).toEqual([]);
function mount(f:Harness,transport:typeof fetch=f.fetcher,workspaceWriteHost?:WorkspaceWriteHost){
 const host=new ManualPlanHost(transport);hosts.push(host);host.activate();host.setAuthority(scope,true);
 history.replaceState(null,'','/?page=planner');render(<OrdinaryNavigationShell lifetime={new OrdinaryRequestLifetime()} manualPlanHost={host} workspaceWriteHost={workspaceWriteHost} identityScope={scope}/>);return host;
}
async function openPlan(){fireEvent.click(await screen.findByRole('button',{name:planTitle,exact:true}));await screen.findByLabelText('计划编辑器');await waitFor(()=>expect((screen.getByRole('button',{name:'打开已关联会话（只读）'}) as HTMLButtonElement).disabled).toBe(false));}
async function seed(f:Harness,count=53){
 const make=(kind:string,id:string,data:any)=>f.post('workspace','create',{kind,id,idempotencyKey:'seed-'+id,data});
 await make('workspace',otherWorkspace,{name:workspaceTitle});await make('session',otherSession,{workspaceId:otherWorkspace,title:sessionTitle});await make('message','other-message',{sessionId:otherSession,role:'assistant',content:unrelatedText});
 await make('workspace',targetWorkspace,{name:workspaceTitle});await make('session',targetSession,{workspaceId:targetWorkspace,title:sessionTitle,mode:'deep',model:'saved-label-not-execution'});
 for(let index=1;index<=count;index++)await make('message','target-message-'+String(index).padStart(2,'0'),{sessionId:targetSession,role:index%2?'user':'assistant',content:messageText(index)});
 const plan=await f.post('manual-plans','create',{idempotencyKey:'seed-plan',title:planTitle,objective:'保持不变的已保存目标',notes:'保持不变的已保存备注',targetDate:'2026-10-31'});
 const got=await f.post('manual-plans','get',{id:plan.id});
 await f.post('manual-plans','setSessionLink',{id:plan.id,expectedRevision:1,idempotencyKey:'seed-linked-target',scope:got.storeScope,sessionLink:{workspaceId:targetWorkspace,sessionId:targetSession,workspaceRevision:1,sessionRevision:1}});
 return f.post('manual-plans','get',{id:plan.id,scope:got.storeScope});
}
afterEach(()=>{cleanup();hosts.splice(0).forEach(host=>host.dispose());workspaceHosts.splice(0).forEach(host=>host.dispose());harnesses.splice(0).forEach(f=>{f.release();f.close();f.persist();expect(f.unexpected).toEqual([]);});vi.restoreAllMocks();localStorage.clear();sessionStorage.clear();history.replaceState(null,'','/');});

it('continuous current-handler / real SQLite read-only open, all pages and close preserve reopened plan, collection, search, authored draft and hidden workspace recovery',async()=>{
 const f=createHarness('continuous');harnesses.push(f);vi.spyOn(globalThis,'fetch').mockImplementation(f.fetcher);const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 let saved=await seed(f);f.seedDocuments();const source=await f.fetcher('/api/documents/choices');const documentScope=(await source.json()).uploadScope;
 const materials=documentIds.slice(0,2).map(documentId=>({kind:'document',documentStoreId:documentScope,documentId}));
 await f.post('manual-plans','addMaterialLinks',{id:saved.id,expectedRevision:saved.revision,idempotencyKey:'seed-material-collection',scope:saved.storeScope,materialLinks:materials});saved=await f.post('manual-plans','get',{id:saved.id,scope:saved.storeScope});
 let host=mount(f);await openPlan();expect(host.session!.editor!.record).toEqual(saved);expect(linkedCalls(f)).toHaveLength(0);
 // Destroy both UI host and both stores; the second half is a fresh reload, not a retained success DTO.
 cleanup();host.dispose();f.reopen();host=mount(f);await openPlan();expect(host.session!.editor!.record).toEqual(saved);expect(linkedCalls(f)).toHaveLength(0);
 const hiddenHost=new WorkspaceWriteHost();workspaceHosts.push(hiddenHost);hiddenHost.activate();hiddenHost.setAuthority(scope,true);
 const hidden=hiddenHost.session!;hidden.setDraft({dirty:true,view:{kind:'session',workspaceId:otherWorkspace},editor:{title:'隐藏的未保存普通工作区草稿'},importText:'必须逐字保留'});
 const hiddenTransport=vi.spyOn(workspaceApi,'create').mockRejectedValue(new Error('Explicit synthetic uncertain transport fixture; no server request'));
 await hidden.submit(captureWorkspaceCommand('create',{kind:'session',id:'hidden-never-sent',data:{workspaceId:otherWorkspace,title:'隐藏的待核对会话'}},hidden.draftVersion,'hidden-uncertain-command'));
 expect(hidden.pending?.phase).toBe('unknown');const hiddenBefore={draft:hidden.draft,pending:hidden.pending,version:hidden.draftVersion,completion:hidden.completionEvent};
 // Add the real hidden WorkspaceWriteHost without replacing the plan host/session.
 cleanup();host.session!.detach();history.replaceState(null,'','/?page=planner');render(<OrdinaryNavigationShell lifetime={new OrdinaryRequestLifetime()} manualPlanHost={host} workspaceWriteHost={hiddenHost} identityScope={scope}/>);
 await screen.findByLabelText('计划编辑器');
 click('为此计划查找本地资料');await screen.findByText(/文档匹配：12 条/);
 const search=screen.getByRole('region',{name:'本地文档搜索'});const searchInput=within(search).getByLabelText('文档查询') as HTMLInputElement;
 fireEvent.change(searchInput,{target:{value:'已提交查询资料'}});fireEvent.click(within(search).getByRole('button',{name:'搜索文档'}));await screen.findByText(/文档匹配：12 条（查询：已提交查询资料）/);
 fireEvent.click(within(search).getByRole('button',{name:'下一页',exact:true}));await within(search).findByText('第 2 页');
 // Page two holds saved rows 1/2; choose a new result on page one, then return.
 fireEvent.click(within(search).getByRole('button',{name:'上一页',exact:true}));await within(search).findByText('第 1 页');
 click('选择文档：已提交查询资料-12.txt');await waitFor(()=>expect(host.session!.editor!.materialBasket).toHaveLength(1));
 fireEvent.click(within(search).getByRole('button',{name:'下一页',exact:true}));await within(search).findByText('第 2 页');
 fireEvent.change(searchInput,{target:{value:'未提交检索草稿必须保留'}});
 const objective=screen.getByLabelText('目标') as HTMLTextAreaElement;fireEvent.change(objective,{target:{value:'未保存的手工目标，打开会话不能保存或覆盖。'}});
 const editor=host.session!.editor!,editorBefore=JSON.stringify(editor),searchHtml=search.innerHTML,locationBefore=location.href;
 const persistedBefore=f.snapshot('01-before-open');const readStart=f.calls.length;
 click('打开已关联会话（只读）');await within(viewer()).findByText(messageText(1));
 expect(within(viewer()).getByText(messageText(25))).toBeTruthy();expect(within(viewer()).queryByText(messageText(26))).toBeNull();
 expect(viewer().textContent).toContain(targetWorkspace);expect(viewer().textContent).toContain(targetSession);expect(viewer().textContent).toContain(workspaceTitle);expect(viewer().textContent).toContain(sessionTitle);
 expect(viewer().textContent).not.toContain(unrelatedText);expect(within(viewer()).queryByRole('textbox')).toBeNull();
 expect(within(viewer()).getAllByRole('button').every(button=>/上一页消息|下一页消息|重新读取会话|关闭会话查看/.test(button.textContent??''))).toBe(true);
 click('下一页消息');await within(viewer()).findByText(messageText(26));expect(within(viewer()).getByText(messageText(50))).toBeTruthy();expect(within(viewer()).queryByText(messageText(1))).toBeNull();
 click('下一页消息');await within(viewer()).findByText(messageText(53));expect((screen.getByRole('button',{name:'下一页消息'}) as HTMLButtonElement).disabled).toBe(true);
 click('上一页消息');await within(viewer()).findByText(messageText(26));click('上一页消息');await within(viewer()).findByText(messageText(1));
 const pages=linkedCalls(f);expect(pages.map(call=>call.input.offset)).toEqual([0,25,50,25,0]);
 for(const call of pages){expect(call).toMatchObject({generation:2,status:200,input:{id:saved.id,expectedRevision:saved.revision,scope:saved.storeScope,sessionLink:saved.data.sessionLink,limit:25},payload:{scope:saved.storeScope,planId:saved.id,planRevision:saved.revision,sessionLink:saved.data.sessionLink,total:53}});expect(call.payload.items.every((row:any)=>row.kind==='message'&&row.data.sessionId===targetSession&&row.deletedAt===null)).toBe(true);expect(call.input).not.toHaveProperty('idempotencyKey');}
 writeFileSync(join(f.output,'02-viewer-first-page.html'),document.body.innerHTML);
 click('关闭会话查看');expect(screen.queryByRole('region',{name:'已关联会话只读查看'})).toBeNull();
 expect(host.session!.editor).toBe(editor);expect(JSON.stringify(host.session!.editor)).toBe(editorBefore);expect(effectiveManualPlanLinks(host.session!.editor!.record!.data)).toEqual(materials);
 expect(screen.getByLabelText('目标')).toBe(objective);expect(screen.getByRole('region',{name:'本地文档搜索'})).toBe(search);expect(search.innerHTML).toBe(searchHtml);expect(searchInput.value).toBe('未提交检索草稿必须保留');expect(location.href).toBe(locationBefore);
 expect({draft:hidden.draft,pending:hidden.pending,version:hidden.draftVersion,completion:hidden.completionEvent}).toEqual(hiddenBefore);expect(hidden.pending).toBe(hiddenBefore.pending);expect(hiddenTransport).toHaveBeenCalledTimes(1);expect(confirm).not.toHaveBeenCalled();
 expect(f.snapshot('03-after-close')).toEqual(persistedBefore);noFallback(f.calls.slice(readStart));expect(f.calls.slice(readStart).every(call=>call.path==='/api/manual-plans/linkedSession')).toBe(true);
 // Close an in-flight real response and then deliberately deliver it after abort.
 f.hold();click('打开已关联会话（只读）');await waitFor(()=>expect(f.held).toBe(true));click('关闭会话查看');await act(async()=>{f.release();await new Promise(resolve=>setTimeout(resolve,20));});
 expect(screen.queryByRole('region',{name:'已关联会话只读查看'})).toBeNull();expect(JSON.stringify(host.session!.editor)).toBe(editorBefore);expect(search.innerHTML).toBe(searchHtml);expect(f.inspect()).toEqual(persistedBefore);
 writeFileSync(join(f.output,'flow-result.json'),JSON.stringify({result:'PASS',handlerIdentity,planId:saved.id,exactSavedSession:saved.data.sessionLink,messageCount:53,messagePageOffsets:[0,25,50,25,0],allStoresAndHostReopened:true,noEagerMessageRead:true,unsavedAuthoredEditBasketAndMountedCommittedSearchPreserved:true,hiddenWorkspacePendingAndDraftPreserved:true,lateResponseAfterCloseDiscarded:true,allDatabaseBytesUnchanged:true,unscopedWorkspaceFallback:false,aiOrModelExecution:false,skipped:['browser/device: 受阻跳过','HTTP listener/network','full product parity']},null,2)+'\n');
},30000);

it('rejects changed target and identical-ID replacement store; exact historical unsupported handler never causes unscoped fallback',async()=>{
 const f=createHarness('guarded'),replacement=createHarness('replacement-store');harnesses.push(f,replacement);const saved=await seed(f,2);replacement.copyRecordsFrom(f,saved.storeScope);
 const replacementPlan=await replacement.post('manual-plans','get',{id:saved.id});expect(replacementPlan.id).toBe(saved.id);expect(replacementPlan.revision).toBe(saved.revision);expect(replacementPlan.storeScope).not.toBe(saved.storeScope);expect(replacementPlan.data.sessionLink.sessionId).toBe(saved.data.sessionLink.sessionId);
 let selected=f;const transport:typeof fetch=(url,init)=>selected.fetcher(url,init);vi.spyOn(globalThis,'fetch').mockImplementation(transport);mount(f,transport);await openPlan();
 const before=f.inspect(),otherBefore=replacement.inspect(),start=f.calls.length;
 selected=replacement;click('打开已关联会话（只读）');await within(viewer()).findByRole('alert');expect(viewer().textContent).toMatch(/不可用/);expect(viewer().textContent).not.toContain(messageText(1));expect(linkedCalls(replacement).at(-1)?.status).not.toBe(200);click('关闭会话查看');
 selected=f;f.older(true);click('打开已关联会话（只读）');await within(viewer()).findByRole('alert');expect(viewer().textContent).toMatch(/不可用/);expect(linkedCalls(f).at(-1)).toMatchObject({historical:true,status:404});expect(viewer().textContent).not.toContain(messageText(1));click('关闭会话查看');f.older(false);
 expect(f.inspect()).toEqual(before);expect(replacement.inspect()).toEqual(otherBefore);noFallback(f.calls.slice(start));noFallback(replacement.calls);
 await f.post('workspace','update',{kind:'session',id:targetSession,expectedRevision:1,idempotencyKey:'synthetic-target-changed',patch:{title:sessionTitle+'（版本已改）'}});const changed=f.inspect(),changedStart=f.calls.length;
 click('打开已关联会话（只读）');await within(viewer()).findByRole('alert');expect(viewer().textContent).toMatch(/不可用/);expect(linkedCalls(f).at(-1)?.status).not.toBe(200);expect(viewer().textContent).not.toContain(messageText(1));expect(f.inspect()).toEqual(changed);noFallback(f.calls.slice(changedStart));
 const durable=await f.post('manual-plans','get',{id:saved.id,scope:saved.storeScope});expect(durable).toEqual(saved);
 writeFileSync(join(f.output,'guard-results.json'),JSON.stringify({result:'PASS',wrongStoreIdenticalOwnerIdsRevisionsAndTitlesRejected:true,historicalUnsupportedHandlerStatus:404,targetRevisionChangedRejected:true,noAutomaticRelinking:true,noFallback:true,databaseReadPhasesUnchanged:true},null,2)+'\n');
},15000);

it('same-scope forced host generation replacement invalidates a delayed successful opening',async()=>{
 const f=createHarness('host-replacement');harnesses.push(f);await seed(f,2);vi.spyOn(globalThis,'fetch').mockImplementation(f.fetcher);const host=mount(f);await openPlan();
 const before=f.inspect(),oldSession=host.session,start=f.calls.length;f.hold();click('打开已关联会话（只读）');await waitFor(()=>expect(f.held).toBe(true));
 act(()=>{host.setAuthority(scope,true);});expect(host.session).not.toBe(oldSession);
 await act(async()=>{f.release();await new Promise(resolve=>setTimeout(resolve,20));});expect(screen.queryByRole('region',{name:'已关联会话只读查看'})).toBeNull();expect(screen.queryByText(messageText(1))).toBeNull();
 await openPlan();expect(screen.queryByRole('region',{name:'已关联会话只读查看'})).toBeNull();expect(linkedCalls(f)).toHaveLength(1);expect(f.inspect()).toEqual(before);noFallback(f.calls.slice(start));
 click('打开已关联会话（只读）');await within(viewer()).findByText(messageText(1));expect(linkedCalls(f)).toHaveLength(2);expect(f.inspect()).toEqual(before);
 writeFileSync(join(f.output,'guard-results.json'),JSON.stringify({result:'PASS',sameScopeNewGenerationInvalidatesLateRead:true,reopeningPlanDoesNotRestoreOpeningGrant:true,explicitNewOpenRequired:true,noWrites:true},null,2)+'\n');
},15000);
