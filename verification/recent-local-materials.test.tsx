import React from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {LocalRecentMaterials} from '../candidate/src/components/LocalRecentMaterials';
const scope='11111111-1111-4111-8111-111111111111';
const otherScope='22222222-2222-4222-8222-222222222222';
const id=(n:number)=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
const doc=(n:number)=>({id:id(n),name:`Document ${n}`,format:'txt',createdAt:'2026-01-01T00:00:00Z',trashedAt:null});
const job=(n:number)=>({id:id(n),title:`Transcript ${n}`,filename:`source-${n}.wav`,status:'completed',created:'2026-01-01T00:00:00Z',deleted_at:null,result:null});
const docs=(offset=0,total=11,storeScope=scope)=>({storeScope,total,offset,limit:10,documents:Array.from({length:Math.min(10,Math.max(0,total-offset))},(_,n)=>doc(n+offset+1))});
const jobs=(offset=0,total=11)=>({total,offset,limit:10,hasMore:offset+10<total,jobs:Array.from({length:Math.min(10,Math.max(0,total-offset))},(_,n)=>job(n+offset+1))});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'X-Transcription-Store-Id':scope}});
function fixture(override?:(url:URL,init:RequestInit)=>Response|Promise<Response>|undefined) {
 const calls:{url:URL;init:RequestInit}[]=[];
 vi.stubGlobal('fetch',vi.fn((input:string,init:RequestInit)=>{
  const url=new URL(input,'http://localhost'); calls.push({url,init});
  const result=override?.(url,init);if(result!==undefined)return Promise.resolve(result);
  if(url.pathname==='/api/local-asr/identity') {expect(init.method).toBe('GET');expect(url.search).toBe('');expect(init.headers).toBeUndefined();return Promise.resolve(json({transcriptionStoreId:scope}));}
  if(url.pathname==='/api/documents/choices')return Promise.resolve(json({uploadScope:scope}));
  const offset=Number(url.searchParams.get('offset')||0);
  if(url.pathname==='/api/documents')return Promise.resolve(json(docs(offset)));
  if(url.pathname==='/api/local-asr/jobs') {const result=jobs(offset);const selected=url.searchParams.get('statuses')?.split(',');if(selected)result.jobs=result.jobs.map(item=>({...item,status:selected[0]}));return Promise.resolve(json(result));}
  if(url.pathname.startsWith('/api/documents/'))return Promise.resolve(json({storeScope:scope,document:doc(Number(url.pathname.slice(-12))),text:'Exact synthetic document text'}));
  throw Error('Unadmitted synthetic request');
 }));return calls;
}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('uses only active empty-query GET sources and keeps pagination/refresh independent',async()=>{
 const calls=fixture();render(<LocalRecentMaterials/>);
 await screen.findByText('Document 1');await screen.findByText('Transcript 1');
 fireEvent.click(within(screen.getByRole('navigation',{name:'文档入库分页'})).getByText('下一页'));
 await screen.findByText('Document 11');expect(screen.getByText('Transcript 1')).toBeTruthy();
 const transcriptRequests=calls.filter(c=>c.url.pathname==='/api/local-asr/jobs').length;
 fireEvent.click(screen.getByText('刷新文档记录'));await screen.findByText('Document 11');
 expect(calls.filter(c=>c.url.pathname==='/api/local-asr/jobs')).toHaveLength(transcriptRequests);
 const transcriptCalls=calls.filter(c=>c.url.pathname.startsWith('/api/local-asr/'));
 expect(transcriptCalls[0].url.pathname).toBe('/api/local-asr/identity');
 expect(transcriptCalls.filter(c=>c.url.pathname==='/api/local-asr/identity')).toHaveLength(1);
 for(const {url,init} of calls) {
  expect(init.method).toBe('GET');
  if(url.pathname==='/api/documents') {expect(url.searchParams.get('q')).toBe('');expect(url.searchParams.get('view')).toBe('active');expect(init.headers).toEqual({'X-Document-Store-Id':scope});}
  if(url.pathname==='/api/local-asr/jobs') {expect(url.searchParams.get('q')).toBe('');expect(url.searchParams.get('scope')).toBe('active');expect(init.headers).toEqual({'X-Transcription-Store-Id':scope});}
 }
});
it('opens exact document text with captured scope and forwards exact transcript to guarded shell callback only',async()=>{
 const calls=fixture(), navigate=vi.fn();render(<LocalRecentMaterials onNavigate={navigate}/>);
 fireEvent.click(await screen.findByText('查看提取文字：Document 1'));
 await screen.findByText('Exact synthetic document text');
 expect(calls.find(c=>c.url.pathname===`/api/documents/${id(1)}`)?.init.headers).toEqual({'X-Citation-Store-Id':scope});
 const previous=location.href;fireEvent.click(await screen.findByText('打开转写记录：Transcript 1'));
 expect(navigate).toHaveBeenCalledTimes(1);const target=new URL(navigate.mock.calls[0][0],location.href);
 expect(target.searchParams.get('transcriptStoreId')).toBe(scope);expect(target.searchParams.get('page')).toBe('files');expect(target.searchParams.get('transcriptJob')).toBe(id(1));expect(location.href).toBe(previous);
});
it('rejects wrong-ID text without displaying payload',async()=>{
 fixture(url=>url.pathname===`/api/documents/${id(1)}`?json({storeScope:scope,document:doc(2),text:'WRONG RECORD'}):undefined);
 render(<LocalRecentMaterials/>);fireEvent.click(await screen.findByText('查看提取文字：Document 1'));
 await screen.findByText(/缺失或已删除的文档不会替换/);expect(screen.queryByText('WRONG RECORD')).toBeNull();
});
it('blocks document source substitution until explicit reload and preserves transcript page',async()=>{
 let changed=false;
 const calls=fixture(url=>url.pathname==='/api/documents'?json(docs(Number(url.searchParams.get('offset')),11,changed?otherScope:scope)):url.pathname==='/api/documents/choices'?json({uploadScope:changed?otherScope:scope}):undefined);
 render(<LocalRecentMaterials/>);await screen.findByText('Document 1');await screen.findByText('Transcript 1');
 fireEvent.click(within(screen.getByRole('navigation',{name:'转写记录分页'})).getByText('下一页'));await screen.findByText('Transcript 11');
 changed=true;fireEvent.click(screen.getByText('刷新文档记录'));await screen.findByText(/文档来源已变化/);
 expect((screen.getByText('刷新文档记录') as HTMLButtonElement).disabled).toBe(true);expect(screen.getByText('Transcript 11')).toBeTruthy();
 expect(calls.filter(c=>c.url.pathname==='/api/documents/choices')).toHaveLength(1);
 fireEvent.click(screen.getByText('重新载入文档来源'));await screen.findByText('Document 1');
 expect(calls.filter(c=>c.url.pathname==='/api/documents/choices')).toHaveLength(2);expect(screen.getByText('Transcript 11')).toBeTruthy();
});
it('late ignored-abort JSON cannot overwrite reload, and unmount aborts pending detail',async()=>{
 let resolveLate!:(value:unknown)=>void, first=true;
 let detailSignal:AbortSignal|undefined;
 fixture((url,init)=>{
  if(url.pathname==='/api/documents'&&first) {first=false;return {ok:true,status:200,json:()=>new Promise(resolve=>{resolveLate=resolve;})} as Response;}
  if(url.pathname===`/api/documents/${id(1)}`) {detailSignal=init.signal as AbortSignal;return new Promise(()=>{});}
 });
 const view=render(<LocalRecentMaterials/>);await waitFor(()=>expect(resolveLate).toBeTruthy());
 fireEvent.click(screen.getByText('重新载入文档来源'));await screen.findByText('Document 1');
 await act(async()=>{resolveLate(docs(0,0));});expect(screen.getByText('Document 1')).toBeTruthy();
 fireEvent.click(screen.getByText('查看提取文字：Document 1'));await waitFor(()=>expect(detailSignal).toBeTruthy());view.unmount();expect(detailSignal?.aborted).toBe(true);
});
it('isolates source errors and retries; empty means only that source',async()=>{
 let fail=true;fixture(url=>url.pathname==='/api/local-asr/jobs'?json(fail?{}:jobs(0,0),fail?503:200):url.pathname==='/api/documents'?json(docs(0,0)):undefined);
 render(<LocalRecentMaterials/>);await screen.findByText('暂无未删除的本地文档。');await screen.findByText(/503/);
 expect(screen.queryByText('暂无未删除的本地转写记录。')).toBeNull();fail=false;fireEvent.click(screen.getByText('重试转写记录'));await screen.findByText('暂无未删除的本地转写记录。');
});
it('recovers shrinking source page without changing other source',async()=>{
 let total=11;fixture(url=>url.pathname==='/api/documents'?json(docs(Number(url.searchParams.get('offset')),total)):undefined);
 render(<LocalRecentMaterials/>);await screen.findByText('Document 1');
 fireEvent.click(within(screen.getByRole('navigation',{name:'文档入库分页'})).getByText('下一页'));await screen.findByText('Document 11');
 total=1;fireEvent.click(screen.getByText('刷新文档记录'));await screen.findByText('Document 1');expect(screen.getByText('Transcript 1')).toBeTruthy();
 expect(within(screen.getByRole('navigation',{name:'文档入库分页'})).getByText(/第 1 页/)).toBeTruthy();
});
it('suppresses late JSON failure after explicit reload and shows bounded transcript disclosure',async()=>{
 let rejectLate!:(reason:Error)=>void, first=true;
 fixture(url=>{
  if(url.pathname==='/api/documents'&&first) {first=false;return {ok:true,status:200,json:()=>new Promise((_resolve,reject)=>{rejectLate=reject;})} as Response;}
  if(url.pathname==='/api/local-asr/jobs')return json(jobs(0,1020));
 });
 render(<LocalRecentMaterials/>);await waitFor(()=>expect(rejectLate).toBeTruthy());
 fireEvent.click(screen.getByText('重新载入文档来源'));await screen.findByText('Document 1');
 await act(async()=>{rejectLate(Error('STALE JSON FAILURE'));});expect(screen.queryByText('STALE JSON FAILURE')).toBeNull();
 expect(screen.getByText(/此页最多浏览该来源前 1010 条/)).toBeTruthy();expect(screen.getByText(/记录及固定链接绑定首次读取/)).toBeTruthy();
});
it('missing document returns unavailable without replacing it or disturbing transcript records',async()=>{
 fixture(url=>url.pathname===`/api/documents/${id(1)}`?json({},404):undefined);
 render(<LocalRecentMaterials/>);fireEvent.click(await screen.findByText('查看提取文字：Document 1'));
 await screen.findByText(/404/);expect(screen.queryByRole('article',{name:'近期文档提取文字'})).toBeNull();expect(screen.getByText('Transcript 1')).toBeTruthy();
});
it('late detail JSON rejection cannot replace a newer selected document',async()=>{
 let rejectLate!:(reason:Error)=>void;
 fixture(url=>url.pathname===`/api/documents/${id(1)}`?{ok:true,status:200,json:()=>new Promise((_resolve,reject)=>{rejectLate=reject;})} as Response:undefined);
 render(<LocalRecentMaterials/>);fireEvent.click(await screen.findByText('查看提取文字：Document 1'));
 await waitFor(()=>expect(rejectLate).toBeTruthy());fireEvent.click(screen.getByText('查看提取文字：Document 2'));await screen.findByText('Exact synthetic document text');
 await act(async()=>{rejectLate(Error('STALE DETAIL ERROR'));});expect(screen.queryByText(/STALE DETAIL ERROR/)).toBeNull();
 expect(within(screen.getByRole('article',{name:'近期文档提取文字'})).getByText(`文档 ID：${id(2)}`)).toBeTruthy();
});
it('detail HTTP 409 blocks documents until explicit reload without affecting transcripts',async()=>{
 fixture(url=>url.pathname===`/api/documents/${id(1)}`?json({},409):undefined);
 render(<LocalRecentMaterials/>);fireEvent.click(await screen.findByText('查看提取文字：Document 1'));
 await screen.findByText(/文档来源已变化/);expect((screen.getByText('刷新文档记录') as HTMLButtonElement).disabled).toBe(true);
 expect(screen.queryByText('查看提取文字：Document 1')).toBeNull();expect(screen.getByText('Transcript 1')).toBeTruthy();
 fireEvent.click(screen.getByText('重新载入文档来源'));await screen.findByText('查看提取文字：Document 1');
});
it('never requests transcript offsets above 1000 even when more rows exist',async()=>{
 const calls=fixture(url=>url.pathname==='/api/local-asr/jobs'?json(jobs(Number(url.searchParams.get('offset')),1020)):undefined);
 render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');
 for(let offset=10;offset<=1000;offset+=10) {
  fireEvent.click(within(screen.getByRole('navigation',{name:'转写记录分页'})).getByText('下一页'));
  await screen.findByText(`Transcript ${offset+1}`);
 }
 const next=within(screen.getByRole('navigation',{name:'转写记录分页'})).getByText('下一页') as HTMLButtonElement;
 expect(next.disabled).toBe(true);fireEvent.click(next);
 expect(Math.max(...calls.filter(c=>c.url.pathname==='/api/local-asr/jobs').map(c=>Number(c.url.searchParams.get('offset'))))).toBe(1000);
 expect(screen.getByText('Document 1')).toBeTruthy();
});
it.each(['success','error'] as const)('StrictMode replay suppresses obsolete choices JSON %s',async outcome=>{
 let settle!:(value?:unknown)=>void, first=true;
 const signals:AbortSignal[]=[];
 fixture((url,init)=>{
  if(url.pathname==='/api/documents/choices') {
   signals.push(init.signal as AbortSignal);
   if(first) {first=false;return {ok:true,status:200,json:()=>new Promise((resolve,reject)=>{settle=value=>outcome==='success'?resolve(value):reject(Error('OBSOLETE STRICT ERROR'));})} as Response;}
  }
  return undefined;
 });
 const view=render(<React.StrictMode><LocalRecentMaterials/></React.StrictMode>);
 await screen.findByText('Document 1');await screen.findByText('Transcript 1');
 expect(signals.length).toBeGreaterThanOrEqual(2);expect(signals[0].aborted).toBe(true);
 await act(async()=>{settle({uploadScope:otherScope});});
 expect(screen.getByText('Document 1')).toBeTruthy();expect(screen.queryByText(/OBSOLETE STRICT ERROR/)).toBeNull();expect(screen.queryByText(/文档来源已变化/)).toBeNull();
 view.unmount();expect(signals.every(signal=>signal.aborted)).toBe(true);
});

