import React from 'react';
import {afterEach,it,expect,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
// Diagnostic only. Real shell, research list, receiver and native jsdom History.
// PDF display and transport are synthetic; this is not browser/device acceptance.
vi.mock('../candidate/src/components/PdfPageReader',()=>({PdfPageReader:(p:any)=><div data-testid="selected-pdf" data-id={p.documentId}/>}));
const scope='10000000-0000-4000-8000-000000000001';
const record=(n:number)=>({id:`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`,revision:0,trashedAt:null,name:`needle-${n}.pdf`,format:'pdf',bytes:1,sha256:'a'.repeat(64),textSha256:'b'.repeat(64),createdAt:'2026-10-22',pages:1,workspaceId:null,folderId:null,workspaceName:null,folderName:null,stale:false});
const json=(data:unknown)=>new Response(JSON.stringify(data));
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();history.replaceState(null,'','/');});
it.each(['retained','store-changed','identity-changed'] as const)('search -> page 2 -> PDF -> accepted Back: %s',async scenario=>{
 let liveScope=scope;
 const lists:{query:string|null;offset:number}[]=[];
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
  const url=new URL(String(input),location.href);
  if(url.pathname==='/api/documents/choices')return json({uploadScope:liveScope,workspaces:[],folders:[]});
  if(url.pathname==='/api/documents'){
   const offset=Number(url.searchParams.get('offset'));lists.push({query:url.searchParams.get('q'),offset});
   return json({storeScope:liveScope,documents:Array.from({length:11},(_,i)=>record(i+1)).slice(offset,offset+10),total:11,offset,limit:10});
  }
  if(url.pathname===`/api/documents/${record(11).id}`)return json({storeScope:scope,document:record(11),text:'needle synthetic PDF'});
  throw Error(`Unexpected diagnostic request ${url}`);
 }));
 history.replaceState(null,'','/?page=research');
 const lifetime=new OrdinaryRequestLifetime();
 const view=render(<OrdinaryNavigationShell lifetime={lifetime} identityScope="original"/>);
 const search=await screen.findByRole('region',{name:'本地文档搜索'});
 await within(search).findByText('needle-1.pdf');
 fireEvent.change(screen.getByLabelText('文档查询'),{target:{value:'needle'}});
 fireEvent.click(screen.getByRole('button',{name:'搜索文档'}));
 await within(search).findByText(/查询：needle/);
 fireEvent.click(within(search).getByRole('button',{name:'下一页'}));
 await within(search).findByText('第 2 页');
 // Only the committed query is a return preference, not a newer unsent search draft.
 fireEvent.change(screen.getByLabelText('文档查询'),{target:{value:'unsent draft'}});
 fireEvent.click(within(search).getByRole('button',{name:'打开 PDF：needle-11.pdf'}));
 expect((await screen.findByTestId('selected-pdf')).dataset.id).toBe(record(11).id);
 if(scenario==='retained'){
  const confirmation=vi.spyOn(window,'confirm').mockReturnValue(false);
  fireEvent.change(screen.getByLabelText('新文件夹名称'),{target:{value:'keep until accepted'}});
  await act(async()=>{history.back();await new Promise(resolve=>setTimeout(resolve,100));});
  expect(location.search).toBe('?page=documents');
  expect((screen.getByLabelText('新文件夹名称') as HTMLInputElement).value).toBe('keep until accepted');
  expect(confirmation).toHaveBeenCalled();
  confirmation.mockReturnValue(true);
 }
 if(scenario==='store-changed')liveScope='30000000-0000-4000-8000-000000000003';
 if(scenario==='identity-changed')view.rerender(<OrdinaryNavigationShell lifetime={lifetime} identityScope="replacement"/>);
 const beforeReturn=lists.length;
 await act(async()=>{history.back();await new Promise(resolve=>setTimeout(resolve,80));});
 await waitFor(()=>expect(location.search).toBe('?page=research'));
 if(scenario==='store-changed'){
  await screen.findByText('文档来源已变化，请明确重新载入来源后再搜索');
  expect(lists).toHaveLength(beforeReturn);
  expect(screen.queryByRole('button',{name:/打开 PDF：/})).toBeNull();
  return;
 }
 await screen.findByText(/文档匹配：11 条/);
 if(scenario==='identity-changed'){
  expect((screen.getByLabelText('文档查询') as HTMLInputElement).value).toBe('');
  expect(lists.at(-1)).toEqual({query:'',offset:0});
  return;
 }
 console.log('OBSERVED_RETURN',JSON.stringify({draft:(screen.getByLabelText('文档查询') as HTMLInputElement).value,lastList:lists.at(-1)}));
 expect((screen.getByLabelText('文档查询') as HTMLInputElement).value).toBe('needle');
 expect(lists.at(-1)).toEqual({query:'needle',offset:10});
 // The consumed preference cannot resurrect on a second Forward/Back traversal.
 await act(async()=>{history.forward();await new Promise(resolve=>setTimeout(resolve,80));});
 await screen.findByText('本地研究文档');
 expect(screen.queryByTestId('selected-pdf')).toBeNull();
 await act(async()=>{history.back();await new Promise(resolve=>setTimeout(resolve,80));});
 await screen.findByText(/文档匹配：11 条/);
 expect((screen.getByLabelText('文档查询') as HTMLInputElement).value).toBe('');
 expect(lists.at(-1)).toEqual({query:'',offset:0});
});
