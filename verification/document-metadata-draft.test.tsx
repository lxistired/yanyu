import {writeUnsavedHistory} from '../candidate/src/components/unsaved-work';
import React from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {LocalDocuments} from '../candidate/src/components/LocalDocuments';
import {allowLeavingUnsavedWork,useUnsavedWork} from '../candidate/src/components/unsaved-work';
import {retainUploadRecord,type UploadRecord} from '../candidate/src/components/document-upload-journal';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
vi.mock('../candidate/src/components/ServiceReportsEntry',()=>({ServiceReportsEntry:()=>null}));
const scope='10000000-0000-4000-8000-000000000001',id='20000000-0000-4000-8000-000000000002';
const record={id,revision:4,trashedAt:null,name:'synthetic.md',format:'md',bytes:1,sha256:'a'.repeat(64),textSha256:'b'.repeat(64),createdAt:'2026-10-21',pages:null,workspaceId:'w1',folderId:'f1',workspaceName:'One',folderName:'First',stale:false};
const choices={uploadScope:scope,workspaces:[{id:'w1',name:'One'},{id:'w2',name:'Two'}],folders:[{id:'f1',name:'First',workspaceId:'w1'},{id:'f2',name:'Second',workspaceId:'w1'}]};
const pending:UploadRecord={version:1,scope,operationId:'30000000-0000-4000-8000-000000000003',name:'pending.md',format:'md',bytes:1,sha256:'a'.repeat(64),workspaceId:null,folderId:null,createdAt:'2026-10-21'};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const list=(documents=[record])=>json({storeScope:scope,documents,total:documents.length,offset:0,limit:10});
function Other(){useUnsavedWork(true);return null}
function setup(extra?:(path:string,init?:RequestInit)=>Promise<Response>|undefined,options:{other?:boolean;shell?:boolean}={}){
 const fetcher=vi.fn((input:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(input),result=extra?.(path,init);if(result)return result;
  if(path==='/api/documents/choices')return Promise.resolve(json(choices));
  if(path.startsWith('/api/documents?'))return Promise.resolve(list());
  if(path.endsWith('/metadata'))return Promise.resolve(json({document:record}));
  if(path.includes('/upload-operations/')){const {version,scope:_,...rest}=pending;return Promise.resolve(json({scope,operationId:pending.operationId,outcome:'committed',receipt:{...rest,documentId:id},document:record}));}
  throw Error('Unexpected test request '+path);
 });
 vi.stubGlobal('fetch',fetcher);if(options.shell)history.replaceState(null,'','/?page=documents');
 const life=new OrdinaryRequestLifetime();const view=render(<>{options.other&&<Other/>}{options.shell?<OrdinaryNavigationShell lifetime={life}/>:<LocalDocuments/>}</>);return {...view,fetcher,life};
}
async function open(){fireEvent.click(await screen.findByRole('button',{name:'编辑名称与归属',exact:true}));}
function change(label:string,value:string){fireEvent.change(screen.getByLabelText(label),{target:{value}})}
function value(label:string){return (screen.getByLabelText(label) as HTMLInputElement).value}
function clean(){vi.mocked(window.confirm).mockClear();expect(allowLeavingUnsavedWork()).toBe(true);expect(window.confirm).not.toHaveBeenCalled()}
function save(){fireEvent.submit(screen.getByRole('form',{name:'编辑文档资料'}))}
beforeEach(()=>{localStorage.clear();vi.spyOn(window,'confirm').mockReturnValue(false)});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear();history.replaceState(null,'','/')});
it.each(['','   ','bad/name\u0001',' synthetic.md '])('preserves raw name %j on Stay and clears only on exact reversion',async name=>{
 setup();await open();clean();change('显示名称',name);fireEvent.click(screen.getByText('取消编辑'));expect(value('显示名称')).toBe(name);expect(window.confirm).toHaveBeenCalledOnce();change('显示名称',record.name);clean();fireEvent.click(screen.getByText('取消编辑'));expect(screen.queryByLabelText('显示名称')).toBeNull();
});
it('tracks workspace and folder independently, including cleared folder',async()=>{
 setup();await open();change('目标文件夹','f2');expect(allowLeavingUnsavedWork()).toBe(false);change('目标文件夹','f1');clean();change('目标工作区','w2');expect(value('目标文件夹')).toBe('');change('目标工作区','w1');expect(allowLeavingUnsavedWork()).toBe(false);change('目标文件夹','f1');clean();
});
it('guards cancel and replacement, then captures a new opening baseline',async()=>{
 setup();await open();change('显示名称','  ');fireEvent.click(screen.getByText('编辑名称与归属'));expect(value('显示名称')).toBe('  ');vi.mocked(window.confirm).mockReturnValue(true);fireEvent.click(screen.getByText('取消编辑'));clean();await open();expect(value('显示名称')).toBe(record.name);clean();
});
it.each(['工作区','本地文件夹','搜索','清除搜索','文档回收站','预览纯文本','移入文档回收站'])('guards local navigation %s on Stay',async target=>{
 setup();await open();change('显示名称','   ');if(target==='工作区')change(target,'w2');else if(target==='本地文件夹')change(target,'');else fireEvent.click(screen.getByRole('button',{name:target,exact:true}));expect(value('显示名称')).toBe('   ');expect(window.confirm).toHaveBeenCalledOnce();
});
it('route Stay preserves inputs and Leave unmounts owned token',async()=>{
 setup(undefined,{shell:true});await open();change('显示名称','');fireEvent.click(screen.getByRole('button',{name:'首页',exact:true}));expect(value('显示名称')).toBe('');expect(location.search).toBe('?page=documents');vi.mocked(window.confirm).mockReturnValue(true);fireEvent.click(screen.getByRole('button',{name:'首页',exact:true}));expect(screen.queryByLabelText('显示名称')).toBeNull();clean();
});
it.each(['popstate','hashchange'])('standalone %s Stay retains raw draft and Leave dismisses',async event=>{
 setup();await open();act(()=>prepareOwnedHistory(event==='hashchange'?'/#other':'/?other=1'));change('显示名称','  ');await historyBack();expect(location.hash).toBe('');expect(value('显示名称')).toBe('  ');vi.mocked(window.confirm).mockReturnValue(true);await historyBack();expect(screen.queryByLabelText('显示名称')).toBeNull();clean();
});
it.each([400,409,500])('save failure %s retains raw values, opening revision and token without abandonment prompt',async status=>{
 const {fetcher}=setup(path=>path.endsWith('/metadata')?Promise.resolve(json({error:{message:'Synthetic rejected'}},status)):undefined);await open();change('显示名称','  ');change('目标工作区','w2');save();await screen.findByText('Synthetic rejected');expect(value('显示名称')).toBe('  ');expect(value('目标工作区')).toBe('w2');expect(window.confirm).not.toHaveBeenCalled();expect(JSON.parse(fetcher.mock.calls.find(([p])=>String(p).endsWith('/metadata'))![1]!.body as string)).toEqual({revision:4,name:'  ',workspaceId:'w2',folderId:null});expect(allowLeavingUnsavedWork()).toBe(false);
});
it('successful own save clears only its token without prompting',async()=>{
 setup();await open();change('显示名称','saved');save();await screen.findByText(/文档资料已更新/);expect(screen.queryByLabelText('显示名称')).toBeNull();clean();
});
it('successful own save preserves another editor token',async()=>{
 vi.mocked(window.confirm).mockReturnValue(true);setup(undefined,{other:true});await open();vi.mocked(window.confirm).mockClear();change('显示名称','saved');save();await screen.findByText(/文档资料已更新/);expect(window.confirm).not.toHaveBeenCalled();vi.mocked(window.confirm).mockReturnValue(false);expect(allowLeavingUnsavedWork()).toBe(false);
});
it.each(['failure','missing','changed'])('unrelated upload reconciliation refresh %s preserves draft and original revision',async kind=>{
 retainUploadRecord(localStorage,pending);let lists=0;const {fetcher}=setup(path=>path.startsWith('/api/documents?')&&++lists>1?Promise.resolve(kind==='failure'?json({},500):list(kind==='missing'?[]:[{...record,revision:5,name:'latest server name'}])):undefined);
 await open();change('显示名称','  ');change('目标文件夹','f2');fireEvent.click(screen.getByText('核对上传结果'));await waitFor(()=>expect(lists).toBe(2));await screen.findByText(/当前列表尚未核实此编辑版本/);expect(value('显示名称')).toBe('  ');expect(value('目标文件夹')).toBe('f2');expect(window.confirm).not.toHaveBeenCalled();expect(allowLeavingUnsavedWork()).toBe(false);vi.mocked(window.confirm).mockClear();save();await screen.findByText(/文档资料已更新/);expect(JSON.parse(fetcher.mock.calls.find(([p])=>String(p).endsWith('/metadata'))![1]!.body as string).revision).toBe(4);
});
it.each([200,409])('late save %s after accepted history dismissal cannot change the next editor',async status=>{
 let resolve!:(r:Response)=>void;const {fetcher}=setup(path=>path.endsWith('/metadata')?new Promise(r=>resolve=r):undefined);await open();change('显示名称','old draft');save();vi.mocked(window.confirm).mockReturnValue(true);act(()=>{history.replaceState(null,'','/#leave');window.dispatchEvent(new Event('hashchange'))});expect(screen.queryByLabelText('显示名称')).toBeNull();await act(async()=>resolve(json({error:{message:'Old conflict'}},status)));await open();expect(value('显示名称')).toBe(record.name);expect(screen.queryByText('Old conflict')).toBeNull();expect(screen.queryByText(/文档资料已更新/)).toBeNull();clean();expect(fetcher.mock.calls.filter(([p])=>String(p).endsWith('/metadata'))).toHaveLength(1);
});
it('unmount aborts save and prevents late completion from changing a new mount',async()=>{
 let resolve!:(r:Response)=>void;let signal:AbortSignal|null|undefined;const first=setup((path,init)=>path.endsWith('/metadata')?new Promise(r=>{resolve=r;signal=init?.signal}):undefined);await open();change('显示名称','old');save();first.unmount();expect(signal?.aborted).toBe(true);setup();await open();change('显示名称','new draft');await act(async()=>resolve(json({})));expect(value('显示名称')).toBe('new draft');expect(screen.queryByText(/文档资料已更新/)).toBeNull();expect(allowLeavingUnsavedWork()).toBe(false);
});
it('retains unavailable opening associations visibly and does not normalize them on Stay',async()=>{
 setup(path=>path.startsWith('/api/documents?')?Promise.resolve(list([{...record,workspaceId:'gone-workspace',folderId:'gone-folder',stale:true}])):undefined);await open();expect(value('目标工作区')).toBe('gone-workspace');expect(value('目标文件夹')).toBe('gone-folder');clean();change('显示名称','');fireEvent.click(screen.getByText('取消编辑'));expect(value('显示名称')).toBe('');expect(value('目标工作区')).toBe('gone-workspace');expect(value('目标文件夹')).toBe('gone-folder');
});
it('beforeunload is registered for dirty raw edits and removed after exact reversion',async()=>{
 setup();await open();change('显示名称',' ');const dirty=new Event('beforeunload',{cancelable:true});window.dispatchEvent(dirty);expect(dirty.defaultPrevented).toBe(true);change('显示名称',record.name);const cleanEvent=new Event('beforeunload',{cancelable:true});window.dispatchEvent(cleanEvent);expect(cleanEvent.defaultPrevented).toBe(false);
});

it('folder creation saves only its own draft and preserves open metadata',async()=>{
 setup(path=>path==='/api/documents/folders'?Promise.resolve(json({folder:{id:'50000000-0000-4000-8000-000000000005',name:'new',workspaceId:null}})):undefined);await open();change('显示名称','unsaved metadata');change('新文件夹名称','new');fireEvent.click(screen.getByText('创建本地文件夹'));await screen.findByText('本地文件夹已创建');expect(value('显示名称')).toBe('unsaved metadata');expect(window.confirm).not.toHaveBeenCalled();expect(allowLeavingUnsavedWork()).toBe(false);
});

function prepareOwnedHistory(target:string){const current=location.href;writeUnsavedHistory(target);writeUnsavedHistory(current)}
async function historyBack(){await act(async()=>{history.back();await new Promise(r=>setTimeout(r,65))})}
