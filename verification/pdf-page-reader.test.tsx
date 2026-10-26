import {imageResponse,installPdfCrypto} from './pdf-image-fixture';
import React from 'react';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {PdfPageReader} from '../candidate/src/components/PdfPageReader';

const scope='44444444-4444-4444-8444-444444444444';
const id='11111111-1111-4111-8111-111111111111';
const otherId='22222222-2222-4222-8222-222222222222';
const initial={page:1,bookmark:null as number|null,scale:100,pages:3,sha256:'a'.repeat(64)};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(status<300?{storeScope:scope,...(data as object)}:data),{status,headers:{'Content-Type':'application/json'}});
type Extra=(path:string,init?:RequestInit)=>Promise<Response>|undefined;
function setup(data=initial,extra?:Extra) {
 const fetcher=vi.fn((input:RequestInfo|URL,init?:RequestInit)=>String(input).includes('/page?')?Promise.resolve(imageResponse(String(input),data.sha256,data.pages)):String(input).endsWith('/annotations')?Promise.resolve(json({documentId:String(input).split('/')[3],sha256:data.sha256,revision:0,notes:[]})):extra?.(String(input),init)??Promise.resolve(json(init?.method==='PUT'?{...data,...JSON.parse(init.body as string)}:data)));
 vi.stubGlobal('fetch',fetcher);
 return {...render(<PdfPageReader storeScope={scope} selectedSha256={initial.sha256} selectedPages={initial.pages} documentId={id} documentName="synthetic.pdf"/>),fetcher};
}
const writes=(fetcher:ReturnType<typeof setup>['fetcher'])=>fetcher.mock.calls.filter(([,init])=>init?.method==='PUT');
const position=(call:ReturnType<typeof setup>['fetcher']['mock']['calls'][number])=>JSON.parse(call[1]!.body as string);
beforeEach(()=>installPdfCrypto());
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

it('restores the saved page, zoom and bookmark and persists only after the page image loads',async()=>{
 const {fetcher,container}=setup({...initial,page:2,scale:150,bookmark:3});
 const image=await screen.findByRole('img');
 expect(image.getAttribute('data-source-url')).toBe(`/api/documents/${id}/page?page=2&scale=150&storeScope=${scope}`);
 expect(screen.getByText('第 2 / 3 页 · 缩放 150%')).toBeTruthy();expect(screen.getByText('书签：第 3 页')).toBeTruthy();
 expect(writes(fetcher)).toHaveLength(0);expect(container.querySelector('iframe,object,embed')).toBeNull();
 fireEvent.load(image);await screen.findByText('阅读位置与书签已保存');
 expect(writes(fetcher)).toHaveLength(1);expect(position(writes(fetcher)[0])).toEqual({page:2,bookmark:3,scale:150});
 expect(writes(fetcher)[0][1]?.headers).toEqual({'Content-Type':'application/json','X-Document-Store-Id':scope});
});

