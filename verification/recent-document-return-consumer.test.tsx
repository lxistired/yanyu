import React,{StrictMode} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {LocalRecentMaterials} from '../candidate/src/components/LocalRecentMaterials';
// SOURCE-ONLY: synthetic DTO tests authored here have not been executed.
const scope='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const id=(n:number)=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
const document=(n:number)=>({id:id(n),name:`Return document ${n}`,format:'pdf',createdAt:'2026-10-22T00:00:00Z',trashedAt:null,stale:false,sha256:'a'.repeat(64),pages:1,revision:0,workspaceId:null,folderId:null});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'X-Transcription-Store-Id':scope}});
const listing=(offset:number,total=11,storeScope=scope)=>({storeScope,total,offset,limit:10,documents:Array.from({length:total},(_,i)=>document(i+1)).slice(offset,offset+10)});
type Call={url:URL;init:RequestInit};
function fixture(override?:(url:URL,init:RequestInit)=>Response|Promise<Response>|undefined){
 const calls:Call[]=[];
 const fetcher=vi.fn((input:string,init:RequestInit)=>{
  const url=new URL(input,location.href);calls.push({url,init});expect(init.method).toBe('GET');
  const changed=override?.(url,init);if(changed)return Promise.resolve(changed);
  if(url.pathname==='/api/documents/choices')return Promise.resolve(json({uploadScope:scope}));
  if(url.pathname==='/api/documents')return Promise.resolve(json(listing(Number(url.searchParams.get('offset')))));
  if(url.pathname.startsWith('/api/documents/'))return Promise.resolve(json({storeScope:scope,document:document(Number(url.pathname.slice(-12))),text:'fresh synthetic extraction'}));
  if(url.pathname==='/api/local-asr/identity')return Promise.resolve(json({transcriptionStoreId:scope}));
  if(url.pathname==='/api/local-asr/jobs')return Promise.resolve(json({jobs:[],total:0,offset:0,limit:10,hasMore:false}));
  throw Error('Unadmitted synthetic request');
 });vi.stubGlobal('fetch',fetcher);
 return {calls,lists:()=>calls.filter(c=>c.url.pathname==='/api/documents'),choices:()=>calls.filter(c=>c.url.pathname==='/api/documents/choices')};
}
const restored=()=>({documentStoreId:scope,offset:10});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('does not read any returned page until fresh choices confirm the remembered store',async()=>{
 let resolve!:(value:Response)=>void;const f=fixture(url=>url.pathname==='/api/documents/choices'?new Promise(done=>{resolve=done;}):undefined);
 render(<LocalRecentMaterials initialDocumentReturn={restored()}/>);await waitFor(()=>expect(resolve).toBeTruthy());
 expect(f.lists()).toHaveLength(0);expect(screen.queryByText('Return document 11')).toBeNull();
 await act(async()=>resolve(json({uploadScope:scope})));await screen.findByText('Return document 11');
 expect(f.lists()[0].url.searchParams.get('offset')).toBe('10');expect(f.lists()[0].init.headers).toEqual({'X-Document-Store-Id':scope});
});
it.each([other,undefined,null,'invalid',scope+'\n'])('blocks mismatched or invalid discovery %s until explicit reload',async discovered=>{
 let store:unknown=discovered;const f=fixture(url=>url.pathname==='/api/documents/choices'?json({uploadScope:store}):url.pathname==='/api/documents'?json(listing(Number(url.searchParams.get('offset')),11,String(store))):undefined);
 render(<LocalRecentMaterials initialDocumentReturn={restored()}/>);await screen.findByText(/文档来源已变化/);
 expect(f.lists()).toHaveLength(0);expect((screen.getByText('刷新文档记录') as HTMLButtonElement).disabled).toBe(true);expect(screen.queryByText('重试文档记录')).toBeNull();
 fireEvent.click(screen.getByText('刷新文档记录'));expect(f.choices()).toHaveLength(1);expect(f.lists()).toHaveLength(0);
 store=other;fireEvent.click(screen.getByText('重新载入文档来源'));await screen.findByText('Return document 1');
 expect(f.choices()).toHaveLength(2);expect(f.lists()[0].url.searchParams.get('offset')).toBe('0');expect(f.lists()[0].init.headers).toEqual({'X-Document-Store-Id':other});
});
it('malformed returned discovery JSON requires explicit source reload',async()=>{
 const f=fixture(url=>url.pathname==='/api/documents/choices'?new Response('{bad json'):undefined);
 render(<LocalRecentMaterials initialDocumentReturn={restored()}/>);await screen.findByText(/文档来源已变化/);expect(f.lists()).toHaveLength(0);expect(screen.queryByText('重试文档记录')).toBeNull();
});
it('a transient choices error retries with the same expected store, not automatic substitution',async()=>{
 let fail=true;const f=fixture(url=>url.pathname==='/api/documents/choices'?fail?json({},503):json({uploadScope:other}):undefined);
 render(<LocalRecentMaterials initialDocumentReturn={restored()}/>);await screen.findByText(/503/);expect(f.lists()).toHaveLength(0);
 fail=false;fireEvent.click(screen.getByText('重试文档记录'));await screen.findByText(/文档来源已变化/);expect(f.lists()).toHaveLength(0);
});
it('explicit reload fences a late ignored-abort choices JSON result',async()=>{
 let resolveLate!:(value:unknown)=>void,first=true;const f=fixture(url=>{
  if(url.pathname==='/api/documents/choices'&&first){first=false;return {ok:true,status:200,json:()=>new Promise(resolve=>{resolveLate=resolve;})} as Response;}
  if(url.pathname==='/api/documents/choices')return json({uploadScope:other});
  if(url.pathname==='/api/documents')return json(listing(Number(url.searchParams.get('offset')),11,other));
 });
 render(<LocalRecentMaterials initialDocumentReturn={restored()}/>);await waitFor(()=>expect(resolveLate).toBeTruthy());
 fireEvent.click(screen.getByText('重新载入文档来源'));await screen.findByText('Return document 1');
 await act(async()=>resolveLate({uploadScope:scope}));expect(f.lists()).toHaveLength(1);expect(f.lists()[0].init.headers).toEqual({'X-Document-Store-Id':other});expect(screen.queryByText(/文档来源已变化/)).toBeNull();
});
it('unmounting before late discovery never starts the restored list request',async()=>{
 let resolveLate!:(value:unknown)=>void;const f=fixture(url=>url.pathname==='/api/documents/choices'?{ok:true,status:200,json:()=>new Promise(resolve=>{resolveLate=resolve;})} as Response:undefined);
 const view=render(<LocalRecentMaterials initialDocumentReturn={restored()}/>);await waitFor(()=>expect(resolveLate).toBeTruthy());view.unmount();
 await act(async()=>resolveLate({uploadScope:scope}));expect(f.lists()).toHaveLength(0);expect(f.choices()[0].init.signal?.aborted).toBe(true);
});
it('fresh returned totals recover a shrunken page without changing the verified source',async()=>{
 const f=fixture(url=>url.pathname==='/api/documents'?json(listing(Number(url.searchParams.get('offset')),1)):undefined);
 render(<LocalRecentMaterials initialDocumentReturn={restored()}/>);await screen.findByText('Return document 1');
 expect(f.lists().map(c=>c.url.searchParams.get('offset'))).toEqual(['10','0']);expect(f.choices()).toHaveLength(1);
 expect(within(screen.getByRole('navigation',{name:'文档入库分页'})).getByText(/第 1 页/)).toBeTruthy();
});
it('StrictMode and inline preview Close retain only the committed document page',async()=>{
 const f=fixture(),open=vi.fn();render(<StrictMode><LocalRecentMaterials initialDocumentReturn={restored()} onOpenPdf={open}/></StrictMode>);
 await screen.findByText('Return document 11');fireEvent.click(screen.getByText('查看提取文字：Return document 11'));await screen.findByText('fresh synthetic extraction');
 fireEvent.click(screen.getByText('关闭文字预览'));expect(screen.getByText('Return document 11')).toBeTruthy();expect(open).not.toHaveBeenCalled();
 fireEvent.click(screen.getByText('打开 PDF：Return document 11'));expect(open).toHaveBeenCalledTimes(1);expect(open.mock.calls[0][1]).toEqual(restored());expect(Object.isFrozen(open.mock.calls[0][0])).toBe(true);
 expect(f.lists().every(c=>c.url.searchParams.get('offset')==='10')).toBe(true);
});
