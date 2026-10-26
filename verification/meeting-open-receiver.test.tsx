import React,{StrictMode} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {OrganizationHostView} from '../candidate/src/components/OrganizationHostView';
import {OrganizationWriteHost} from '../candidate/src/components/organization-write-host';
import {createMeetingOpenIntent,type MeetingOpenIntent} from '../candidate/src/components/meeting-open-intent';
import {selectMeetingRecord} from '../candidate/src/components/meeting-open-selection';
import {acceptedMeetingRecord} from '../candidate/src/components/meeting-open-receiver';
import {organizationApi} from '../candidate/src/adapters/organization';
import {allowLeavingUnsavedWork} from '../candidate/src/components/unsaved-work';
import type {OrganizationKind,OrganizationRecord} from '../candidate/shared/organization';
const time='2026-10-22T00:00:00.000Z';
const meeting=(id='meeting-a',state:'scheduled'|'cancelled'|'completed'='scheduled'):OrganizationRecord<'meeting'>=>({id,kind:'meeting',revision:1,createdAt:time,updatedAt:time,deletedAt:null,data:{title:'Synthetic '+id,organizationId:null,series:'',category:'research',startsAt:time,endsAt:'2026-10-22T01:00:00.000Z',timezone:'UTC',location:'Local room',description:'Synthetic only',attendeeIds:[],state,providerAvailability:'unconfigured'}});
const org:OrganizationRecord<'organization'>={id:'org-a',kind:'organization',revision:1,createdAt:time,updatedAt:time,deletedAt:null,data:{name:'Synthetic organization',parentId:null,category:'other',description:'',website:'',tags:[],verification:'unverified'}};
const person:OrganizationRecord<'person'>={id:'person-a',kind:'person',revision:1,createdAt:time,updatedAt:time,deletedAt:null,data:{name:'Synthetic person',organizationId:'other-org',role:'',department:'',email:'',biography:'',followed:false,tags:[]}};
const kinds:OrganizationKind[]=['organization','person','meeting','meeting-registration','crm-contact','service-record','bookmark','reading-record','access-request','share-draft'];
const empty=()=>Object.fromEntries(kinds.map(k=>[k,[]])) as Record<OrganizationKind,OrganizationRecord[]>;
function deferred<T>(){let resolve!:(v:T)=>void;let reject!:(e:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
const hosts:OrganizationWriteHost[]=[];
afterEach(()=>{cleanup();for(const host of hosts.splice(0))host.dispose();vi.restoreAllMocks();vi.unstubAllGlobals();});
function fixture(record=meeting()){
 const host=new OrganizationWriteHost();host.activate();host.setAuthority('a'.repeat(64),true);hosts.push(host);
 const catalog=empty();catalog.meeting=[record];catalog.organization=[org];catalog.person=[person];
 const list=vi.spyOn(organizationApi,'list').mockImplementation(async input=>{const items=catalog[input.kind];return {items,total:items.length,offset:0,nextOffset:null} as never;});
 const get=vi.spyOn(organizationApi,'get').mockResolvedValue(record as never);
 const submit=vi.spyOn(host.session!,'submit').mockResolvedValue(null);
 const recover=vi.spyOn(host.session!,'recover');
 const download=vi.spyOn(organizationApi,'exportMeetingIcs');
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
 const make=(epoch=1)=>createMeetingOpenIntent(selectMeetingRecord(record,host.identityScope!,host.generationId),epoch,{identityScope:host.identityScope!,hostGeneration:host.generationId,session:host.session!,isCurrent:()=>true},host.session!.editorVersion,host.session!.editor?.token??null,()=>true)!;
 return {host,catalog,list,get,submit,recover,download,confirm,make};
}
for(const state of ['scheduled','cancelled','completed'] as const)it(`opens pristine existing non-UUID ${state} meeting after guarded exact read without writes`,async()=>{
 const f=fixture(meeting('a',state)),intent=f.make();render(<OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/>);
 await screen.findByRole('dialog',{name:'编辑会议'});
 expect(f.get).toHaveBeenCalledWith({kind:'meeting',id:'a',includeDeleted:false},expect.any(AbortSignal));
 expect(f.host.session!.editor?.record?.id).toBe('a');expect(f.host.session!.unsavedState().dirty).toBe(false);expect(intent.pending).toBe(false);
 expect(f.submit).not.toHaveBeenCalled();expect(f.recover).not.toHaveBeenCalled();expect(f.download).not.toHaveBeenCalled();expect(f.confirm).not.toHaveBeenCalled();
});
for(const failure of ['revision-low','revision-high','deleted','id','content','parent','attendees','kind'] as const)it(`rejects fresh ${failure} mismatch without replacing editor`,async()=>{
 const f=fixture(),intent=f.make(),changed=structuredClone(meeting());
 if(failure==='revision-low')changed.revision=0;if(failure==='revision-high')changed.revision=2;if(failure==='deleted')changed.deletedAt=time;if(failure==='id')changed.id='wrong';if(failure==='content')changed.data.description='changed';if(failure==='parent')changed.data.organizationId=org.id;if(failure==='attendees')changed.data.attendeeIds=[person.id];
 f.get.mockResolvedValue((failure==='kind'?org:changed) as never);
 render(<OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/>);
 await screen.findByText(/无法打开所选会议/);expect(f.host.session!.editor).toBeNull();expect(intent.pending).toBe(false);expect(f.submit).not.toHaveBeenCalled();
});
it('requires every live exact-kind association without inventing same-organization restriction',()=>{
 const record=meeting();record.data.organizationId=org.id;record.data.attendeeIds=[person.id];const pin=selectMeetingRecord(record,'a'.repeat(64),1)!;const catalog=empty();catalog.organization=[org];catalog.person=[person];
 expect(acceptedMeetingRecord(record,pin,catalog)?.id).toBe(record.id);
 for(const invalid of [[],[{...person,deletedAt:time}],[{...person,kind:'organization'}],[person,person]]){catalog.person=invalid as OrganizationRecord[];expect(acceptedMeetingRecord(record,pin,catalog)).toBeNull();}
 catalog.person=[person];catalog.organization=[];expect(acceptedMeetingRecord(record,pin,catalog)).toBeNull();
});
it('uses one actual global approval for an unchanged hidden dirty baseline and preserves projection through refresh',async()=>{
 const f=fixture(),old=meeting('old');f.host.session!.setEditor({kind:'meeting',record:old,token:'old-editor'});
 const view=render(<OrganizationHostView host={f.host} visible routeEpoch={0}/>);await screen.findByRole('article',{name:org.data.name});fireEvent.change(screen.getByLabelText('会议标题 *'),{target:{value:'Hidden dirty draft'}});
 f.host.projection!.setDraft('planned','Retained synthetic reason');
 view.rerender(<OrganizationHostView host={f.host} visible={false} routeEpoch={0}/>);
 f.catalog['service-record']=[{id:'service-a',kind:'service-record',revision:1,createdAt:time,updatedAt:time,deletedAt:null,data:{organizationId:org.id,contactId:null,activity:'other',occurredAt:time,summary:'Synthetic service',notes:'',source:null,provenance:'user-recorded-local'}}];
 const version=f.host.session!.editorVersion,token=f.host.session!.editor!.token;
 expect(allowLeavingUnsavedWork()).toBe(true);expect(f.host.session!.editorVersion).toBe(version);expect(f.host.session!.editor!.token).toBe(token);
 const intent=f.make();view.rerender(<OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/>);
 await screen.findByDisplayValue('Synthetic meeting-a');expect(f.confirm).toHaveBeenCalledOnce();expect(f.host.projection!.state.status).toBe('planned');expect(f.host.projection!.state.reason).toBe('Retained synthetic reason');
});
it('new input cancels synchronously before deferred snapshot, ignored-abort success cannot discard it',async()=>{
 const f=fixture();f.host.session!.setEditor({kind:'meeting',record:meeting('old'),token:'old-editor'});const view=render(<OrganizationHostView host={f.host} visible routeEpoch={0}/>);await screen.findByRole('article',{name:org.data.name});const intent=f.make(),pending=deferred<OrganizationRecord<'meeting'>>();f.get.mockImplementation(()=>pending.promise as never);
 view.rerender(<OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/>);await waitFor(()=>expect(f.get).toHaveBeenCalled());
 fireEvent.change(screen.getByLabelText('会议标题 *'),{target:{value:'Newer synthetic draft'}});expect(intent.pending).toBe(false);
 await act(async()=>pending.resolve(meeting()));expect(screen.getByDisplayValue('Newer synthetic draft')).toBeTruthy();expect(f.host.session!.editor!.record!.id).toBe('old');expect(f.submit).not.toHaveBeenCalled();
});
for(const reason of ['partial','failure','wrong-kind'] as const)it(`does not admit ${reason} catalog`,async()=>{
 const f=fixture(),intent=f.make();f.list.mockImplementation(async input=>{if(input.kind==='organization'){if(reason==='failure')throw Error('Synthetic catalog failed');return {items:reason==='wrong-kind'?[person]:[],total:reason==='partial'?1:1,offset:0,nextOffset:null} as never;}return{items:[],total:0,offset:0,nextOffset:null} as never;});
 render(<OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/>);await screen.findByText(/无法打开所选会议/);expect(f.get).not.toHaveBeenCalled();expect(f.host.session!.editor).toBeNull();
});
it('previous loaded catalog cannot admit a new route until automatic current refresh completes',async()=>{
 const f=fixture();const view=render(<OrganizationHostView host={f.host} visible routeEpoch={0}/>);await screen.findByRole('article',{name:org.data.name});
 const pending=deferred<never>();f.list.mockImplementation(()=>pending.promise);const intent=f.make(1);view.rerender(<OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/>);
 await act(async()=>{});expect(f.get).not.toHaveBeenCalled();expect(intent.pending).toBe(true);
});
it('manual refresh withdraws selected open but automatic refresh and StrictMode replay do not',async()=>{
 const f=fixture(),intent=f.make(),pending=deferred<OrganizationRecord<'meeting'>>();f.get.mockImplementation(()=>pending.promise as never);
 render(<StrictMode><OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/></StrictMode>);await waitFor(()=>expect(f.get).toHaveBeenCalled());expect(intent.pending).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'刷新目录'}));expect(intent.pending).toBe(false);await act(async()=>pending.resolve(meeting()));expect(screen.queryByRole('dialog')).toBeNull();
});
it('StrictMode commits once and later explicit save remains update of same id/revision, never create',async()=>{
 const f=fixture(),intent=f.make();const view=render(<StrictMode><OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/></StrictMode>);await screen.findByRole('dialog',{name:'编辑会议'});
 const token=f.host.session!.editor!.token;view.rerender(<StrictMode><OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/></StrictMode>);expect(f.host.session!.editor!.token).toBe(token);
 const field=screen.getByLabelText('会议标题 *');fireEvent.change(field,{target:{value:'Explicit update'}});fireEvent.submit(field.closest('form')!);await waitFor(()=>expect(f.submit).toHaveBeenCalledOnce());
 expect(f.submit.mock.calls[0][0]).toMatchObject({operation:'update',kind:'meeting',id:'meeting-a'});expect(JSON.parse(f.submit.mock.calls[0][0].body)).toMatchObject({id:'meeting-a',expectedRevision:1});
});
it('hide and newer intent suppress stale success and stale failure',async()=>{
 const f=fixture(),first=f.make(),pending=deferred<OrganizationRecord<'meeting'>>();f.get.mockImplementationOnce(()=>pending.promise as never);
 const view=render(<OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={first}/>);await waitFor(()=>expect(f.get).toHaveBeenCalled());
 first.pending=false;view.rerender(<OrganizationHostView host={f.host} visible={false} routeEpoch={2}/>);await act(async()=>pending.reject(Error('Old synthetic error')));expect(screen.queryByText(/无法打开所选会议/)).toBeNull();
 const next=f.make(3);view.rerender(<OrganizationHostView host={f.host} visible routeEpoch={3} meetingOpenIntent={next}/>);await screen.findByRole('dialog',{name:'编辑会议'});expect(next.pending).toBe(false);
});
for(const barrier of ['ordinary','projection','retention'] as const)it(`hard blocks ${barrier} barrier preserving exact existing state`,async()=>{
 const f=fixture(),intent=f.make();const original=f.host.session!.editor;
 const pending={phase:'uncertain',command:{id:'original-command'}};
 if(barrier==='ordinary')vi.spyOn(f.host.session!,'pending','get').mockReturnValue(pending as never);
 if(barrier==='projection')vi.spyOn(f.host.projection!,'unsavedState').mockReturnValue({dirty:true,pending:true});
 if(barrier==='retention')vi.spyOn(f.host.session!,'draftRetentionIncomplete','get').mockReturnValue(true);
 const discard=vi.spyOn(f.host.projection!,'discardUnsubmittedDraft');
 render(<OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/>);await screen.findByText(/无法打开所选会议/);
 expect(f.host.session!.editor).toEqual(original);expect(f.get).not.toHaveBeenCalled();expect(f.submit).not.toHaveBeenCalled();expect(f.recover).not.toHaveBeenCalled();expect(discard).not.toHaveBeenCalled();
 if(barrier==='ordinary')expect(f.host.session!.pending).toBe(pending);
});
for(const cursor of [NaN,undefined,0,-1,0.5,10_001])it(`rejects malformed cursor ${String(cursor)} without scanning again`,async()=>{
 const f=fixture(),intent=f.make();f.list.mockImplementation(async input=>({items:[],total:1,offset:0,nextOffset:input.kind==='person'?cursor:null}) as never);
 render(<OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/>);await screen.findByText(/无法打开所选会议/);
 expect(f.list.mock.calls.filter(([input])=>input.kind==='person').every(([input])=>input.offset===0)).toBe(true);expect(f.get).not.toHaveBeenCalled();
});
it('pending state arriving while fresh get waits prevents commit and preserves original command',async()=>{
 const f=fixture(),intent=f.make(),read=deferred<OrganizationRecord<'meeting'>>();f.get.mockImplementation(()=>read.promise as never);
 render(<OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/>);await waitFor(()=>expect(f.get).toHaveBeenCalled());
 const pending={phase:'uncertain',command:{id:'newly-pending'}};vi.spyOn(f.host.session!,'pending','get').mockReturnValue(pending as never);
 await act(async()=>read.resolve(meeting()));await screen.findByText(/无法打开所选会议/);expect(f.host.session!.pending).toBe(pending);expect(f.host.session!.editor).toBeNull();expect(f.recover).not.toHaveBeenCalled();
});
it('vetoed local action withdraws handoff but keeps dirty editor and filters',async()=>{
 const f=fixture();f.host.session!.setEditor({kind:'meeting',record:meeting('old'),token:'retained'});const view=render(<OrganizationHostView host={f.host} visible routeEpoch={0}/>);await screen.findByRole('article',{name:org.data.name});
 fireEvent.change(screen.getByLabelText('会议标题 *'),{target:{value:'Kept dirty draft'}});const intent=f.make(),read=deferred<OrganizationRecord<'meeting'>>();f.get.mockImplementation(()=>read.promise as never);view.rerender(<OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/>);await waitFor(()=>expect(f.get).toHaveBeenCalled());
 f.confirm.mockReturnValue(false);fireEvent.click(screen.getByRole('button',{name:'取消编辑'}));expect(intent.pending).toBe(false);await act(async()=>read.resolve(meeting()));expect(screen.getByDisplayValue('Kept dirty draft')).toBeTruthy();expect(f.host.session!.editor!.record!.id).toBe('old');
});
it('accepted handoff retires older ICS completion without triggering a late download',async()=>{
 const f=fixture();const view=render(<OrganizationHostView host={f.host} visible routeEpoch={0}/>);await screen.findByRole('article',{name:org.data.name});
 fireEvent.click(screen.getByRole('button',{name:'会议与参会',exact:true}));const download=deferred<never>();f.download.mockImplementation(()=>download.promise);
 const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});const objectUrl=vi.fn();vi.stubGlobal('URL',class extends URL {static createObjectURL=objectUrl;});
 fireEvent.click(screen.getByRole('button',{name:'下载 ICS'}));const intent=f.make(1);view.rerender(<OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/>);await screen.findByRole('dialog',{name:'编辑会议'});
 await act(async()=>download.resolve({content:'SYNTHETIC',mediaType:'text/calendar',filename:'synthetic.ics'} as never));expect(objectUrl).not.toHaveBeenCalled();expect(click).not.toHaveBeenCalled();expect(screen.queryByText(/已生成本地 ICS 下载/)).toBeNull();
});
it('accepted handoff retires an older reload error without changing new editor notices',async()=>{
 const f=fixture();f.host.session!.setEditor({kind:'meeting',record:meeting('old'),token:'old-editor'});vi.spyOn(f.host.session!,'takeRejection').mockReturnValueOnce({conflict:true,message:'Synthetic conflict',command:{operation:'update',body:'{}',kind:'meeting',id:'old',fingerprint:'synthetic',token:'old-editor',message:'Synthetic conflict'}});const view=render(<OrganizationHostView host={f.host} visible routeEpoch={0}/>);await screen.findByRole('article',{name:org.data.name});
 const reload=deferred<never>();f.get.mockImplementationOnce(()=>reload.promise);fireEvent.click(screen.getByRole('button',{name:'重新载入最新版本（放弃未保存修改）'}));
 const intent=f.make(1);view.rerender(<OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/>);await screen.findByDisplayValue('Synthetic meeting-a');
 await act(async()=>reload.reject(Error('Synthetic late reload error')));expect(screen.queryByText(/无法重新载入/)).toBeNull();expect(f.host.session!.editor!.record!.id).toBe('meeting-a');
});
it('host authority replacement cancels ignored-abort fresh get and does not open in new session',async()=>{
 const f=fixture(),intent=f.make(),read=deferred<OrganizationRecord<'meeting'>>();f.get.mockImplementation(()=>read.promise as never);render(<OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/>);await waitFor(()=>expect(f.get).toHaveBeenCalled());
 await act(async()=>{f.host.setAuthority('b'.repeat(64),true);read.resolve(meeting());});expect(f.host.session!.editor).toBeNull();expect(screen.queryByRole('dialog')).toBeNull();
});
for(const barrier of ['projection','retention','editor-version','editor-token'] as const)it(`rechecks ${barrier} immediately before commit`,async()=>{
 const f=fixture(),intent=f.make(),read=deferred<OrganizationRecord<'meeting'>>();f.get.mockImplementation(()=>read.promise as never);
 render(<OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/>);await waitFor(()=>expect(f.get).toHaveBeenCalled());
 if(barrier==='projection')vi.spyOn(f.host.projection!,'unsavedState').mockReturnValue({dirty:true,pending:true});
 if(barrier==='retention')vi.spyOn(f.host.session!,'draftRetentionIncomplete','get').mockReturnValue(true);
 if(barrier==='editor-version')vi.spyOn(f.host.session!,'editorVersion','get').mockReturnValue(intent.approvedEditorVersion+1);
 if(barrier==='editor-token')vi.spyOn(f.host.session!,'editor','get').mockReturnValue({kind:'meeting',record:meeting('newer'),token:'newer-token',dirty:true});
 const before=f.host.session!.editor;
 await act(async()=>read.resolve(meeting()));await screen.findByText(/无法打开所选会议/);expect(f.host.session!.editor).toEqual(before);expect(intent.pending).toBe(false);expect(f.submit).not.toHaveBeenCalled();expect(f.recover).not.toHaveBeenCalled();
});
for(const action of ['tab','search'] as const)it(`newer local ${action} suppresses stale get error`,async()=>{
 const f=fixture(),intent=f.make(),read=deferred<OrganizationRecord<'meeting'>>();f.get.mockImplementation(()=>read.promise as never);render(<OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/>);await waitFor(()=>expect(f.get).toHaveBeenCalled());
 if(action==='tab')fireEvent.click(screen.getByRole('button',{name:'会议与参会',exact:true}));else fireEvent.change(screen.getByLabelText('搜索本地记录'),{target:{value:'Newer local query'}});
 expect(intent.pending).toBe(false);await act(async()=>read.reject(Error('Ignored older synthetic failure')));expect(screen.queryByText(/无法打开所选会议/)).toBeNull();expect(screen.queryByRole('dialog')).toBeNull();
 if(action==='search')expect(screen.getByDisplayValue('Newer local query')).toBeTruthy();
});
it('Escape dismissal synchronously withdraws get and cannot reopen from late success',async()=>{
 const f=fixture();f.host.session!.setEditor({kind:'meeting',record:meeting('old'),token:'old-editor'});const view=render(<OrganizationHostView host={f.host} visible routeEpoch={0}/>);await screen.findByRole('article',{name:org.data.name});
 const intent=f.make(),read=deferred<OrganizationRecord<'meeting'>>();f.get.mockImplementation(()=>read.promise as never);view.rerender(<OrganizationHostView host={f.host} visible routeEpoch={1} meetingOpenIntent={intent}/>);await waitFor(()=>expect(f.get).toHaveBeenCalled());
 fireEvent.keyDown(document,{key:'Escape'});expect(intent.pending).toBe(false);await act(async()=>read.resolve(meeting()));expect(screen.queryByRole('dialog')).toBeNull();expect(f.host.session!.editor).toBeNull();
});