it('bounds previous/next and integer jumps, offers exactly three zoom levels and navigates to bookmarks',async()=>{
 const {fetcher}=setup({...initial,bookmark:3});await screen.findByRole('img');
 expect((screen.getByText('PDF 上一页') as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByText('PDF 下一页'));expect((await screen.findByRole('img')).getAttribute('data-source-url')).toContain('page=2&scale=100');
 fireEvent.click(screen.getByText('转到书签'));expect(screen.getByText('第 3 / 3 页 · 缩放 100%')).toBeTruthy();
 expect((screen.getByText('PDF 下一页') as HTMLButtonElement).disabled).toBe(true);
 for(const value of ['0','4','1.5','']) {
  fireEvent.change(screen.getByLabelText('PDF 页码'),{target:{value}});fireEvent.click(screen.getByText('跳转页面'));
  expect(screen.getByRole('alert').textContent).toContain('1 至 3');expect((await screen.findByRole('img')).getAttribute('data-source-url')).toContain('page=3&scale=100');
 }
 fireEvent.change(screen.getByLabelText('PDF 页码'),{target:{value:'1'}});fireEvent.click(screen.getByText('跳转页面'));
 expect(screen.queryByRole('alert')).toBeNull();
 expect([...screen.getByLabelText('PDF 缩放').querySelectorAll('option')].map(option=>option.value)).toEqual(['75','100','150']);
 fireEvent.change(screen.getByLabelText('PDF 缩放'),{target:{value:'75'}});expect((await screen.findByRole('img')).getAttribute('data-source-url')).toContain('page=1&scale=75');
 fireEvent.load(await screen.findByRole('img'));await screen.findByText('阅读位置与书签已保存');expect(position(writes(fetcher)[0])).toEqual({page:1,bookmark:3,scale:75});
});

it('saves, reopens, navigates to and removes the document bookmark without changing the source',async()=>{
 let stored={...initial};
 const {unmount,fetcher}=setup(initial,(_path,init)=>{if(init?.method==='PUT')stored={...stored,...JSON.parse(init.body as string)};return Promise.resolve(json(stored));});
 fireEvent.load(await screen.findByRole('img'));await screen.findByText('阅读位置与书签已保存');
 fireEvent.click(screen.getByText('PDF 下一页'));fireEvent.load(await screen.findByRole('img'));await waitFor(()=>expect(stored.page).toBe(2));
 fireEvent.click(screen.getByText('将当前页设为书签'));await waitFor(()=>expect(stored.bookmark).toBe(2));
 expect(screen.getByText('移除当前页书签').getAttribute('aria-pressed')).toBe('true');
 fireEvent.change(screen.getByLabelText('PDF 缩放'),{target:{value:'150'}});fireEvent.load(await screen.findByRole('img'));await waitFor(()=>expect(stored.scale).toBe(150));
 unmount();render(<PdfPageReader storeScope={scope} selectedSha256={initial.sha256} selectedPages={initial.pages} documentId={id} documentName="synthetic.pdf"/>);
 expect((await screen.findByRole('img')).getAttribute('data-source-url')).toContain('page=2&scale=150');expect(screen.getByText('书签：第 2 页')).toBeTruthy();
 fireEvent.load(await screen.findByRole('img'));await screen.findByText('阅读位置与书签已保存');
 fireEvent.click(screen.getByText('移除当前页书签'));await waitFor(()=>expect(stored.bookmark).toBeNull());
 expect(stored.sha256).toBe(initial.sha256);expect(fetcher.mock.calls.every(([path])=>[ `/api/documents/${id}/reader`, `/api/documents/${id}/annotations` ].includes(String(path))||String(path).startsWith(`/api/documents/${id}/page?`))).toBe(true);
});

it('reports image failure, retries the same bounded URL and does not save failed renders',async()=>{
 const {fetcher}=setup();const image=await screen.findByRole('img');fireEvent.error(image);
 expect(screen.getByRole('alert').textContent).toContain('页面图片加载失败');expect(writes(fetcher)).toHaveLength(0);
 expect((screen.getByText('将当前页设为书签') as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByText('重试页面图片'));const retry=await screen.findByRole('img');expect(retry).not.toBe(image);expect(retry.getAttribute('data-source-url')).toBe(image.getAttribute('data-source-url'));
 fireEvent.load(retry);await screen.findByText('阅读位置与书签已保存');expect(writes(fetcher)).toHaveLength(1);expect(screen.queryByRole('alert')).toBeNull();
});

it('ignores obsolete page image events after a newer navigation',async()=>{
 const {fetcher}=setup();const oldImage=await screen.findByRole('img');fireEvent.click(screen.getByText('PDF 下一页'));
 fireEvent.load(oldImage);fireEvent.error(oldImage);expect(writes(fetcher)).toHaveLength(0);expect(screen.queryByRole('alert')).toBeNull();
 fireEvent.load(await screen.findByRole('img'));await screen.findByText('阅读位置与书签已保存');expect(position(writes(fetcher)[0]).page).toBe(2);
});

it('serializes writes and coalesces queued page loads so old completions cannot rewind the reader',async()=>{
 const pending:{resolve:(response:Response)=>void;position:unknown}[]=[];
 const {fetcher}=setup(initial,(_path,init)=>init?.method==='PUT'?new Promise(resolve=>pending.push({resolve,position:JSON.parse(init.body as string)})):undefined);
 fireEvent.load(await screen.findByRole('img'));expect(pending).toHaveLength(1);
 fireEvent.click(screen.getByText('PDF 下一页'));fireEvent.load(await screen.findByRole('img'));
 fireEvent.click(screen.getByText('PDF 下一页'));fireEvent.load(await screen.findByRole('img'));
 expect(writes(fetcher)).toHaveLength(1);expect(screen.queryByText('阅读位置与书签已保存')).toBeNull();
 await act(async()=>pending[0].resolve(json({...initial,...pending[0].position as object})));
 await waitFor(()=>expect(pending).toHaveLength(2));expect(position(writes(fetcher)[1]).page).toBe(3);
 expect(screen.getByText('第 3 / 3 页 · 缩放 100%')).toBeTruthy();expect(screen.queryByText('阅读位置与书签已保存')).toBeNull();
 await act(async()=>pending[1].resolve(json({...initial,...pending[1].position as object})));
 await screen.findByText('阅读位置与书签已保存');expect(screen.getByText('上次保存的阅读位置：第 3 页')).toBeTruthy();
});

it('preserves an unsaved bookmark after a write failure and retries the exact state',async()=>{
 let fail=false;
 const {fetcher}=setup(initial,(_path,init)=>init?.method==='PUT'&&fail?Promise.resolve(json({error:{message:'Disk is full'}},507)):undefined);
 fireEvent.load(await screen.findByRole('img'));await screen.findByText('阅读位置与书签已保存');fail=true;
 fireEvent.click(screen.getByText('将当前页设为书签'));await screen.findByText(/Disk is full/);expect(screen.queryByText('阅读位置与书签已保存')).toBeNull();expect(screen.getByText('书签：第 1 页')).toBeTruthy();
 fail=false;fireEvent.click(screen.getByText('重试保存阅读状态'));await screen.findByText('阅读位置与书签已保存');
 expect(position(writes(fetcher).at(-1)!)).toEqual({page:1,bookmark:1,scale:100});expect(screen.queryByRole('alert')).toBeNull();
});

it('rejects inconsistent successful save responses instead of announcing saved state',async()=>{
 setup(initial,(_path,init)=>init?.method==='PUT'?Promise.resolve(json({...initial,sha256:'b'.repeat(64)})):undefined);
 fireEvent.load(await screen.findByRole('img'));await screen.findByText(/保存结果与阅读状态不一致/);expect(screen.queryByText('阅读位置与书签已保存')).toBeNull();
});

it('shows read errors and supports retry without creating a page image prematurely',async()=>{
 let fail=true;setup(initial,()=>fail?Promise.resolve(json({error:{message:'PDF unavailable'}},404)):undefined);
 await screen.findByText('PDF unavailable');expect(screen.queryByRole('img')).toBeNull();fail=false;
 fireEvent.click(screen.getByText('重试载入阅读器'));await screen.findByRole('img');expect(screen.queryByRole('alert')).toBeNull();
});

it.each([{...initial,page:0},{...initial,bookmark:4},{...initial,scale:200},{...initial,pages:41},{...initial,sha256:'invalid'}])('rejects malformed metadata before rendering a source image: %j',async data=>{
 setup(data);await screen.findByText('阅读状态无效，请重新载入');expect(screen.queryByRole('img')).toBeNull();
});

it('rejects an invalid document ID without any network request',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);render(<PdfPageReader storeScope={scope} selectedSha256={initial.sha256} selectedPages={initial.pages} documentId="../secret?url=https://example.invalid" documentName="bad.pdf"/>);
 await screen.findByText('无效文档标识');expect(fetcher).not.toHaveBeenCalled();
});

