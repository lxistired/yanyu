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
const scope='11111111-1111-4111-8111-111111111111', id='aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const releases:(()=>void)[]=[];
afterEach(()=>{cleanup();for(const release of releases.splice(0))release();vi.restoreAllMocks();vi.unstubAllGlobals();history.replaceState(null,'','/');});
function sourceFixture(pendingDocuments=false) {
 const signals:AbortSignal[]=[];let settleDocument!:(value:Response)=>void;
 const fetch=vi.fn((input:string,init:RequestInit)=>{
  const url=new URL(input,location.href);signals.push(init.signal as AbortSignal);
  if(url.pathname==='/api/local-asr/identity') {expect(init.method).toBe('GET');expect(url.search).toBe('');expect(init.headers).toBeUndefined();return Promise.resolve(new Response(JSON.stringify({transcriptionStoreId:scope}),{headers:{'X-Transcription-Store-Id':scope}}));}
  if(url.pathname==='/api/documents/choices')return Promise.resolve(new Response(JSON.stringify({uploadScope:scope})));
  if(url.pathname==='/api/documents') {
   if(pendingDocuments)return new Promise<Response>(resolve=>{settleDocument=resolve;});
   return Promise.resolve(new Response(JSON.stringify({storeScope:scope,documents:[],total:0,offset:0,limit:10})));
  }
  if(url.pathname==='/api/local-asr/jobs') {expect(init.method).toBe('GET');expect(init.headers).toEqual({'X-Transcription-Store-Id':scope});return Promise.resolve(new Response(JSON.stringify({jobs:[{id,title:'Synthetic selected transcript',filename:'synthetic.wav',status:'completed',created:'2026-01-01',deleted_at:null,result:null}],total:1,offset:0,limit:10,hasMore:false}),{headers:{'X-Transcription-Store-Id':scope}}));}
  throw Error('Unadmitted synthetic shell request');
 });vi.stubGlobal('fetch',fetch);return {fetch,signals,settle:(value:Response)=>settleDocument(value),hasPending:()=>!!settleDocument};
}
function start(page='tasks') {history.replaceState(null,'',`/?page=${page}`);const life=new OrdinaryRequestLifetime();render(<OrdinaryNavigationShell lifetime={life}/>);return life;}
function tasksButton() {return screen.getAllByRole('button',{name:'近期本地资料',exact:true})[0];}
function retainedDraft() {const token=Symbol('synthetic retained draft');releases.push(registerUnsavedSession({token,scope:token,getState:()=>({dirty:true,pending:false})}));}
it('tasks entry honors Stay then Leave before any recent-source reads',async()=>{
 const fixture=sourceFixture(), confirm=vi.spyOn(window,'confirm').mockReturnValue(false), life=start('workspace');
 fireEvent.change(screen.getByLabelText('Synthetic workspace draft'),{target:{value:'preserve me'}});fireEvent.click(tasksButton());
 expect(confirm).toHaveBeenCalledTimes(1);expect(location.search).toBe('?page=workspace');expect(screen.getByDisplayValue('preserve me')).toBeTruthy();expect(life.epoch).toBe(0);expect(fixture.fetch).not.toHaveBeenCalled();
 confirm.mockReturnValue(true);fireEvent.click(tasksButton());await screen.findByText('暂无未删除的本地文档。');
 expect(location.search).toBe('?page=tasks');expect(life.epoch).toBe(1);expect(screen.queryByDisplayValue('preserve me')).toBeNull();
 expect(screen.queryByText('此功能在当前组合中不可用')).toBeNull();
});
it('exact transcript selection honors Stay then Leave through real shell guards',async()=>{
 sourceFixture();const life=start(),confirm=vi.spyOn(window,'confirm').mockReturnValue(false);retainedDraft();
 const open=await screen.findByText('打开转写记录：Synthetic selected transcript');fireEvent.click(open);
 expect(confirm).toHaveBeenCalledTimes(1);expect(location.search).toBe('?page=tasks');expect(life.epoch).toBe(0);expect(screen.queryByTestId('exact-transcript')).toBeNull();
 confirm.mockReturnValue(true);fireEvent.click(open);expect(location.search).toBe(`?page=files&transcriptStoreId=${scope}&transcriptJob=${id}`);expect(life.epoch).toBe(1);expect(screen.getByTestId('exact-transcript').textContent).toBe(id);
});
it('denied foreign history preserves recent screen and reports mismatch without accepting route',async()=>{
 sourceFixture();const life=start();await screen.findByText('打开转写记录：Synthetic selected transcript');retainedDraft();vi.spyOn(window,'confirm').mockReturnValue(false);
 act(()=>{history.replaceState(null,'','/?page=files');window.dispatchEvent(new PopStateEvent('popstate'));});
 expect(life.epoch).toBe(0);expect(screen.queryByTestId('exact-transcript')).toBeNull();expect(screen.getByText('打开转写记录：Synthetic selected transcript')).toBeTruthy();
 expect(screen.getByText(/无法安全恢复地址/)).toBeTruthy();
});
it('denied owned Back restores tasks route without accepting a new epoch',async()=>{
 sourceFixture();const life=start();await screen.findByText('打开转写记录：Synthetic selected transcript');retainedDraft();vi.spyOn(window,'confirm').mockReturnValue(false);
 act(()=>{writeUnsavedHistory('/?page=home');writeUnsavedHistory('/?page=tasks');});
 await act(async()=>{history.back();await new Promise(resolve=>setTimeout(resolve,65));});
 await waitFor(()=>expect(location.search).toBe('?page=tasks'));
 expect(life.epoch).toBe(0);expect(screen.getByText('打开转写记录：Synthetic selected transcript')).toBeTruthy();
});
it('accepted route change aborts source work and ignores late response after unmount',async()=>{
 const fixture=sourceFixture(true),life=start();await waitFor(()=>expect(fixture.hasPending()).toBe(true));
 fireEvent.click(within(screen.getByRole('navigation',{name:'主导航'})).getByRole('button',{name:'首页',exact:true}));expect(location.search).toBe('?page=home');expect(life.epoch).toBe(1);expect(fixture.signals.every(signal=>signal.aborted)).toBe(true);
 await act(async()=>{fixture.settle(new Response(JSON.stringify({storeScope:scope,documents:[],total:0,offset:0,limit:10})));});
 expect(screen.queryByText('暂无未删除的本地文档。')).toBeNull();expect(screen.getByRole('heading',{level:1}).textContent).toBe('首页');
});
it('history owner write refusal prevents exact transcript route acceptance',async()=>{
 sourceFixture();const life=start();const open=await screen.findByText('打开转写记录：Synthetic selected transcript');
 // Injection models the existing history owner's restoration barrier return false.
 // Actual owned/foreign history traversal behavior is covered separately above.
 const write=vi.spyOn(unsavedHistory,'writeUnsavedHistory').mockReturnValue(false);fireEvent.click(open);
 expect(write).toHaveBeenCalledTimes(1);expect(location.search).toBe('?page=tasks');expect(life.epoch).toBe(0);expect(screen.queryByTestId('exact-transcript')).toBeNull();
 expect(screen.getByText('打开转写记录：Synthetic selected transcript')).toBeTruthy();
});
