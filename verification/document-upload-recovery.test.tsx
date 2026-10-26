import React from 'react';
import {createHash,webcrypto} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {LocalDocuments} from '../candidate/src/components/LocalDocuments';
import {readUploadRecords,retainUploadRecord,UPLOAD_JOURNAL_PREFIX,type UploadRecord} from '../candidate/src/components/document-upload-journal';

// Entirely synthetic, in-process fault injection: no real HTTP or external service is used.
const scope='10000000-0000-4000-8000-000000000001';
const otherScope='20000000-0000-4000-8000-000000000002';
const operationId='30000000-0000-4000-8000-000000000003';
const otherOperation='40000000-0000-4000-8000-000000000004';
const folderId='50000000-0000-4000-8000-000000000005';
const documentId='60000000-0000-4000-8000-000000000006';
const content='SYNTHETIC_ONLY_UPLOAD_RECOVERY_CONTENT';
const sha256=createHash('sha256').update(content).digest('hex');
const choices={uploadScope:scope,workspaces:[{id:'original-workspace',name:'Original workspace'},{id:'changed-workspace',name:'Changed workspace'}],folders:[{id:folderId,name:'Original folder',workspaceId:'original-workspace'}]};
const pending=(patch:Partial<UploadRecord>={}):UploadRecord=>({version:1,scope,operationId,name:'synthetic.md',format:'md',bytes:Buffer.byteLength(content),sha256,workspaceId:'original-workspace',folderId,createdAt:'2026-10-17T12:00:00.000Z',...patch});
const key=(item:UploadRecord)=>`${UPLOAD_JOURNAL_PREFIX}${item.scope}:${item.operationId}`;
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function saved(item:UploadRecord){
 const receipt={operationId:item.operationId,documentId,name:item.name,format:item.format,bytes:item.bytes,sha256:item.sha256,workspaceId:item.workspaceId,folderId:item.folderId,createdAt:'2026-10-17T12:01:00.000Z'};
 const document={id:documentId,revision:0,trashedAt:null,name:item.name,format:item.format,bytes:item.bytes,sha256:item.sha256,textSha256:'b'.repeat(64),createdAt:receipt.createdAt,pages:null,workspaceId:item.workspaceId,folderId:item.folderId,workspaceName:null,folderName:null,stale:false};
 return {receipt,document};
}
function syntheticFile(text=content,name='synthetic.md'){
 const file=new File([text],name,{type:'text/markdown'}),bytes=new TextEncoder().encode(text);
 Object.defineProperty(file,'arrayBuffer',{value:async()=>Uint8Array.from(bytes).buffer});return file;
}
type Extra=(path:string,init?:RequestInit)=>Promise<Response>|undefined;
function setup(extra?:Extra,choiceData:unknown=choices){
 const fetcher=vi.fn((input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
  const path=String(input),override=extra?.(path,init);if(override)return override;
  if(path==='/api/documents/choices')return Promise.resolve(json(choiceData));
  if(path.startsWith('/api/documents?'))return Promise.resolve(json({storeScope:scope,documents:[],total:0,offset:0,limit:10}));
  if(path.startsWith('/api/documents/upload?')){
   const headers=new Headers(init?.headers),op=headers.get('X-Upload-Operation-Id');
   const item=readUploadRecords(localStorage,scope).find(value=>value.operationId===op);
   if(!item)throw Error('Test detected dispatch before durable recovery metadata');
   return Promise.resolve(json(saved(item),201));
  }
  throw Error(`Unexpected synthetic request: ${path}`);
 });
 vi.stubGlobal('fetch',fetcher);return {...render(<LocalDocuments/>),fetcher};
}
const posts=(fetcher:ReturnType<typeof setup>['fetcher'])=>fetcher.mock.calls.filter(([,init])=>init?.method==='POST');
const checks=(fetcher:ReturnType<typeof setup>['fetcher'])=>fetcher.mock.calls.filter(([path])=>String(path).startsWith('/api/documents/upload-operations/'));
async function ready(){
 await screen.findByText('没有匹配的文档。上传文件，或调整筛选条件。');
 await waitFor(()=>expect(screen.getByLabelText('工作区').closest('fieldset')!.disabled).toBe(false));
}
function selectNew(file=syntheticFile()){fireEvent.change(screen.getByLabelText('选择文档'),{target:{files:[file]}});return file}
function upload(){fireEvent.click(screen.getByRole('button',{name:'上传并保存'}))}
function selectRetry(item=pending(),file=syntheticFile()){fireEvent.change(screen.getByLabelText(`为${item.name}重新选择原文件`),{target:{files:[file]}});return file}
async function retained(){return screen.findByRole('region',{name:'上传结果恢复'})}
beforeEach(()=>{localStorage.clear();vi.stubGlobal('crypto',webcrypto)});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear()});