it('aborts an old metadata read and ignores its late completion when the document changes',async()=>{
 let resolve!:(response:Response)=>void;let signal:AbortSignal|null|undefined;
 const {rerender}=setup(initial,(path,init)=>path===`/api/documents/${id}/reader`?new Promise(done=>{resolve=done;signal=init?.signal;}):Promise.resolve(json({...initial,page:3})));
 rerender(<PdfPageReader storeScope={scope} selectedSha256={initial.sha256} selectedPages={initial.pages} documentId={otherId} documentName="new.pdf"/>);expect(signal?.aborted).toBe(true);
 expect((await screen.findByRole('img')).getAttribute('data-source-url')).toContain(`/api/documents/${otherId}/page?page=3`);
 await act(async()=>resolve(json(initial)));expect((await screen.findByRole('img')).getAttribute('data-source-url')).toContain(`/api/documents/${otherId}/page?page=3`);
});

it('aborts an in-flight save and discards queued writes when the reader is closed',async()=>{
 let resolve!:(response:Response)=>void;let signal:AbortSignal|null|undefined;
 const {fetcher,unmount}=setup(initial,(_path,init)=>init?.method==='PUT'?new Promise(done=>{resolve=done;signal=init.signal;}):undefined);
 fireEvent.load(await screen.findByRole('img'));fireEvent.click(screen.getByText('PDF 下一页'));fireEvent.load(await screen.findByRole('img'));
 unmount();expect(signal?.aborted).toBe(true);await act(async()=>resolve(json(initial)));expect(writes(fetcher)).toHaveLength(1);
});

