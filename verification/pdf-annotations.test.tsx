import {imageResponse,installPdfCrypto} from './pdf-image-fixture';
import React from 'react';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {PdfPageReader} from '../candidate/src/components/PdfPageReader';
const scope='44444444-4444-4444-8444-444444444444';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',noteId='33333333-3333-4333-8333-333333333333';
const hash='a'.repeat(64),now='2026-10-15T00:00:00.000Z';
const reader={page:1,bookmark:null,scale:100,pages:3,sha256:hash};
const empty={documentId:id,sha256:hash,revision:0,notes:[] as any[]};
const note={id:noteId,page:2,rect:null,comment:'初始批注',createdAt:now,updatedAt:now};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(status<300?{storeScope:scope,...(value as object)}:value),{status,headers:{'Content-Type':'application/json'}});
const deferred=()=>{let resolve!:(value:Response)=>void;const promise=new Promise<Response>(done=>resolve=done);return {promise,resolve};};
type Extra=(path:string,init?:RequestInit)=>Promise<Response>|undefined;
function setup(initial=empty,extra?:Extra) {
 let stored=structuredClone(initial);
 const fetcher=vi.fn((input:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(input);if(path.includes('/page?'))return Promise.resolve(imageResponse(path,hash,reader.pages));const custom=extra?.(path,init);if(custom)return custom;
  if(path.endsWith('/reader'))return Promise.resolve(json(init?.method==='PUT'?{...reader,...JSON.parse(init.body as string)}:reader));
  if(init?.method==='POST'||init?.method==='PUT') {
   const {sha256,revision,...body}=JSON.parse(init.body as string);
   stored={...stored,revision:stored.revision+1,notes:init.method==='POST'?[...stored.notes,{...body,id:noteId,createdAt:now,updatedAt:now}]:stored.notes.map(n=>n.id===noteId?{...n,...body,updatedAt:now}:n)};
  }
  return Promise.resolve(json(stored));
 });
 vi.stubGlobal('fetch',fetcher);
 return {...render(<PdfPageReader storeScope={scope} selectedSha256={hash} selectedPages={reader.pages} documentId={id} documentName="synthetic.pdf"/>),fetcher,stored:()=>stored};
}
const writes=(fetcher:ReturnType<typeof setup>['fetcher'])=>fetcher.mock.calls.filter(([path,init])=>String(path).includes('/annotations')&&['POST','PUT'].includes(init?.method??''));
async function ready(){await screen.findByText('尚无批注');fireEvent.load(await screen.findByRole('img'));}
async function createDraft(comment='用户批注'){fireEvent.click(screen.getByText('新增当前页批注'));fireEvent.change(screen.getByLabelText('批注内容'),{target:{value:comment}});}
beforeEach(()=>installPdfCrypto());
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

it('creates a page note, persists exact revision/hash, reopens it and renders hostile Unicode text literally',async()=>{
 const {fetcher,unmount,container}=setup();await ready();const comment='研究 🧪 <img src=x onerror=alert(1)>\n中文 & <script>bad()</script>';
 await createDraft(comment);fireEvent.click(screen.getByText('保存批注'));await screen.findByText('批注已保存');
 expect(JSON.parse(writes(fetcher)[0][1]!.body as string)).toEqual({sha256:hash,revision:0,page:1,rect:null,comment});
 expect(container.querySelectorAll('img')).toHaveLength(1);expect(container.querySelector('script,iframe,object,embed')).toBeNull();
 expect(container.querySelector('.pdf-annotation-comment')?.textContent).toBe(comment);
 unmount();render(<PdfPageReader storeScope={scope} selectedSha256={hash} selectedPages={reader.pages} documentId={id} documentName="synthetic.pdf"/>);await screen.findByText('页面批注（1 / 250）');expect(document.querySelector('.pdf-annotation-comment')?.textContent).toBe(comment);
});

it('reads and jumps to an existing note, edits it using PUT and retains its page across navigation',async()=>{
 const {fetcher}=setup({...empty,revision:4,notes:[note]});await screen.findByText('初始批注');
 fireEvent.click(screen.getByText('查看第 2 页批注'));expect(screen.getByText('第 2 / 3 页 · 缩放 100%')).toBeTruthy();
 fireEvent.click(screen.getByText('编辑批注'));fireEvent.change(screen.getByLabelText('批注内容'),{target:{value:'已修改'}});
 fireEvent.click(screen.getByText('PDF 下一页'));expect(screen.getByText('草稿仍属于第 2 页。')).toBeTruthy();fireEvent.click(screen.getByText('保存批注'));await screen.findByText('批注已保存');
 expect(writes(fetcher)[0][0]).toBe(`/api/documents/${id}/annotations/${noteId}`);expect(writes(fetcher)[0][1]?.method).toBe('PUT');
 expect(JSON.parse(writes(fetcher)[0][1]!.body as string)).toEqual({sha256:hash,revision:4,page:2,rect:null,comment:'已修改'});expect(screen.getByText('第 3 / 3 页 · 缩放 100%')).toBeTruthy();
});