function statusDialog() {fireEvent.click(screen.getByRole('button',{name:/转写状态筛选/}));return within(screen.getByRole('dialog',{name:'筛选近期转写状态'}));}
const transcriptReads=(calls:{url:URL;init:RequestInit}[])=>calls.filter(call=>call.url.pathname==='/api/local-asr/jobs');
it('stages multi-status choices without reads; confirm filters only transcripts and resets their page',async()=>{
 const calls=fixture();render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');await screen.findByText('Document 1');
 fireEvent.click(within(screen.getByRole('navigation',{name:'文档入库分页'})).getByText('下一页'));await screen.findByText('Document 11');
 fireEvent.click(within(screen.getByRole('navigation',{name:'转写记录分页'})).getByText('下一页'));await screen.findByText('Transcript 11');
 const before=calls.length, dialog=statusDialog();fireEvent.click(dialog.getByLabelText('转写失败'));fireEvent.click(dialog.getByLabelText('转写完成'));
 expect(calls).toHaveLength(before);expect((dialog.getByLabelText('全部状态') as HTMLInputElement).checked).toBe(false);
 fireEvent.click(dialog.getByText('确认筛选'));await screen.findByText('Transcript 1');
 expect(screen.getByText('Document 11')).toBeTruthy();expect(calls).toHaveLength(before+1);
 const last=transcriptReads(calls).at(-1)!;expect(last.url.searchParams.get('statuses')).toBe('completed,failed');expect(last.url.searchParams.get('offset')).toBe('0');expect(last.init.headers).toEqual({'X-Transcription-Store-Id':scope});
 fireEvent.click(within(screen.getByRole('navigation',{name:'转写记录分页'})).getByText('下一页'));await screen.findByText('Transcript 11');
 expect(transcriptReads(calls).at(-1)!.url.searchParams.get('statuses')).toBe('completed,failed');
 fireEvent.click(screen.getByText('刷新转写记录'));await screen.findByText('Transcript 11');expect(transcriptReads(calls).at(-1)!.url.searchParams.get('statuses')).toBe('completed,failed');
});
it('cancel, Escape, outside and reset stay draft-only; last deselection restores All and no-op preserves page',async()=>{
 const calls=fixture();render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');
 fireEvent.click(within(screen.getByRole('navigation',{name:'转写记录分页'})).getByText('下一页'));await screen.findByText('Transcript 11');const before=calls.length;
 let dialog=statusDialog();fireEvent.click(dialog.getByLabelText('转写失败'));fireEvent.click(dialog.getByText('取消筛选'));
 dialog=statusDialog();expect((dialog.getByLabelText('全部状态') as HTMLInputElement).checked).toBe(true);fireEvent.click(dialog.getByLabelText('识别中'));fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});
 dialog=statusDialog();fireEvent.click(dialog.getByLabelText('转写完成'));fireEvent.pointerDown(document.body);
 dialog=statusDialog();fireEvent.click(dialog.getByLabelText('转写失败'));fireEvent.click(dialog.getByText('重置'));expect((dialog.getByLabelText('全部状态') as HTMLInputElement).checked).toBe(true);
 fireEvent.click(dialog.getByLabelText('转写失败'));fireEvent.click(dialog.getByLabelText('转写失败'));expect((dialog.getByLabelText('全部状态') as HTMLInputElement).checked).toBe(true);fireEvent.click(dialog.getByText('确认筛选'));
 expect(calls).toHaveLength(before);expect(screen.getByText('Transcript 11')).toBeTruthy();
});
it('reports filtered empty separately and explicit source reload retains the committed selection',async()=>{
 const calls=fixture(url=>url.pathname==='/api/local-asr/jobs'&&url.searchParams.has('statuses')?json(jobs(0,0)):undefined);
 render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');let dialog=statusDialog();fireEvent.click(dialog.getByLabelText('转写失败'));fireEvent.click(dialog.getByText('确认筛选'));
 await screen.findByText('没有匹配所选状态的本地转写记录。');expect(screen.queryByText('暂无未删除的本地转写记录。')).toBeNull();
 fireEvent.click(screen.getByText('重新载入转写来源'));await screen.findByText('没有匹配所选状态的本地转写记录。');expect(transcriptReads(calls).at(-1)!.url.searchParams.get('statuses')).toBe('failed');
 dialog=statusDialog();fireEvent.click(dialog.getByLabelText('全部状态'));fireEvent.click(dialog.getByText('确认筛选'));await screen.findByText('Transcript 1');expect(transcriptReads(calls).at(-1)!.url.searchParams.has('statuses')).toBe(false);
});
for(const late of ['success','failure'] as const)it(`fences late ${late} JSON after a new committed filter`,async()=>{
 let resolveLate!:(value:unknown)=>void,rejectLate!:(reason:Error)=>void;
 fixture(url=>url.pathname==='/api/local-asr/jobs'&&url.searchParams.get('statuses')==='failed'?{ok:true,status:200,headers:new Headers({'X-Transcription-Store-Id':scope}),json:()=>new Promise((resolve,reject)=>{resolveLate=resolve;rejectLate=reject;})} as Response:undefined);
 const navigate=vi.fn();render(<LocalRecentMaterials onNavigate={navigate}/>);await screen.findByText('Transcript 1');
 let dialog=statusDialog();fireEvent.click(dialog.getByLabelText('转写失败'));fireEvent.click(dialog.getByText('确认筛选'));await waitFor(()=>expect(resolveLate).toBeTruthy());
 dialog=statusDialog();fireEvent.click(dialog.getByLabelText('全部状态'));fireEvent.click(dialog.getByLabelText('转写完成'));fireEvent.click(dialog.getByText('确认筛选'));await screen.findByText('Transcript 1');
 await act(async()=>{if(late==='success')resolveLate(jobs(0,0));else rejectLate(Error('STALE FILTER FAILURE'));});
 expect(screen.getByText('Transcript 1')).toBeTruthy();expect(screen.queryByText('STALE FILTER FAILURE')).toBeNull();
 fireEvent.click(screen.getByText('打开转写记录：Transcript 1'));expect(navigate).toHaveBeenCalledTimes(1);expect(new URL(navigate.mock.calls[0][0],location.href).searchParams.get('transcriptJob')).toBe(id(1));
});
it('synchronously invalidates old row selection when filter confirmation precedes the React commit',async()=>{
 fixture();const navigate=vi.fn();render(<LocalRecentMaterials onNavigate={navigate}/>);const old=await screen.findByText('打开转写记录：Transcript 1');
 const dialog=statusDialog();fireEvent.click(dialog.getByLabelText('转写失败'));const confirm=dialog.getByText('确认筛选');
 // Native clicks in one act batch exercise a still-mounted old row before React flushes.
 act(()=>{confirm.click();old.click();});expect(navigate).not.toHaveBeenCalled();
 await screen.findByText('Transcript 1');fireEvent.click(screen.getByText('打开转写记录：Transcript 1'));expect(navigate).toHaveBeenCalledTimes(1);
});

