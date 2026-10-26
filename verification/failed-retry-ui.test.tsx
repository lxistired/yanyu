import {fixtureStoreHeaders, fixtureStoreUrl, fixtureStoreKey, FIXTURE_STORE_ID} from './transcription-store-fixture';
import {TranscriptionStoreBoundary} from '../candidate/src/components/TranscriptionStoreBoundary';
import {beforeEach,afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {FailedTranscriptionRetry, parseRetryCheck, parseRetryPost, type RetryOperations} from '../candidate/src/components/FailedTranscriptionRetry';
import {LocalTranscription} from '../candidate/src/components/LocalTranscription';
import {boundedTransport} from '../visual-harness/bounded-transport';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
const id='12345678-abcd-4abc-8abc-123456789abc', child='22345678-abcd-4abc-8abc-123456789abc';
const check={parentId:id,state:'uncommitted',reconciliationFinal:false,child:null,eligible:true};
const created={parentId:id,state:'created',reconciliationFinal:true,child:{id:child,status:'completed'},eligible:false};
const ok=(data:unknown,status=200)=>({headers:fixtureStoreHeaders(),ok:status<300,status,json:async()=>data});
const audio=()=>new File(['synthetic'], 'original.wav', {type:'audio/wav'});
const setup=(operations:RetryOperations=new Map(),onChanged=vi.fn())=>render(<TranscriptionStoreBoundary><FailedTranscriptionRetry id={id} language="en" maxBytes={1000} disabled={false} operations={operations} onChanged={onChanged}/></TranscriptionStoreBoundary>);
async function ready(selected=audio()){fireEvent.click(screen.getByText('核对重试资格与结果'));await screen.findByText(/可重新选择原文件/);fireEvent.change(screen.getByLabelText('为此失败任务重新选择原文件'),{target:{files:[selected]}});}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();history.replaceState(null,'','/');});
it('locks double clicks synchronously, binds exact parent and original language, and clears only its File',async()=>{
 let finish!:(value:unknown)=>void;const pending=new Promise(resolve=>finish=resolve);const f=vi.fn(async(_url:string,init?:RequestInit)=>init?.method==='POST'?pending:ok(check));vi.stubGlobal('fetch',f);const changed=vi.fn();setup(new Map(),changed);const selected=audio();await ready(selected);
 const button=screen.getByText('用原文件重试此失败任务');fireEvent.click(button);fireEvent.click(button);
 await waitFor(()=>expect(f.mock.calls.filter(([,i])=>i?.method==='POST')).toHaveLength(1));
 const [url,init]=f.mock.calls.find(([,i])=>i?.method==='POST')!;expect(url).toBe(`/api/local-asr/jobs/${id}/retry`);expect(Object.fromEntries(new Headers(init?.headers))).toEqual({'content-type':'audio/wav','x-audio-filename':'original.wav','x-audio-language':'en','x-transcription-store-id':FIXTURE_STORE_ID});expect(init?.body).toBe(selected);
 finish(ok({id:child,parentId:id,status:'processing',replayed:false},202));await screen.findByText('查看重试任务');expect(screen.queryByText(/待重新上传/)).toBeNull();expect(changed).toHaveBeenCalledOnce();
});
it('keeps ambiguous POST unknown across row remount, ignores sentinel errors, rechecks GET only',async()=>{
 let reconciled=false;const f=vi.fn(async(_url:string,init?:RequestInit)=>init?.method==='POST'?ok({error:{code:'UNAVAILABLE',message:'SENTINEL_PRIVATE_PATH'}},500):ok(reconciled?created:check));vi.stubGlobal('fetch',f);const operations:RetryOperations=new Map();const view=setup(operations);await ready();fireEvent.click(screen.getByText('用原文件重试此失败任务'));await screen.findByText('核对重试结果');expect(screen.queryByText(/SENTINEL/)).toBeNull();
 view.unmount();setup(operations);expect(screen.queryByText(/待重新上传/)).toBeNull();expect((screen.getByText('用原文件重试此失败任务') as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByText('核对重试结果'));await screen.findByText(/尚未确认结果/);expect(operations.get(fixtureStoreKey(id))?.phase).toBe('unknown');reconciled=true;fireEvent.click(screen.getByText('核对重试结果'));await screen.findByText('查看重试任务');expect(f.mock.calls.filter(([,i])=>i?.method==='POST')).toHaveLength(1);
});
it('discarded row preflight cannot POST or clear a new row file',async()=>{
 let finish!:(value:unknown)=>void;let gets=0;const f=vi.fn(async()=>++gets===1?ok(check):new Promise(resolve=>finish=resolve));vi.stubGlobal('fetch',f);const operations:RetryOperations=new Map();const changed=vi.fn();const view=setup(operations,changed);await ready();fireEvent.click(screen.getByText('用原文件重试此失败任务'));view.unmount();setup(operations,changed);finish(ok(check));await waitFor(()=>expect(operations.get(fixtureStoreKey(id))?.phase).toBe('blocked'));expect(f).toHaveBeenCalledTimes(2);expect(changed).not.toHaveBeenCalled();
});
it('late POST confirmation updates only parent operation, not discarded row callbacks',async()=>{
 let finish!:(value:unknown)=>void;const f=vi.fn(async(_url:string,init?:RequestInit)=>init?.method==='POST'?new Promise(resolve=>finish=resolve):ok(check));vi.stubGlobal('fetch',f);const operations:RetryOperations=new Map();const changed=vi.fn();const view=setup(operations,changed);await ready();fireEvent.click(screen.getByText('用原文件重试此失败任务'));await waitFor(()=>expect(finish).toBeTypeOf('function'));view.unmount();finish(ok({id:child,parentId:id,status:'completed',replayed:true}));await waitFor(()=>expect(operations.get(fixtureStoreKey(id))?.phase).toBe('confirmed'));expect(changed).not.toHaveBeenCalled();setup(operations);expect(screen.getByText('查看重试任务')).toBeTruthy();
});
it('rejects malformed parent, child, status, and reconciliation combinations',()=>{
 for(const data of [{...created,child:{id:child+'\n',status:'completed'}},{...created,parentId:child},{...created,child:{id,status:'completed'}},{...created,child:{id:child,status:'raw-secret'}},{...created,reconciliationFinal:false},{...check,reconciliationFinal:true},{...check,state:'pending'}])expect(()=>parseRetryCheck(data,id)).toThrow();
 for(const data of [{id:child+'\n',parentId:id,status:'processing',replayed:false},{id:child,parentId:child,status:'processing',replayed:false},{id:child,parentId:id,status:'completed',replayed:false},{id,parentId:id,status:'processing',replayed:false}])expect(()=>parseRetryPost(data,id,202)).toThrow();
 expect(()=>parseRetryPost({id:child,parentId:id,status:'processing',replayed:false},id,200)).toThrow();
});
it('legacy receipts and invalid limits never enable upload; raw server message stays hidden',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>ok({error:{code:'RECEIPT_UNAVAILABLE',message:'SENTINEL_SECRET'}},409)));const view=setup();fireEvent.click(screen.getByText('核对重试资格与结果'));await screen.findByText(/此旧任务没有可核验/);expect((screen.getByLabelText('为此失败任务重新选择原文件') as HTMLInputElement).disabled).toBe(true);expect(screen.queryByText(/SENTINEL/)).toBeNull();
 view.rerender(<TranscriptionStoreBoundary><FailedTranscriptionRetry id={id} language="en" maxBytes={NaN} disabled={false} operations={new Map()} onChanged={()=>{}}/></TranscriptionStoreBoundary>);expect((screen.getByText('核对重试资格与结果') as HTMLButtonElement).disabled).toBe(true);
});
it('preserves ordinary upload, rename/search drafts, filters and URL after explicit uncertain recovery',async()=>{
 history.replaceState(null,'',fixtureStoreUrl(`/?workspaceId=workspace&transcriptJob=${id}`));const before=location.href;
 const model={maxSeconds:60,maxBytes:1000,chunkSeconds:30,overlapSeconds:1,deadlineSeconds:120};
 const job={id,filename:'failed.wav',title:'Failed',library_revision:1,deleted_at:null,status:'failed',requested_language:'en',created:'2026-10-21',error:null,result:null};
 let posts=0;const f=vi.fn(async(url:string,init?:RequestInit)=>url.endsWith('/retry')?init?.method==='POST'?(++posts===1?ok({},500):ok({id:child,parentId:id,status:'completed',replayed:true})):ok(check):ok({jobs:[job],model,total:1,activeJobCount:0}));vi.stubGlobal('fetch',f);render(<LocalTranscription/>);await screen.findByText('Failed');
 fireEvent.change(screen.getByLabelText('选择音频文件'),{target:{files:[new File(['other'],'other.wav')]}});fireEvent.change(screen.getByLabelText('搜索转写'),{target:{value:'unsent search'}});fireEvent.click(screen.getByText('重命名'));fireEvent.change(screen.getByLabelText('转写标题'),{target:{value:'unsaved title'}});
 await ready();fireEvent.click(screen.getByText('用原文件重试此失败任务'));await screen.findByText('核对重试结果');fireEvent.click(screen.getByText('核对重试结果'));await screen.findByText('重新选择原文件以安全重试同一父任务');fireEvent.click(screen.getByText('重新选择原文件以安全重试同一父任务'));fireEvent.change(screen.getByLabelText('为此失败任务重新选择原文件'),{target:{files:[audio()]}});fireEvent.click(screen.getByText('用原文件重试此失败任务'));await screen.findByText('查看重试任务');expect(posts).toBe(2);expect(location.href).toBe(before);expect((screen.getByLabelText('搜索转写') as HTMLInputElement).value).toBe('unsent search');expect((screen.getByLabelText('转写标题') as HTMLInputElement).value).toBe('unsaved title');expect(screen.getByText(/待上传：other.wav/)).toBeTruthy();expect(f.mock.calls.some(([url])=>url==='/api/local-asr/transcribe')).toBe(false);
 vi.spyOn(window,'confirm').mockReturnValue(false);const event=new MouseEvent('click',{bubbles:true,cancelable:true});screen.getByText('查看重试任务').dispatchEvent(event);expect(event.defaultPrevented).toBe(true);
});
it('admits only exact UUID GET/POST retry paths with safe transport options',async()=>{
 const native=vi.fn(async()=>new Response('{}'));const transport=boundedTransport(new OrdinaryRequestLifetime(),native);const path=`/api/local-asr/jobs/${id}/retry`;
 for(const method of ['GET','POST']){await transport(path,{method,credentials:'include',redirect:'follow',cache:'reload'});expect(native.mock.calls.at(-1)?.[1]).toEqual({method,credentials:'same-origin',redirect:'error',cache:'no-store'});}
 native.mockClear();for(const variant of [path+'/',path+'?x=1',path+'#x',path+'\n',path.replace(id,id.toUpperCase()),path.replace(id,'not-a-uuid'),'https://example.test'+path,path.replace('/retry','/%72etry')])for(const method of ['GET','POST'])expect((await transport(variant,{method})).status).toBe(503);
 for(const method of ['PUT','DELETE','PATCH','HEAD'])expect((await transport(path,{method})).status).toBe(503);expect(native).not.toHaveBeenCalled();
});

