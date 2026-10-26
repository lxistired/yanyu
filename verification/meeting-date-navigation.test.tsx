import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {LocalMeetingAgenda} from '../candidate/src/components/LocalMeetingAgenda';
import {agendaDateRange,shiftAgendaDate} from '../candidate/src/components/local-meeting-agenda';
import {organizationApi} from '../candidate/src/adapters/organization';
import {OrganizationWriteSession} from '../candidate/src/components/organization-write-session';
const empty={items:[],total:0,offset:0,nextOffset:null};
const selectDate=(date:string)=>fireEvent.change(screen.getByLabelText('浏览日期（UTC）'),{target:{value:date}});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('uses UTC dates and Monday-exclusive week ranges, independent of display zone, with bounded invalid dates',()=>{
 expect(agendaDateRange('2026-10-23','day')).toEqual({from:'2026-10-23T00:00:00.000Z',to:'2026-10-24T00:00:00.000Z'});
 expect(agendaDateRange('2026-10-25','week')).toEqual({from:'2026-10-19T00:00:00.000Z',to:'2026-10-26T00:00:00.000Z'});
 expect(shiftAgendaDate('2026-10-23','week',1)).toBe('2026-10-26');expect(shiftAgendaDate('2026-01-01','day',-1)).toBe('2025-12-31');
 for(const date of ['', '2026-02-30','2100-12-31'])expect(()=>agendaDateRange(date,'day')).toThrow();
});
it('day/week navigation, today, advanced filters and clear reuse only the existing read request',async()=>{
 const list=vi.spyOn(organizationApi,'list').mockResolvedValue(empty);
 render(<LocalMeetingAgenda onManageOrganizations={()=>{}}/>);await screen.findByText(/没有符合筛选/);
 expect(screen.getByRole('button',{name:'日视图'}).getAttribute('aria-pressed')).toBe('false');
 selectDate('2026-10-23');fireEvent.click(screen.getByRole('button',{name:'日视图'}));await waitFor(()=>expect(list).toHaveBeenLastCalledWith(expect.objectContaining({from:'2026-10-23T00:00:00.000Z',to:'2026-10-24T00:00:00.000Z',offset:0}),expect.any(AbortSignal)));
 fireEvent.change(screen.getByLabelText('会议状态'),{target:{value:'scheduled'}});
 fireEvent.click(screen.getByRole('button',{name:'周视图'}));await waitFor(()=>expect(list).toHaveBeenLastCalledWith(expect.objectContaining({from:'2026-10-19T00:00:00.000Z',to:'2026-10-26T00:00:00.000Z',state:'scheduled'}),expect.any(AbortSignal)));
 fireEvent.click(screen.getByRole('button',{name:'下一周'}));await waitFor(()=>expect(list).toHaveBeenLastCalledWith(expect.objectContaining({from:'2026-10-26T00:00:00.000Z'}),expect.any(AbortSignal)));
 fireEvent.click(screen.getByRole('button',{name:'上一周'}));await waitFor(()=>expect(list).toHaveBeenLastCalledWith(expect.objectContaining({from:'2026-10-19T00:00:00.000Z'}),expect.any(AbortSignal)));
 fireEvent.click(screen.getByRole('button',{name:'今天（UTC）'}));await waitFor(()=>expect(list).toHaveBeenLastCalledWith(expect.objectContaining(agendaDateRange(new Date().toISOString().slice(0,10),'week')),expect.any(AbortSignal)));
 fireEvent.change(screen.getByLabelText('UTC 下限'),{target:{value:'2026-10-21T12:00:00Z'}});await screen.findByText(/本页 0 条/);
 expect(screen.getByRole('button',{name:'周视图'}).getAttribute('aria-pressed')).toBe('false');
 fireEvent.click(screen.getByRole('button',{name:'清空全部筛选'}));await waitFor(()=>expect(list).toHaveBeenLastCalledWith({kind:'meeting',includeDeleted:false,sortBy:'date',direction:'asc',limit:50,offset:0},expect.any(AbortSignal)));
});
it('date change aborts pending range; clearing invalid date keeps applied range explicitly and issues no new request',async()=>{
 const resolves:((v:any)=>void)[]=[];const list=vi.spyOn(organizationApi,'list').mockImplementation(()=>new Promise(resolve=>resolves.push(resolve)));
 render(<LocalMeetingAgenda initialFilters={{from:'2026-10-23T00:00:00.000Z',to:'2026-10-24T00:00:00.000Z',state:''}} onManageOrganizations={()=>{}}/>);selectDate('2026-10-24');expect(list.mock.calls[0][1]?.aborted).toBe(true);expect(list.mock.calls[1][0]).toMatchObject({from:'2026-10-24T00:00:00.000Z',to:'2026-10-25T00:00:00.000Z'});
 await act(async()=>resolves[1](empty));selectDate('');expect(list).toHaveBeenCalledTimes(2);expect(screen.getByRole('alert').textContent).toContain('当前列表仍使用');
 await act(async()=>resolves[0]({bad:true}));expect(screen.queryByText(/无法读取或校验/)).toBeNull();
});
it('exact meeting open remembers filters without writing; remount restores week and state',async()=>{
 const filters={...agendaDateRange('2026-10-23','week'),state:'scheduled' as const};
 const record={id:'meeting-1',kind:'meeting',revision:1,createdAt:'2026-10-21T00:00:00Z',updatedAt:'2026-10-21T00:00:00Z',deletedAt:null,data:{title:'Synthetic date meeting',organizationId:null,series:'',category:'research',startsAt:'2026-10-23T01:00:00Z',endsAt:'2026-10-23T02:00:00Z',timezone:'Asia/Shanghai',location:'',description:'',attendeeIds:[],state:'scheduled',providerAvailability:'unconfigured'}};
 vi.spyOn(organizationApi,'list').mockResolvedValue({items:[record],total:1,offset:0,nextOffset:null} as never);
 const remember=vi.fn(),open=vi.fn(),session=new OrganizationWriteSession();const submit=vi.spyOn(session,'submit');
 render(<LocalMeetingAgenda initialFilters={filters} onRememberFilters={remember} onManageOrganizations={()=>{}} onOpenMeeting={open} binding={{session,identityScope:'a'.repeat(64),hostGeneration:1,isCurrent:()=>true}}/>);
 fireEvent.click(await screen.findByRole('button',{name:'打开此会议记录：Synthetic date meeting'}));expect(remember).toHaveBeenCalledWith(filters);expect(open).toHaveBeenCalledOnce();expect(submit).not.toHaveBeenCalled();
 cleanup();render(<LocalMeetingAgenda initialFilters={remember.mock.calls[0][0]} onManageOrganizations={()=>{}}/>);await screen.findByText('Synthetic date meeting');expect(screen.getByRole('button',{name:'周视图'}).getAttribute('aria-pressed')).toBe('true');expect((screen.getByLabelText('会议状态') as HTMLSelectElement).value).toBe('scheduled');
});
