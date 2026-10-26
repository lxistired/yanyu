import {writeUnsavedHistory} from '../candidate/src/components/unsaved-work';
import React from 'react';
import {webcrypto} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {LocalDocuments} from '../candidate/src/components/LocalDocuments';
import {allowLeavingUnsavedWork,useUnsavedWork} from '../candidate/src/components/unsaved-work';
import {readUploadRecords} from '../candidate/src/components/document-upload-journal';
const scope='10000000-0000-4000-8000-000000000001',id='20000000-0000-4000-8000-000000000002';
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status});
function receipt(){const r=readUploadRecords(localStorage,scope)[0];const {version,scope:ignored,...fields}=r;return {scope,operationId:r.operationId,outcome:'committed',receipt:{...fields,documentId:id},document:{id,sha256:r.sha256,trashedAt:null}}}
function Other(){useUnsavedWork(true);return null}
function setup(extra?:(path:string,init?:RequestInit)=>Promise<Response>|undefined,other=false){
 const fetcher=vi.fn((input:RequestInfo|URL,init?:RequestInit)=>{const p=String(input),r=extra?.(p,init);if(r)return r;
 if(p==='/api/documents/choices')return Promise.resolve(json({uploadScope:scope,workspaces:[],folders:[]}));
 if(p.startsWith('/api/documents?'))return Promise.resolve(json({storeScope:scope,documents:[],total:0,offset:0,limit:10}));
 if(p==='/api/documents/folders')return Promise.resolve(json({folder:{id:'40000000-0000-4000-8000-000000000004',name:'saved',workspaceId:null}}));
 if(p.startsWith('/api/documents/upload'))return Promise.resolve(json(receipt()));throw Error(p)});
 vi.stubGlobal('fetch',fetcher);return {...render(<>{other&&<Other/>}<LocalDocuments/></>),fetcher};
}
async function ready(){await screen.findByText('没有匹配的文档。上传文件，或调整筛选条件。')}
function name(value:string){fireEvent.change(screen.getByLabelText('新文件夹名称'),{target:{value}})}
function file(label='synthetic.md'){const f=new File(['synthetic'],label);Object.defineProperty(f,'arrayBuffer',{value:async()=>new TextEncoder().encode('synthetic').buffer});fireEvent.change(screen.getByLabelText('选择文档'),{target:{files:[f]}});return f}
function submit(label:string){fireEvent.submit(screen.getByLabelText(label).closest('form')!)}
function unload(){const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented}
function historyEvent(type:string){act(()=>{history.replaceState(null,'','/#other');window.dispatchEvent(new Event(type))})}
beforeEach(()=>{localStorage.clear();vi.stubGlobal('crypto',webcrypto);vi.spyOn(window,'confirm').mockReturnValue(false)});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear();history.replaceState(null,'','/')});
it.each(['file','folder'])('guards %s draft and unload, exact clearing releases guard',async kind=>{setup();await ready();if(kind==='file')file();else name('   ');expect(unload()).toBe(true);fireEvent.click(screen.getByText('文档回收站'));expect(window.confirm).toHaveBeenCalledOnce();if(kind==='file')fireEvent.change(screen.getByLabelText('选择文档'),{target:{files:[]}});else name('');expect(unload()).toBe(false)});
it.each(['popstate','hashchange'])('%s Stay retains both drafts; accepted dismissal releases only own tokens',async type=>{setup();await ready();act(()=>prepareOwnedHistory(type==='hashchange'?'/#other':'/?other=1'));file();name(' raw ');await historyBack();expect(location.hash).toBe('');expect((screen.getByLabelText('新文件夹名称') as HTMLInputElement).value).toBe(' raw ');expect(unload()).toBe(true);vi.mocked(window.confirm).mockReturnValue(true);await historyBack();expect((screen.getByLabelText('新文件夹名称') as HTMLInputElement).value).toBe('');expect(unload()).toBe(false)});
it.each([400,409,500])('folder %s failure keeps raw name without abandonment prompt',async status=>{setup(p=>p.endsWith('/folders')?Promise.resolve(json({error:{message:'synthetic rejection'}},status)):undefined);await ready();name(' raw ');submit('新文件夹名称');await screen.findByText('synthetic rejection');expect((screen.getByLabelText('新文件夹名称') as HTMLInputElement).value).toBe(' raw ');expect(window.confirm).not.toHaveBeenCalled();expect(unload()).toBe(true)});
it('successful folder save does not clear selected file or unrelated editor',async()=>{setup(undefined,true);await ready();file();name('saved');submit('新文件夹名称');await screen.findByText('本地文件夹已创建');expect(window.confirm).not.toHaveBeenCalled();expect((screen.getByRole('button',{name:'上传并保存'}) as HTMLButtonElement).disabled).toBe(false);expect(allowLeavingUnsavedWork()).toBe(false)});
it('late folder completion preserves a newer raw name and target after accepted dismissal',async()=>{let resolve!:(r:Response)=>void;setup(p=>p.endsWith('/folders')?new Promise(r=>resolve=r):undefined);await ready();name('old');submit('新文件夹名称');vi.mocked(window.confirm).mockReturnValue(true);historyEvent('hashchange');name('new raw');await act(async()=>resolve(json({folder:{id:'60000000-0000-4000-8000-000000000006',name:'old',workspaceId:null}})));expect((screen.getByLabelText('新文件夹名称') as HTMLInputElement).value).toBe('new raw');expect((screen.getByLabelText('本地文件夹') as HTMLSelectElement).value).toBe('');expect(screen.queryByText('本地文件夹已创建')).toBeNull()});
it('upload failure preserves selected File and guard; confirmed own receipt clears it without prompting',async()=>{let post=true;setup(p=>p.startsWith('/api/documents/upload?')&&post?Promise.reject(Error('synthetic lost response')):undefined);await ready();file();submit('选择文档');await screen.findByText('synthetic lost response');expect(unload()).toBe(true);expect(window.confirm).not.toHaveBeenCalled();post=false;fireEvent.click(screen.getByText('核对上传结果'));await screen.findByText(/已核实文档已保存到本地/);expect(unload()).toBe(false)});
it('old receipt cannot clear a newer selected File even with the same name',async()=>{setup(p=>p.startsWith('/api/documents/upload?')?Promise.reject(Error('synthetic lost response')):undefined);await ready();file();submit('选择文档');await screen.findByText('synthetic lost response');file();fireEvent.click(screen.getByText('核对上传结果'));await screen.findByText(/已核实文档已保存到本地/);expect(unload()).toBe(true);expect((screen.getByRole('button',{name:'上传并保存'}) as HTMLButtonElement).disabled).toBe(false)});
it('successful upload clears only its selection, retaining raw folder name',async()=>{setup();await ready();name('  ');file();submit('选择文档');await screen.findByText(/已核实文档已保存到本地/);expect(window.confirm).not.toHaveBeenCalled();expect((screen.getByLabelText('新文件夹名称') as HTMLInputElement).value).toBe('  ');expect(unload()).toBe(true)});