it('retains metadata before POST, sends raw bytes and exact operation/store headers, and reports saved without downloading',async()=>{
 let observed:UploadRecord|undefined;
 const {fetcher}=setup((path,init)=>{if(path.startsWith('/api/documents/upload?')){
  observed=readUploadRecords(localStorage,scope)[0];expect(observed).toBeTruthy();
  expect(localStorage.getItem(key(observed!))).not.toContain(content);expect(init?.body).toBeInstanceOf(File);
 }});
 await ready();fireEvent.change(screen.getByLabelText('工作区'),{target:{value:'original-workspace'}});fireEvent.change(screen.getByLabelText('本地文件夹'),{target:{value:folderId}});
 const file=selectNew();upload();await screen.findByText(/已核实文档已保存到本地/);
 expect(posts(fetcher)).toHaveLength(1);const [path,init]=posts(fetcher)[0];
 expect(path).toBe(`/api/documents/upload?name=synthetic.md&workspaceId=original-workspace&folderId=${folderId}`);
 expect(init).toMatchObject({method:'POST',body:file,headers:{'Content-Type':'application/octet-stream','X-Upload-Operation-Id':observed!.operationId,'X-Upload-Store-Id':scope}});
 expect(readUploadRecords(localStorage,scope)).toEqual([]);expect(screen.queryByRole('region',{name:'上传结果恢复'})).toBeNull();
 expect(fetcher.mock.calls.some(([path])=>String(path).includes('/download'))).toBe(false);expect(screen.queryByText(/已请求下载/)).toBeNull();
});

it('restores pending operations after remount without an automatic status check or retransmission',async()=>{
 const one=pending(),foreign=pending({scope:otherScope,name:'foreign.md'});retainUploadRecord(localStorage,one);retainUploadRecord(localStorage,foreign);
 const first=setup();await retained();await ready();expect(posts(first.fetcher)).toHaveLength(0);expect(checks(first.fetcher)).toHaveLength(0);
 expect(screen.queryByText('foreign.md')).toBeNull();expect((screen.getByRole('button',{name:'用原操作重试上传'}) as HTMLButtonElement).disabled).toBe(true);
 first.unmount();const second=setup();await retained();await ready();
 expect(posts(second.fetcher)).toHaveLength(0);expect(checks(second.fetcher)).toHaveLength(0);expect(readUploadRecords(localStorage,scope)).toEqual([one]);
 selectNew();expect((screen.getByRole('button',{name:'上传并保存'}) as HTMLButtonElement).disabled).toBe(true);
});

it('treats absent as nonterminal and retains original identity until an explicit byte-identical retry',async()=>{
 const item=pending();retainUploadRecord(localStorage,item);
 const {fetcher}=setup(path=>path.endsWith(`/upload-operations/${operationId}`)?Promise.resolve(json({scope,operationId,outcome:'absent'})):undefined);
 await retained();fireEvent.click(screen.getByRole('button',{name:'核对上传结果'}));await screen.findByText(/不能据此认定上传失败/);
 expect(readUploadRecords(localStorage,scope)).toEqual([item]);expect(posts(fetcher)).toHaveLength(0);
 fireEvent.change(screen.getByLabelText('工作区'),{target:{value:'changed-workspace'}});
 const original=selectRetry();fireEvent.click(screen.getByRole('button',{name:'用原操作重试上传'}));await screen.findByText(/已核实文档已保存到本地/);
 expect(posts(fetcher)).toHaveLength(1);expect(posts(fetcher)[0][0]).toBe(`/api/documents/upload?name=synthetic.md&workspaceId=original-workspace&folderId=${folderId}`);
 expect(posts(fetcher)[0][1]).toMatchObject({body:original,headers:{'X-Upload-Operation-Id':operationId,'X-Upload-Store-Id':scope}});
 expect(readUploadRecords(localStorage,scope)).toEqual([]);
});

