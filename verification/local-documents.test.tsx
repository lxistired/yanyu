import {imageResponse} from './pdf-image-fixture';
import React from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createHash,webcrypto} from 'node:crypto';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {LocalDocuments} from '../candidate/src/components/LocalDocuments';
import {readUploadRecords} from '../candidate/src/components/document-upload-journal';
const id='11111111-1111-4111-8111-111111111111';
const record={id,name:'source.md',format:'md',bytes:8,sha256:createHash('sha256').update('original').digest('hex'),textSha256:'b'.repeat(64),createdAt:'2026-10-15',pages:null,workspaceId:null,folderId:null,workspaceName:null,folderName:null,stale:false};
const uploadScope='70000000-0000-4000-8000-000000000007';
const choices={uploadScope,workspaces:[{id:'w1',name:'Workspace One'},{id:'w2',name:'Workspace Two'}],folders:[{id:'f1',name:'First folder',workspaceId:'w1'}]};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function setup(extra?:(path:string,init?:RequestInit)=>Promise<Response>|undefined){const fetcher=vi.fn((input:RequestInfo|URL,init?:RequestInit)=>{const path=String(input),override=extra?.(path,init);if(override)return override;if(path.startsWith('/api/documents/upload?')){const item=readUploadRecords(localStorage,uploadScope).find(value=>value.operationId===new Headers(init?.headers).get('X-Upload-Operation-Id'))!;const receipt={operationId:item.operationId,documentId:id,name:item.name,format:item.format,bytes:item.bytes,sha256:item.sha256,workspaceId:item.workspaceId,folderId:item.folderId,createdAt:'2026-10-17T12:00:00.000Z'};return Promise.resolve(json({receipt,document:{...record,id,sha256:item.sha256,bytes:item.bytes,workspaceId:item.workspaceId,folderId:item.folderId}},201))}return Promise.resolve(path==='/api/documents/choices'?json(choices):json({storeScope:uploadScope,documents:[record],total:1,offset:0,limit:10}));});vi.stubGlobal('fetch',fetcher);const view=render(<LocalDocuments/>);return {...view,fetcher};}
const originalArrayBuffer=Object.getOwnPropertyDescriptor(File.prototype,'arrayBuffer');
beforeEach(()=>{
 sessionStorage.clear();localStorage.clear();vi.stubGlobal('crypto',webcrypto);
 Object.defineProperty(File.prototype,'arrayBuffer',{configurable:true,value:function(this:File){return new Promise<ArrayBuffer>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(reader.error);reader.onload=()=>resolve(reader.result as ArrayBuffer);reader.readAsArrayBuffer(this)})}});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();sessionStorage.clear();localStorage.clear();if(originalArrayBuffer)Object.defineProperty(File.prototype,'arrayBuffer',originalArrayBuffer);else delete (File.prototype as {arrayBuffer?:unknown}).arrayBuffer;});
