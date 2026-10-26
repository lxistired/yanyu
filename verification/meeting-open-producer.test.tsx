import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {LocalMeetingAgenda} from '../candidate/src/components/LocalMeetingAgenda';
import {agendaRequest,validateAgendaPage} from '../candidate/src/components/local-meeting-agenda';
import {organizationApi} from '../candidate/src/adapters/organization';
import {OrganizationWriteSession} from '../candidate/src/components/organization-write-session';
import {canonicalMeetingRecord,meetingOpenSelection,selectMeetingRecord} from '../candidate/src/components/meeting-open-selection';
import {createMeetingOpenIntent,meetingEditorApprovalCurrent,type MeetingAgendaBinding} from '../candidate/src/components/meeting-open-intent';
const scope='a'.repeat(64);
const row=(id='a')=>({id,kind:'meeting' as const,revision:1,createdAt:'2026-10-21T00:00:00Z',updatedAt:'2026-10-21T00:00:00Z',deletedAt:null,data:{title:' Meeting '+id+' ',organizationId:null as string|null,series:'',category:'other' as const,startsAt:'2026-10-22T09:00:00+08:00',endsAt:'2026-10-22T10:00:00+08:00',timezone:'Asia/Shanghai',location:'',description:'line\n"two"\t',attendeeIds:['person-b','person-a'],state:'scheduled' as const,providerAvailability:'unconfigured' as const}});
const page=(id='a')=>({items:[row(id)],total:1,offset:0,nextOffset:null});
const binding=(generation=1):MeetingAgendaBinding=>({identityScope:scope,hostGeneration:generation,session:new OrganizationWriteSession(),isCurrent:()=>true});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('pins full raw strings/order with deterministic object keys and freezes exact seven fields',()=>{
 const r=row();const pin=selectMeetingRecord(r,scope,0)!;expect(pin).not.toBeNull();expect(Object.isFrozen(pin)).toBe(true);expect(Object.keys(pin)).toHaveLength(7);expect(pin.recordJson).toContain('09:00:00+08:00');
 expect(canonicalMeetingRecord({...r,data:Object.fromEntries(Object.entries(r.data).reverse())})).toBe(pin.recordJson);
 expect(canonicalMeetingRecord({...r,data:{...r.data,attendeeIds:[...r.data.attendeeIds].reverse()}})).not.toBe(pin.recordJson);
 expect(canonicalMeetingRecord({...r,data:{...r.data,startsAt:'2026-10-22T01:00:00Z'}})).not.toBe(pin.recordJson);
 r.data.title='changed';expect(JSON.parse(pin.recordJson).data.title).toBe(' Meeting a ');expect(meetingOpenSelection(pin)).toEqual(pin);
});
it('rejects full-input IDs, revision/scope/generation tricks and noncanonical or mismatched pins',()=>{
 const pin=selectMeetingRecord(row(),scope,1)!;
 for(const bad of ['a\n','a\r','', 'a'.repeat(101)])expect(selectMeetingRecord(row(bad),scope,1)).toBeNull();
 for(const change of [{revision:0},{revision:1.1},{hostGeneration:-1},{identityScope:scope+'\n'},{id:'other'},{organizationId:'other'},{recordJson:' '+pin.recordJson},{extra:true}])expect(meetingOpenSelection({...pin,...change})).toBeNull();
 expect(selectMeetingRecord({...row(),data:{...row().data,organizationId:'org\n'}},scope,1)).toBeNull();
 expect(selectMeetingRecord({...row(),data:{...row().data,attendeeIds:['person\n']}},scope,1)).toBeNull();
});
it('rejects nested getters, symbols, holes and array extras without invoking accessors',()=>{
 let reads=0;const getter={enumerable:true,get(){reads++;throw Error('must not invoke');}};
 const a=row();Object.defineProperty(a.data,'title',getter);expect(canonicalMeetingRecord(a)).toBeNull();
 const b=row();Object.defineProperty(b.data.attendeeIds,'0',getter);expect(canonicalMeetingRecord(b)).toBeNull();
 const c=row();delete (c.data.attendeeIds as unknown[])[0];expect(canonicalMeetingRecord(c)).toBeNull();
 const d=row();Object.defineProperty(d.data.attendeeIds,'extra',{value:1});expect(canonicalMeetingRecord(d)).toBeNull();
 const e=row();Object.defineProperty(e.data,Symbol('extra'),{value:1});expect(canonicalMeetingRecord(e)).toBeNull();
 const pin=selectMeetingRecord(row(),scope,1)!;const f={...pin};Object.defineProperty(f,'recordJson',getter);expect(meetingOpenSelection(f)).toBeNull();expect(reads).toBe(0);
});
it('accepts bounded escaped valid records and rejects oversized incoming pin strings',()=>{
 const r=row();r.data.description='\t'.repeat(16000);r.data.attendeeIds=Array.from({length:200},(_,i)=>String(i).padEnd(100,'a'));
 expect(canonicalMeetingRecord(r)).not.toBeNull();r.data.description='\n'.repeat(16000);r.data.title='x'.repeat(720);r.data.series='x'.repeat(720);r.data.location='x'.repeat(720);
 // A valid description can escape to two bytes per character; incoming arbitrarily large pins fail before parsing.
 const pin=selectMeetingRecord(row(),scope,1)!;expect(meetingOpenSelection({...pin,recordJson:' '.repeat(65537)})).toBeNull();
 expect(new TextEncoder().encode(canonicalMeetingRecord(r)!).length).toBeLessThanOrEqual(65536);
});
it('intent ownership and immutable editor approval stay separate; changed editor stamp and withdrawn owner reject',()=>{
 const b=binding();const pin=selectMeetingRecord(row(),scope,1)!;let own=true;
 const intent=createMeetingOpenIntent(pin,1,b,b.session.editorVersion,null,()=>own)!;expect(intent.current()).toBe(true);expect(meetingEditorApprovalCurrent(intent)).toBe(true);
 b.session.setEditor({kind:'meeting',token:'new',dirty:true});expect(intent.current()).toBe(true);expect(meetingEditorApprovalCurrent(intent)).toBe(false);
 expect(createMeetingOpenIntent(pin,1,b,0,null,()=>true)).toBeNull();own=false;expect(intent.current()).toBe(false);
 expect(()=>Object.assign(intent,{approvedEditorVersion:999})).toThrow();intent.pending=false;expect(intent.current()).toBe(false);
});
it('hostless and invalid optional pins preserve listing and generic action',async()=>{
 vi.spyOn(organizationApi,'list').mockResolvedValue(page() as never);const generic=vi.fn(),open=vi.fn();render(<LocalMeetingAgenda onManageOrganizations={generic} onOpenMeeting={open}/>);
 expect(await screen.findByText('Meeting a')).toBeTruthy();expect(screen.queryByRole('button',{name:/打开此会议记录/})).toBeNull();fireEvent.click(screen.getByText('在机构管理中管理会议'));expect(generic).toHaveBeenCalledOnce();cleanup();
 // Descriptor-boundary mock, not a JSON HTTP payload: legacy array admission permits this own data index.
 const invalidPinPage=page('a');Object.defineProperty(invalidPinPage.items[0].data.attendeeIds,'0',{enumerable:false});
 expect(validateAgendaPage(invalidPinPage,agendaRequest({from:'',to:'',state:''}))).toBe(invalidPinPage);
 expect(selectMeetingRecord(invalidPinPage.items[0],scope,1)).toBeNull();
 vi.mocked(organizationApi.list).mockResolvedValue(invalidPinPage as never);render(<LocalMeetingAgenda binding={binding()} onManageOrganizations={generic} onOpenMeeting={open}/>);expect(await screen.findByText('Meeting a')).toBeTruthy();expect(screen.queryByRole('button',{name:/打开此会议记录/})).toBeNull();
 fireEvent.click(screen.getByText('在机构管理中管理会议'));expect(generic).toHaveBeenCalledTimes(2);expect(open).not.toHaveBeenCalled();
});
it('bound acceptance opens captured pin and stale detached click cannot survive refresh/filter',async()=>{
 vi.spyOn(organizationApi,'list').mockResolvedValue(page() as never);const b=binding(),open=vi.fn();render(<LocalMeetingAgenda binding={b} onManageOrganizations={()=>{}} onOpenMeeting={open}/>);
 const button=await screen.findByRole('button',{name:/打开此会议记录/});fireEvent.click(button);expect(open).toHaveBeenCalledOnce();expect(open.mock.calls[0][0]).toEqual(selectMeetingRecord(row(),scope,1));
 fireEvent.change(screen.getByLabelText('会议状态'),{target:{value:'completed'}});fireEvent.click(button);expect(open).toHaveBeenCalledOnce();
});
it('captures binding before request and suppresses ignored-abort old result after same-scope reset',async()=>{
 let resolve!:(v:unknown)=>void;const list=vi.spyOn(organizationApi,'list').mockImplementationOnce(()=>new Promise(r=>{resolve=r;}) as never).mockResolvedValue(page('new') as never);const open=vi.fn();let live=true;const old={...binding(),isCurrent:()=>live};
 const view=render(<LocalMeetingAgenda binding={old} onManageOrganizations={()=>{}} onOpenMeeting={open}/>);live=false;const next=binding(2);view.rerender(<LocalMeetingAgenda binding={next} onManageOrganizations={()=>{}} onOpenMeeting={open}/>);
 await screen.findByText('Meeting new');await act(async()=>resolve(page('old')));expect(screen.queryByText('Meeting old')).toBeNull();fireEvent.click(screen.getByRole('button',{name:/打开此会议记录/}));expect(open.mock.calls[0][0].hostGeneration).toBe(2);expect(list).toHaveBeenCalledTimes(2);
});
it('old live page loses direct-open immediately when binding current predicate fails',async()=>{
 vi.spyOn(organizationApi,'list').mockResolvedValue(page() as never);let live=true;const b={...binding(),isCurrent:()=>live},open=vi.fn();render(<LocalMeetingAgenda binding={b} onManageOrganizations={()=>{}} onOpenMeeting={open}/>);const button=await screen.findByRole('button',{name:/打开此会议记录/});live=false;fireEvent.click(button);expect(open).not.toHaveBeenCalled();
});
it('bound rejection after lifecycle loss cannot publish stale error before React cleanup',async()=>{
 let reject!:(e:Error)=>void;vi.spyOn(organizationApi,'list').mockImplementation(()=>new Promise((_,r)=>{reject=r;}) as never);let live=true;const b={...binding(),isCurrent:()=>live};render(<LocalMeetingAgenda binding={b} onManageOrganizations={()=>{}} onOpenMeeting={()=>{}}/>);live=false;await act(async()=>reject(Error('late old error')));expect(screen.queryByRole('alert')).toBeNull();
});
it('accepted pin is detached from row mutation, and refresh withdraws the old page synchronously',async()=>{
 const value=page();vi.spyOn(organizationApi,'list').mockResolvedValueOnce(value as never).mockImplementation(()=>new Promise(()=>{}) as never);const b=binding(),open=vi.fn();render(<LocalMeetingAgenda binding={b} onManageOrganizations={()=>{}} onOpenMeeting={open}/>);const button=await screen.findByRole('button',{name:/打开此会议记录/});value.items[0].data.title='changed after acceptance';fireEvent.click(button);expect(JSON.parse(open.mock.calls[0][0].recordJson).data.title).toBe(' Meeting a ');fireEvent.click(screen.getByText('刷新 / 重试'));fireEvent.click(button);expect(open).toHaveBeenCalledOnce();
});
it('paging accepts only the new snapshot, never a detached previous row action',async()=>{
 const first={items:[row('a')],total:2,offset:0,nextOffset:1},second={items:[row('b')],total:2,offset:1,nextOffset:null};vi.spyOn(organizationApi,'list').mockResolvedValueOnce(first as never).mockResolvedValueOnce(second as never);const b=binding(),open=vi.fn();render(<LocalMeetingAgenda binding={b} onManageOrganizations={()=>{}} onOpenMeeting={open}/>);const old=await screen.findByRole('button',{name:/打开此会议记录/});fireEvent.click(screen.getByText('下一页'));fireEvent.click(old);expect(open).not.toHaveBeenCalled();await screen.findByText('Meeting b');fireEvent.click(screen.getByRole('button',{name:/打开此会议记录/}));expect(open.mock.calls[0][0].id).toBe('b');
});