it.each([{...initial,sha256:'b'.repeat(64)},{...initial,pages:4}])('rejects a valid but different selected PDF identity before image or annotations mount: %j',async data=>{
 const {fetcher}=setup(data);
 await screen.findByText('阅读状态与所选 PDF 原件不一致，请重新打开');
 expect(screen.queryByRole('img')).toBeNull();expect(screen.queryByRole('region',{name:'PDF 批注'})).toBeNull();
 expect(fetcher.mock.calls.map(([path])=>path)).toEqual([`/api/documents/${id}/reader`]);expect(writes(fetcher)).toHaveLength(0);
});

it.each([
 {selectedSha256:'invalid',selectedPages:3},
 {selectedSha256:initial.sha256,selectedPages:null},
 {selectedSha256:initial.sha256,selectedPages:0},
 {selectedSha256:initial.sha256,selectedPages:41},
 {selectedSha256:initial.sha256,selectedPages:1.5},
 {selectedSha256:initial.sha256,selectedPages:'3'},
 {selectedSha256:{toString(){throw Error('must not coerce');}},selectedPages:3},
 {selectedSha256:initial.sha256,selectedPages:{toString(){throw Error('must not coerce');}}},
])('rejects malformed selected metadata without fetching or coercion: %j',async selection=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 render(<PdfPageReader storeScope={scope} documentId={id} documentName="synthetic.pdf" {...selection as any}/>);
 await screen.findByText('所选 PDF 原件信息无效，请重新打开');expect(fetcher).not.toHaveBeenCalled();expect(screen.queryByRole('img')).toBeNull();
});

it('retries a mismatched initial response against the same selected identity',async()=>{
 let mismatched=true;
 const {fetcher}=setup(initial,(_path,init)=>!init?.method?Promise.resolve(json({...initial,sha256:mismatched?'b'.repeat(64):initial.sha256})):undefined);
 await screen.findByText('阅读状态与所选 PDF 原件不一致，请重新打开');expect(writes(fetcher)).toHaveLength(0);
 mismatched=false;fireEvent.click(screen.getByText('重试载入阅读器'));
 fireEvent.load(await screen.findByRole('img'));await screen.findByText('阅读位置与书签已保存');expect(writes(fetcher)).toHaveLength(1);
 expect(screen.queryByText('阅读状态与所选 PDF 原件不一致，请重新打开')).toBeNull();
});

it.each(['hash','pages'] as const)('replaces the session for changed selected %s with the same ID and ignores late JSON',async changed=>{
 let complete!:(value:unknown)=>void;let oldSignal:AbortSignal|null|undefined;let reads=0;
 const next={...initial,...(changed==='hash'?{sha256:'b'.repeat(64)}:{pages:4})};
 const fetcher=vi.fn((path:RequestInfo|URL,init?:RequestInit)=>{
  if(String(path).includes('/page?'))return Promise.resolve(imageResponse(String(path),next.sha256,next.pages));
  if(String(path).endsWith('/annotations'))return Promise.resolve(json({documentId:id,sha256:next.sha256,revision:0,notes:[]}));
  if(init?.method==='PUT')return Promise.resolve(json({...next,...JSON.parse(init.body as string)}));
  if(++reads===1){oldSignal=init?.signal;return Promise.resolve({ok:true,json:()=>new Promise(done=>{complete=done;})} as Response);}
  return Promise.resolve(json(next));
 });
 vi.stubGlobal('fetch',fetcher);
 const {rerender}=render(<PdfPageReader storeScope={scope} documentId={id} documentName="synthetic.pdf" selectedSha256={initial.sha256} selectedPages={initial.pages}/>);
 await waitFor(()=>expect(complete).toBeTypeOf('function'));
 rerender(<PdfPageReader storeScope={scope} documentId={id} documentName="same-id.pdf" selectedSha256={next.sha256} selectedPages={next.pages}/>);
 expect(oldSignal?.aborted).toBe(true);await screen.findByRole('img');
 await act(async()=>complete(initial));
 expect(screen.getByText(`第 1 / ${next.pages} 页 · 缩放 100%`)).toBeTruthy();expect(screen.getByText(`原件 SHA-256：${next.sha256}`)).toBeTruthy();
 expect(writes(fetcher)).toHaveLength(0);expect(screen.queryByText('阅读状态与所选 PDF 原件不一致，请重新打开')).toBeNull();
});