it('fetches metadata only until explicit preview and renders hostile Markdown as literal text',async()=>{
 const text='<img src="https://example.invalid/track" onerror="alert(1)">\n[link](javascript:alert(1))';
 const {fetcher,container}=setup(path=>path===`/api/documents/${id}`?Promise.resolve(json({storeScope:uploadScope,document:record,text})):undefined);
 await screen.findByRole('heading',{name:'source.md'});expect(fetcher.mock.calls.some(([p])=>String(p)===`/api/documents/${id}`)).toBe(false);
 fireEvent.click(screen.getByText('预览纯文本'));await screen.findByRole('region',{name:'文档纯文本预览'});
 expect(container.querySelector('pre')?.textContent).toBe(text);expect(container.querySelector('img,iframe,object,embed')).toBeNull();
 fireEvent.click(screen.getByText('关闭预览'));expect(container.querySelector('pre')).toBeNull();
});
it('clears folder when workspace changes and uploads exactly one raw file with the selected scope',async()=>{
 const {fetcher}=setup();
 await waitFor(()=>expect((screen.getByLabelText('工作区') as HTMLSelectElement).disabled).toBe(false));
 fireEvent.change(screen.getByLabelText('工作区'),{target:{value:'w1'}});fireEvent.change(screen.getByLabelText('本地文件夹'),{target:{value:'f1'}});
 fireEvent.change(screen.getByLabelText('工作区'),{target:{value:'w2'}});expect((screen.getByLabelText('本地文件夹') as HTMLSelectElement).value).toBe('');
 const file=new File(['hello'],'source.md',{type:'text/markdown'});fireEvent.change(screen.getByLabelText('选择文档'),{target:{files:[file]}});fireEvent.click(screen.getByText('上传并保存'));
 await screen.findByText(/文档已保存到本地/);const call=fetcher.mock.calls.find(([p])=>String(p).startsWith('/api/documents/upload'))!;
 expect(call[0]).toBe('/api/documents/upload?name=source.md&workspaceId=w2');expect(call[1]).toMatchObject({method:'POST',body:file,headers:{'Content-Type':'application/octet-stream','X-Upload-Store-Id':uploadScope}});expect(new Headers(call[1]?.headers).get('X-Upload-Operation-Id')).toMatch(/^[a-f0-9-]{36}$/);
});
it('rejects oversized and unsupported files before upload',async()=>{
 const {fetcher}=setup();await screen.findByRole('heading',{name:'source.md'});
 const file=new File(['x'],'script.html');fireEvent.change(screen.getByLabelText('选择文档'),{target:{files:[file]}});fireEvent.click(screen.getByText('上传并保存'));expect(screen.getByRole('alert').textContent).toContain('仅支持');
 const large=new File(['x'],'large.txt');Object.defineProperty(large,'size',{value:8*1024*1024+1});fireEvent.change(screen.getByLabelText('选择文档'),{target:{files:[large]}});fireEvent.click(screen.getByText('上传并保存'));expect(screen.getByRole('alert').textContent).toContain('8 MiB');expect(fetcher.mock.calls.filter(([p])=>String(p).includes('/upload'))).toHaveLength(0);
});
it('creates a local folder with explicit null workspace and selects it',async()=>{
 const {fetcher}=setup(path=>path==='/api/documents/folders'?Promise.resolve(json({folder:{id:'80000000-0000-4000-8000-000000000008',name:'Local folder',workspaceId:null}})):undefined);
 await screen.findByRole('heading',{name:'source.md'});fireEvent.change(screen.getByLabelText('新文件夹名称'),{target:{value:'Local folder'}});fireEvent.click(screen.getByText('创建本地文件夹'));await screen.findByText('本地文件夹已创建');
 expect((screen.getByLabelText('本地文件夹') as HTMLSelectElement).value).toBe('80000000-0000-4000-8000-000000000008');expect(JSON.parse(fetcher.mock.calls.find(([p])=>p==='/api/documents/folders')![1]!.body as string)).toEqual({name:'Local folder',workspaceId:null});
});
it('encodes literal search, paginates, and clears it',async()=>{
 const {fetcher}=setup(path=>path.startsWith('/api/documents?')?Promise.resolve(json({storeScope:uploadScope,documents:[record],total:21,offset:0,limit:10})):undefined);
 await screen.findByRole('heading',{name:'source.md'});fireEvent.change(screen.getByLabelText('搜索文档'),{target:{value:'100% & _'}});fireEvent.click(screen.getByText('搜索'));await waitFor(()=>expect(fetcher.mock.calls.some(([p])=>String(p).includes('q=100%25+%26+_'))).toBe(true));
 await screen.findByRole('heading',{name:'source.md'});fireEvent.click(screen.getByText('下一页'));await waitFor(()=>expect(fetcher.mock.calls.some(([p])=>String(p).includes('offset=10'))).toBe(true));
 fireEvent.click(screen.getByText('清除搜索'));await waitFor(()=>expect(String(fetcher.mock.calls.at(-1)![0])).toBe('/api/documents?q=&offset=0&limit=10&view=active'));
});
it('ignores a late list response after filters change, and aborts requests on unmount',async()=>{
 let resolve!:(r:Response)=>void;let oldSignal:AbortSignal|null|undefined;
 const {unmount}=setup((path,init)=>{if(path==='/api/documents?q=&offset=0&limit=10&view=active'){oldSignal=init?.signal;return new Promise(r=>resolve=r);}if(path.includes('workspaceId=w1'))return Promise.resolve(json({storeScope:uploadScope,documents:[{...record,name:'current.txt'}],total:1,offset:0,limit:10}));});
 await waitFor(()=>expect((screen.getByLabelText('工作区') as HTMLSelectElement).disabled).toBe(false));fireEvent.change(screen.getByLabelText('工作区'),{target:{value:'w1'}});
 await screen.findByRole('heading',{name:'current.txt'});expect(oldSignal?.aborted).toBe(true);
 await act(async()=>resolve(json({storeScope:uploadScope,documents:[record],total:1,offset:0,limit:10})));expect(screen.queryByRole('heading',{name:'source.md'})).toBeNull();unmount();
});
it('reports download errors and prevents duplicate preview requests',async()=>{
 let resolve!:(r:Response)=>void;
 const {fetcher}=setup(path=>path.endsWith('/download')?Promise.resolve(json({error:{message:'Original unavailable'}},404)):path===`/api/documents/${id}`?new Promise(r=>resolve=r):undefined);
 await screen.findByRole('heading',{name:'source.md'});fireEvent.click(screen.getByText('下载原始文件'));await screen.findByText('原件下载未获得有效响应，请刷新核对后重试');
 fireEvent.click(screen.getByText('预览纯文本'));fireEvent.click(screen.getByText('预览纯文本'));expect(fetcher.mock.calls.filter(([p])=>p===`/api/documents/${id}`)).toHaveLength(1);
 await act(async()=>resolve(json({storeScope:uploadScope,document:record,text:'hello'})));await screen.findByRole('region',{name:'文档纯文本预览'});
});
it('downloads via a safe UUID filename and revokes its object URL',async()=>{
 const create=vi.fn(()=> 'blob:local-doc'),revoke=vi.fn();Object.defineProperty(URL,'createObjectURL',{configurable:true,value:create});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:revoke});
 let filename='';vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(function(this:HTMLAnchorElement){filename=this.download;});
 setup(path=>path.endsWith('/download')?Promise.resolve(new Response('original',{headers:{'Content-Type':'application/octet-stream','Content-Length':'8','X-Document-Sha256':record.sha256,'X-Document-Store-Id':uploadScope}})):undefined);await screen.findByRole('heading',{name:'source.md'});fireEvent.click(screen.getByText('下载原始文件'));await screen.findByText(/已请求下载原始文件/);expect(filename).toBe(`document-${id}.md`);await waitFor(()=>expect(revoke).toHaveBeenCalledWith('blob:local-doc'),{timeout:1500});
});
it('aborts an explicit preview when the document page unmounts and discards its late result',async()=>{
 let resolve!:(r:Response)=>void;let signal:AbortSignal|null|undefined;
 const {unmount}=setup((path,init)=>path===`/api/documents/${id}`?new Promise(r=>{resolve=r;signal=init?.signal;}):undefined);
 await screen.findByRole('heading',{name:'source.md'});fireEvent.click(screen.getByText('预览纯文本'));unmount();expect(signal?.aborted).toBe(true);
 await act(async()=>resolve(json({storeScope:uploadScope,document:record,text:'late preview'})));expect(screen.queryByText('late preview')).toBeNull();
});
it('shows server validation failures without claiming upload success',async()=>{
 setup(path=>path.startsWith('/api/documents/upload?')?Promise.resolve(json({error:{message:'PDF exceeds 40 pages'}},400)):undefined);
 await screen.findByRole('heading',{name:'source.md'});fireEvent.change(screen.getByLabelText('选择文档'),{target:{files:[new File(['pdf'],'source.pdf')]}});fireEvent.click(screen.getByText('上传并保存'));await screen.findByText('PDF exceeds 40 pages');expect(screen.queryByText(/文档已保存到本地/)).toBeNull();
});
it('opens PDF pages only on request and keeps text preview a separate literal-text action',async()=>{
 const pdf={...record,name:'synthetic.pdf',format:'pdf',pages:2};
 const {fetcher,container}=setup(path=>path.startsWith('/api/documents?')?Promise.resolve(json({storeScope:uploadScope,documents:[pdf],total:1,offset:0,limit:10})):path.endsWith('/reader')?Promise.resolve(json({storeScope:uploadScope,page:1,bookmark:null,scale:100,pages:2,sha256:pdf.sha256})):path===`/api/documents/${id}/page?page=1&scale=100&storeScope=${uploadScope}`?Promise.resolve(imageResponse(path,pdf.sha256,pdf.pages,uploadScope)):path===`/api/documents/${id}`?Promise.resolve(json({storeScope:uploadScope,document:pdf,text:'<script>synthetic only</script>'})):undefined);
 await screen.findByRole('heading',{name:'synthetic.pdf'});expect(fetcher.mock.calls.some(([path])=>String(path).endsWith('/reader'))).toBe(false);
 fireEvent.click(screen.getByText('阅读 PDF 页面'));const image=await screen.findByRole('img');expect(image.getAttribute('src')).toMatch(/^data:image\/png;base64,/);expect(image.getAttribute('data-source-url')).toBe(`/api/documents/${id}/page?page=1&scale=100&storeScope=${uploadScope}`);const pageCall=fetcher.mock.calls.find(([p])=>p===image.getAttribute('data-source-url'))!;expect(new Headers(pageCall[1]?.headers).get('X-Document-Store-Id')).toBe(uploadScope);expect(screen.queryByRole('region',{name:'文档纯文本预览'})).toBeNull();
 fireEvent.click(screen.getByText('预览纯文本'));await screen.findByRole('region',{name:'文档纯文本预览'});expect(screen.queryByRole('region',{name:'PDF 页面阅读器'})).toBeNull();expect(container.querySelector('pre')?.textContent).toBe('<script>synthetic only</script>');expect(container.querySelector('script,iframe,object,embed')).toBeNull();
 fireEvent.click(screen.getByText('阅读 PDF 页面'));await screen.findByRole('img');expect(container.querySelector('pre')).toBeNull();
 fireEvent.click(screen.getByText('关闭 PDF 阅读器'));expect(screen.queryByRole('img')).toBeNull();
});
it('closes the PDF reader and aborts metadata loading when a list filter changes',async()=>{
 let signal:AbortSignal|null|undefined;
 const {container}=setup((path,init)=>path.startsWith('/api/documents?')?Promise.resolve(json({storeScope:uploadScope,documents:[{...record,format:'pdf',pages:2}],total:1,offset:0,limit:10})):path.endsWith('/reader')?new Promise(()=>{signal=init?.signal;}):undefined);
 await screen.findByRole('heading',{name:'source.md'});fireEvent.click(screen.getByText('阅读 PDF 页面'));await screen.findByText('正在载入 PDF 阅读状态…');
 fireEvent.change(screen.getByLabelText('工作区'),{target:{value:'w1'}});expect(signal?.aborted).toBe(true);expect(container.querySelector('.pdf-page-reader')).toBeNull();
});
it('edits metadata with exact revision and clears incompatible folder on workspace change',async()=>{
 const {fetcher}=setup(path=>path.startsWith('/api/documents?')?Promise.resolve(json({storeScope:uploadScope,documents:[{...record,revision:4,workspaceId:'w1',folderId:'f1'}],total:1,offset:0,limit:10})):undefined);
 await screen.findByText('编辑名称与归属');fireEvent.click(screen.getByText('编辑名称与归属'));fireEvent.change(screen.getByLabelText('目标工作区'),{target:{value:'w2'}});expect((screen.getByLabelText('目标文件夹') as HTMLSelectElement).value).toBe('');fireEvent.change(screen.getByLabelText('显示名称'),{target:{value:'合成 🌿 <b>literal</b>'}});fireEvent.click(screen.getByText('保存资料'));await screen.findByText(/文档资料已更新/);expect(JSON.parse(fetcher.mock.calls.find(([p])=>String(p).endsWith('/metadata'))![1]!.body as string)).toEqual({revision:4,name:'合成 🌿 <b>literal</b>',workspaceId:'w2',folderId:null});
});
it('cancels trash confirmation without a mutation and hides content actions in trash',async()=>{
 const {fetcher}=setup(path=>path.includes('view=trash')?Promise.resolve(json({storeScope:uploadScope,documents:[{...record,revision:1,trashedAt:'2026-10-15'}],total:1,offset:0,limit:10})):undefined);
 await screen.findByText('移入文档回收站');fireEvent.click(screen.getByText('移入文档回收站'));expect(screen.getByText('确认移入文档回收站')).toBeTruthy();fireEvent.click(screen.getByText('取消移入'));expect(fetcher.mock.calls.some(([p])=>String(p).endsWith('/trash'))).toBe(false);fireEvent.click(screen.getByText('文档回收站'));await screen.findByText('恢复文档');expect(screen.queryByText('下载原始文件')).toBeNull();expect(screen.queryByText('预览纯文本')).toBeNull();expect(screen.queryByText('编辑名称与归属')).toBeNull();
});
it('keeps edit form on conflict and prevents duplicate writes',async()=>{
 let resolve!:(r:Response)=>void;const {fetcher}=setup(path=>path.endsWith('/metadata')?new Promise(r=>resolve=r):undefined);await screen.findByText('编辑名称与归属');fireEvent.click(screen.getByText('编辑名称与归属'));fireEvent.click(screen.getByText('保存资料'));fireEvent.click(screen.getByText('保存资料'));expect(fetcher.mock.calls.filter(([p])=>String(p).endsWith('/metadata'))).toHaveLength(1);await act(async()=>resolve(json({error:{message:'Document changed; refresh before retrying'}},409)));expect(screen.getByRole('alert').textContent).toContain('Document changed');expect(screen.getByLabelText('显示名称')).toBeTruthy();expect(screen.queryByText(/文档资料已更新/)).toBeNull();
});
it.each(['trash','metadata'])('opening a citation preview clears the prior %s panel',async operation=>{
 setup(path=>path===`/api/documents/${id}`?Promise.resolve(json({storeScope:uploadScope,document:{...record,revision:0,textSha256:createHash('sha256').update('Synthetic citation source').digest('hex')},text:'Synthetic citation source'})):path.endsWith('/citations')?Promise.resolve(json({storeScope:uploadScope,citations:[]})):undefined);
 await screen.findByText('预览纯文本');
 fireEvent.click(screen.getByText(operation==='trash'?'移入文档回收站':'编辑名称与归属'));
 expect(screen.getByText(operation==='trash'?'确认移入文档回收站':'保存资料')).toBeTruthy();
 fireEvent.click(screen.getByText('预览纯文本'));await screen.findByRole('region',{name:'文档纯文本预览'});
 expect(screen.queryByText(operation==='trash'?'确认移入文档回收站':'保存资料')).toBeNull();
});
it('declining close or trash keeps the citation selection and separate human note',async()=>{
 const {fetcher}=setup(path=>path===`/api/documents/${id}`?Promise.resolve(json({storeScope:uploadScope,document:{...record,revision:0,textSha256:createHash('sha256').update('Synthetic citation source').digest('hex')},text:'Synthetic citation source'})):path.endsWith('/citations')?Promise.resolve(json({storeScope:uploadScope,citations:[]})):undefined);
 await screen.findByText('预览纯文本');fireEvent.click(screen.getByText('预览纯文本'));await screen.findByText('尚无已保存引用');
 const pre=screen.getByLabelText('可选择的原始提取文字'),r=document.createRange();r.setStart(pre.firstChild!,0);r.setEnd(pre.firstChild!,9);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(r);fireEvent.mouseUp(pre);
 fireEvent.change(screen.getByLabelText('人工备注（可选）'),{target:{value:'keep note'}});await screen.findByText('最小恢复记录已保存到本标签页');
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 fireEvent.click(screen.getByText('关闭预览'));fireEvent.click(screen.getByText('移入文档回收站'));
 expect(confirm).toHaveBeenCalledTimes(2);expect(screen.getByLabelText('人工备注（可选）')).toHaveProperty('value','keep note');
 expect(screen.queryByText('确认移入文档回收站')).toBeNull();expect(fetcher.mock.calls.some(([p,init])=>String(p).endsWith('/trash')&&init?.method==='PUT')).toBe(false);
 fireEvent.click(screen.getByText('取消所选引用'));fireEvent.click(screen.getByText('关闭预览'));
 expect(screen.queryByRole('region',{name:'文档纯文本预览'})).toBeNull();window.getSelection()!.removeAllRanges();
});
it('prevents creating a new citation draft while a parent folder operation is pending',async()=>{
 let resolve!:(r:Response)=>void;
 setup(path=>path===`/api/documents/${id}`?Promise.resolve(json({storeScope:uploadScope,document:{...record,revision:0,textSha256:createHash('sha256').update('Synthetic citation source').digest('hex')},text:'Synthetic citation source'})):path.endsWith('/citations')?Promise.resolve(json({storeScope:uploadScope,citations:[]})):path==='/api/documents/folders'?new Promise(r=>resolve=r):undefined);
 await screen.findByText('预览纯文本');fireEvent.click(screen.getByText('预览纯文本'));await screen.findByText('尚无已保存引用');
 fireEvent.change(screen.getByLabelText('新文件夹名称'),{target:{value:'new synthetic folder'}});fireEvent.click(screen.getByText('创建本地文件夹'));
 const pre=screen.getByLabelText('可选择的原始提取文字'),r=document.createRange();r.setStart(pre.firstChild!,0);r.setEnd(pre.firstChild!,9);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(r);fireEvent.mouseUp(pre);
 expect(screen.queryByText('保存所选文字引用')).toBeNull();
 await act(async()=>resolve(json({folder:{id:'50000000-0000-4000-8000-000000000005',name:'new synthetic folder',workspaceId:null}})));
 expect(screen.getByRole('region',{name:'文档纯文本预览'})).toBeTruthy();window.getSelection()!.removeAllRanges();
});

