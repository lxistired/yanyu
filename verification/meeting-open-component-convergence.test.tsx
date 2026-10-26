// JSDOM orchestration: real agenda, shell, retained host and editor; only in-memory fetch transport is mocked.
import React,{StrictMode} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {OrganizationWriteHost} from '../candidate/src/components/organization-write-host';
import type {OrganizationKind,OrganizationRecord} from '../candidate/shared/organization';
const time='2026-10-22T00:00:00.000Z';
const meeting=(id='meeting-a',state:'scheduled'|'cancelled'|'completed'='scheduled'):OrganizationRecord<'meeting'>=>({id,kind:'meeting',revision:1,createdAt:time,updatedAt:time,deletedAt:null,data:{title:'Synthetic '+id,organizationId:null,series:'',category:'research',startsAt:time,endsAt:'2026-10-22T01:00:00.000Z',timezone:'UTC',location:'Local room',description:'Synthetic only',attendeeIds:[],state,providerAvailability:'unconfigured'}});
const org:OrganizationRecord<'organization'>={id:'org-a',kind:'organization',revision:1,createdAt:time,updatedAt:time,deletedAt:null,data:{name:'Synthetic organization',parentId:null,category:'other',description:'',website:'',tags:[],verification:'unverified'}};
const person:OrganizationRecord<'person'>={id:'person-a',kind:'person',revision:1,createdAt:time,updatedAt:time,deletedAt:null,data:{name:'Synthetic person',organizationId:'other-org',role:'',department:'',email:'',biography:'',followed:false,tags:[]}};
const kinds:OrganizationKind[]=['organization','person','meeting','meeting-registration','crm-contact','service-record','bookmark','reading-record','access-request','share-draft'];
const empty=()=>Object.fromEntries(kinds.map(k=>[k,[]])) as Record<OrganizationKind,OrganizationRecord[]>;

const hosts:OrganizationWriteHost[]=[];
afterEach(()=>{cleanup();hosts.splice(0).forEach(h=>h.dispose());vi.restoreAllMocks();vi.unstubAllGlobals();history.replaceState(null,'','/');});
async function fixture(deferredGet=false){
 const host=new OrganizationWriteHost();host.activate();host.setAuthority('a'.repeat(64),true);hosts.push(host);
 const target=meeting('selected-meeting'),old=meeting('old-meeting'),catalog=empty();catalog.organization=[org];catalog.meeting=[target];
 let resolveGet!:(r:Response)=>void;const pending=new Promise<Response>(resolve=>resolveGet=resolve);
 const calls:{path:string;body:any}[]=[];
 const response=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
 const transport=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(url),body=JSON.parse(String(init?.body??'null'));calls.push({path,body});expect(init?.method).toBe('POST');
  if(path==='/api/organization/list'){expect(kinds).toContain(body.kind);const items=catalog[body.kind as OrganizationKind];return response({items,total:items.length,offset:0,nextOffset:null});}
  if(path==='/api/organization/get'){expect(body).toEqual({kind:'meeting',id:target.id,includeDeleted:false});return deferredGet?pending:response(target);}
  throw Error('Unexpected mutation, export, recovery or unrelated request: '+path);
 });vi.stubGlobal('fetch',transport);
 const writes=[vi.spyOn(host.session!,'submit'),vi.spyOn(host.session!,'recover'),vi.spyOn(host.projection!,'submit'),vi.spyOn(host.projection!,'retry')];
 host.session!.setEditor({kind:'meeting',record:old,token:'old-editor'});
 history.replaceState(null,'','/?page=organization');const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
 render(<StrictMode><OrdinaryNavigationShell lifetime={new OrdinaryRequestLifetime()} organizationWriteHost={host}/></StrictMode>);
 await screen.findByRole('article',{name:org.data.name});
 fireEvent.change(screen.getByLabelText('会议标题 *'),{target:{value:'Retained hidden draft'}});
 expect(host.session!.unsavedState().dirty).toBe(true);
 act(()=>host.projection!.setDraft('planned','Retained projection reason'));
 fireEvent.click(screen.getByRole('button',{name:'本地会议日程',exact:true}));
 const open=await screen.findByRole('button',{name:'打开此会议记录：'+target.data.title});
 catalog['service-record']=[{id:'service-a',kind:'service-record',revision:1,createdAt:time,updatedAt:time,deletedAt:null,data:{organizationId:org.id,contactId:null,activity:'other',occurredAt:time,summary:'Synthetic service',notes:'',source:null,provenance:'user-recorded-local'}}];
 confirm.mockClear();
 const noWrites=()=>{for(const spy of writes)expect(spy).not.toHaveBeenCalled();expect(calls.every(c=>['/api/organization/list','/api/organization/get'].includes(c.path))).toBe(true);};
 return{host,target,old,open,confirm,calls,noWrites,finish:()=>resolveGet(response(target))};
}
it('real agenda to retained editor uses one accepted hidden-draft guard, no writes, and preserves latent projection through refresh',async()=>{
 const f=await fixture();const before=f.host.session!.editor,version=f.host.session!.editorVersion;
 f.confirm.mockReturnValue(false);fireEvent.click(f.open);
 expect(f.confirm).toHaveBeenCalledOnce();expect(location.search).toBe('?page=calendar');expect(f.host.session!.editor).toEqual(before);expect(f.host.session!.editorVersion).toBe(version);expect(f.calls.filter(c=>c.path.endsWith('/get'))).toHaveLength(0);f.noWrites();
 f.confirm.mockClear();f.confirm.mockReturnValue(true);fireEvent.click(f.open);
 await screen.findByDisplayValue(f.target.data.title);expect(f.confirm).toHaveBeenCalledOnce();expect(location.search).toBe('?page=organization');
 expect(f.host.session!.editor!.record!.id).toBe(f.target.id);expect(f.host.session!.editor!.record!.revision).toBe(1);expect(f.host.session!.unsavedState().dirty).toBe(false);
 expect(f.host.projection!.state.status).toBe('planned');expect(f.host.projection!.state.reason).toBe('Retained projection reason');
 expect(f.calls.filter(c=>c.path.endsWith('/get'))).toHaveLength(1);f.noWrites();
});
it('real retained editor newer input defeats ignored-abort deferred selected get without writes',async()=>{
 const f=await fixture(true);fireEvent.click(f.open);await waitFor(()=>expect(f.calls.filter(c=>c.path.endsWith('/get'))).toHaveLength(1));
 fireEvent.change(screen.getByLabelText('会议标题 *'),{target:{value:'Newer editor input'}});
 await act(async()=>f.finish());expect(screen.getByDisplayValue('Newer editor input')).toBeTruthy();expect(f.host.session!.editor!.record!.id).toBe(f.old.id);expect(f.host.session!.unsavedState().dirty).toBe(true);
 expect(f.confirm).toHaveBeenCalledOnce();expect(f.host.projection!.state.reason).toBe('Retained projection reason');f.noWrites();
});