it('recovers a lost post-commit response by explicit GET after reload without creating or downloading another document',async()=>{
 let committed:UploadRecord|undefined;
 const first=setup(path=>{if(path.startsWith('/api/documents/upload?')){committed=readUploadRecords(localStorage,scope)[0];return Promise.reject(new TypeError('Synthetic acknowledgement lost after commit'))}});
 await ready();selectNew();upload();await screen.findByText(/未取得成功回执，已保留原操作/);await retained();
 expect(committed).toBeTruthy();expect(posts(first.fetcher)).toHaveLength(1);first.unmount();
 const second=setup(path=>path.endsWith(`/upload-operations/${committed!.operationId}`)?Promise.resolve(json({scope,operationId:committed!.operationId,outcome:'committed',...saved(committed!)})):undefined);
 await retained();await ready();expect(checks(second.fetcher)).toHaveLength(0);expect(posts(second.fetcher)).toHaveLength(0);
 fireEvent.click(screen.getByRole('button',{name:'核对上传结果'}));await screen.findByText(/已核实文档已保存到本地/);
 expect(checks(second.fetcher)).toHaveLength(1);expect(posts(second.fetcher)).toHaveLength(0);expect(readUploadRecords(localStorage,scope)).toEqual([]);
 expect(second.fetcher.mock.calls.some(([path])=>String(path).endsWith('/download'))).toBe(false);
});

it('retries a lost-response operation with the exact original UUID and never treats the retry as a new upload',async()=>{
 let attempts=0,original:UploadRecord|undefined;
 const {fetcher}=setup(path=>{if(path.startsWith('/api/documents/upload?')){
  attempts++;const item=readUploadRecords(localStorage,scope)[0];original??=item;
  return attempts===1?Promise.reject(new TypeError('Synthetic lost response')):Promise.resolve(json(saved(original),201));
 }});
 await ready();selectNew();upload();await screen.findByText(/未取得成功回执，已保留原操作/);selectRetry(original!,syntheticFile());
 fireEvent.click(screen.getByRole('button',{name:'用原操作重试上传'}));await screen.findByText(/已核实文档已保存到本地/);
 expect(posts(fetcher)).toHaveLength(2);expect(posts(fetcher)[0][0]).toBe(posts(fetcher)[1][0]);
 expect(new Headers(posts(fetcher)[0][1]?.headers).get('X-Upload-Operation-Id')).toBe(new Headers(posts(fetcher)[1][1]?.headers).get('X-Upload-Operation-Id'));
 expect(readUploadRecords(localStorage,scope)).toEqual([]);
});

it.each([
 ['a changed filename',()=>syntheticFile(content,'renamed.md')],
 ['a changed length',()=>syntheticFile(content+'!')],
 ['same-length different content',()=>syntheticFile('X'+content.slice(1))],
] as const)('rejects reselected %s locally without sending bytes or erasing the pending operation',async(_label,file)=>{
 const item=pending();retainUploadRecord(localStorage,item);const {fetcher}=setup();await retained();selectRetry(item,file());
 fireEvent.click(screen.getByRole('button',{name:'用原操作重试上传'}));await screen.findByText(/请选择原来同名、同内容的文件/);
 expect(posts(fetcher)).toHaveLength(0);expect(readUploadRecords(localStorage,scope)).toEqual([item]);expect(screen.queryByText(/已核实文档已保存到本地/)).toBeNull();
});