it.each(['http','network','decode'])('late folder %s failure after Leave does not contaminate newer draft and releases lock',async failure=>{
 let resolve!:(r:Response)=>void,reject!:(e:Error)=>void,attempts=0;
 const {fetcher}=setup(p=>p.endsWith('/folders')&&++attempts===1?new Promise((r,j)=>{resolve=r;reject=j}):undefined);
 await ready();name('old');submit('新文件夹名称');
 vi.mocked(window.confirm).mockReturnValue(true);historyEvent('hashchange');name('new raw');
 await act(async()=>{if(failure==='network')reject(Error('old network failure'));else resolve(failure==='decode'?new Response('SYNTHETIC_REPLY_MARKER'):json({error:{message:'old http failure'}},409))});
 expect(screen.queryByRole('alert')).toBeNull();expect((screen.getByLabelText('新文件夹名称') as HTMLInputElement).value).toBe('new raw');expect(unload()).toBe(true);
 expect((screen.getByRole('button',{name:'创建本地文件夹'}) as HTMLButtonElement).closest('fieldset')!.disabled).toBe(false);
 submit('新文件夹名称');await screen.findByText('本地文件夹已创建');
 expect(fetcher.mock.calls.filter(([p])=>String(p).endsWith('/folders'))).toHaveLength(2);expect(unload()).toBe(false);
});
it.each(['http','network','decode'])('current folder %s failure remains visible and retains raw draft, then retry works',async failure=>{
 let resolve!:(r:Response)=>void,reject!:(e:Error)=>void,attempts=0;
 setup(p=>p.endsWith('/folders')&&++attempts===1?new Promise((r,j)=>{resolve=r;reject=j}):undefined);
 await ready();name(' current raw ');submit('新文件夹名称');
 await act(async()=>{if(failure==='network')reject(Error('current network failure'));else resolve(failure==='decode'?new Response('SYNTHETIC_REPLY_MARKER'):json({error:{message:'current http failure'}},500))});
 expect(screen.getByRole('alert').textContent).toBeTruthy();expect(document.body.textContent).not.toContain('SYNTHETIC_REPLY_MARKER');expect((screen.getByLabelText('新文件夹名称') as HTMLInputElement).value).toBe(' current raw ');expect(unload()).toBe(true);expect(window.confirm).not.toHaveBeenCalled();
 submit('新文件夹名称');await screen.findByText('本地文件夹已创建');expect(screen.queryByRole('alert')).toBeNull();expect(unload()).toBe(false);
});
it('unmount aborts pending folder request and its late failure cannot affect a fresh mount',async()=>{
 let reject!:(e:Error)=>void,signal:AbortSignal|undefined|null;
 const first=setup((p,init)=>p.endsWith('/folders')?new Promise((_r,j)=>{reject=j;signal=init?.signal}):undefined);
 await ready();name('old');submit('新文件夹名称');first.unmount();expect(signal?.aborted).toBe(true);
 setup();await ready();name('new');await act(async()=>reject(Error('old unmounted failure')));
 expect(screen.queryByRole('alert')).toBeNull();expect((screen.getByLabelText('新文件夹名称') as HTMLInputElement).value).toBe('new');submit('新文件夹名称');await screen.findByText('本地文件夹已创建');
});

