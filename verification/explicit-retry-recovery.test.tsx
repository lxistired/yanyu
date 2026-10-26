import {fixtureStoreHeaders, fixtureStoreUrl, fixtureStoreKey} from './transcription-store-fixture';
import {TranscriptionStoreBoundary} from '../candidate/src/components/TranscriptionStoreBoundary';
import {beforeEach,afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {FailedTranscriptionRetry, type RetryOperations} from '../candidate/src/components/FailedTranscriptionRetry';
const id='12345678-abcd-4abc-8abc-123456789abc', child='22345678-abcd-4abc-8abc-123456789abc';
const eligible={parentId:id,state:'uncommitted',reconciliationFinal:false,child:null,eligible:true};
const created={parentId:id,state:'created',reconciliationFinal:true,child:{id:child,status:'completed'},eligible:false};
const ok=(data:unknown,status=200)=>({headers:fixtureStoreHeaders(),ok:status<300,status,json:async()=>data});
const postResult=()=>ok({parentId:id,id:child,status:'completed',replayed:true});
const audio=()=>new File(['synthetic'], 'original.wav', {type:'audio/wav'});
function deferred(){let resolve!:(value:any)=>void;const promise=new Promise(r=>resolve=r);return {resolve,promise};}
const setup=(operations:RetryOperations=new Map(),changed=vi.fn())=>render(<TranscriptionStoreBoundary><FailedTranscriptionRetry id={id} language="en" maxBytes={1000} disabled={false} operations={operations} onChanged={changed}/></TranscriptionStoreBoundary>);
const select=(file=audio())=>fireEvent.change(screen.getByLabelText('为此失败任务重新选择原文件'),{target:{files:[file]}});
const submit=()=>fireEvent.click(screen.getByText('用原文件重试此失败任务'));
const recheck=()=>fireEvent.click(screen.getByText('核对重试结果'));
async function begin(){fireEvent.click(screen.getByText('核对重试资格与结果'));await screen.findByText(/可重新选择原文件/);select();submit();await screen.findByText('核对重试结果');}
async function recover(){recheck();await screen.findByText('重新选择原文件以安全重试同一父任务');fireEvent.click(screen.getByText('重新选择原文件以安全重试同一父任务'));}
const unknown=():RetryOperations=>new Map([[fixtureStoreKey(id),{phase:'unknown',generation:1,uncertain:true}]]);
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('requires fresh selection and separate explicit submit, same parent and one locked manual POST',async()=>{
 const second=deferred();let posts=0;const f=vi.fn(async(_url:string,init?:RequestInit)=>init?.method==='POST'?++posts===1?ok({},500):second.promise:ok(eligible));vi.stubGlobal('fetch',f);const ops:RetryOperations=new Map();setup(ops);await begin();expect(screen.queryByText(/待重新上传/)).toBeNull();await recover();expect(posts).toBe(1);expect((screen.getByText('用原文件重试此失败任务') as HTMLButtonElement).disabled).toBe(true);
 const fresh=audio();select(fresh);expect(posts).toBe(1);submit();submit();await waitFor(()=>expect(posts).toBe(2));const calls=f.mock.calls.filter(([,init])=>init?.method==='POST');expect(calls.every(([url])=>url===`/api/local-asr/jobs/${id}/retry`)).toBe(true);expect(calls[1][1]?.body).toBe(fresh);second.resolve(postResult());await screen.findByText('查看重试任务');expect(ops.get(fixtureStoreKey(id))?.child?.id).toBe(child);
});
it('old server commit observed in fresh preflight confirms existing child without manual POST',async()=>{
 const freshCheck=deferred();let gets=0;const f=vi.fn(async()=>++gets===1?ok(eligible):freshCheck.promise);vi.stubGlobal('fetch',f);setup(unknown());await recover();select();submit();await waitFor(()=>expect(gets).toBe(2));freshCheck.resolve(ok(created));await screen.findByText('查看重试任务');expect(f.mock.calls.every(call=>call.length===1 || (call as any)[1]?.method!=='POST')).toBe(true);
});
it('commit racing after GET reuses same child through manual replay response',async()=>{
 // Model an old server operation continuing after the client received an unknown result.
 // Backend uniqueness/hash behavior is covered separately; this asserts UI request identity.
 const oldServer=deferred(), manualResponse=deferred();let serverChild:string|null=null, posts=0;
 const oldCommit=oldServer.promise.then(()=>{serverChild=child;});
 const f=vi.fn(async(_url:string,init?:RequestInit)=>{if(init?.method==='POST'){posts++;if(posts===1)return ok({},500);await manualResponse.promise;return ok({parentId:id,id:serverChild,status:'completed',replayed:true});}return ok(eligible);});
 vi.stubGlobal('fetch',f);const ops:RetryOperations=new Map();setup(ops);await begin();await recover();select();submit();await waitFor(()=>expect(posts).toBe(2));oldServer.resolve(null);await oldCommit;manualResponse.resolve(null);await screen.findByText('查看重试任务');expect(ops.get(fixtureStoreKey(id))?.child?.id).toBe(child);expect(posts).toBe(2);expect(f.mock.calls.filter(([,init])=>init?.method==='POST').every(([url])=>url===`/api/local-asr/jobs/${id}/retry`)).toBe(true);
});
it('pending and errors stay GET-only; wrong file is safe and requires another fresh selection',async()=>{
 let result:any={...eligible,state:'pending',eligible:false};const f=vi.fn(async(_url:string,init?:RequestInit)=>init?.method==='POST'?ok({error:{code:'UPLOAD_MISMATCH',message:'SENTINEL_PRIVATE'}},409):ok(result));vi.stubGlobal('fetch',f);setup(unknown());recheck();await screen.findByText(/尚未确认结果/);expect(screen.queryByText('重新选择原文件以安全重试同一父任务')).toBeNull();result=eligible;await recover();select(new File(['wrong'],'wrong.wav'));submit();await screen.findByText(/文件与原上传不一致/);expect(screen.queryByText(/SENTINEL_PRIVATE/)).toBeNull();expect(screen.queryByText(/待重新上传/)).toBeNull();await recover();expect((screen.getByText('用原文件重试此失败任务') as HTMLButtonElement).disabled).toBe(true);
});
it('discard fences deferred recovery preflight; reselect needs another explicit action and GET',async()=>{
 vi.spyOn(window,'confirm').mockReturnValue(true);const pending=deferred();let gets=0,posts=0;const f=vi.fn(async(_url:string,init?:RequestInit)=>init?.method==='POST'?(posts++,postResult()):++gets===2?pending.promise:ok(eligible));vi.stubGlobal('fetch',f);setup(unknown());await recover();select();submit();fireEvent.click(screen.getByText('放弃所选重试文件'));pending.resolve(ok(eligible));await screen.findByText(/任务状态已变化/);expect(posts).toBe(0);fireEvent.click(screen.getByText('核对重试资格与结果'));await screen.findByText('重新选择原文件以安全重试同一父任务');fireEvent.click(screen.getByText('重新选择原文件以安全重试同一父任务'));select();expect(posts).toBe(0);submit();await screen.findByText('查看重试任务');expect(posts).toBe(1);
});
it('generation ignores late old GET and late old POST responses without overwriting confirmed child',async()=>{
 for(const method of ['GET','POST']){
  const late=deferred();const ops=unknown();let gets=0;const f=vi.fn(async(_url:string,init?:RequestInit)=>init?.method===method && (method==='POST'||++gets===2)?late.promise:ok(eligible));vi.stubGlobal('fetch',f);const changed=vi.fn();const view=setup(ops,changed);await recover();select();submit();await waitFor(()=>expect(f.mock.calls.length).toBeGreaterThanOrEqual(method==='POST'?3:2));
  const current=ops.get(fixtureStoreKey(id))!;ops.set(fixtureStoreKey(id),{phase:'confirmed',generation:current.generation+1,child:{id:child,status:'completed'}});late.resolve(method==='POST'?ok({},500):ok(eligible));await new Promise(resolve=>setTimeout(resolve,0));expect(ops.get(fixtureStoreKey(id))?.phase).toBe('confirmed');expect(ops.get(fixtureStoreKey(id))?.child?.id).toBe(child);expect(changed).not.toHaveBeenCalled();view.unmount();
 }
});
it('confirmed and deleted/inaccessible linked children never unlock after errors, GET absence, or remount',async()=>{
 for(const known of ['confirmed','unavailable']){
  const ops:RetryOperations=known==='confirmed'?new Map([[fixtureStoreKey(id),{phase:'confirmed',generation:1,child:{id:child,status:'completed'}}]]):unknown();let reads=0;vi.stubGlobal('fetch',vi.fn(async()=>++reads===1?ok({error:{code:known==='confirmed'?'UNAVAILABLE':'RETRY_UNAVAILABLE',message:'SENTINEL_PRIVATE'}},409):ok(eligible)));
  let view=setup(ops);fireEvent.click(screen.getByText(known==='confirmed'?'核对重试资格与结果':'核对重试结果'));await screen.findByText(known==='confirmed'?'暂时无法核对本地服务。':'已有重试任务不可访问，请勿再次上传。');view.unmount();view=setup(ops);recheck();await screen.findByText(/已有重试任务记录/);expect(screen.queryByText('重新选择原文件以安全重试同一父任务')).toBeNull();expect((screen.getByLabelText('为此失败任务重新选择原文件') as HTMLInputElement).disabled).toBe(true);expect(screen.queryByText(/SENTINEL_PRIVATE/)).toBeNull();view.unmount();
 }
});

it('ambiguous POST receipt errors never recommend ordinary upload as recovery',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>init?.method==='POST'?ok({error:{code:'RECEIPT_UNAVAILABLE'}},409):ok(eligible)));setup();await begin();await screen.findByText(/不要通过普通上传替代此重试/);expect(screen.queryByText(/此旧任务没有可核验的上传凭据，请使用上方普通上传/)).toBeNull();
});

beforeEach(() => { history.replaceState(null, '', fixtureStoreUrl()); });