it('blocks duplicate new-submit clicks while hashing or sending and keeps one operation',async()=>{
 let resolve!:(value:Response)=>void;const {fetcher}=setup(path=>path.startsWith('/api/documents/upload?')?new Promise(r=>{resolve=r}):undefined);
 await ready();selectNew();const form=screen.getByLabelText('选择文档').closest('form')!;
 fireEvent.submit(form);fireEvent.submit(form);await waitFor(()=>expect(posts(fetcher)).toHaveLength(1));
 const item=readUploadRecords(localStorage,scope)[0];expect(readUploadRecords(localStorage,scope)).toHaveLength(1);
 fireEvent.submit(form);expect(posts(fetcher)).toHaveLength(1);
 await act(async()=>resolve(json(saved(item),201)));await screen.findByText(/已核实文档已保存到本地/);
});

it('blocks overlapping check and retry clicks until the original check settles',async()=>{
 const item=pending();retainUploadRecord(localStorage,item);let resolve!:(value:Response)=>void;
 const {fetcher}=setup(path=>path.includes('/upload-operations/')?new Promise(r=>{resolve=r}):undefined);
 await retained();selectRetry();const check=screen.getByRole('button',{name:'核对上传结果'}),retry=screen.getByRole('button',{name:'用原操作重试上传'});
 fireEvent.click(check);fireEvent.click(check);fireEvent.click(retry);
 expect(checks(fetcher)).toHaveLength(1);expect(posts(fetcher)).toHaveLength(0);
 await act(async()=>resolve(json({scope,operationId,outcome:'absent'})));await screen.findByText(/不能据此认定上传失败/);
 expect(readUploadRecords(localStorage,scope)).toEqual([item]);
});

it('blocks duplicate retry clicks and cross-action checks while the original retry is pending',async()=>{
 const item=pending();retainUploadRecord(localStorage,item);let resolve!:(value:Response)=>void;
 const {fetcher}=setup(path=>path.startsWith('/api/documents/upload?')?new Promise(r=>{resolve=r}):undefined);
 await retained();selectRetry();const retry=screen.getByRole('button',{name:'用原操作重试上传'});fireEvent.click(retry);fireEvent.click(retry);
 await waitFor(()=>expect(posts(fetcher)).toHaveLength(1));fireEvent.click(screen.getByRole('button',{name:'核对上传结果'}));expect(checks(fetcher)).toHaveLength(0);
 await act(async()=>resolve(json(saved(item),201)));await screen.findByText(/已核实文档已保存到本地/);expect(posts(fetcher)).toHaveLength(1);
});

it.each(['write throws','write disappears','corrupt record','storage inaccessible'] as const)('fails closed with no POST when %s',async mode=>{
 if(mode==='corrupt record')localStorage.setItem(key(pending()),'{');
 if(mode==='storage inaccessible')vi.spyOn(window,'localStorage','get').mockImplementation(()=>{throw Error('Synthetic storage access denied')});
 const {fetcher}=setup();await ready();
 if(mode==='write throws')vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('Synthetic storage quota')});
 if(mode==='write disappears')vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{});
 selectNew();upload();await screen.findAllByRole('alert');
 expect(posts(fetcher)).toHaveLength(0);expect(screen.queryByText(/已核实文档已保存到本地/)).toBeNull();
});

it('requires a valid store scope from choices before sending an upload',async()=>{
 const {fetcher}=setup(undefined,{...choices,uploadScope:undefined});await ready();await screen.findByText(/未取得本地文档库标识/);selectNew();upload();
 expect(posts(fetcher)).toHaveLength(0);expect(localStorage.length).toBe(0);
});

it.each(['scope','operation','receipt','document','unknown outcome'] as const)('retains pending metadata and refuses false success on mismatched %s result',async kind=>{
 const item=pending();retainUploadRecord(localStorage,item);const result:any={scope,operationId,outcome:'committed',...saved(item)};
 if(kind==='scope')result.scope=otherScope;if(kind==='operation')result.operationId=otherOperation;
 if(kind==='receipt')result.receipt.sha256='f'.repeat(64);if(kind==='document')result.document.id=otherOperation;if(kind==='unknown outcome')result.outcome='failed';
 const {fetcher}=setup(path=>path.includes('/upload-operations/')?Promise.resolve(json(result)):undefined);await retained();
 fireEvent.click(screen.getByRole('button',{name:'核对上传结果'}));await screen.findByRole('alert');
 expect(readUploadRecords(localStorage,scope)).toEqual([item]);expect(posts(fetcher)).toHaveLength(0);expect(screen.queryByText(/已核实文档已保存到本地/)).toBeNull();
});

