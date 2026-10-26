import React,{useState} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {registerUnsavedSession,useUnsavedWork,writeUnsavedHistory} from '../candidate/src/components/unsaved-work';
import * as unsavedHistory from '../candidate/src/components/unsaved-work';
// Keep the actual recent-materials component, shell, route selector and unsaved/history
// implementation. Unrelated leaves are inert synthetic boundaries, not exercised here.
vi.mock('../candidate/src/components/WorkspaceManager',()=>({WorkspaceManager:()=>{const [draft,setDraft]=useState('');useUnsavedWork(!!draft);return <input aria-label="Synthetic workspace draft" value={draft} onChange={event=>setDraft(event.target.value)}/>;}}));
vi.mock('../candidate/src/components/LocalTranscription',()=>({LocalTranscription:()=> <p data-testid="exact-transcript">{new URL(location.href).searchParams.get('transcriptJob')}</p>}));
vi.mock('../candidate/src/components/LocalDocuments',()=>({LocalDocuments:()=>null}));
vi.mock('../candidate/src/components/LocalResearchSearch',()=>({LocalResearchSearch:()=>null}));
vi.mock('../candidate/src/components/PrivateCompanyData',()=>({PrivateCompanyData:()=>null}));
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
// SOURCE-ONLY: authored assertions, not executed or passed in this overlay.
const scope='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const id=(n:number)=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
const releases:(()=>void)[]=[];
afterEach(()=>{cleanup();for(const release of releases.splice(0))release();vi.restoreAllMocks();vi.unstubAllGlobals();history.replaceState(null,'','/');});
function fixture(){
 let store=scope;const calls:URL[]=[];
 vi.stubGlobal('fetch',vi.fn((input:string,init:RequestInit)=>{
  const url=new URL(input,location.href);calls.push(url);expect(init.method).toBe('GET');
  const json=(value:unknown)=>Promise.resolve(new Response(JSON.stringify(value),{headers:{'X-Transcription-Store-Id':store}}));
  if(url.pathname==='/api/documents/choices')return json({uploadScope:scope});
  if(url.pathname==='/api/documents')return json({storeScope:scope,documents:[],total:0,offset:0,limit:10});
  if(url.pathname==='/api/local-asr/identity')return json({transcriptionStoreId:store});
  if(url.pathname==='/api/local-asr/jobs'){
   expect(init.headers).toEqual({'X-Transcription-Store-Id':store});const offset=Number(url.searchParams.get('offset'));
   const rows=Array.from({length:11},(_,i)=>({id:id(i+1),title:`Return transcript ${i+1}`,filename:'synthetic.wav',status:'interrupted',created:'2024-02-29T12:00:00.000Z',deleted_at:null,result:null,uploadOrigin:'recording-draft',uploadOriginAssurance:'client-declared'}));
   return json({jobs:rows.slice(offset,offset+10),total:11,offset,limit:10,hasMore:offset+10<11});
  }throw Error('Unadmitted synthetic return request');
 }));return {calls,setStore:(value:string)=>{store=value;},jobs:()=>calls.filter(url=>url.pathname==='/api/local-asr/jobs'),identities:()=>calls.filter(url=>url.pathname==='/api/local-asr/identity')};
}
function start(){history.replaceState(null,'','/?page=tasks');const lifetime=new OrdinaryRequestLifetime();const view=render(<OrdinaryNavigationShell lifetime={lifetime}/>);return {...view,lifetime};}
async function filteredSecondPage(){
 await screen.findByText('Return transcript 1');
 fireEvent.click(screen.getByRole('button',{name:/转写状态筛选/}));fireEvent.click(screen.getByLabelText('已中断'));fireEvent.click(screen.getByText('确认筛选'));await screen.findByText('Return transcript 1');
 fireEvent.click(screen.getByText('提交入口筛选'));fireEvent.change(screen.getByLabelText('提交入口（客户端声明）'),{target:{value:'recording-draft'}});fireEvent.click(screen.getByText('应用入口筛选'));await screen.findByText('Return transcript 1');
 fireEvent.click(screen.getByText('创建日期筛选'));fireEvent.change(screen.getByLabelText('开始日期（UTC）'),{target:{value:'2024-02-29'}});fireEvent.change(screen.getByLabelText('结束日期（UTC，含当天）'),{target:{value:'2024-02-29'}});fireEvent.click(screen.getByText('应用日期筛选'));await screen.findByText('Return transcript 1');
 fireEvent.click(within(screen.getByRole('navigation',{name:'转写记录分页'})).getByText('下一页'));await screen.findByText('Return transcript 11');
}
function open(){fireEvent.click(screen.getByText('打开转写记录：Return transcript 11'));}
async function back(){await act(async()=>{history.back();await new Promise(resolve=>setTimeout(resolve,65));});}
function assertFiltered(url:URL,offset='10'){expect(Object.fromEntries(url.searchParams)).toEqual({q:'',scope:'active',offset,limit:'10',statuses:'interrupted',createdFrom:'2024-02-29',createdThrough:'2024-02-29',origin:'recording-draft'});}
function retainedDraft(){const token=Symbol('synthetic return draft');releases.push(registerUnsavedSession({token,scope:token,getState:()=>({dirty:true,pending:false})}));}
it('accepted exact transcript Back restores only committed filters/page and freshly rereads the source',async()=>{
 const f=fixture();start();await filteredSecondPage();
 // Uncommitted edits must not leak into the return ticket.
 fireEvent.click(screen.getByText('提交入口筛选'));fireEvent.change(screen.getByLabelText('提交入口（客户端声明）'),{target:{value:'unknown'}});
 fireEvent.click(screen.getByText('创建日期筛选'));fireEvent.change(screen.getByLabelText('开始日期（UTC）'),{target:{value:'2025-01-01'}});
 open();expect(screen.getByTestId('exact-transcript').textContent).toBe(id(11));expect(new URL(location.href).searchParams.size).toBe(3);
 await back();await screen.findByText('Return transcript 11');assertFiltered(f.jobs().at(-1)!);expect(f.identities()).toHaveLength(2);
 expect(screen.getByText('第 2 页 · 当前筛选共 11 条')).toBeTruthy();
 fireEvent.click(screen.getByText('提交入口筛选'));expect((screen.getByLabelText('提交入口（客户端声明）') as HTMLSelectElement).value).toBe('recording-draft');
 fireEvent.click(screen.getByText('创建日期筛选'));expect((screen.getByLabelText('开始日期（UTC）') as HTMLInputElement).value).toBe('2024-02-29');
});
it('Stay on opening and denied Back keep current epoch; accepted retry restores the ticket',async()=>{
 const f=fixture(),view=start();await filteredSecondPage();retainedDraft();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 open();expect(view.lifetime.epoch).toBe(0);expect(screen.queryByTestId('exact-transcript')).toBeNull();assertFiltered(f.jobs().at(-1)!);
 confirm.mockReturnValue(true);open();expect(view.lifetime.epoch).toBe(1);
 confirm.mockReturnValue(false);await back();await waitFor(()=>expect(location.search).toContain('page=files'));expect(view.lifetime.epoch).toBe(1);expect(screen.getByTestId('exact-transcript')).toBeTruthy();
 confirm.mockReturnValue(true);await back();await screen.findByText('Return transcript 11');assertFiltered(f.jobs().at(-1)!);
});
it('a changed return source blocks before jobs; only explicit reload admits the new source',async()=>{
 const f=fixture();start();await filteredSecondPage();open();const jobs=f.jobs().length;f.setStore(other);
 await back();await screen.findByRole('alert');expect(f.jobs()).toHaveLength(jobs);expect(screen.queryByText('Return transcript 11')).toBeNull();expect((screen.getByText('刷新转写记录') as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByText('重新载入转写来源'));await screen.findByText('Return transcript 1');assertFiltered(f.jobs().at(-1)!,'0');
});
it('a refused history write retains the filtered view and creates no route transition',async()=>{
 const f=fixture(),view=start();await filteredSecondPage();vi.spyOn(unsavedHistory,'writeUnsavedHistory').mockReturnValue(false);open();
 expect(view.lifetime.epoch).toBe(0);expect(location.search).toBe('?page=tasks');expect(screen.getByText('Return transcript 11')).toBeTruthy();assertFiltered(f.jobs().at(-1)!);
});
it('explicit shell replace on the transcript consumes no old return context',async()=>{
 const f=fixture();start();await filteredSecondPage();open();fireEvent.click(screen.getByText('替换当前路由并刷新'));await back();await screen.findByText('Return transcript 1');
 expect(f.jobs().at(-1)!.searchParams.get('offset')).toBe('0');expect(f.jobs().at(-1)!.searchParams.has('origin')).toBe(false);
});
it('ordinary navigation back to tasks is a fresh view, not a return ticket',async()=>{
 const f=fixture();start();await filteredSecondPage();open();
 // Primary navigation selects a group root; tasks is a destination in the home group.
 fireEvent.click(within(screen.getByRole('navigation',{name:'主导航'})).getByRole('button',{name:'首页',exact:true}));expect(new URL(location.href).searchParams.get('page')).toBe('home');expect(new URL(location.href).searchParams.has('transcriptJob')).toBe(false);
 fireEvent.click(within(screen.getByRole('navigation',{name:'首页分组导航'})).getByRole('button',{name:'近期本地资料',exact:true}));expect(new URL(location.href).searchParams.get('page')).toBe('tasks');expect(new URL(location.href).searchParams.has('transcriptJob')).toBe(false);await screen.findByText('Return transcript 1');
 expect(f.jobs().at(-1)!.searchParams.get('offset')).toBe('0');expect(f.jobs().at(-1)!.searchParams.has('statuses')).toBe(false);
});
it('identity change drops a pending ticket before accepted Back',async()=>{
 const f=fixture(),view=start();await filteredSecondPage();open();view.rerender(<OrdinaryNavigationShell lifetime={view.lifetime} identityScope="new-synthetic-identity"/>);await back();await screen.findByText('Return transcript 1');expect(f.jobs().at(-1)!.searchParams.has('origin')).toBe(false);
});
it('remounting the shell never adopts context from history.state or the previous shell',async()=>{
 const f=fixture(),view=start();await filteredSecondPage();open();await back();await screen.findByText('Return transcript 11');view.unmount();render(<OrdinaryNavigationShell lifetime={new OrdinaryRequestLifetime()}/>);await screen.findByText('Return transcript 1');expect(f.jobs().at(-1)!.searchParams.has('origin')).toBe(false);
});
