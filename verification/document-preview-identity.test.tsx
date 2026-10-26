import {imageResponse} from './pdf-image-fixture';
import React from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {webcrypto} from 'node:crypto';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {LocalDocuments} from '../candidate/src/components/LocalDocuments';
const id='20000000-0000-4000-8000-000000000002',other='30000000-0000-4000-8000-000000000003',scope='10000000-0000-4000-8000-000000000001';
const record={id,revision:4,trashedAt:null,name:'synthetic.md',format:'md',bytes:1,sha256:'a'.repeat(64),textSha256:'b'.repeat(64),createdAt:'2026-10-21',pages:null,workspaceId:null,folderId:null,workspaceName:null,folderName:null,stale:false};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const payload=(document:unknown=record,text:unknown='synthetic text')=>({storeScope:scope,document,text});
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject};}
function setup(detail:(init?:RequestInit)=>Promise<Response>,format='md'){
 const fetcher=vi.fn((input:RequestInfo|URL,init?:RequestInit)=>{const p=String(input);
  if(p==='/api/documents/choices')return Promise.resolve(json({uploadScope:scope,workspaces:[],folders:[]}));
  if(p.startsWith('/api/documents?'))return Promise.resolve(json({storeScope:scope,documents:[{...record,format,pages:format==='pdf'?1:record.pages}],total:1,offset:0,limit:10}));
  if(p===`/api/documents/${id}`)return detail(init);
  if(p.endsWith('/citations'))return Promise.resolve(json({storeScope:scope,citations:[]}));
  if(p.endsWith('/annotations'))return Promise.resolve(json({storeScope:scope,documentId:id,sha256:record.sha256,revision:0,notes:[]}));
  if(format==='pdf'&&p===`/api/documents/${id}/page?page=1&scale=100&storeScope=${scope}`)return Promise.resolve(imageResponse(p,record.sha256,1,scope));
  if(p.endsWith('/reader'))return Promise.resolve(json({storeScope:scope,page:1,bookmark:null,scale:100,pages:1,sha256:record.sha256}));
  throw Error('Unexpected synthetic request '+p);
 });vi.stubGlobal('fetch',fetcher);return {...render(<LocalDocuments/>),fetcher};
}
async function open(){fireEvent.click(await screen.findByRole('button',{name:'预览纯文本',exact:true}));}
async function released(){await waitFor(()=>expect((screen.getByRole('button',{name:'预览纯文本',exact:true}) as HTMLButtonElement).disabled).toBe(false));}
function dismiss(){act(()=>{history.replaceState(null,'','/#dismissed');window.dispatchEvent(new Event('hashchange'));});}
beforeEach(()=>{history.replaceState(null,'','/');localStorage.clear();sessionStorage.clear();vi.stubGlobal('crypto',webcrypto);vi.spyOn(window,'confirm').mockReturnValue(true);});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear();sessionStorage.clear();history.replaceState(null,'','/');});
it('rejects same-scope document substitution before citation mount, releases lock and permits exact-ID retry',async()=>{
 let first=true;const {fetcher}=setup(()=>Promise.resolve(json(first?payload({...record,id:other,name:'wrong.md'},'WRONG SOURCE'):payload())));
 await open();await screen.findByText('文档预览响应无效，请刷新文档列表后重新打开预览');await released();
 expect(screen.queryByRole('region',{name:'文档纯文本预览'})).toBeNull();expect(screen.queryByText('WRONG SOURCE')).toBeNull();expect(fetcher.mock.calls.some(([p])=>String(p).endsWith('/citations'))).toBe(false);
 first=false;await open();await screen.findByRole('region',{name:'文档纯文本预览'});await waitFor(()=>expect(fetcher.mock.calls.some(([p])=>p===`/api/documents/${id}/citations`)).toBe(true));
 expect(fetcher.mock.calls.some(([p])=>p===`/api/documents/${other}/citations`)).toBe(false);
});
it.each([
 ['null envelope',null],['array envelope',[]],['missing scope',{document:record,text:'x'}],['other scope',{...payload(),storeScope:other}],
 ['missing document',{storeScope:scope,text:'x'}],['null document',payload(null)],['array document',payload([])],['missing ID',payload({...record,id:undefined})],['nonstring text',payload(record,17)],['missing text',{storeScope:scope,document:record}],
])('rejects %s without a preview or citations',async(_label,data)=>{const {fetcher}=setup(()=>Promise.resolve(json(data)));await open();await screen.findByRole('alert');await released();expect(screen.queryByRole('region',{name:'文档纯文本预览'})).toBeNull();expect(fetcher.mock.calls.some(([p])=>String(p).endsWith('/citations'))).toBe(false);});
it.each(['txt','md','pdf'])('preserves %s literal-text preview and full metadata',async format=>{
 const text='<script>synthetic only</script>';const {container,fetcher}=setup(()=>Promise.resolve(json(payload({...record,format},text))),format);await open();await screen.findByRole('region',{name:'文档纯文本预览'});expect(container.querySelector('pre')?.textContent).toBe(text);expect(container.querySelector('script,iframe,object')).toBeNull();expect(screen.getByText(/原件 SHA-256/).textContent).toContain(record.sha256);expect(fetcher.mock.calls.some(([p])=>String(p).endsWith('/reader'))).toBe(false);
});
it('preserves empty text preview',async()=>{setup(()=>Promise.resolve(json(payload(record,''))));await open();await screen.findByText(/未提取到可检索文字/);});
it.each(['success','wrong ID','wrong scope','HTTP404','HTTP409','network','invalid JSON'])('suppresses late %s after accepted mounted history dismissal',async kind=>{
 const pending=deferred<Response>();const {fetcher}=setup(()=>pending.promise);await open();dismiss();
 await act(async()=>{if(kind==='network')pending.reject(Error('STALE NETWORK'));else if(kind==='invalid JSON')pending.resolve(new Response('{'));else if(kind.startsWith('HTTP'))pending.resolve(json({error:{message:'STALE HTTP'}},Number(kind.slice(4))));else pending.resolve(json(kind==='wrong ID'?payload({...record,id:other}):kind==='wrong scope'?{...payload(),storeScope:other}:payload()));});
 await released();expect(screen.queryByRole('region',{name:'文档纯文本预览'})).toBeNull();expect(screen.queryByRole('alert')).toBeNull();expect(fetcher.mock.calls.some(([p])=>String(p).endsWith('/citations'))).toBe(false);
});
it.each(['valid','wrong ID','malformed','reject'])('suppresses deferred JSON %s after dismissal',async kind=>{
 const body=deferred<unknown>();let decoding=false;setup(()=>Promise.resolve({ok:true,json:()=>{decoding=true;return body.promise;}} as Response));await open();await waitFor(()=>expect(decoding).toBe(true));dismiss();
 await act(async()=>{if(kind==='reject')body.reject(Error('STALE JSON'));else body.resolve(kind==='valid'?payload():kind==='wrong ID'?payload({...record,id:other}):null);});await released();expect(screen.queryByRole('region',{name:'文档纯文本预览'})).toBeNull();expect(screen.queryByRole('alert')).toBeNull();
});
it('aborts on unmount and discards ignored-abort late JSON',async()=>{
 const body=deferred<unknown>();let signal:AbortSignal|null|undefined,decoding=false;const {unmount}=setup(init=>{signal=init?.signal;return Promise.resolve({ok:true,json:()=>{decoding=true;return body.promise;}} as Response);});await open();await waitFor(()=>expect(decoding).toBe(true));unmount();expect(signal?.aborted).toBe(true);await act(async()=>body.resolve(payload()));expect(screen.queryByRole('region',{name:'文档纯文本预览'})).toBeNull();
});
it('deduplicates clicks and pins request header to visible scope',async()=>{
 const pending=deferred<Response>();const {fetcher}=setup(()=>pending.promise);await open();fireEvent.click(screen.getByRole('button',{name:'预览纯文本',exact:true}));const calls=fetcher.mock.calls.filter(([p])=>p===`/api/documents/${id}`);expect(calls).toHaveLength(1);expect(new Headers(calls[0][1]?.headers).get('X-Citation-Store-Id')).toBe(scope);await act(async()=>pending.resolve(json(payload())));await released();
});
it('declined unsaved metadata abandonment retains raw draft and never requests preview',async()=>{
 const {fetcher}=setup(()=>Promise.resolve(json(payload())));fireEvent.click(await screen.findByText('编辑名称与归属'));fireEvent.change(screen.getByLabelText('显示名称'),{target:{value:' raw changed '}});vi.mocked(window.confirm).mockReturnValue(false);await open();expect((screen.getByLabelText('显示名称') as HTMLInputElement).value).toBe(' raw changed ');expect(fetcher.mock.calls.some(([p])=>p===`/api/documents/${id}`)).toBe(false);
});
it('PDF page action stays separate and text preview still switches away from reader',async()=>{
 const {fetcher}=setup(()=>Promise.resolve(json(payload({...record,format:'pdf',pages:1}))),'pdf');fireEvent.click(await screen.findByText('阅读 PDF 页面'));const image=await screen.findByRole('img');expect(image.getAttribute('src')).toMatch(/^data:image\/png;base64,/);expect(image.getAttribute('data-source-url')).toBe(`/api/documents/${id}/page?page=1&scale=100&storeScope=${scope}`);const pageCall=fetcher.mock.calls.find(([p])=>p===image.getAttribute('data-source-url'))!;expect(new Headers(pageCall[1]?.headers).get('X-Document-Store-Id')).toBe(scope);await waitFor(()=>expect(fetcher.mock.calls.some(([p])=>String(p).endsWith('/annotations'))).toBe(true));expect(screen.queryByRole('alert')).toBeNull();expect(fetcher.mock.calls.some(([p])=>p===`/api/documents/${id}`)).toBe(false);await open();await screen.findByRole('region',{name:'文档纯文本预览'});expect(screen.queryByRole('region',{name:'PDF 页面阅读器'})).toBeNull();
});