it('retains an acknowledged POST when its receipt does not match the retained operation',async()=>{
 const {fetcher}=setup(path=>{if(path.startsWith('/api/documents/upload?')){const result=saved(readUploadRecords(localStorage,scope)[0]);result.receipt.operationId=otherOperation;return Promise.resolve(json(result,201))}});
 await ready();selectNew();upload();await screen.findByText(/上传回执与原操作不符/);await retained();
 expect(posts(fetcher)).toHaveLength(1);expect(readUploadRecords(localStorage,scope)).toHaveLength(1);expect(screen.queryByText(/已核实文档已保存到本地/)).toBeNull();
});

it('settles only the checked operation, preserving a second pending operation and a foreign-store journal',async()=>{
 const one=pending(),two=pending({operationId:otherOperation,name:'second.md'}),foreign=pending({scope:otherScope,name:'foreign.md'});
 for(const item of [one,two,foreign])retainUploadRecord(localStorage,item);
 const {fetcher}=setup(path=>path.endsWith(`/upload-operations/${operationId}`)?Promise.resolve(json({scope,operationId,outcome:'committed',...saved(one)})):undefined);
 const panel=await retained();fireEvent.click(within(panel).getAllByRole('button',{name:'核对上传结果'})[0]);await screen.findByText(/已核实文档已保存到本地/);
 expect(readUploadRecords(localStorage,scope)).toEqual([two]);expect(readUploadRecords(localStorage,otherScope)).toEqual([foreign]);
 expect(within(await retained()).getByRole('heading',{name:'second.md'})).toBeTruthy();expect(posts(fetcher)).toHaveLength(0);
});

it('keeps journal evidence when acknowledgement settlement cannot remove the stored key',async()=>{
 const item=pending();retainUploadRecord(localStorage,item);
 const {fetcher}=setup(path=>path.includes('/upload-operations/')?Promise.resolve(json({scope,operationId,outcome:'committed',...saved(item)})):undefined);
 await retained();vi.spyOn(Storage.prototype,'removeItem').mockImplementation(()=>{throw Error('Synthetic cannot remove')});
 fireEvent.click(screen.getByRole('button',{name:'核对上传结果'}));await screen.findByRole('alert');
 expect(readUploadRecords(localStorage,scope)).toEqual([item]);expect(screen.queryByText(/已核实文档已保存到本地/)).toBeNull();expect(posts(fetcher)).toHaveLength(0);
});

it.each([400,413,415,422])('retains original operation after HTTP %i because a rejected attempt does not prove its earlier outcome',async status=>{
 const {fetcher}=setup(path=>path.startsWith('/api/documents/upload?')?Promise.resolve(json({error:{message:`Synthetic validation rejection ${status}`}},status)):undefined);
 await ready();selectNew();upload();await screen.findByText(`Synthetic validation rejection ${status}`);await screen.findByText(/未取得成功回执，已保留原操作/);await retained();
 expect(posts(fetcher)).toHaveLength(1);expect(readUploadRecords(localStorage,scope)).toHaveLength(1);expect(screen.queryByText(/已核实文档已保存到本地/)).toBeNull();
 expect((screen.getByRole('button',{name:'上传并保存'}) as HTMLButtonElement).disabled).toBe(true);expect(checks(fetcher)).toHaveLength(0);
});