it('does not remount the reader or discard an annotation draft when only the document name changes',async()=>{
 const {rerender,fetcher}=setup();await screen.findByText('尚无批注');
 fireEvent.click(screen.getByText('新增当前页批注'));fireEvent.change(screen.getByLabelText('批注内容'),{target:{value:'保留我的草稿'}});
 const before=fetcher.mock.calls.length;
 rerender(<PdfPageReader storeScope={scope} documentId={id} documentName="renamed.pdf" selectedSha256={initial.sha256} selectedPages={initial.pages}/>);
 expect((screen.getByLabelText('批注内容') as HTMLTextAreaElement).value).toBe('保留我的草稿');expect(fetcher.mock.calls).toHaveLength(before);
});

it.each(['hash','pages'] as const)('aborts a pending save and drops its queue when selected %s changes with the same ID',async changed=>{
 const next={...initial,...(changed==='hash'?{sha256:'b'.repeat(64)}:{pages:4})};
 let current=initial;let finish!:(response:Response)=>void;let oldSignal:AbortSignal|null|undefined;
 const fetcher=vi.fn((path:RequestInfo|URL,init?:RequestInit)=>{
  if(String(path).includes('/page?'))return Promise.resolve(imageResponse(String(path),current.sha256,current.pages));
  if(String(path).endsWith('/annotations'))return Promise.resolve(json({documentId:id,sha256:current.sha256,revision:0,notes:[]}));
  if(init?.method==='PUT')return new Promise<Response>(resolve=>{finish=resolve;oldSignal=init.signal;});
  return Promise.resolve(json(current));
 });
 vi.stubGlobal('fetch',fetcher);
 const {rerender}=render(<PdfPageReader storeScope={scope} documentId={id} documentName="synthetic.pdf" selectedSha256={initial.sha256} selectedPages={initial.pages}/>);
 fireEvent.load(await screen.findByRole('img'));expect(writes(fetcher)).toHaveLength(1);
 fireEvent.click(screen.getByText('PDF 下一页'));fireEvent.load(await screen.findByRole('img'));expect(writes(fetcher)).toHaveLength(1);
 current=next;rerender(<PdfPageReader storeScope={scope} documentId={id} documentName="synthetic.pdf" selectedSha256={next.sha256} selectedPages={next.pages}/>);
 expect(oldSignal?.aborted).toBe(true);await screen.findByRole('img');
 await act(async()=>finish(json(initial)));
 expect(writes(fetcher)).toHaveLength(1);expect(screen.queryByText('阅读位置与书签已保存')).toBeNull();
 expect(screen.getByText(`第 1 / ${next.pages} 页 · 缩放 100%`)).toBeTruthy();expect(screen.getByText(`原件 SHA-256：${next.sha256}`)).toBeTruthy();
});

it('removes a valid reader and suppresses pending writes when selection becomes invalid',async()=>{
 let finish!:(response:Response)=>void;let oldSignal:AbortSignal|null|undefined;
 const {rerender,fetcher}=setup(initial,(_path,init)=>init?.method==='PUT'?new Promise(resolve=>{finish=resolve;oldSignal=init.signal;}):undefined);
 const image=await screen.findByRole('img');fireEvent.load(image);
 fireEvent.click(screen.getByText('PDF 下一页'));const queuedImage=await screen.findByRole('img');fireEvent.load(queuedImage);
 const requests=fetcher.mock.calls.length;
 rerender(<PdfPageReader storeScope={scope} documentId={id} documentName="synthetic.pdf" selectedSha256={initial.sha256} selectedPages={null}/>);
 await screen.findByText('所选 PDF 原件信息无效，请重新打开');expect(oldSignal?.aborted).toBe(true);
 expect(screen.queryByRole('img')).toBeNull();expect(screen.queryByRole('region',{name:'PDF 批注'})).toBeNull();
 fireEvent.load(image);fireEvent.load(queuedImage);await act(async()=>finish(json(initial)));
 expect(fetcher.mock.calls).toHaveLength(requests);expect(writes(fetcher)).toHaveLength(1);expect(screen.queryByText('阅读位置与书签已保存')).toBeNull();
});
