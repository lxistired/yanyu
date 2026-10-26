import React,{StrictMode} from 'react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {OrganizationWriteHost} from '../candidate/src/components/organization-write-host';
import {selectMeetingRecord} from '../candidate/src/components/meeting-open-selection';
import {meetingEditorApprovalCurrent,type MeetingAgendaBinding,type MeetingOpenIntent} from '../candidate/src/components/meeting-open-intent';
import type {PdfOpenIntent} from '../candidate/src/components/pdf-open-intent';
const state=vi.hoisted(()=>({binding:null as MeetingAgendaBinding|null,open:null as null|((value:any)=>void),meeting:null as MeetingOpenIntent|null,pdf:null as PdfOpenIntent|null,openPdf:null as null|((value:any)=>void),historyMode:'normal',afterWrite:null as null|(()=>void)}));
vi.mock('../candidate/src/components/unsaved-work',async original=>{const real:any=await original();return {...real,writeUnsavedHistory(...args:any[]){if(state.historyMode==='false')return false;if(state.historyMode==='throw')throw Error('synthetic history failure');const result=real.writeUnsavedHistory(...args);state.afterWrite?.();return result}}});
vi.mock('../candidate/src/components/LocalMeetingAgenda',()=>({LocalMeetingAgenda:({binding,onOpenMeeting,onManageOrganizations}:any)=>{state.binding=binding;state.open=onOpenMeeting;return <><p>agenda fixture</p><button onClick={onManageOrganizations}>generic organization management</button></>}}));
vi.mock('../candidate/src/components/OrganizationHostView',()=>({OrganizationHostView:({meetingOpenIntent,visible}:any)=>{state.meeting=meetingOpenIntent;return <p data-testid="retained-manager" data-visible={visible}>{meetingOpenIntent?'selected':'plain'}</p>}}));
vi.mock('../candidate/src/components/LocalResearchSearch',()=>({LocalResearchSearch:({onOpenPdf}:any)=>{state.openPdf=onOpenPdf;return <p>research fixture</p>}}));
vi.mock('../candidate/src/components/LocalDocuments',()=>({LocalDocuments:({pdfOpenIntent}:any)=>{state.pdf=pdfOpenIntent;return <p>document fixture</p>}}));
vi.mock('../candidate/src/components/OrganizationManager',()=>({OrganizationManager:()=> <p>standalone generic manager</p>}));
vi.mock('../candidate/src/components/ServiceReportsEntry',()=>({ServiceReportsEntry:()=>null}));
const scope='a'.repeat(64),other='b'.repeat(64),hosts:OrganizationWriteHost[]=[];const writes:ReturnType<typeof vi.spyOn>[]=[];
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected shell-only network request')}));});
const record={id:'meeting-1',kind:'meeting',revision:1,createdAt:'2026-10-22T00:00:00.000Z',updatedAt:'2026-10-22T00:00:00.000Z',deletedAt:null,data:{title:'Synthetic meeting',organizationId:null,series:'',category:'research',startsAt:'2026-10-22T10:00:00.000Z',endsAt:'2026-10-22T11:00:00.000Z',timezone:'UTC',location:'',description:'',attendeeIds:[],state:'scheduled',providerAvailability:'unconfigured'}};
const pdf={storeScope:'10000000-0000-4000-8000-000000000001',documentId:'20000000-0000-4000-8000-000000000002',format:'pdf',sha256:'a'.repeat(64),pages:1,revision:0,workspaceId:null,folderId:null};
function host(){const h=new OrganizationWriteHost();h.activate();h.setAuthority(scope,true);hosts.push(h);writes.push(vi.spyOn(h.session!,'submit'),vi.spyOn(h.session!,'recover'),vi.spyOn(h.projection!,'submit'),vi.spyOn(h.projection!,'retry'),vi.spyOn(h.projection!,'discardUnsubmittedDraft'));return h}
function start(h:OrganizationWriteHost|undefined=host(),page='calendar'){history.replaceState(null,'',`/?page=${page}`);const life=new OrdinaryRequestLifetime();const tree=render(<StrictMode><OrdinaryNavigationShell lifetime={life} organizationWriteHost={h}/></StrictMode>);return{...tree,life,host:h}}
function select(binding=state.binding){const selection=selectMeetingRecord(record,binding!.identityScope,binding!.hostGeneration);expect(selection).not.toBeNull();act(()=>state.open!(selection));return selection}
afterEach(()=>{for(const call of writes.splice(0))expect(call).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();cleanup();hosts.splice(0).forEach(h=>h.dispose());vi.restoreAllMocks();vi.unstubAllGlobals();state.binding=null;state.open=null;state.meeting=null;state.pdf=null;state.openPdf=null;state.historyMode='normal';state.afterWrite=null;history.replaceState(null,'','/');});
it('captures trusted binding and opens existing selection without writes, URL identity or history record data',()=>{const {life,host:h}=start();const binding=state.binding!;expect(binding.session).toBe(h!.session);expect(binding.isCurrent()).toBe(true);select();expect(state.meeting?.current()).toBe(true);expect(meetingEditorApprovalCurrent(state.meeting!)).toBe(true);expect(state.meeting?.session).toBe(h!.session);expect(h!.session!.editor).toBeNull();expect(h!.session!.pending).toBeNull();expect(location.search).toBe('?page=organization');expect(JSON.stringify(history.state)).not.toContain(record.id);expect(life.epoch).toBe(1);});
it('hidden retained dirty editor asks once, preserves snapshot and does not clear unrelated projection',()=>{const h=host();h.session!.setEditor({kind:'meeting',token:'old-editor',dirty:true,draft:{title:'keep'}});const original=h.session!.editor;const projection=h.projection!.state;const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);start(h);select();expect(confirm).toHaveBeenCalledTimes(1);expect(state.meeting?.approvedEditorVersion).toBe(h.session!.editorVersion);expect(state.meeting?.approvedEditorToken).toBe('old-editor');expect(h.session!.editor).toEqual(original);expect(h.projection!.state).toBe(projection);});
it('Stay preserves hidden draft, route, epoch and prior pending ownership',()=>{const h=host();h.session!.setEditor({kind:'meeting',token:'old',dirty:true,draft:{title:'keep'}});vi.spyOn(window,'confirm').mockReturnValue(false);const {life}=start(h);select();expect(location.search).toBe('?page=calendar');expect(life.epoch).toBe(0);expect(state.meeting).toBeNull();expect(h.session!.editor?.draft).toEqual({title:'keep'});});
it.each(['ordinary','projection','retention'])('%s barrier refuses selected-open before guard/history and preserves state',kind=>{const h=host(),pending={synthetic:'exact pending'};if(kind==='ordinary')vi.spyOn(h.session!,'pending','get').mockReturnValue(pending as any);if(kind==='projection'){vi.spyOn(h.projection!,'unsavedState').mockReturnValue({dirty:false,pending:true});vi.spyOn(h.projection!,'state','get').mockReturnValue({...h.projection!.state,pending:pending as any});}if(kind==='retention')vi.spyOn(h.session!,'draftRetentionIncomplete','get').mockReturnValue(true);const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);const {life}=start(h);select();expect(confirm).not.toHaveBeenCalled();expect(location.search).toBe('?page=calendar');expect(life.epoch).toBe(0);expect(state.meeting).toBeNull();if(kind==='ordinary')expect(h.session!.pending).toBe(pending);if(kind==='projection')expect(h.projection!.state.pending).toBe(pending);});
it.each(['false','throw'])('history %s leaves route, epoch and editor unchanged',mode=>{const {host:h,life}=start();state.historyMode=mode;select();expect(location.search).toBe('?page=calendar');expect(life.epoch).toBe(0);expect(state.meeting).toBeNull();expect(h!.session!.editor).toBeNull();});
it('post-history authority loss admits only plain actual route, never fictitious rollback',()=>{const {host:h,life}=start();state.afterWrite=()=>h!.setAuthority(null,true);select();expect(location.search).toBe('?page=organization');expect(life.epoch).toBe(1);expect(state.meeting).toBeNull();expect(screen.getByTestId('retained-manager').textContent).toBe('plain');});
it('editor mutation during accepted dirty guard refuses admission before history',()=>{const h=host();h.session!.setEditor({kind:'meeting',token:'old',dirty:true});vi.spyOn(window,'confirm').mockImplementation(()=>{h.session!.setEditor({kind:'meeting',token:'new',dirty:true});return true});const {life}=start(h);select();expect(location.search).toBe('?page=calendar');expect(life.epoch).toBe(0);expect(h.session!.editor?.token).toBe('new');expect(state.meeting).toBeNull();});
it.each(['roundtrip','forced'])('%s authority change permanently withdraws previous intent/binding',mode=>{const {host:h}=start();const binding=state.binding!;select();const previous=state.meeting!;act(()=>{if(mode==='roundtrip'){h!.setAuthority(other,true);h!.setAuthority(scope,true)}else h!.setAuthority(scope,true)});expect(previous.current()).toBe(false);expect(previous.pending).toBe(false);expect(binding.isCurrent()).toBe(false);});
it('same-route explicit meeting replaces intent and ordinary generic action withdraws it',()=>{const {life}=start();select();const old=state.meeting!;select();expect(old.current()).toBe(false);expect(life.epoch).toBe(2);fireEvent.click(screen.getByRole('button',{name:'机构',exact:true}));expect(state.meeting).toBeNull();expect(life.epoch).toBe(3);});
it('fresh explicit PDF and meeting navigation mutually withdraw pending selections',()=>{
 const {life}=start(undefined,'research'),firstOpenPdf=state.openPdf!;
 act(()=>firstOpenPdf(pdf));
 const previousPdf=state.pdf!;
 expect(previousPdf.current()).toBe(true);expect(previousPdf.pending).toBe(true);
 expect(location.search).toBe('?page=documents');expect(life.epoch).toBe(1);

 // Enter the actual agenda before selecting. Ordinary navigation already ends PDF ownership.
 fireEvent.click(screen.getByRole('button',{name:'我的',exact:true}));
 fireEvent.click(screen.getByRole('button',{name:'本地会议日程',exact:true}));
 expect(previousPdf.current()).toBe(false);expect(previousPdf.pending).toBe(false);
 expect(location.search).toBe('?page=calendar');expect(life.epoch).toBe(3);
 select();
 const previousMeeting=state.meeting!;
 expect(previousMeeting.current()).toBe(true);expect(previousMeeting.pending).toBe(true);
 expect(previousPdf.current()).toBe(false);
 expect(location.search).toBe('?page=organization');expect(life.epoch).toBe(4);

 // A PDF producer exists only on its source page. Re-enter it and use the fresh callback.
 fireEvent.click(screen.getByRole('button',{name:'研究',exact:true}));
 fireEvent.click(screen.getByRole('button',{name:'资料检索',exact:true}));
 expect(previousMeeting.current()).toBe(false);expect(previousMeeting.pending).toBe(false);
 expect(state.meeting).toBeNull();expect(life.epoch).toBe(6);
 const freshOpenPdf=state.openPdf!;expect(freshOpenPdf).not.toBe(firstOpenPdf);
 act(()=>freshOpenPdf({...pdf,revision:1}));
 expect(state.pdf).not.toBe(previousPdf);expect(state.pdf?.current()).toBe(true);
 expect(state.pdf?.selection.revision).toBe(1);expect(previousMeeting.current()).toBe(false);
 expect(previousPdf.current()).toBe(false);
 expect(location.search).toBe('?page=documents');expect(life.epoch).toBe(7);
});
it('a departed PDF producer cannot mint a selection, withdraw a meeting, or revive after return',()=>{
 const {life}=start(undefined,'research'),staleOpenPdf=state.openPdf!;
 fireEvent.click(screen.getByRole('button',{name:'我的',exact:true}));
 fireEvent.click(screen.getByRole('button',{name:'本地会议日程',exact:true}));
 const push=vi.spyOn(history,'pushState'),confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
 const calendarHistory=history.state;
 act(()=>staleOpenPdf(pdf));
 expect(state.pdf).toBeNull();expect(state.meeting).toBeNull();
 expect(location.search).toBe('?page=calendar');expect(life.epoch).toBe(2);
 expect(history.state).toEqual(calendarHistory);expect(push).not.toHaveBeenCalled();
 expect(confirm).not.toHaveBeenCalled();

 select();
 const meeting=state.meeting!,meetingHistory=history.state;
 expect(meeting.current()).toBe(true);expect(push).toHaveBeenCalledTimes(1);
 act(()=>staleOpenPdf({...pdf,revision:1}));
 expect(state.pdf).toBeNull();expect(state.meeting).toBe(meeting);
 expect(meeting.current()).toBe(true);expect(meeting.pending).toBe(true);
 expect(location.search).toBe('?page=organization');expect(life.epoch).toBe(3);
 expect(history.state).toEqual(meetingHistory);expect(push).toHaveBeenCalledTimes(1);
 expect(confirm).not.toHaveBeenCalled();

 fireEvent.click(screen.getByRole('button',{name:'研究',exact:true}));
 fireEvent.click(screen.getByRole('button',{name:'资料检索',exact:true}));
 const freshOpenPdf=state.openPdf!,researchHistory=history.state;
 expect(freshOpenPdf).not.toBe(staleOpenPdf);expect(meeting.pending).toBe(false);
 expect(push).toHaveBeenCalledTimes(3);
 act(()=>staleOpenPdf(pdf));
 expect(state.pdf).toBeNull();expect(location.search).toBe('?page=research');
 expect(life.epoch).toBe(5);expect(history.state).toEqual(researchHistory);
 expect(push).toHaveBeenCalledTimes(3);
 act(()=>freshOpenPdf(pdf));
 expect(state.pdf?.current()).toBe(true);expect(location.search).toBe('?page=documents');
 expect(life.epoch).toBe(6);expect(push).toHaveBeenCalledTimes(4);
});
it('a meeting callback with a withdrawn host binding cannot replace a current PDF selection',()=>{
 const {life,host:h}=start(),binding=state.binding!,staleOpenMeeting=state.open!;
 const selection=selectMeetingRecord(record,binding.identityScope,binding.hostGeneration)!;
 expect(selection).not.toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'研究',exact:true}));
 fireEvent.click(screen.getByRole('button',{name:'资料检索',exact:true}));
 act(()=>state.openPdf!(pdf));
 const currentPdf=state.pdf!;
 expect(currentPdf.current()).toBe(true);expect(life.epoch).toBe(3);
 act(()=>h!.setAuthority(other,true));
 expect(binding.isCurrent()).toBe(false);
 const push=vi.spyOn(history,'pushState'),documentHistory=history.state;
 act(()=>staleOpenMeeting(selection));
 expect(state.meeting).toBeNull();expect(state.pdf).toBe(currentPdf);
 expect(currentPdf.current()).toBe(true);expect(currentPdf.pending).toBe(true);
 expect(location.search).toBe('?page=documents');expect(life.epoch).toBe(3);
 expect(history.state).toEqual(documentHistory);expect(push).not.toHaveBeenCalled();
});
it('hostless agenda cannot mint a meeting selection and generic management remains ordinary',()=>{history.replaceState(null,'','/?page=calendar');const life=new OrdinaryRequestLifetime();render(<OrdinaryNavigationShell lifetime={life}/>);expect(state.binding).toBeNull();const pin=selectMeetingRecord(record,scope,1)!;act(()=>state.open!(pin));expect(life.epoch).toBe(0);fireEvent.click(screen.getByText('generic organization management'));expect(location.search).toBe('?page=organization');});
it('pop/replace/unmount withdraw ownership without parsing deep-link identity',()=>{const tree=start();select();const old=state.meeting!;fireEvent.click(screen.getByText('替换当前路由并刷新'));expect(old.current()).toBe(false);select();const next=state.meeting!;act(()=>{history.replaceState(null,'',`/?page=organization&meetingId=${record.id}`);window.dispatchEvent(new PopStateEvent('popstate'))});expect(next.current()).toBe(false);expect(state.meeting).toBeNull();select();const active=state.meeting!;expect(active.current()).toBe(true);tree.unmount();expect(active.current()).toBe(false);});
