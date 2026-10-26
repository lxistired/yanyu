// @vitest-environment jsdom
import React from 'react';
import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import {render,screen,waitFor,cleanup,act,within,fireEvent} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {WorkspaceManager} from '../candidate/src/components/WorkspaceManager';
import {WorkspaceHostView} from '../candidate/src/components/WorkspaceHostView';
import {WorkspaceWriteHost} from '../candidate/src/components/workspace-write-host';
import {workspaceApi} from '../candidate/src/adapters/workspace';
import {ApiError} from '../candidate/src/adapters/api';
import {Modal} from '../candidate/src/components/common';
import {allowLeavingUnsavedWork} from '../candidate/src/components/unsaved-work';
vi.mock('../candidate/src/adapters/workspace',()=>({workspaceApi:{list:vi.fn(),create:vi.fn(),get:vi.fn(),previewDelete:vi.fn(),batchDelete:vi.fn()}}));
let host:WorkspaceWriteHost,rows:any[],calls:any[],receipts:Map<string,any>;
beforeEach(()=>{vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Synthetic linked-transcript identity is unavailable'));host=new WorkspaceWriteHost();host.activate();host.setAuthority('a'.repeat(64),true);rows=[];calls=[];receipts=new Map();
 vi.mocked(workspaceApi.list).mockImplementation(async({kind,offset=0})=>({items:kind==='workspace'?[...rows]:[],total:kind==='workspace'?rows.length:0,offset,nextOffset:null}) as any);
 vi.mocked(workspaceApi.get).mockImplementation(async({id})=>structuredClone(rows.find(v=>v.id===id)));
 vi.mocked(workspaceApi.create).mockImplementation(async(input)=>{calls.push(structuredClone(input));let row=receipts.get(input.idempotencyKey);if(!row){row={kind:input.kind,id:`synthetic-${rows.length+1}`,revision:1,createdAt:'2026-10-21T00:00:00Z',updatedAt:'2026-10-21T00:00:00Z',deletedAt:null,data:{parentId:null,description:'',...structuredClone(input.data)}};rows.push(row);receipts.set(input.idempotencyKey,row);}if(calls.length===1)throw new ApiError({code:'PROVIDER_ERROR',message:'Synthetic committed response lost',retryable:true},'unknown');return row;});
});
afterEach(()=>{cleanup();host.dispose();vi.restoreAllMocks();vi.clearAllMocks();});
async function draft(name:string){const u=userEvent.setup();const button=await screen.findByRole('button',{name:'新建工作区',exact:true});await waitFor(()=>expect((button as HTMLButtonElement).disabled).toBe(false));await u.click(button);await u.type(screen.getByLabelText('工作区名称'),name);return u;}
it('unknown A then B save is blocked; original exact retry resolves without clearing newer B',async()=>{render(<WorkspaceManager session={host.session!}/>);const u=await draft('A');await u.click(screen.getByRole('button',{name:'保存工作区'}));await waitFor(()=>expect(host.session?.pending?.phase).toBe('unknown'));const name=screen.getByLabelText('工作区名称');await u.clear(name);await u.type(name,'B');await u.click(screen.getByRole('button',{name:'保存工作区'}));expect(calls).toHaveLength(1);await u.click(screen.getByRole('button',{name:'重试原操作',exact:true}));await waitFor(()=>expect(host.session?.pending).toBeNull());expect(calls).toHaveLength(2);expect(calls[0].idempotencyKey).toBe(calls[1].idempotencyKey);expect(rows).toHaveLength(1);expect(screen.getByDisplayValue('B')).toBeTruthy();});
it('unknown draft and key survive visible→hidden→visible; hidden host does not consume other modal Escape',async()=>{let closes=0;const view=render(<WorkspaceHostView host={host} visible/>);const u=await draft('A');await u.click(screen.getByRole('button',{name:'保存工作区'}));await waitFor(()=>expect(host.session?.pending?.phase).toBe('unknown'));const key=JSON.parse(host.session!.pending!.command.body).idempotencyKey;view.rerender(<><WorkspaceHostView host={host} visible={false}/><Modal title="Other page" onClose={()=>closes++}><p>Other editor</p></Modal></>);await u.keyboard('{Escape}');expect(closes).toBe(1);expect(host.session?.draft?.editor).toBeTruthy();view.rerender(<WorkspaceHostView host={host} visible/>);expect(await screen.findByDisplayValue('A')).toBeTruthy();expect(JSON.parse(host.session!.pending!.command.body).idempotencyKey).toBe(key);await u.click(screen.getByRole('button',{name:'重试原操作',exact:true}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect(rows).toHaveLength(1);});
it('host dirtiness registers one guard even with mounted editor, still guards when hidden',async()=>{const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const view=render(<WorkspaceHostView host={host} visible/>);await draft('A');expect(allowLeavingUnsavedWork()).toBe(false);expect(confirm).toHaveBeenCalledTimes(1);view.rerender(<WorkspaceHostView host={host} visible={false}/>);expect(allowLeavingUnsavedWork()).toBe(false);expect(confirm).toHaveBeenCalledTimes(2);});
it('pending→remount→late ACK/current closes same original create draft and cannot resave stale A',async()=>{let finish!:(v:any)=>void;vi.mocked(workspaceApi.create).mockImplementation(async(input)=>{calls.push(input);const r={kind:'workspace',id:'late',revision:1,createdAt:'2026-10-21T00:00:00Z',updatedAt:'2026-10-21T00:00:00Z',deletedAt:null,data:{name:'A',description:'',parentId:null}};rows.push(r);return new Promise(resolve=>finish=resolve);});const view=render(<WorkspaceHostView host={host} visible/>);const u=await draft('A');await u.click(screen.getByRole('button',{name:'保存工作区'}));await waitFor(()=>expect(calls).toHaveLength(1));view.rerender(<WorkspaceHostView host={host} visible={false}/>);view.rerender(<WorkspaceHostView host={host} visible/>);expect(await screen.findByDisplayValue('A')).toBeTruthy();await act(async()=>finish(rows[0]));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect(host.session?.completionEvent).toBeNull();expect(calls).toHaveLength(1);});

it('older batch A recovery never closes newer B preview or clears its selection or expands original range',async()=>{
 rows=['A','B'].map(name=>({kind:'workspace',id:name,revision:1,createdAt:'2026-10-21T00:00:00Z',updatedAt:'2026-10-21T00:00:00Z',deletedAt:null,data:{name,parentId:null,description:''}}));
 vi.mocked(workspaceApi.previewDelete).mockImplementation(async({id})=>[{kind:'workspace',id,expectedRevision:1}]);
 const writes:any[]=[];vi.mocked(workspaceApi.batchDelete).mockImplementation(async(input)=>{writes.push(structuredClone(input));const r=rows.find(r=>r.id===input.items[0].id);r.deletedAt='2026-10-21T00:00:00Z';r.revision=2;if(writes.length===1)throw Error('committed response lost');return [{kind:'workspace',id:r.id,revision:2,deletedAt:r.deletedAt}];});
 render(<WorkspaceHostView host={host} visible/>);const u=userEvent.setup();await u.click(await screen.findByRole('button',{name:'删除 A',exact:true}));const confirm=await screen.findByRole('button',{name:'确认移到回收站'});await waitFor(()=>expect((confirm as HTMLButtonElement).disabled).toBe(false));await u.click(confirm);await waitFor(()=>expect(host.session?.pending?.phase).toBe('unknown'));await u.click(screen.getByRole('button',{name:'取消',exact:true}));await u.click(screen.getByRole('checkbox',{name:'选择 B',exact:true}));await u.click(screen.getByRole('button',{name:'删除 B',exact:true}));await waitFor(()=>expect((screen.getByRole('button',{name:'确认移到回收站'}) as HTMLButtonElement).disabled).toBe(false));await u.click(screen.getByRole('button',{name:'重试原操作',exact:true}));await waitFor(()=>expect(host.session?.pending).toBeNull());expect(screen.getByRole('dialog',{name:'确认删除范围'})).toBeTruthy();expect(screen.getByText('选择：B')).toBeTruthy();await waitFor(()=>expect((screen.getByRole('checkbox',{name:'选择 B',exact:true}) as HTMLInputElement).checked).toBe(true));expect(writes).toHaveLength(2);expect(writes[0]).toEqual(writes[1]);expect(writes[0].items.map((v:any)=>v.id)).toEqual(['A']);expect(rows.find(r=>r.id==='B').deletedAt).toBeNull();
});


// Manual conversation is an entry into the same real manager and write host.
// The transport below is synthetic; it does not represent browser or HTTP proof.
function manualRows() {
 const at='2026-10-24T00:00:00Z';
 const record=(kind:string,id:string,data:any)=>({kind,id,data,revision:1,createdAt:at,updatedAt:at,deletedAt:null});
 rows=[record('workspace','wa',{name:'Workspace A',parentId:null,description:''}),
   record('workspace','wb',{name:'Workspace B',parentId:null,description:''}),
   record('session','sa',{title:'Session A',workspaceId:'wa',groupId:null,pinned:false,mode:'quick',model:''}),
   record('session','sb',{title:'Session B',workspaceId:'wb',groupId:null,pinned:false,mode:'quick',model:''}),
   record('message','ma',{sessionId:'sa',role:'user',content:'Saved manual note A',sequence:1}),
   record('message','mb',{sessionId:'sb',role:'assistant',content:'Other workspace note B',sequence:1})];
 vi.mocked(workspaceApi.list).mockImplementation(async(request)=>{
   const items=rows.filter(row=>row.kind===request.kind && (request.includeDeleted||!row.deletedAt) &&
     (!request.workspaceId||row.data.workspaceId===request.workspaceId) &&
     (!request.sessionId||row.data.sessionId===request.sessionId));
   return {items:structuredClone(items),total:items.length,offset:request.offset??0,nextOffset:null} as any;
 });
 vi.mocked(workspaceApi.create).mockImplementation(async(input)=>{
   calls.push(structuredClone(input));
   let row=receipts.get(input.idempotencyKey);
   if(!row){row=record(input.kind,'manual-'+receipts.size,{...structuredClone(input.data),...(input.kind==='message'?{sequence:2}:{})});rows.push(row);receipts.set(input.idempotencyKey,row);}
   return structuredClone(row);
 });
}
async function openManualMessages() {
 const u=userEvent.setup();
 const select=await screen.findByRole('combobox',{name:'当前工作区'});
 await waitFor(()=>expect(within(select).getByRole('option',{name:'Workspace A'})).toBeTruthy());
 await u.selectOptions(select,'wa');
 const card=(await screen.findByRole('heading',{name:'Session A',level:2})).closest('article')!;
 await u.click(within(card).getByRole('button',{name:'查看消息'}));
 await screen.findByRole('heading',{name:'Saved manual note A',level:2});
 return u;
}
it('manual entry requires explicit workspace then session and returns without writes or cross-scope reads',async()=>{
 manualRows(); const original=host.session;
 render(<WorkspaceHostView host={host} visible entryMode="manual-conversation"/>);
 await screen.findByText('请先选择一个工作区，再选择会话；尚未读取任何会话消息。');
 expect(screen.getByRole('button',{name:'新建会话'}).hasAttribute('disabled')).toBe(true);
 expect(workspaceApi.list).toHaveBeenCalled();
 expect(vi.mocked(workspaceApi.list).mock.calls.every(([q])=>q.kind==='workspace')).toBe(true);
 expect(screen.getByText(/本地手工会话，未连接 AI；消息由用户录入/)).toBeTruthy();
 const u=await openManualMessages();
 expect(screen.queryByText('Other workspace note B')).toBeNull();
 expect(vi.mocked(workspaceApi.list).mock.calls.filter(([q])=>q.kind==='session').every(([q])=>q.workspaceId==='wa')).toBe(true);
 expect(vi.mocked(workspaceApi.list).mock.calls.filter(([q])=>q.kind==='message').every(([q])=>q.sessionId==='sa')).toBe(true);
 await u.click(screen.getByRole('button',{name:'返回会话列表'}));
 await screen.findByRole('heading',{name:'Session A',level:2});
 expect((screen.getByLabelText('当前工作区') as HTMLSelectElement).value).toBe('wa');
 expect(host.session).toBe(original);expect(calls).toHaveLength(0);
 expect(globalThis.fetch).not.toHaveBeenCalled();expect(screen.queryByRole('region',{name:'关联转写资料'})).toBeNull();
});
it('manual assistant-role append uses one existing captured command and displays no generated reply',async()=>{
 manualRows();render(<WorkspaceHostView host={host} visible entryMode="manual-conversation"/>);
 const u=await openManualMessages();await u.click(screen.getByRole('button',{name:'新建消息'}));
 expect(screen.getByRole('option',{name:'助手（手工录入，非 AI 回复）'})).toBeTruthy();
 await u.selectOptions(screen.getByLabelText('消息角色'),'assistant');await u.type(screen.getByLabelText('消息正文'),'Human typed assistant note');
 let release!:()=>void;const create=vi.mocked(workspaceApi.create).getMockImplementation()!;
 vi.mocked(workspaceApi.create).mockImplementation(async input=>new Promise(resolve=>{release=async()=>resolve(await create(input));}));
 const save=screen.getByRole('button',{name:'保存消息'});
 fireEvent.click(save);fireEvent.click(save);
 await waitFor(()=>expect(host.session?.pending?.phase).toBe('sending'));
 expect(workspaceApi.create).toHaveBeenCalledTimes(1);
 const captured=JSON.parse(host.session!.pending!.command.body);
 expect(captured).toMatchObject({kind:'message',data:{sessionId:'sa',role:'assistant',content:'Human typed assistant note'}});
 expect(captured.idempotencyKey).toBeTruthy();
 await act(async()=>release());await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
 await screen.findByRole('heading',{name:'Human typed assistant note',level:2});
 expect(screen.getByText('Session A · 助手（手工标记，非生成回复）')).toBeTruthy();
 expect(rows.filter(row=>row.kind==='message'&&row.data.sessionId==='sa')).toHaveLength(2);
 expect(calls).toHaveLength(1);expect(host.session?.pending).toBeNull();
});
it('manual unknown append retains edited draft and exact retry across entry mode changes',async()=>{
 manualRows();const create=vi.mocked(workspaceApi.create).getMockImplementation()!;
 vi.mocked(workspaceApi.create).mockImplementation(async input=>{const row=await create(input);if(calls.length===1)throw new ApiError({code:'PROVIDER_ERROR',message:'Synthetic lost ACK',retryable:true},'unknown');return row;});
 const view=render(<WorkspaceHostView host={host} visible entryMode="manual-conversation"/>);
 const original=host.session;const u=await openManualMessages();await u.click(screen.getByRole('button',{name:'新建消息'}));
 await u.type(screen.getByLabelText('消息正文'),'Original A');await u.click(screen.getByRole('button',{name:'保存消息'}));
 await waitFor(()=>expect(host.session?.pending?.phase).toBe('unknown'));
 await u.clear(screen.getByLabelText('消息正文'));await u.type(screen.getByLabelText('消息正文'),'New draft B');
 const command=host.session!.pending!.command;
 view.rerender(<WorkspaceHostView host={host} visible entryMode="workspace"/>);
 view.rerender(<WorkspaceHostView host={host} visible={false} entryMode="manual-conversation"/>);
 view.rerender(<WorkspaceHostView host={host} visible entryMode="manual-conversation"/>);
 expect(screen.getByDisplayValue('New draft B')).toBeTruthy();expect(host.session).toBe(original);expect(host.session?.pending?.command).toBe(command);
 await u.click(screen.getByRole('button',{name:'保存消息'}));expect(calls).toHaveLength(1);
 await u.click(screen.getByRole('button',{name:'重试原操作',exact:true}));await waitFor(()=>expect(host.session?.pending).toBeNull());
 expect(calls).toHaveLength(2);expect(calls[0]).toEqual(calls[1]);expect(screen.getByDisplayValue('New draft B')).toBeTruthy();
 expect(rows.filter(row=>row.data.content==='Original A')).toHaveLength(1);
 expect(rows.filter(row=>row.data.content==='New draft B')).toHaveLength(0);
});
it('non-conversation dirty editor blocks entry switching without changing its draft or version',async()=>{
 const go=vi.fn();const view=render(<WorkspaceHostView host={host} visible onOpenWorkspace={go}/>);
 await draft('Keep original workspace');const original=host.session, retained=host.session!.draft,version=host.session!.draftVersion;
 view.rerender(<WorkspaceHostView host={host} visible entryMode="manual-conversation" onOpenWorkspace={go}/>);
 expect(screen.getByText(/工作区仍有其他类型的草稿或待确认操作/)).toBeTruthy();expect(screen.queryByRole('dialog')).toBeNull();
 expect(host.session).toBe(original);expect(host.session!.draft).toEqual(retained);expect(host.session!.draftVersion).toBe(version);expect(calls).toHaveLength(0);
 await userEvent.setup().click(screen.getByRole('button',{name:'返回工作区管理'}));expect(go).toHaveBeenCalledOnce();
 view.rerender(<WorkspaceHostView host={host} visible/>);expect(screen.getByDisplayValue('Keep original workspace')).toBeTruthy();
});
it('non-conversation unknown command is not hidden behind a fresh conversation writer',async()=>{
 const view=render(<WorkspaceHostView host={host} visible/>);const u=await draft('Workspace original command');
 await u.click(screen.getByRole('button',{name:'保存工作区'}));await waitFor(()=>expect(host.session?.pending?.phase).toBe('unknown'));
 const command=host.session!.pending!.command,retained=host.session!.draft,version=host.session!.draftVersion;
 view.rerender(<WorkspaceHostView host={host} visible entryMode="manual-conversation"/>);
 expect(screen.getByText(/工作区仍有其他类型的草稿或待确认操作/)).toBeTruthy();expect(calls).toHaveLength(1);
 expect(host.session?.pending?.command).toBe(command);expect(host.session!.draft).toEqual(retained);expect(host.session!.draftVersion).toBe(version);
 view.rerender(<WorkspaceHostView host={host} visible/>);await u.click(screen.getByRole('button',{name:'重试原操作',exact:true}));
 await waitFor(()=>expect(host.session?.pending).toBeNull());expect(calls).toHaveLength(2);expect(calls[0]).toEqual(calls[1]);expect(rows).toHaveLength(1);
});
it('manual message dirty draft uses the same single leave guard and cancelled close keeps content',async()=>{
 manualRows();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 const view=render(<WorkspaceHostView host={host} visible entryMode="manual-conversation"/>);const u=await openManualMessages();
 await u.click(screen.getByRole('button',{name:'新建消息'}));await u.type(screen.getByLabelText('消息正文'),'Do not discard');
 expect(allowLeavingUnsavedWork()).toBe(false);expect(confirm).toHaveBeenCalledTimes(1);
 await u.keyboard('{Escape}');expect(confirm).toHaveBeenCalledTimes(2);expect(screen.getByDisplayValue('Do not discard')).toBeTruthy();
 view.rerender(<WorkspaceHostView host={host} visible={false} entryMode="manual-conversation"/>);
 expect(allowLeavingUnsavedWork()).toBe(false);expect(confirm).toHaveBeenCalledTimes(3);expect(calls).toHaveLength(0);
});
it('manual entry identity change detaches old selection and draft instead of reusing them',async()=>{
 manualRows();render(<WorkspaceHostView host={host} visible entryMode="manual-conversation"/>);const u=await openManualMessages();
 await u.click(screen.getByRole('button',{name:'新建消息'}));await u.type(screen.getByLabelText('消息正文'),'Old owner text');
 const original=host.session;vi.mocked(workspaceApi.list).mockClear();
 act(()=>{host.setAuthority('b'.repeat(64),true);});
 await screen.findByText('请先选择一个工作区，再选择会话；尚未读取任何会话消息。');
 expect(original?.available).toBe(false);expect(host.session).not.toBe(original);expect(screen.queryByDisplayValue('Old owner text')).toBeNull();
 expect((screen.getByLabelText('当前工作区') as HTMLSelectElement).value).toBe('');
 expect(vi.mocked(workspaceApi.list).mock.calls.every(([q])=>q.kind==='workspace')).toBe(true);expect(calls).toHaveLength(0);
});
it('manual entry is unavailable without host authority and does not start read or write fallbacks',()=>{
 host.setAuthority(null,true);render(<WorkspaceHostView host={host} visible entryMode="manual-conversation"/>);
 expect(screen.getByText('本地手工会话暂不可用：尚未取得固定合成身份范围。')).toBeTruthy();
 expect(workspaceApi.list).not.toHaveBeenCalled();expect(calls).toHaveLength(0);
});
it('manual re-entry refuses a moved session and never replaces it with another session',async()=>{
 manualRows();const view=render(<WorkspaceHostView host={host} visible entryMode="manual-conversation"/>);
 await openManualMessages();view.rerender(<WorkspaceHostView host={host} visible={false} entryMode="manual-conversation"/>);
 rows.find(row=>row.id==='sa').data.workspaceId='wb';vi.mocked(workspaceApi.list).mockClear();
 view.rerender(<WorkspaceHostView host={host} visible entryMode="manual-conversation"/>);
 await screen.findByText('请选择当前工作区内的有效会话；未找到、已删除或已移动的选择不会自动改用其他记录。');
 expect(vi.mocked(workspaceApi.list).mock.calls.some(([q])=>q.kind==='message')).toBe(false);
 expect(screen.queryByRole('heading',{name:'Other workspace note B',level:2})).toBeNull();
 expect(screen.getByRole('button',{name:'新建消息'}).hasAttribute('disabled')).toBe(true);expect(calls).toHaveLength(0);
});
