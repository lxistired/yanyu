import React,{useState} from 'react';
import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import {render,screen,waitFor,cleanup,act} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {ManualPlanManager} from '../candidate/src/components/ManualPlanManager';
import {ManualPlanHost} from '../candidate/src/components/manual-plan-host';
import {WorkspaceHostView} from '../candidate/src/components/WorkspaceHostView';
import {WorkspaceWriteHost} from '../candidate/src/components/workspace-write-host';
import {workspaceApi} from '../candidate/src/adapters/workspace';
import {allowLeavingUnsavedWork} from '../candidate/src/components/unsaved-work';
import {createPlanConversationIntent,admitPlanConversation,type PlanConversationIntent,type PlanConversationSource} from '../candidate/src/components/plan-conversation-handoff';
vi.mock('../candidate/src/adapters/workspace',()=>({workspaceApi:{list:vi.fn(),get:vi.fn(),create:vi.fn()}}));
const at='2026-10-24T00:00:00.000Z',identity='a'.repeat(64),scope='b'.repeat(64);
const link={scope,workspaceId:'wa',sessionId:'sa',workspaceRevision:1,sessionRevision:1};
const record=(kind:string,id:string,data:any)=>({kind,id,data,revision:1,createdAt:at,updatedAt:at,deletedAt:null});
let host:WorkspaceWriteHost,planHost:ManualPlanHost,rows:any[],plan:any,requests:any[],invalid:string|null,writes:any[];
beforeEach(()=>{
 invalid=null;requests=[];writes=[];
 rows=[record('workspace','wa',{name:'Workspace A',parentId:null,description:''}),record('workspace','wb',{name:'Workspace B',parentId:null,description:''}),
  record('session','sa',{title:'Duplicate title',workspaceId:'wa',groupId:null,pinned:false,mode:'quick',model:''}),record('session','sb',{title:'Duplicate title',workspaceId:'wb',groupId:null,pinned:false,mode:'quick',model:''}),
  record('message','ma',{sessionId:'sa',role:'user',content:'Correct A manual message',sequence:1}),record('message','mb',{sessionId:'sb',role:'user',content:'Wrong B manual message',sequence:1})];
 plan={...record('manual-research-plan','p',{schemaVersion:1,provenance:'user-authored-local',state:'draft',title:'Source plan',objective:'Original objective',notes:'Original notes',targetDate:null,sessionLink:link}),storeScope:scope};
 planHost=new ManualPlanHost(async(url,init)=>{
  const input=JSON.parse(String(init?.body));requests.push({url,input});
  let value:any;
  if(String(url).endsWith('/list'))value={items:[plan],total:1,offset:0,nextOffset:null};
  else if(String(url).endsWith('/linkedSession')){
   value={scope,planId:'p',planRevision:1,sessionLink:link,workspace:{id:'wa',title:'Workspace A',revision:1},session:{id:'sa',title:'Duplicate title',revision:1,workspaceId:'wa',mode:'quick',model:''},items:[rows.find(r=>r.id==='ma')],total:1,offset:0,nextOffset:null};
   if(invalid==='scope')value.scope='c'.repeat(64);if(invalid==='revision')value.session.revision=2;
  }else throw Error('Unexpected plan operation: '+url);
  return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
 });
 planHost.activate();planHost.setAuthority(identity,true);
 planHost.session!.editor={key:'p',record:plan,draft:{title:'Source plan',objective:'Original objective',notes:'Unsaved plan notes',targetDate:null},dirty:true,materialBasket:[{kind:'transcript',transcriptStoreId:'source-a',jobId:'pending-material'}]};
 host=new WorkspaceWriteHost();host.activate();host.setAuthority(identity,true);
 host.session!.setDraft({view:{kind:'message',workspaceId:'wb',sessionId:'sb',groupId:'*',watchlistId:'',query:'',includeDeleted:false,pinned:false,offset:0},editor:null,dirty:false});
 vi.mocked(workspaceApi.list).mockImplementation(async(q)=>{const items=rows.filter(r=>r.kind===q.kind&&(!q.workspaceId||r.data.workspaceId===q.workspaceId)&&(!q.sessionId||r.data.sessionId===q.sessionId));return {items:structuredClone(items),total:items.length,offset:0,nextOffset:null} as any;});
 vi.mocked(workspaceApi.get).mockImplementation(async(q)=>structuredClone(rows.find(r=>r.id===q.id)));
 vi.mocked(workspaceApi.create).mockImplementation(async(q)=>{writes.push(structuredClone(q));const r=record(q.kind,'created-message',{...q.data,sequence:2});rows.push(r);return structuredClone(r) as any;});
});
afterEach(()=>{cleanup();host.dispose();planHost.dispose();vi.restoreAllMocks();vi.clearAllMocks();});
/** Bounded composition of real components, not the application's Shell or URL history. */
function Flow(){
 const [page,setPage]=useState<'planner'|'chat'>('planner'),[intent,setIntent]=useState<PlanConversationIntent|null>(null);
 const open=(source:PlanConversationSource)=>{const next=createPlanConversationIntent(source,host,()=>planHost.session===source.session,()=>true);if(next&&allowLeavingUnsavedWork()){setIntent(next);setPage('chat');}};
 return <>{page==='planner'&&<ManualPlanManager session={planHost.session!} onClose={()=>{}} onOpenConversation={open}/>}<WorkspaceHostView host={host} visible={page==='chat'} entryMode="manual-conversation" conversationIntent={intent} onReturnToPlan={()=>{if(allowLeavingUnsavedWork()){setPage('planner');setIntent(null);}}}/></>;
}
async function handoff(){const u=userEvent.setup();await u.click(await screen.findByRole('button',{name:'打开已关联会话（只读）'}));await u.click(await screen.findByRole('button',{name:'转到此会话手工记录'}));return u;}
it('exact linked A replaces only clean old B selection; manual save and guarded return preserve source plan plus new message draft',async()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(true),source=planHost.session!.editor,writer=host.session;
 render(<Flow/>);const u=await handoff();await screen.findByRole('heading',{name:'Correct A manual message',level:2});
 expect(screen.queryByText('Wrong B manual message')).toBeNull();expect(host.session).toBe(writer);expect(writes).toHaveLength(0);
 const linked=requests.filter(r=>String(r.url).endsWith('/linkedSession'));expect(linked.map(r=>r.input.limit)).toEqual([25,1]);expect(linked[1].input).toMatchObject({id:'p',expectedRevision:1,scope,sessionLink:link});
 expect(vi.mocked(workspaceApi.list).mock.calls.filter(([q])=>q.kind==='message').every(([q])=>q.sessionId==='sa')).toBe(true);
 await u.click(screen.getByRole('button',{name:'新建消息'}));await u.type(screen.getByLabelText('消息正文'),'Explicit human note');await u.click(screen.getByRole('button',{name:'保存消息'}));
 await screen.findByRole('heading',{name:'Explicit human note',level:2});expect(writes).toHaveLength(1);expect(writes[0].data).toMatchObject({sessionId:'sa',role:'user',content:'Explicit human note'});
 await u.click(screen.getByRole('button',{name:'新建消息'}));await u.type(screen.getByLabelText('消息正文'),'Keep unsaved message');
 confirm.mockReturnValue(false);await u.click(screen.getByRole('button',{name:'返回来源计划：Source plan'}));expect(screen.getByDisplayValue('Keep unsaved message')).toBeTruthy();
 confirm.mockReturnValue(true);await u.click(screen.getByRole('button',{name:'返回来源计划：Source plan'}));await screen.findByRole('region',{name:'计划会话关联'});
 expect(planHost.session!.editor).toBe(source);expect(screen.getByDisplayValue('Unsaved plan notes')).toBeTruthy();expect(screen.getByRole('listitem',{name:'待添加资料 transcript source-a pending-material'})).toBeTruthy();
 expect((host.session!.draft!.editor as any).draft.content).toBe('Keep unsaved message');expect(writes).toHaveLength(1);
});
it('stale revision and wrong store envelope fail closed with no old B manager, and changed lookup revision blocks message reads',async()=>{
 const source={session:planHost.session!,record:plan,link};
 for(const failure of ['scope','revision']){
  invalid=failure;const before=host.session!.draft,version=host.session!.draftVersion;const intent=createPlanConversationIntent(source,host,()=>true,()=>true)!;
  const view=render(<WorkspaceHostView host={host} visible entryMode="manual-conversation" conversationIntent={intent}/>);
  await screen.findByText(/无法进入来源计划的精确会话/);expect(workspaceApi.list).not.toHaveBeenCalled();expect(host.session!.draft).toEqual(before);expect(host.session!.draftVersion).toBe(version);view.unmount();
 }
 invalid=null;rows.find(r=>r.id==='sa').revision=2;const intent=createPlanConversationIntent(source,host,()=>true,()=>true)!;
 render(<WorkspaceHostView host={host} visible entryMode="manual-conversation" conversationIntent={intent}/>);
 await screen.findByText(/来源计划的会话版本已变化/);expect(vi.mocked(workspaceApi.list).mock.calls.some(([q])=>q.kind==='message')).toBe(false);expect(screen.getByRole('button',{name:'新建消息'}).hasAttribute('disabled')).toBe(true);expect(writes).toHaveLength(0);
});
it('existing destination draft is not overwritten and delayed admission cannot overwrite a newer draft or host generation',async()=>{
 const source={session:planHost.session!,record:plan,link},saved=host.session!.draft!;
 host.session!.setDraft({...saved,editor:{kind:'message',draft:{sessionId:'sb',content:'Existing B draft'}},dirty:true});
 expect(createPlanConversationIntent(source,host,()=>true,()=>true)).toBeNull();expect(requests).toHaveLength(0);
 host.session!.setDraft(saved);let release!:()=>void;const original=source.session.client.linkedSession.bind(source.session.client);
 vi.spyOn(source.session.client,'linkedSession').mockImplementation(async input=>{await new Promise<void>(r=>release=r);return original(input);});
 const intent=createPlanConversationIntent(source,host,()=>true,()=>true)!;const pending=admitPlanConversation(intent,()=>true);
 host.session!.setDraft({...saved,editor:{kind:'message',draft:{sessionId:'sb',content:'New B draft'}},dirty:true});release();expect(await pending).toBe(false);expect((host.session!.draft!.editor as any).draft.content).toBe('New B draft');
 host.session!.setDraft(saved);const old=createPlanConversationIntent(source,host,()=>true,()=>true)!;act(()=>host.setAuthority(identity,true));expect(await admitPlanConversation(old,()=>true)).toBe(false);expect(host.session!.draft).toBeNull();expect(writes).toHaveLength(0);
});