it('rejects mismatched filter rows without presenting them as successful results',async()=>{
 fixture(url=>url.pathname==='/api/local-asr/jobs'&&url.searchParams.get('statuses')==='failed'?json(jobs(0,1)):undefined);render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');
 const dialog=statusDialog();fireEvent.click(dialog.getByLabelText('转写失败'));fireEvent.click(dialog.getByText('确认筛选'));await screen.findByText('本地转写来源返回了不匹配所选状态的记录，请重试');expect(screen.queryByText('Transcript 1')).toBeNull();expect(screen.getByText('Document 1')).toBeTruthy();
});
it('normalizes selection order for no-op Confirm and keeps source failure blocked across filter changes',async()=>{
 let changed=false;const calls=fixture(url=>url.pathname==='/api/local-asr/jobs'&&changed?new Response(JSON.stringify(jobs()),{headers:{'X-Transcription-Store-Id':otherScope}}):undefined);
 render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');let dialog=statusDialog();fireEvent.click(dialog.getByLabelText('转写失败'));fireEvent.click(dialog.getByLabelText('转写完成'));fireEvent.click(dialog.getByText('确认筛选'));await screen.findByText('Transcript 1');
 fireEvent.click(within(screen.getByRole('navigation',{name:'转写记录分页'})).getByText('下一页'));await screen.findByText('Transcript 11');const count=calls.length;
 dialog=statusDialog();fireEvent.click(dialog.getByLabelText('转写完成'));fireEvent.click(dialog.getByLabelText('转写完成'));fireEvent.click(dialog.getByText('确认筛选'));expect(calls).toHaveLength(count);expect(screen.getByText('Transcript 11')).toBeTruthy();
 changed=true;fireEvent.click(screen.getByText('刷新转写记录'));await waitFor(()=>expect((screen.getByText('刷新转写记录') as HTMLButtonElement).disabled).toBe(true));const failedCount=calls.length;
 dialog=statusDialog();fireEvent.click(dialog.getByLabelText('全部状态'));fireEvent.click(dialog.getByText('确认筛选'));await screen.findByText('转写来源无法核验或已变化，请明确重新载入转写来源。');expect(calls).toHaveLength(failedCount);expect(screen.queryByText('Transcript 1')).toBeNull();
 expect(calls.filter(c=>c.url.pathname==='/api/local-asr/identity')).toHaveLength(1);
});
it('Reset from committed status stays draft-only until Confirm clears query and page',async()=>{
 const calls=fixture();render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');let dialog=statusDialog();fireEvent.click(dialog.getByLabelText('转写失败'));fireEvent.click(dialog.getByText('确认筛选'));await screen.findByText('Transcript 1');
 fireEvent.click(within(screen.getByRole('navigation',{name:'转写记录分页'})).getByText('下一页'));await screen.findByText('Transcript 11');const count=calls.length;
 dialog=statusDialog();fireEvent.click(dialog.getByText('重置'));expect(calls).toHaveLength(count);expect(screen.getByText('Transcript 11')).toBeTruthy();fireEvent.click(dialog.getByText('取消筛选'));
 dialog=statusDialog();expect((dialog.getByLabelText('转写失败') as HTMLInputElement).checked).toBe(true);fireEvent.click(dialog.getByText('重置'));fireEvent.click(dialog.getByText('确认筛选'));await screen.findByText('Transcript 1');expect(transcriptReads(calls).at(-1)!.url.searchParams.has('statuses')).toBe(false);expect(transcriptReads(calls).at(-1)!.url.searchParams.get('offset')).toBe('0');
});
it('ignores a superseded fetch response with changed source and 409 before reading its headers',async()=>{
 let resolveLate!:(value:Response)=>void;
 const calls=fixture(url=>url.pathname==='/api/local-asr/jobs'&&url.searchParams.get('statuses')==='failed'?new Promise(resolve=>{resolveLate=resolve;}):undefined);
 render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');let dialog=statusDialog();fireEvent.click(dialog.getByLabelText('转写失败'));fireEvent.click(dialog.getByText('确认筛选'));await waitFor(()=>expect(resolveLate).toBeTruthy());
 dialog=statusDialog();fireEvent.click(dialog.getByLabelText('全部状态'));fireEvent.click(dialog.getByText('确认筛选'));await screen.findByText('Transcript 1');
 await act(async()=>resolveLate(new Response('{}',{status:409,headers:{'X-Transcription-Store-Id':otherScope}})));
 expect((screen.getByText('刷新转写记录') as HTMLButtonElement).disabled).toBe(false);fireEvent.click(screen.getByText('刷新转写记录'));await screen.findByText('Transcript 1');expect(calls.filter(c=>c.url.pathname==='/api/local-asr/identity')).toHaveLength(1);
});