it.each([409,429,500,503])('retains uncertain outcome on HTTP %i and blocks a new upload',async status=>{
 const {fetcher}=setup(path=>path.startsWith('/api/documents/upload?')?Promise.resolve(json({error:{message:`Synthetic uncertain ${status}`}},status)):undefined);
 await ready();selectNew();upload();await screen.findByText(`Synthetic uncertain ${status}`);await retained();
 expect(readUploadRecords(localStorage,scope)).toHaveLength(1);expect((screen.getByRole('button',{name:'上传并保存'}) as HTMLButtonElement).disabled).toBe(true);
 expect(posts(fetcher)).toHaveLength(1);expect(screen.queryByText(/已核实文档已保存到本地/)).toBeNull();
});

it('retains an in-flight upload on unmount and discards its late success until an explicit check',async()=>{
 let resolve!:(value:Response)=>void,signal:AbortSignal|null|undefined;
 const first=setup((path,init)=>path.startsWith('/api/documents/upload?')?new Promise(r=>{resolve=r;signal=init?.signal}):undefined);
 await ready();selectNew();upload();await waitFor(()=>expect(posts(first.fetcher)).toHaveLength(1));const item=readUploadRecords(localStorage,scope)[0];first.unmount();expect(signal?.aborted).toBe(true);
 await act(async()=>resolve(json(saved(item),201)));expect(readUploadRecords(localStorage,scope)).toEqual([item]);
 const second=setup();await retained();await ready();expect(posts(second.fetcher)).toHaveLength(0);expect(checks(second.fetcher)).toHaveLength(0);
});

it('uses a new operation for a later deliberate upload of the same bytes after the first is confirmed',async()=>{
 const {fetcher}=setup();await ready();selectNew();upload();await screen.findByText(/已核实文档已保存到本地/);
 selectNew();upload();await waitFor(()=>expect(posts(fetcher)).toHaveLength(2));await waitFor(()=>expect(readUploadRecords(localStorage,scope)).toEqual([]));
 const ids=posts(fetcher).map(([,init])=>new Headers(init?.headers).get('X-Upload-Operation-Id'));
 expect(ids[0]).toMatch(/^[a-f0-9-]{36}$/);expect(ids[1]).not.toBe(ids[0]);
});

it('reacts to another tab journal change without retransmitting either operation',async()=>{
 const {fetcher}=setup();await ready();const item=pending();retainUploadRecord(localStorage,item);
 act(()=>window.dispatchEvent(new StorageEvent('storage',{key:key(item),newValue:JSON.stringify(item)})));
 await retained();expect(posts(fetcher)).toHaveLength(0);expect(checks(fetcher)).toHaveLength(0);
 localStorage.removeItem(key(item));act(()=>window.dispatchEvent(new StorageEvent('storage',{key:key(item),newValue:null})));
 await waitFor(()=>expect(screen.queryByRole('region',{name:'上传结果恢复'})).toBeNull());
});

it('reports a previously committed upload now in trash without creating or restoring a document',async()=>{
 const item=pending();retainUploadRecord(localStorage,item);const result=saved(item);result.document.trashedAt='2026-10-17T12:02:00.000Z' as any;
 const {fetcher}=setup(path=>path.includes('/upload-operations/')?Promise.resolve(json({scope,operationId,outcome:'committed',...result})):undefined);
 await retained();fireEvent.click(screen.getByRole('button',{name:'核对上传结果'}));await screen.findByText(/目前在文档回收站/);
 expect(readUploadRecords(localStorage,scope)).toEqual([]);expect(posts(fetcher)).toHaveLength(0);expect(fetcher.mock.calls.some(([,init])=>init?.method==='PUT')).toBe(false);
});

it('cancelling the explicit abandon warning keeps the original operation and selected retry file without network work',async()=>{
 const item=pending();retainUploadRecord(localStorage,item);const {fetcher}=setup();await retained();await ready();selectRetry();
 const calls=fetcher.mock.calls.length,confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 fireEvent.click(screen.getByRole('button',{name:'放弃追踪此上传'}));
 expect(confirm).toHaveBeenCalledTimes(1);const warning=confirm.mock.calls[0][0];
 expect(warning).toContain('仅移除此浏览器中的恢复记录');expect(warning).toContain('不会取消服务端上传或删除已保存文档');expect(warning).toContain('可能创建重复文档');
 expect(readUploadRecords(localStorage,scope)).toEqual([item]);expect(fetcher.mock.calls).toHaveLength(calls);
 expect((screen.getByRole('button',{name:'用原操作重试上传'}) as HTMLButtonElement).disabled).toBe(false);
});