const invalidFolder='文件夹响应无效，草稿已保留；请核对文件夹列表后再重试。';
const validFolder={id:'70000000-0000-4000-8000-000000000007',name:'SYNTHETIC_REPLY_MARKER',workspaceId:null};
const malformedFolders=[null,{},[],{folder:null},{folder:[]},{folder:{}},
 ...[null,23,'','not-a-uuid'].map(id=>({folder:{...validFolder,id}})),
 ...[null,{},'', ' ', 'a/b','a\\b','bad\u0000','\ud800','中'.repeat(171)].map(name=>({folder:{...validFolder,name}})),
 ...[undefined,23,{},'', 'bad space','a'.repeat(161)].map(workspaceId=>({folder:{...validFolder,workspaceId}}))];
it.each(malformedFolders.map((body,i)=>({body,i})))('current malformed folder DTO $i retains draft and shows only fixed error',async({body})=>{
 let resolve!:(r:Response)=>void,attempts=0;
 setup(p=>p.endsWith('/folders')&&++attempts===1?new Promise(r=>resolve=r):undefined);
 await ready();name(' raw draft ');submit('新文件夹名称');await act(async()=>resolve(json(body)));
 expect(screen.getByRole('alert').textContent).toBe(invalidFolder);expect(document.body.textContent).not.toContain('SYNTHETIC_REPLY_MARKER');
 expect((screen.getByLabelText('新文件夹名称') as HTMLInputElement).value).toBe(' raw draft ');expect(unload()).toBe(true);
 expect((screen.getByLabelText('本地文件夹') as HTMLSelectElement).options).toHaveLength(1);
 submit('新文件夹名称');await screen.findByText('本地文件夹已创建');expect(unload()).toBe(false);
});
it.each(malformedFolders.map((body,i)=>({body,i})))('stale malformed folder DTO $i cannot mutate choices or newer draft',async({body})=>{
 let resolve!:(r:Response)=>void;setup(p=>p.endsWith('/folders')?new Promise(r=>resolve=r):undefined);
 await ready();name('old');submit('新文件夹名称');vi.mocked(window.confirm).mockReturnValue(true);historyEvent('hashchange');name('new raw');
 await act(async()=>resolve(json(body)));expect(screen.queryByRole('alert')).toBeNull();expect(document.body.textContent).not.toContain('SYNTHETIC_REPLY_MARKER');
 expect((screen.getByLabelText('新文件夹名称') as HTMLInputElement).value).toBe('new raw');expect(unload()).toBe(true);
 expect((screen.getByLabelText('本地文件夹') as HTMLSelectElement).options).toHaveLength(1);
 expect((screen.getByRole('button',{name:'创建本地文件夹'}) as HTMLButtonElement).closest('fieldset')!.disabled).toBe(false);
});
it('stale valid folder DTO also leaves current choices unchanged',async()=>{
 let resolve!:(r:Response)=>void;setup(p=>p.endsWith('/folders')?new Promise(r=>resolve=r):undefined);await ready();name('old');submit('新文件夹名称');vi.mocked(window.confirm).mockReturnValue(true);historyEvent('hashchange');name('new');await act(async()=>resolve(json({folder:validFolder})));
 expect((screen.getByLabelText('本地文件夹') as HTMLSelectElement).options).toHaveLength(1);expect(screen.queryByText('本地文件夹已创建')).toBeNull();
});
it.each(['😀 合成资料', '中'.repeat(170), 'a'.repeat(512), ' nfc-e\u0301 '])('valid backend folder name %s remains accepted without normalization',async savedName=>{
 setup(p=>p.endsWith('/folders')?Promise.resolve(json({folder:{...validFolder,name:savedName},extra:'ignored'})):undefined);await ready();name(savedName);submit('新文件夹名称');await screen.findByText('本地文件夹已创建');expect((screen.getByLabelText('本地文件夹') as HTMLSelectElement).value).toBe(validFolder.id);expect(screen.queryByRole('alert')).toBeNull();
});

it.each(['workspace.valid_1:a-b','w'.repeat(160)])('accepts backend workspace identifier %s',async workspaceId=>{
 setup(p=>p==='/api/documents/choices'?Promise.resolve(json({uploadScope:scope,workspaces:[{id:workspaceId,name:'Synthetic workspace'}],folders:[]})):p.endsWith('/folders')?Promise.resolve(json({folder:{...validFolder,workspaceId}})):undefined);await ready();fireEvent.change(screen.getByLabelText('工作区'),{target:{value:workspaceId}});name('saved');submit('新文件夹名称');await screen.findByText('本地文件夹已创建');expect((screen.getByLabelText('本地文件夹') as HTMLSelectElement).value).toBe(validFolder.id);
});

function prepareOwnedHistory(target:string){const current=location.href;writeUnsavedHistory(target);writeUnsavedHistory(current)}
async function historyBack(){await act(async()=>{history.back();await new Promise(r=>setTimeout(r,65))})}