it.each(['hash','pages'] as const)('binds PDF reader metadata to the selected list row and rejects different %s before annotations or writes',async changed=>{
 const pdf={...record,name:'selected.pdf',format:'pdf',pages:2};
 const response={page:1,bookmark:null,scale:100,pages:2,sha256:pdf.sha256,...(changed==='hash'?{sha256:'c'.repeat(64)}:{pages:3})};
 const {fetcher,container}=setup(path=>path.startsWith('/api/documents?')?Promise.resolve(json({storeScope:uploadScope,documents:[pdf],total:1,offset:0,limit:10})):path.endsWith('/reader')?Promise.resolve(json({storeScope:uploadScope,...response})):undefined);
 await screen.findByRole('heading',{name:'selected.pdf'});fireEvent.click(screen.getByText('阅读 PDF 页面'));
 await screen.findByText('阅读状态与所选 PDF 原件不一致，请重新打开');
 expect(container.querySelector('img,iframe,object,embed')).toBeNull();expect(screen.queryByRole('region',{name:'PDF 批注'})).toBeNull();
 expect(fetcher.mock.calls.filter(([path])=>String(path).endsWith('/reader'))).toHaveLength(1);
 expect(fetcher.mock.calls.some(([path])=>String(path).includes('/annotations')||String(path).includes('/page?'))).toBe(false);
 expect(fetcher.mock.calls.some(([,init])=>['PUT','POST'].includes(init?.method??''))).toBe(false);
 expect(screen.queryByText('阅读位置与书签已保存')).toBeNull();
});