it('confirmed abandonment removes only that local operation with no cancellation, deletion, retransmission or success claim',async()=>{
 const one=pending(),two=pending({operationId:otherOperation,name:'second.md'}),foreign=pending({scope:otherScope,name:'foreign.md'});
 for(const item of [one,two,foreign])retainUploadRecord(localStorage,item);
 const {fetcher}=setup();const panel=await retained();await ready();const calls=fetcher.mock.calls.length;
 vi.spyOn(window,'confirm').mockReturnValue(true);fireEvent.click(within(panel).getAllByRole('button',{name:'放弃追踪此上传'})[0]);
 await screen.findByText(/已移除本地恢复记录。服务端上传没有被取消/);
 expect(readUploadRecords(localStorage,scope)).toEqual([two]);expect(readUploadRecords(localStorage,otherScope)).toEqual([foreign]);
 expect(fetcher.mock.calls).toHaveLength(calls);expect(screen.queryByText(/已核实文档已保存到本地/)).toBeNull();
 expect(within(await retained()).queryByRole('heading',{name:'synthetic.md'})).toBeNull();expect(within(await retained()).getByRole('heading',{name:'second.md'})).toBeTruthy();
});


it('keeps a lost-response operation after reload and a 422 exact retry, still blocking creation of a replacement operation',async()=>{
 const first=setup(path=>path.startsWith('/api/documents/upload?')?Promise.reject(new TypeError('Synthetic acknowledgement lost')):undefined);
 await ready();fireEvent.change(screen.getByLabelText('工作区'),{target:{value:'original-workspace'}});fireEvent.change(screen.getByLabelText('本地文件夹'),{target:{value:folderId}});
 selectNew();upload();await screen.findByText(/未取得成功回执，已保留原操作/);await retained();
 const item=readUploadRecords(localStorage,scope)[0],originalMetadata=localStorage.getItem(key(item)),firstPost=posts(first.fetcher)[0];
 expect(item).toBeTruthy();expect(posts(first.fetcher)).toHaveLength(1);first.unmount();
 const second=setup(path=>path.startsWith('/api/documents/upload?')?Promise.resolve(json({error:{message:'Synthetic original-operation retry rejected after unknown earlier outcome'}},422)):undefined);
 await retained();await ready();expect(posts(second.fetcher)).toHaveLength(0);expect(checks(second.fetcher)).toHaveLength(0);
 const originalFile=selectRetry(item);fireEvent.click(screen.getByRole('button',{name:'用原操作重试上传'}));
 await screen.findByText('Synthetic original-operation retry rejected after unknown earlier outcome');await screen.findByText(/未取得成功回执，已保留原操作/);
 expect(posts(second.fetcher)).toHaveLength(1);const [path,init]=posts(second.fetcher)[0];
 expect(path).toBe(firstPost[0]);expect(init?.body).toBe(originalFile);
 expect(new Headers(init?.headers).get('X-Upload-Operation-Id')).toBe(item.operationId);expect(new Headers(init?.headers).get('X-Upload-Store-Id')).toBe(item.scope);
 expect(localStorage.getItem(key(item))).toBe(originalMetadata);expect(readUploadRecords(localStorage,scope)).toEqual([item]);
 expect((screen.getByRole('button',{name:'上传并保存'}) as HTMLButtonElement).disabled).toBe(true);expect(screen.queryByText(/已核实文档已保存到本地/)).toBeNull();
 selectNew(syntheticFile('A synthetic replacement file','replacement.md'));fireEvent.submit(screen.getByLabelText('选择文档').closest('form')!);
 await screen.findByText(/请先核对待确认的上传/);expect(posts(second.fetcher)).toHaveLength(1);expect(readUploadRecords(localStorage,scope)).toEqual([item]);
});
