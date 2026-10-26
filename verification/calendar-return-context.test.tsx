// Bounded component callbacks; no OrdinaryNavigationShell, browser, HTTP, or SQLite.
import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {LocalMeetingAgenda} from '../candidate/src/components/LocalMeetingAgenda';
import {OrganizationManager} from '../candidate/src/components/OrganizationManager';
import {OrganizationWriteSession} from '../candidate/src/components/organization-write-session';
import {createMeetingOpenIntent} from '../candidate/src/components/meeting-open-intent';
import {organizationApi} from '../candidate/src/adapters/organization';
import {agendaDateRange,agendaHistoryReturn,agendaReturnContext,type AgendaReturnContext} from '../candidate/src/components/local-meeting-agenda';
const time='2026-10-22T00:00:00.000Z';
const row=(i:number):any=>({id:`meeting-${String(i).padStart(3,'0')}`,kind:'meeting',revision:1,createdAt:time,updatedAt:time,deletedAt:null,data:{title:`Meeting ${i}`,organizationId:null,series:'',category:'research',startsAt:time,endsAt:'2026-10-22T01:00:00.000Z',timezone:'UTC',location:'',description:'',attendeeIds:[],state:'scheduled',providerAvailability:'unconfigured'}});
const context:AgendaReturnContext={filters:{...agendaDateRange('2026-10-22','day'),state:'scheduled'},offsets:[0,50],date:'2026-10-22',period:'day'};
afterEach(()=>{cleanup();vi.restoreAllMocks();});
async function openSecondPage(){
 const records=Array.from({length:51},(_,i)=>row(i));const session=new OrganizationWriteSession();
 const binding={session,identityScope:'a'.repeat(64),hostGeneration:1,isCurrent:()=>session.available};
 const list=vi.spyOn(organizationApi,'list').mockImplementation(async(input:any)=>{
  const all=input.kind==='meeting'?records.filter(r=>!input.state||r.data.state===input.state):[];
  const offset=input.offset??0,items=all.slice(offset,offset+(input.limit??50));
  return {items,total:all.length,offset,nextOffset:offset+items.length<all.length?offset+items.length:null} as never;
 });
 const get=vi.spyOn(organizationApi,'get').mockImplementation(async(input:any)=>structuredClone(records.find(r=>r.id===input.id)));
 const update=vi.spyOn(organizationApi,'update').mockImplementation(async(input:any)=>{
  expect(input.id).toBe('meeting-050');const target=records.find(r=>r.id===input.id)!;expect(input.expectedRevision).toBe(target.revision);
  target.data={...target.data,...input.patch};target.revision++;return structuredClone(target);
 });
 const remember=vi.fn(),open=vi.fn();
 render(<LocalMeetingAgenda initialFilters={context.filters} binding={binding} onRememberContext={remember} onOpenMeeting={open} onManageOrganizations={()=>{}}/>);
 await screen.findByText('Meeting 0');fireEvent.click(screen.getByRole('button',{name:/^下一页$/}));await screen.findByText('Meeting 50');
 fireEvent.click(screen.getByRole('button',{name:'打开此会议记录：Meeting 50'}));
 expect(remember.mock.calls[0][0]).toEqual(context);expect(open.mock.calls[0][0].id).toBe('meeting-050');
 const saved=remember.mock.calls[0][0],intent=createMeetingOpenIntent(open.mock.calls[0][0],1,binding,session.editorVersion,null,()=>true)!;
 cleanup();render(<OrganizationManager session={session} visible routeEpoch={1} meetingOpenIntent={intent}/>);
 await screen.findByRole('dialog',{name:'编辑会议'});expect(session.editor?.record?.id).toBe('meeting-050');
 return{records,session,list,get,update,saved};
}
it('second-page exact editor save returns to its filters and page with fresh revision, never another record',async()=>{
 const f=await openSecondPage();fireEvent.change(screen.getByLabelText('会议标题 *'),{target:{value:'Updated target only'}});
 fireEvent.click(screen.getByRole('button',{name:'保存到本地'}));await waitFor(()=>expect(f.session.editor).toBeNull());
 expect(f.update).toHaveBeenCalledOnce();expect(f.records[0].data.title).toBe('Meeting 0');expect(f.records[50].revision).toBe(2);
 cleanup();f.list.mockClear();render(<LocalMeetingAgenda initialContext={f.saved} onManageOrganizations={()=>{}}/>);
 await screen.findByText('Updated target only');expect(screen.queryByText('Meeting 0')).toBeNull();
 expect(f.list.mock.calls[0][0]).toMatchObject({...context.filters,offset:50});expect(screen.getByRole('button',{name:'上一页'}).hasAttribute('disabled')).toBe(false);
 expect((screen.getByLabelText('浏览日期（UTC）') as HTMLInputElement).value).toBe(context.date);f.session.detach();
});
it('explicit cancellation removes selected last-page row, refreshes earlier page without reviving stale selection',async()=>{
 const f=await openSecondPage();fireEvent.click(screen.getByRole('button',{name:'取消编辑'}));
 fireEvent.change(screen.getByLabelText('搜索本地记录'),{target:{value:'Meeting 50'}});
 const article=await screen.findByRole('article',{name:'Meeting 50'});fireEvent.click(within(article).getByRole('button',{name:'取消会议'}));
 fireEvent.click(within(screen.getByRole('dialog',{name:'确认取消会议'})).getByRole('button',{name:'确认取消会议'}));
 await waitFor(()=>expect(f.records[50].data.state).toBe('cancelled'));await waitFor(()=>expect(f.session.pending).toBeNull());
 expect(f.update).toHaveBeenCalledOnce();expect(f.records[0].data.state).toBe('scheduled');
 cleanup();f.list.mockClear();const open=vi.fn();render(<LocalMeetingAgenda initialContext={f.saved} onManageOrganizations={()=>{}} onOpenMeeting={open}/>);
 await screen.findByText('Meeting 0');expect(f.list.mock.calls.map(c=>(c[0] as any).offset)).toEqual([50,0]);expect(screen.queryByText('Meeting 50')).toBeNull();expect(open).not.toHaveBeenCalled();
 expect(screen.getByText(/原页已无符合筛选/)).toBeTruthy();expect((screen.getByLabelText('会议状态') as HTMLSelectElement).value).toBe('scheduled');f.session.detach();
});
it('history context only matches exact calendar entry and snapshots bounded state',()=>{
 const ticket={key:'source-calendar',context};
 expect(agendaHistoryReturn(ticket,'calendar',undefined,'source-calendar')).toEqual(context);
 expect(agendaHistoryReturn(ticket,'calendar',undefined,'unrelated-calendar')).toBeUndefined();
 expect(agendaHistoryReturn(ticket,'home',undefined,'source-calendar')).toBeUndefined();
 expect(agendaHistoryReturn(ticket,'calendar','unknown','source-calendar')).toBeUndefined();
 expect(agendaHistoryReturn(null,'calendar',undefined,'source-calendar')).toBeUndefined();
 expect(agendaReturnContext({...context,offsets:[0,50,50]})).toBeUndefined();
 const copy=agendaReturnContext(context)!;copy.offsets.push(100);expect(context.offsets).toEqual([0,50]);
});
