import React,{StrictMode} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {registerUnsavedSession} from '../candidate/src/components/unsaved-work';
import * as unsavedHistory from '../candidate/src/components/unsaved-work';
// Real recent producer, shell, document receiver and unsaved-history state machine.
// Reader display and unrelated heavy leaves only are inert synthetic boundaries.
// SOURCE-ONLY: authored tests, not executed or validated functionality.
vi.mock('../candidate/src/components/PdfPageReader',()=>({PdfPageReader:(props:any)=><div data-testid="returned-pdf" data-id={props.documentId} data-scope={props.storeScope} data-sha={props.selectedSha256}><button onClick={props.onClose}>Close synthetic PDF</button></div>}));
vi.mock('../candidate/src/components/LocalTranscription',()=>({LocalTranscription:()=> <p data-testid="selected-transcript">{new URL(location.href).searchParams.get('transcriptJob')}</p>}));
vi.mock('../candidate/src/components/LocalResearchSearch',()=>({LocalResearchSearch:()=>null}));
vi.mock('../candidate/src/components/PrivateCompanyData',()=>({PrivateCompanyData:()=>null}));
vi.mock('../candidate/src/components/WorkspaceManager',()=>({WorkspaceManager:()=>null}));
vi.mock('../candidate/src/components/WorkspaceHostView',()=>({WorkspaceHostView:()=>null}));
vi.mock('../candidate/src/components/OrganizationHostView',()=>({OrganizationHostView:()=>null}));
vi.mock('../candidate/src/components/AutomationDefinitionHostView',()=>({AutomationDefinitionHostView:()=>null}));
vi.mock('../candidate/src/components/ManualPlanHostView',()=>({ManualPlanHostView:()=>null}));
vi.mock('../candidate/src/components/OrganizationManager',()=>({OrganizationManager:()=>null}));
vi.mock('../candidate/src/components/AutomationManager',()=>({AutomationManager:()=>null}));
vi.mock('../candidate/src/components/ServiceReportsEntry',()=>({ServiceReportsEntry:()=>null}));
vi.mock('../candidate/src/components/FeedbackSettingsEntry',()=>({FeedbackSettingsEntry:()=>null}));
vi.mock('../candidate/src/components/LocalMeetingAgenda',()=>({LocalMeetingAgenda:()=>null}));
vi.mock('../candidate/src/components/HelpContent',()=>({HelpContent:()=>null}));
vi.mock('../candidate/src/components/IntegrationCapabilities',()=>({IntegrationCapabilities:()=>null}));
const scope='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const id=(n:number)=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
const releases:(()=>void)[]=[];
afterEach(()=>{cleanup();for(const release of releases.splice(0))release();vi.restoreAllMocks();vi.unstubAllGlobals();history.replaceState(null,'','/');});
function fixture(){
 let store=scope,label='Original',missing=false;const calls:{url:URL;init:RequestInit}[]=[];
 const doc=(n:number)=>({id:id(n),name:`${label} PDF ${n}`,format:'pdf',revision:0,trashedAt:null,stale:false,sha256:'a'.repeat(64),pages:1,bytes:100,textSha256:'b'.repeat(64),createdAt:'2026-10-22T00:00:00Z',workspaceId:null,folderId:null,workspaceName:null,folderName:null});
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init:RequestInit={})=>{
  const url=new URL(String(input),location.href);calls.push({url,init});expect(init.method??'GET').toBe('GET');
  const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','X-Transcription-Store-Id':scope}});
  if(url.pathname==='/api/documents/choices')return json({uploadScope:store,workspaces:[],folders:[]});
  if(url.pathname==='/api/documents'){
   expect(new Headers(init.headers).get('X-Document-Store-Id')).toBe(store);const offset=Number(url.searchParams.get('offset'));
   return json({storeScope:store,documents:Array.from({length:11},(_,i)=>doc(i+1)).slice(offset,offset+10),total:11,offset,limit:10});
  }
  if(url.pathname.startsWith('/api/documents/')){
   expect(new Headers(init.headers).get('X-Citation-Store-Id')).toBe(store);
   return missing?json({},404):json({storeScope:store,document:doc(Number(url.pathname.slice(-12))),text:'fresh synthetic extraction'});
  }
  if(url.pathname==='/api/local-asr/identity')return json({transcriptionStoreId:scope});
  if(url.pathname==='/api/local-asr/jobs'){
   const offset=Number(url.searchParams.get('offset'));
   const jobs=Array.from({length:11},(_,i)=>({id:id(i+1),title:`Transcript ${i+1}`,filename:'synthetic.wav',status:'interrupted',created:'2024-02-29T12:00:00Z',deleted_at:null,result:null,uploadOrigin:'recording-draft',uploadOriginAssurance:'client-declared'}));
   return json({jobs:jobs.slice(offset,offset+10),total:11,offset,limit:10,hasMore:offset+10<11});
  }
  throw Error('Unadmitted synthetic return request');
 }));return {calls,setStore:(value:string)=>{store=value;},setLabel:(value:string)=>{label=value;},setMissing:()=>{missing=true;},lists:()=>calls.filter(c=>c.url.pathname==='/api/documents'),choices:()=>calls.filter(c=>c.url.pathname==='/api/documents/choices'),jobs:()=>calls.filter(c=>c.url.pathname==='/api/local-asr/jobs'),details:()=>calls.filter(c=>c.url.pathname.startsWith('/api/documents/')&&!c.url.pathname.endsWith('/choices'))};
}
function start(strict=false){history.replaceState(null,'','/?page=tasks');const lifetime=new OrdinaryRequestLifetime();const shell=<OrdinaryNavigationShell lifetime={lifetime}/>;return {...render(strict?<StrictMode>{shell}</StrictMode>:shell),lifetime};}
async function pageTwo(){await screen.findByText('Original PDF 1');fireEvent.click(within(screen.getByRole('navigation',{name:'文档入库分页'})).getByText('下一页'));await screen.findByText('Original PDF 11');}
function open(){fireEvent.click(screen.getByText('打开 PDF：Original PDF 11'));}
async function back(){await act(async()=>{history.back();await new Promise(resolve=>setTimeout(resolve,65));});}
async function forward(){await act(async()=>{history.forward();await new Promise(resolve=>setTimeout(resolve,65));});}
function retainedDraft(){const token=Symbol('synthetic retained draft');releases.push(registerUnsavedSession({token,scope:token,getState:()=>({dirty:true,pending:false})}));}
it.each([false,true])('real page 2 -> explicit PDF -> Back restores offset with fresh store/rows, StrictMode=%s',async strict=>{
 const f=fixture();start(strict);const storage=vi.spyOn(Storage.prototype,'setItem');await pageTwo();open();const reader=await screen.findByTestId('returned-pdf');
 expect(reader.dataset.id).toBe(id(11));expect(reader.dataset.scope).toBe(scope);expect(reader.dataset.sha).toBe('a'.repeat(64));
 const before=f.calls.length,choices=f.choices().length;f.setLabel('Fresh');await back();await screen.findByText('Fresh PDF 11');
 const returned=f.calls.slice(before).filter(c=>c.url.pathname.startsWith('/api/documents'));
 expect(returned[0].url.pathname).toBe('/api/documents/choices');expect(f.choices().length).toBeGreaterThan(choices);
 expect(f.lists().at(-1)!.url.searchParams.get('offset')).toBe('10');expect(f.lists().at(-1)!.init.headers).toEqual({'X-Document-Store-Id':scope});
 expect(screen.queryByText('Original PDF 11')).toBeNull();expect(screen.queryByText('fresh synthetic extraction')).toBeNull();
 expect(storage).not.toHaveBeenCalled();expect(location.search).toBe('?page=tasks');expect(JSON.stringify(history.state)).not.toMatch(/documentStoreId|offset|sha256|Fresh PDF/);
});
it('reader Close stays in documents; accepted Back returns to the saved recent page',async()=>{
 const f=fixture();start();await pageTwo();open();await screen.findByTestId('returned-pdf');fireEvent.click(screen.getByText('Close synthetic PDF'));
 expect(location.search).toBe('?page=documents');expect(screen.queryByTestId('returned-pdf')).toBeNull();await back();await screen.findByText('Original PDF 11');expect(f.lists().at(-1)!.url.searchParams.get('offset')).toBe('10');
});
it('Stay on opening and denied Back retain current epoch; accepted retry consumes the original ticket',async()=>{
 const f=fixture(),view=start();await pageTwo();retainedDraft();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 open();expect(view.lifetime.epoch).toBe(0);expect(location.search).toBe('?page=tasks');expect(screen.getByText('Original PDF 11')).toBeTruthy();
 confirm.mockReturnValue(true);open();await screen.findByTestId('returned-pdf');expect(view.lifetime.epoch).toBe(1);
 confirm.mockReturnValue(false);await back();await waitFor(()=>expect(location.search).toBe('?page=documents'));expect(view.lifetime.epoch).toBe(1);expect(screen.getByTestId('returned-pdf')).toBeTruthy();
 confirm.mockReturnValue(true);await back();await screen.findByText('Original PDF 11');expect(f.lists().at(-1)!.url.searchParams.get('offset')).toBe('10');
});
it.each(['refused','throwing'])('%s history write retains current page without a transition',async kind=>{
 fixture();const view=start();await pageTwo();const write=vi.spyOn(unsavedHistory,'writeUnsavedHistory');
 if(kind==='refused')write.mockReturnValue(false);else write.mockImplementation(()=>{throw Error('synthetic history refusal');});
 open();expect(view.lifetime.epoch).toBe(0);expect(location.search).toBe('?page=tasks');expect(screen.getByText('Original PDF 11')).toBeTruthy();expect(screen.queryByTestId('returned-pdf')).toBeNull();
});
it('changed return store blocks before list GET and explicit reload starts page 1 in new source',async()=>{
 const f=fixture();start();await pageTwo();open();await screen.findByTestId('returned-pdf');
 // PDF admission and the receiver's sibling list load finish independently.
 // Observe list readiness before measuring requests caused by the return itself.
 await screen.findByRole('heading',{name:'Original PDF 1',exact:true});
 const lists=f.lists().length;f.setStore(other);
 await back();await screen.findByText(/文档来源已变化/);expect(f.lists()).toHaveLength(lists);expect(screen.queryByText('Original PDF 11')).toBeNull();
 fireEvent.click(screen.getByText('重新载入文档来源'));await screen.findByText('Original PDF 1');expect(f.lists().at(-1)!.url.searchParams.get('offset')).toBe('0');
});
it('failed PDF admission does not discard the safe page return preference',async()=>{
 const f=fixture();start();await pageTwo();f.setMissing();open();await screen.findByText('所选 PDF 已变化或暂不可用，未打开；请在文档列表重新核对并选择。');expect(screen.queryByTestId('returned-pdf')).toBeNull();
 await back();await screen.findByText('Original PDF 11');expect(f.lists().at(-1)!.url.searchParams.get('offset')).toBe('10');
});
it('Forward never reopens PDF and a later Back cannot reuse the consumed document ticket',async()=>{
 const f=fixture();start();await pageTwo();open();await screen.findByTestId('returned-pdf');await back();await screen.findByText('Original PDF 11');const details=f.details().length;
 await forward();await waitFor(()=>expect(location.search).toBe('?page=documents'));expect(screen.queryByTestId('returned-pdf')).toBeNull();expect(f.details()).toHaveLength(details);
 await back();await screen.findByText('Original PDF 1');expect(f.lists().at(-1)!.url.searchParams.get('offset')).toBe('0');
});
it.each(['replace','ordinary','identity','remount'])('%s invalidates document return context',async kind=>{
 const f=fixture(),view=start();await pageTwo();open();await screen.findByTestId('returned-pdf');
 if(kind==='replace')fireEvent.click(screen.getByText('替换当前路由并刷新'));
 if(kind==='identity'){view.rerender(<OrdinaryNavigationShell lifetime={view.lifetime} identityScope="other"/>);view.rerender(<OrdinaryNavigationShell lifetime={view.lifetime}/>);}
 if(kind==='remount'){view.unmount();render(<OrdinaryNavigationShell lifetime={new OrdinaryRequestLifetime()}/>);}
 if(kind==='ordinary'){
  fireEvent.click(within(screen.getByRole('navigation',{name:'主导航'})).getByRole('button',{name:'首页',exact:true}));
  fireEvent.click(within(screen.getByRole('navigation',{name:'首页分组导航'})).getByRole('button',{name:'近期本地资料',exact:true}));
 }else await back();
 await screen.findByText('Original PDF 1');expect(f.lists().at(-1)!.url.searchParams.get('offset')).toBe('0');
});
it('transcript and PDF returns never restore the sibling source or resurrect each other',async()=>{
 const f=fixture();start();await pageTwo();await screen.findByText('Transcript 1');
 fireEvent.click(screen.getByRole('button',{name:/转写状态筛选/}));fireEvent.click(screen.getByLabelText('已中断'));fireEvent.click(screen.getByText('确认筛选'));await screen.findByText('Transcript 1');
 fireEvent.click(within(screen.getByRole('navigation',{name:'转写记录分页'})).getByText('下一页'));await screen.findByText('Transcript 11');fireEvent.click(screen.getByText('打开转写记录：Transcript 11'));expect(screen.getByTestId('selected-transcript').textContent).toBe(id(11));
 await back();await screen.findByText('Transcript 11');await screen.findByText('Original PDF 1');expect(f.jobs().at(-1)!.url.searchParams.get('statuses')).toBe('interrupted');expect(f.lists().at(-1)!.url.searchParams.get('offset')).toBe('0');
 await pageTwo();open();await screen.findByTestId('returned-pdf');await back();await screen.findByText('Original PDF 11');await screen.findByText('Transcript 1');
 expect(f.lists().at(-1)!.url.searchParams.get('offset')).toBe('10');expect(f.jobs().at(-1)!.url.searchParams.has('statuses')).toBe(false);expect(f.jobs().at(-1)!.url.searchParams.get('offset')).toBe('0');
});