it('accepted file discard invalidates a pending preflight and never submits captured bytes',async()=>{
 vi.spyOn(window,'confirm').mockReturnValue(true);let finish!:(value:unknown)=>void;let gets=0;const f=vi.fn(async()=>++gets===1?ok(check):new Promise(resolve=>finish=resolve));vi.stubGlobal('fetch',f);const operations:RetryOperations=new Map();setup(operations);await ready();fireEvent.click(screen.getByText('用原文件重试此失败任务'));fireEvent.click(screen.getByText('放弃所选重试文件'));await waitFor(()=>expect(screen.queryByText(/待重新上传/)).toBeNull());finish(ok(check));await screen.findByText(/任务状态已变化/);expect(f).toHaveBeenCalledTimes(2);expect(screen.queryByText(/待重新上传/)).toBeNull();
});

it('polling status change retains dirty failed row and disables retry instead of dropping its File',async()=>{
 let reads=0, finish!:(value:unknown)=>void;const model={maxSeconds:60,maxBytes:1000,chunkSeconds:30,overlapSeconds:1,deadlineSeconds:120};
 const list=(status:string)=>ok({jobs:[{id,filename:'failed.wav',status,requested_language:'en',created:'2026-10-21',error:null,result:null}],model,total:1,activeJobCount:0});
 const f=vi.fn(async(url:string,init?:RequestInit)=>url.endsWith('/retry')?ok(check):++reads===1?list('failed'):new Promise(resolve=>finish=resolve));vi.stubGlobal('fetch',f);
 render(<LocalTranscription/>);await screen.findByText('failed.wav');await ready();await waitFor(()=>expect(finish).toBeTypeOf('function'),{timeout:2000});finish(list('cancelled'));await screen.findByText(/此记录已不在最新结果中或状态已变化/);expect(screen.getByText(/待重新上传：original.wav/)).toBeTruthy();expect((screen.getByText('用原文件重试此失败任务') as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByText('用原文件重试此失败任务'));expect(f.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);
});

it('rejects newline-tainted parent IDs before any request',()=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);render(<TranscriptionStoreBoundary><FailedTranscriptionRetry id={id+'\n'} language="en" maxBytes={1000} disabled={false} operations={new Map()} onChanged={()=>{}}/></TranscriptionStoreBoundary>);fireEvent.click(screen.getByText('核对重试资格与结果'));expect(f).not.toHaveBeenCalled();expect((screen.getByText('核对重试资格与结果') as HTMLButtonElement).disabled).toBe(true);
});

it('never downgrades a confirmed child into upload eligibility after failed reconciliation',async()=>{
 let reads=0;const f=vi.fn(async()=>++reads===1?ok(created):reads===2?ok({error:{code:'UNAVAILABLE',message:'SENTINEL_PRIVATE'}},500):ok(check));vi.stubGlobal('fetch',f);const operations:RetryOperations=new Map();setup(operations);fireEvent.click(screen.getByText('核对重试资格与结果'));await screen.findByText('查看重试任务');fireEvent.click(screen.getByText('核对重试资格与结果'));await screen.findByText('核对重试结果');fireEvent.click(screen.getByText('核对重试结果'));await screen.findByText(/已有重试任务记录/);expect(operations.get(fixtureStoreKey(id))?.phase).toBe('unknown');expect((screen.getByText('用原文件重试此失败任务') as HTMLButtonElement).disabled).toBe(true);expect(screen.queryByText(/SENTINEL/)).toBeNull();expect(f).toHaveBeenCalledTimes(3);
});

beforeEach(() => { history.replaceState(null, '', fixtureStoreUrl()); });