it('captures the listing scope for PDF selection and ignores an interrupted old-store response after genuine reopen',async()=>{
 const oldScope=uploadScope,newScope='80000000-0000-4000-8000-000000000008';
 const pdf={...record,name:'scoped.pdf',format:'pdf',pages:2};let release!:(value:Response)=>void;
 const oldReader=new Promise<Response>(resolve=>release=resolve);
 const first=setup((path)=>path.startsWith('/api/documents?')?Promise.resolve(json({storeScope:oldScope,documents:[pdf],total:1,offset:0,limit:10})):path.endsWith('/reader')?oldReader:undefined);
 await screen.findByRole('heading',{name:'scoped.pdf'});fireEvent.click(screen.getByText('阅读 PDF 页面'));
 const oldCall=first.fetcher.mock.calls.find(([path])=>String(path).endsWith('/reader'))!;expect(new Headers(oldCall[1]?.headers).get('X-Document-Store-Id')).toBe(oldScope);
 first.unmount();
 const second=setup(path=>path==='/api/documents/choices'?Promise.resolve(json({...choices,uploadScope:newScope})):path.startsWith('/api/documents?')?Promise.resolve(json({storeScope:newScope,documents:[pdf],total:1,offset:0,limit:10})):path.endsWith('/reader')?Promise.resolve(json({storeScope:newScope,page:1,bookmark:null,scale:100,pages:2,sha256:pdf.sha256})):path===`/api/documents/${id}/page?page=1&scale=100&storeScope=${newScope}`?Promise.resolve(imageResponse(path,pdf.sha256,pdf.pages,newScope)):path.endsWith('/annotations')?Promise.resolve(json({storeScope:newScope,documentId:id,sha256:pdf.sha256,revision:0,notes:[]})):undefined);
 await screen.findByRole('heading',{name:'scoped.pdf'});fireEvent.click(screen.getByText('阅读 PDF 页面'));await screen.findByRole('img');
 await act(async()=>release(json({storeScope:oldScope,page:2,bookmark:null,scale:100,pages:2,sha256:pdf.sha256})));
 expect(screen.getByRole('img').getAttribute('data-source-url')).toContain('page=1&scale=100&storeScope='+newScope);
 expect(screen.getByRole('img').getAttribute('src')).toMatch(/^data:image\/png;base64,/);
 const pageCalls=second.fetcher.mock.calls.filter(([path])=>String(path).includes('/page?'));expect(pageCalls).toHaveLength(1);expect(pageCalls[0][0]).toBe(`/api/documents/${id}/page?page=1&scale=100&storeScope=${newScope}`);expect(new Headers(pageCalls[0][1]?.headers).get('X-Document-Store-Id')).toBe(newScope);
 for(const [path,init] of second.fetcher.mock.calls.filter(([path])=>/\/(reader|annotations)$/.test(String(path))))expect(new Headers(init?.headers).get('X-Document-Store-Id')).toBe(newScope);
});