it('draws reverse-direction normalized rectangles and preserves them at every zoom',async()=>{
 // jsdom lacks PointerEvent; MouseEvent provides the coordinates used by the UI.
 vi.stubGlobal('PointerEvent',MouseEvent);
 const {fetcher,container}=setup();await ready();fireEvent.click(screen.getByText('框选区域批注'));
 const layer=screen.getByRole('region',{name:'在页面图片上拖动框选批注区域'});
 vi.spyOn(layer,'getBoundingClientRect').mockReturnValue({left:100,top:50,width:1000,height:2000,right:1100,bottom:2050,x:100,y:50,toJSON:()=>({})});
 fireEvent.pointerDown(layer,{clientX:600,clientY:1050,button:0});fireEvent.pointerMove(layer,{clientX:300,clientY:450});fireEvent.pointerUp(layer,{clientX:300,clientY:450});
 fireEvent.change(screen.getByLabelText('批注内容'),{target:{value:'区域'}});fireEvent.click(screen.getByText('保存批注'));await screen.findByText('批注已保存');
 expect(JSON.parse(writes(fetcher)[0][1]!.body as string).rect).toEqual({x:.2,y:.2,width:.3,height:.3});
 for(const scale of ['75','150','100']) {fireEvent.change(screen.getByLabelText('PDF 缩放'),{target:{value:scale}});fireEvent.load(await screen.findByRole('img'));await waitFor(()=>expect(container.querySelector('.pdf-annotation-rect')?.getAttribute('style')).toBe('left: 20%; top: 20%; width: 30%; height: 30%;'));}
 expect(writes(fetcher)).toHaveLength(1);
});

it('rejects tiny rectangles and cancels an in-progress gesture on navigation without losing text',async()=>{
 vi.stubGlobal('PointerEvent',MouseEvent);setup();await ready();fireEvent.click(screen.getByText('框选区域批注'));
 const layer=screen.getByRole('region',{name:'在页面图片上拖动框选批注区域'});
 vi.spyOn(layer,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:1000,height:1000,right:1000,bottom:1000,x:0,y:0,toJSON:()=>({})});
 fireEvent.pointerDown(layer,{clientX:10,clientY:10,button:0});fireEvent.pointerUp(layer,{clientX:11,clientY:11});await screen.findByText(/框选范围太小/);
 fireEvent.change(screen.getByLabelText('批注内容'),{target:{value:'保留文字'}});fireEvent.pointerDown(layer,{clientX:10,clientY:10,button:0});fireEvent.click(screen.getByText('PDF 下一页'));fireEvent.pointerUp(layer,{clientX:700,clientY:700});
 expect((screen.getByLabelText('批注内容') as HTMLTextAreaElement).value).toBe('保留文字');expect(screen.queryByLabelText('当前草稿的批注区域')).toBeNull();expect(screen.getByText('草稿仍属于第 1 页。')).toBeTruthy();
});

it('enforces UTF-8 byte limits and nonempty content before any request',async()=>{
 const {fetcher}=setup();await ready();await createDraft(' ');expect((screen.getByText('保存批注') as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('批注内容'),{target:{value:'🧪'.repeat(1025)}});expect(screen.getByText('4100 / 4096 UTF-8 字节')).toBeTruthy();expect((screen.getByText('保存批注') as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('批注内容'),{target:{value:'\u0000bad'}});expect((screen.getByText('保存批注') as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('批注内容'),{target:{value:'🧪'.repeat(1024)}});fireEvent.click(screen.getByText('保存批注'));await screen.findByText('批注已保存');expect(writes(fetcher)).toHaveLength(1);
});

it('prevents duplicate saves, keeps the draft fixed during an in-flight request, and does not rewind newer navigation',async()=>{
 const pending=deferred();const {fetcher}=setup(empty,(_path,init)=>init?.method==='POST'?pending.promise:undefined);await ready();await createDraft();
 const save=screen.getByText('保存批注');fireEvent.click(save);fireEvent.click(save);expect(writes(fetcher)).toHaveLength(1);expect((screen.getByLabelText('批注内容') as HTMLTextAreaElement).disabled).toBe(true);
 fireEvent.click(screen.getByText('PDF 下一页'));await act(async()=>pending.resolve(json({...empty,revision:1,notes:[{...note,page:1,comment:'用户批注'}]})));await screen.findByText('批注已保存');expect(screen.getByText('第 2 / 3 页 · 缩放 100%')).toBeTruthy();
});

it('keeps a conflicting draft, requires explicit reload, then requires reviewed confirmation with the new revision',async()=>{
 let conflict=true;const fresh={...empty,revision:7,notes:[{...note,comment:'另一个窗口更新'}]};
 const {fetcher}=setup({...empty,revision:4,notes:[note]},(path,init)=>{
  if(init?.method==='PUT'&&path.includes('/annotations')&&conflict)return Promise.resolve(json({error:{message:'Conflict'}},409));
  if(path.endsWith('/annotations')&&!init?.method&&!conflict)return Promise.resolve(json(fresh));
  if(init?.method==='PUT'&&path.includes('/annotations')&&!conflict)return Promise.resolve(json({...fresh,revision:8,notes:[{...note,comment:'我的草稿'}]}));
 });
 await screen.findByText('初始批注');fireEvent.click(screen.getByText('编辑批注'));fireEvent.change(screen.getByLabelText('批注内容'),{target:{value:'我的草稿'}});fireEvent.click(screen.getByText('保存批注'));
 await screen.findByText(/批注已在其他位置更新/);expect((screen.getByLabelText('批注内容') as HTMLTextAreaElement).value).toBe('我的草稿');expect((screen.getByText('保存批注') as HTMLButtonElement).disabled).toBe(true);expect(writes(fetcher)).toHaveLength(1);
 conflict=false;fireEvent.click(screen.getByText('重新载入最新批注'));await screen.findByText('另一个窗口更新');expect(writes(fetcher)).toHaveLength(1);
 fireEvent.click(screen.getByText('确认保存草稿'));await screen.findByText('批注已保存');expect(JSON.parse(writes(fetcher)[1][1]!.body as string).revision).toBe(7);
});

it('reconciles a committed create after a lost response so an explicit retry edits instead of duplicating',async()=>{
 let committed=false;const saved={...empty,revision:1,notes:[{...note,page:1,comment:'用户批注'}]};
 const {fetcher}=setup(empty,(path,init)=>{
  if(init?.method==='POST'){committed=true;return Promise.reject(Error('Network lost'));}
  if(path.endsWith('/annotations')&&!init?.method&&committed)return Promise.resolve(json(saved));
  if(init?.method==='PUT'&&path.includes('/annotations'))return Promise.resolve(json({...saved,revision:2}));
 });await ready();await createDraft();fireEvent.click(screen.getByText('保存批注'));await screen.findByText(/Network lost/);
 expect((screen.getByText('保存批注') as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByText('重新载入最新批注'));await screen.findByText(/发现与提交内容一致/);
 fireEvent.click(screen.getByText('确认保存草稿'));await screen.findByText('批注已保存');expect(writes(fetcher).map(([,init])=>init?.method)).toEqual(['POST','PUT']);
});

it('retains drafts on load errors and recovers without falsely claiming a save',async()=>{
 let fail=false;setup(empty,(path,init)=>path.endsWith('/annotations')&&!init?.method&&fail?Promise.resolve(json({error:{message:'Disk unavailable'}},503)):undefined);await ready();await createDraft('保留');fail=true;
 fireEvent.click(screen.getByText('重新载入最新批注'));await screen.findByText('Disk unavailable');expect((screen.getByLabelText('批注内容') as HTMLTextAreaElement).value).toBe('保留');expect(screen.queryByText('批注已保存')).toBeNull();
 fail=false;fireEvent.click(screen.getByText('重新载入最新批注'));await screen.findByText(/批注已重新载入/);expect((screen.getByLabelText('批注内容') as HTMLTextAreaElement).value).toBe('保留');
});

it('aborts and ignores annotation reads after switching documents',async()=>{
 const pending=deferred();let signal:AbortSignal|null|undefined;
 const {rerender}=setup(empty,(path,init)=>path===`/api/documents/${id}/annotations`?(signal=init?.signal,pending.promise):path===`/api/documents/${other}/annotations`?Promise.resolve(json({...empty,documentId:other})):undefined);
 await screen.findByText('正在载入批注…');rerender(<PdfPageReader storeScope={scope} selectedSha256={hash} selectedPages={reader.pages} documentId={other} documentName="other.pdf"/>);await screen.findByText('尚无批注');expect(signal?.aborted).toBe(true);
 await act(async()=>pending.resolve(json({...empty,notes:[note]})));expect(screen.queryByText('初始批注')).toBeNull();
});

it('aborts a pending annotation write on close and discards its late result',async()=>{
 const pending=deferred();let signal:AbortSignal|null|undefined;
 const {unmount}=setup(empty,(_path,init)=>init?.method==='POST'?(signal=init.signal,pending.promise):undefined);await ready();await createDraft();fireEvent.click(screen.getByText('保存批注'));unmount();expect(signal?.aborted).toBe(true);
 await act(async()=>pending.resolve(json({...empty,revision:1,notes:[note]})));expect(screen.queryByText('批注已保存')).toBeNull();
});

it.each([{...empty,sha256:'b'.repeat(64)},{...empty,documentId:other},{...empty,revision:-1},{...empty,notes:[{...note,page:4}]},{...empty,notes:[{...note,rect:{x:.9,y:0,width:.2,height:.2}}]},{...empty,notes:[note,note]}])('rejects malformed or cross-document annotations before enabling writes: %j',async bad=>{
 setup(bad);await screen.findByText(/批注数据无效/);expect((screen.getByText('新增当前页批注') as HTMLButtonElement).disabled).toBe(true);
});

it('rejects inconsistent successful save responses and retains a reload-only draft',async()=>{
 setup(empty,(_path,init)=>init?.method==='POST'?Promise.resolve(json({...empty,revision:1,notes:[{...note,comment:'wrong'}]})):undefined);await ready();await createDraft();fireEvent.click(screen.getByText('保存批注'));await screen.findByText(/批注保存结果不一致/);expect((screen.getByLabelText('批注内容') as HTMLTextAreaElement).value).toBe('用户批注');expect((screen.getByText('保存批注') as HTMLButtonElement).disabled).toBe(true);expect(screen.queryByText('批注已保存')).toBeNull();
});

it('enforces the 250-note create bound while allowing edits',async()=>{
 const notes=Array.from({length:250},(_,i)=>({...note,id:`${String(i).padStart(8,'0')}-3333-4333-8333-333333333333`}));setup({...empty,notes});await screen.findByText('页面批注（250 / 250）');expect((screen.getByText('新增当前页批注') as HTMLButtonElement).disabled).toBe(true);expect((screen.getAllByText('编辑批注')[0] as HTMLButtonElement).disabled).toBe(false);
});

it('requires review when a manual refresh finds a newer revision during editing',async()=>{
 let refreshed=false;
 setup({...empty,revision:1,notes:[note]},(path,init)=>path.endsWith('/annotations')&&!init?.method&&refreshed?Promise.resolve(json({...empty,revision:2,notes:[{...note,comment:'最新版本'}]})):undefined);
 await screen.findByText('初始批注');fireEvent.click(screen.getByText('编辑批注'));fireEvent.change(screen.getByLabelText('批注内容'),{target:{value:'当前草稿'}});refreshed=true;
 fireEvent.click(screen.getByText('重新载入最新批注'));await screen.findByText('最新版本');expect(screen.getByText('确认保存草稿')).toBeTruthy();expect((screen.getByLabelText('批注内容') as HTMLTextAreaElement).value).toBe('当前草稿');expect(screen.queryByText('保存批注')).toBeNull();
});

it('does not unlock a conflicting draft when the explicit reload fails',async()=>{
 let reload=false;const {fetcher}=setup(empty,(path,init)=>init?.method==='POST'?Promise.resolve(json({error:{message:'Conflict'}},409)):path.endsWith('/annotations')&&!init?.method&&reload?Promise.resolve(json({error:{message:'Reload unavailable'}},503)):undefined);
 await ready();await createDraft();fireEvent.click(screen.getByText('保存批注'));await screen.findByText(/批注已在其他位置更新/);reload=true;fireEvent.click(screen.getByText('重新载入最新批注'));await screen.findByText(/Reload unavailable/);
 expect((screen.getByText('保存批注') as HTMLButtonElement).disabled).toBe(true);expect((screen.getByLabelText('批注内容') as HTMLTextAreaElement).value).toBe('用户批注');expect(writes(fetcher)).toHaveLength(1);
});
