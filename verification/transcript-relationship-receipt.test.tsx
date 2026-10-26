import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {TranscriptRelationshipEditor, type TranscriptRelationship} from '../candidate/src/components/TranscriptRelationships';
import {TranscriptionStoreBoundary} from '../candidate/src/components/TranscriptionStoreBoundary';
import {LocalTranscription} from '../candidate/src/components/LocalTranscription';
import {useTranscriptionStore} from '../candidate/src/components/TranscriptionStoreBoundary';
import {hasUnsavedWork, UnsavedWorkScope} from '../candidate/src/components/unsaved-work';
import {nextRelationshipRevision, validRelationshipReceipt} from '../candidate/src/components/transcript-relationship-receipt';
import {fixtureStoreHeaders, fixtureStoreUrl} from './transcription-store-fixture';
const catalog = {workspaces:[{id:'_a',name:'Alpha',count:1},{id:'b',name:'Beta',count:1}],sessions:[{id:'-s',workspaceId:'_a',title:'Session',count:1}]};
const initial: TranscriptRelationship = {workspaceId:'b',sessionId:null,revision:4,workspaceName:'Beta',sessionTitle:null,stale:false};
const target = {workspaceId:'_a',sessionId:'-s',expectedRevision:4};
const receipt = (workspaceId: string | null = '_a', sessionId: string | null = '-s', revision = 5) => ({relationship:{workspaceId,sessionId,revision,workspaceName:workspaceId ? 'Name' : null,sessionTitle:sessionId ? 'Title' : null,stale:false}});
const ok = (data:unknown, status=200) => ({headers:fixtureStoreHeaders(),ok:status>=200&&status<300,status,json:vi.fn(async()=>data)});
const broken: [string, unknown][] = [
 ['null',null],['scalar',1],['text','saved'],['array',[]],['empty object',{}],['null relationship',{relationship:null}],['array relationship',{relationship:[]}],
 ['wrong workspace',receipt('b')],['wrong session',receipt('_a',null)],
 ['missing revision',{relationship:{...receipt().relationship,revision:undefined}}],['old revision',receipt('_a','-s',4)],['future revision',receipt('_a','-s',6)],['unsafe revision',receipt('_a','-s',Number.MAX_SAFE_INTEGER+1)],['fractional revision',receipt('_a','-s',5.5)],['text revision',{relationship:{...receipt().relationship,revision:'5'}}],
 ['missing stale',{relationship:{...receipt().relationship,stale:undefined}}],['text stale',{relationship:{...receipt().relationship,stale:'false'}}],
 ['bad workspace name',{relationship:{...receipt().relationship,workspaceName:42}}],['bad session title',{relationship:{...receipt().relationship,sessionTitle:{}}}],['bad replay flag',{...receipt(),replayed:'true'}],
];
beforeEach(()=>{history.replaceState(null,'',fixtureStoreUrl());});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();history.replaceState(null,'','/');});
function harness(write:()=>Promise<ReturnType<typeof ok>>, relationship: TranscriptRelationship | null = initial) {
 const scope=Symbol('receipt-row'),changed=vi.fn();
 const fetch=vi.fn(async(url:string, options?:RequestInit)=>url.endsWith('/relationships') ? ok(catalog) : write());
 vi.stubGlobal('fetch',fetch);
 const view=render(<TranscriptionStoreBoundary><UnsavedWorkScope value={scope}><TranscriptRelationshipEditor id="exact-job" relationship={relationship} onChanged={changed}/></UnsavedWorkScope></TranscriptionStoreBoundary>);
 return {fetch,scope,changed,...view};
}
async function open(select=true) {
 fireEvent.click(screen.getByText('关联工作区 / 会话'));
 const field=await screen.findByLabelText('关联工作区');
 if(select){fireEvent.change(field,{target:{value:'_a'}});fireEvent.change(screen.getByLabelText('关联会话'),{target:{value:'-s'}});}
}
const posts=(fetch: ReturnType<typeof vi.fn>)=>fetch.mock.calls.filter(([,options])=>options?.method==='POST');
function expectGated(scope:symbol) {
 expect((screen.getByText('保存关联') as HTMLButtonElement).disabled).toBe(true);
 expect((screen.getByText('清除关联') as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByText('重新载入关联')).toBeTruthy();
 expect(hasUnsavedWork(scope)).toBe(true);
}
it.each(broken)('rejects malformed same-store 200 %s without losing draft or auto-sending',async(_name,data)=>{
 const h=harness(async()=>ok(data));await open();fireEvent.click(screen.getByText('保存关联'));
 await screen.findByText(/保存可能已经发生/);
 expect((screen.getByLabelText('关联工作区') as HTMLSelectElement).value).toBe('_a');
 expect((screen.getByLabelText('关联会话') as HTMLSelectElement).value).toBe('-s');
 expectGated(h.scope);fireEvent.click(screen.getByText('保存关联'));fireEvent.click(screen.getByText('清除关联'));expect(posts(h.fetch)).toHaveLength(1);
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);fireEvent.click(screen.getByText('取消关联修改'));expect(confirm).toHaveBeenCalledOnce();expectGated(h.scope);
});
it.each(['workspace','session','clear','replay','stale replay','optional metadata'] as const)('accepts actual matching %s receipt and releases recovery',async(kind)=>{
 let data:unknown=kind==='clear'?receipt(null,null):kind==='workspace'?receipt('_a',null):receipt();
 if(kind==='replay')data={...receipt(),replayed:true};
 if(kind==='stale replay')data={relationship:{...receipt().relationship,stale:true},replayed:true};
 if(kind==='optional metadata')data={relationship:{workspaceId:'_a',sessionId:'-s',revision:5,stale:false},replayed:false};
 const h=harness(async()=>ok(data));await open();if(kind==='workspace')fireEvent.change(screen.getByLabelText('关联会话'),{target:{value:''}});
 fireEvent.click(screen.getByText(kind==='clear'?'清除关联':'保存关联'));
 await waitFor(()=>expect(screen.queryByLabelText('关联工作区')).toBeNull());expect(hasUnsavedWork(h.scope)).toBe(false);expect(h.changed).toHaveBeenCalledOnce();expect(posts(h.fetch)).toHaveLength(1);
 const body=JSON.parse(posts(h.fetch)[0][1].body);expect(body.expectedRevision).toBe(4);expect(body.workspaceId).toBe(kind==='clear'?null:'_a');expect(body.sessionId).toBe(kind==='clear'||kind==='workspace'?null:'-s');
});
it('keeps an unchanged-selector clear protected while pending and after mismatched receipt; Stay preserves it',async()=>{
 let release!:(value:ReturnType<typeof ok>)=>void;
 const pending=new Promise<ReturnType<typeof ok>>(resolve=>{release=resolve;});const h=harness(()=>pending);await open(false);
 expect(hasUnsavedWork(h.scope)).toBe(false);fireEvent.click(screen.getByText('清除关联'));expect(hasUnsavedWork(h.scope)).toBe(true);
 await act(async()=>{release(ok(receipt('b',null)));});await screen.findByText(/保存可能已经发生/);expectGated(h.scope);
 expect((screen.getByLabelText('关联工作区') as HTMLSelectElement).value).toBe('b');expect(JSON.parse(posts(h.fetch)[0][1].body)).toMatchObject({workspaceId:null,sessionId:null,expectedRevision:4});
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);fireEvent.click(screen.getByText('取消关联修改'));expect(confirm).toHaveBeenCalledOnce();expectGated(h.scope);
 confirm.mockReturnValue(true);fireEvent.click(screen.getByText('取消关联修改'));expect(screen.queryByLabelText('关联工作区')).toBeNull();expect(hasUnsavedWork(h.scope)).toBe(false);expect(posts(h.fetch)).toHaveLength(1);
});
it('failed exact-job reload and Stay retain ambiguous clear; accepted reload enables only a new explicit write at reviewed revision',async()=>{
 let reads=0,writes=0;
 const h=harness(async()=>{throw Error('not used');});
 h.fetch.mockImplementation(async(url:string,options?:RequestInit)=>{
  if(url.endsWith('/relationships'))return ok(catalog);
  if(options?.method==='POST'){writes++;return ok(writes===1?{}:receipt('_a','-s',9));}
  reads++;if(reads===1)return ok({error:{message:'read unavailable'}},503);
  return ok({jobs:[{id:'other-job',status:'completed',relationship:initial},{id:'exact-job',status:'completed',relationship:receipt('_a','-s',8).relationship}]});
 });
 await open(false);fireEvent.click(screen.getByText('清除关联'));await screen.findByText(/保存可能已经发生/);
 fireEvent.click(screen.getByText('重新载入关联'));await screen.findByText('无法载入最新关联，请重试');expectGated(h.scope);
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);fireEvent.click(screen.getByText('重新载入关联'));await waitFor(()=>expect(confirm).toHaveBeenCalledOnce());expectGated(h.scope);expect((screen.getByLabelText('关联工作区') as HTMLSelectElement).value).toBe('b');
 confirm.mockReturnValue(true);fireEvent.click(screen.getByText('重新载入关联'));await waitFor(()=>expect((screen.getByText('保存关联') as HTMLButtonElement).disabled).toBe(false));
 expect((screen.getByLabelText('关联工作区') as HTMLSelectElement).value).toBe('_a');expect(hasUnsavedWork(h.scope)).toBe(false);expect(writes).toBe(1);
 for(const [url] of h.fetch.mock.calls.filter(([url])=>url.includes('/jobs?')))expect(new URL(url,'http://localhost').searchParams.get('jobId')).toBe('exact-job');
 fireEvent.click(screen.getByText('保存关联'));await waitFor(()=>expect(screen.queryByLabelText('关联工作区')).toBeNull());expect(JSON.parse(posts(h.fetch)[1][1].body).expectedRevision).toBe(8);expect(writes).toBe(2);
});
it.each(['empty body','rejected JSON','network','non-success','unexpected 201'] as const)('retains the draft and reload gate for %s',async(kind)=>{
 const h=harness(async()=>{
  if(kind==='network')throw Error('Network unavailable');
  if(kind==='empty body'||kind==='rejected JSON')return {...ok(null,kind==='empty body'?204:200),json:vi.fn(async()=>{throw new SyntaxError('Invalid JSON');})};
  return kind==='non-success'?ok({error:{message:'Conflict'}},409):ok(receipt(),201);
 });await open();fireEvent.click(screen.getByText('保存关联'));await screen.findByText('重新载入关联');await waitFor(()=>expect((screen.getByText('重新载入关联') as HTMLButtonElement).disabled).toBe(false));expectGated(h.scope);expect(posts(h.fetch)).toHaveLength(1);
});
it.each([-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER])('does not send an invalid or overflowing revision %s',async(revision)=>{
 const h=harness(async()=>ok(receipt()),{...initial,revision});await open();fireEvent.click(screen.getByText('保存关联'));await screen.findByText(/尚未发送保存请求/);expect(posts(h.fetch)).toHaveLength(0);expectGated(h.scope);
});
it('validates safe boundaries without inventing job or operation echo fields',()=>{
 expect(nextRelationshipRevision(0)).toBe(1);expect(nextRelationshipRevision(Number.MAX_SAFE_INTEGER-1)).toBe(Number.MAX_SAFE_INTEGER);
 expect(validRelationshipReceipt(receipt('_a','-s',Number.MAX_SAFE_INTEGER),{...target,expectedRevision:Number.MAX_SAFE_INTEGER-1})).toBe(true);
 expect(validRelationshipReceipt(receipt(),target)).toBe(true);
});
it('checks captured intent rather than background relationship props while a write is pending',async()=>{
 let release!:(value:ReturnType<typeof ok>)=>void;const pending=new Promise<ReturnType<typeof ok>>(resolve=>{release=resolve;});
 const h=harness(()=>pending);await open();fireEvent.click(screen.getByText('保存关联'));
 h.rerender(<TranscriptionStoreBoundary><UnsavedWorkScope value={h.scope}><TranscriptRelationshipEditor id="exact-job" relationship={{...initial,revision:99}} onChanged={h.changed}/></UnsavedWorkScope></TranscriptionStoreBoundary>);
 await act(async()=>{release(ok(receipt()));});await waitFor(()=>expect(screen.queryByLabelText('关联工作区')).toBeNull());expect(JSON.parse(posts(h.fetch)[0][1].body).expectedRevision).toBe(4);
});
function ConcurrentRead(){const store=useTranscriptionStore();return <button onClick={()=>void store.fetch('/api/local-asr/jobs?limit=1').catch(()=>{})}>synthetic concurrent read</button>;}
it.each(['before body','during body'] as const)('store changes %s cannot turn a valid DTO into acknowledgement',async(phase)=>{
 let release!:(data:unknown)=>void;const pending=new Promise<unknown>(resolve=>{release=resolve;});
 const response={...ok(receipt()),json:vi.fn(async()=>phase==='during body'?pending:receipt())};
 if(phase==='before body')response.headers=new Headers({'X-Transcription-Store-Id':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'});
 const scope=Symbol('store-change');const fetch=vi.fn(async(url:string,options?:RequestInit)=>url.endsWith('/relationships')?ok(catalog):options?.method==='POST'?response:{...ok({}),headers:new Headers({'X-Transcription-Store-Id':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'})});vi.stubGlobal('fetch',fetch);
 render(<TranscriptionStoreBoundary><UnsavedWorkScope value={scope}><TranscriptRelationshipEditor id="exact-job" relationship={initial} onChanged={()=>{}}/><ConcurrentRead/></UnsavedWorkScope></TranscriptionStoreBoundary>);
 await open();fireEvent.click(screen.getByText('保存关联'));
 if(phase==='during body'){await waitFor(()=>expect(response.json).toHaveBeenCalledOnce());fireEvent.click(screen.getByText('synthetic concurrent read'));await screen.findByText(/本页不会自动切换来源/);await act(async()=>{release(receipt());});}
 await screen.findByText('重新载入关联');expectGated(scope);expect((screen.getByLabelText('关联工作区') as HTMLSelectElement).value).toBe('_a');if(phase==='before body')expect(response.json).not.toHaveBeenCalled();expect(posts(fetch)).toHaveLength(1);
});
it('unmount cleans the unsaved marker and a late response cannot create a second write or alter a new editor',async()=>{
 let release!:(data:ReturnType<typeof ok>)=>void;const pending=new Promise<ReturnType<typeof ok>>(resolve=>{release=resolve;});
 const old=harness(()=>pending);await open();fireEvent.click(screen.getByText('保存关联'));old.unmount();expect(hasUnsavedWork(old.scope)).toBe(false);
 const fresh=harness(async()=>ok(receipt()));await open();await act(async()=>{release(ok({}));});expect((screen.getByLabelText('关联会话') as HTMLSelectElement).value).toBe('-s');expect(posts(old.fetch)).toHaveLength(1);expect(posts(fresh.fetch)).toHaveLength(0);expect(hasUnsavedWork(old.scope)).toBe(false);
});

it('ambiguous unchanged-selector clear retains a row removed from the workspace-filtered results',async()=>{
 history.replaceState(null,'',fixtureStoreUrl('/?page=files&workspaceId=b'));let dispatched=false;
 const job={id:'exact-job',filename:'synthetic.wav',title:'Retained relationship',library_revision:0,deleted_at:null,status:'completed',created:'2026-10-22T00:00:00Z',error:null,relationship:initial,result:{text:'Synthetic',duration_seconds:1,inference_seconds:1,language:'en'}};
 const fetch=vi.fn(async(url:string,options?:RequestInit)=>{
  if(options?.method==='POST'){dispatched=true;return ok({});}
  if(url.endsWith('/relationships'))return ok(catalog);
  if(url.endsWith('/transcript'))return ok({raw:'Synthetic',corrected:null,revision:0,updated:null});
  return ok({jobs:dispatched?[]:[job],model:null,total:dispatched?0:1,hasMore:false,activeJobCount:0});
 });vi.stubGlobal('fetch',fetch);render(<LocalTranscription/>);
 await screen.findByText('关联工作区 / 会话');await open(false);fireEvent.click(screen.getByText('清除关联'));
 await screen.findByText(/保存可能已经发生/);await screen.findByText(/此记录已不在最新结果中/);
 expect((screen.getByLabelText('关联工作区') as HTMLSelectElement).value).toBe('b');
 const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);expect(event.defaultPrevented).toBe(true);expect(posts(fetch)).toHaveLength(1);
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);fireEvent.click(screen.getByText('显示全部关联范围'));expect(confirm).toHaveBeenCalledOnce();expect(location.search).toContain('workspaceId=b');expect(screen.getByText('重新载入关联')).toBeTruthy();
 confirm.mockReturnValue(true);fireEvent.click(screen.getByText('取消关联修改'));await waitFor(()=>expect(screen.queryByRole('heading',{name:'Retained relationship'})).toBeNull(),{timeout:2500});expect(posts(fetch)).toHaveLength(1);
});

it('a 503 after unchanged-selector clear remains an unverified write until accepted reload or cancel',async()=>{
 const h=harness(async()=>ok({error:{message:'Storage unavailable'}},503));await open(false);expect(hasUnsavedWork(h.scope)).toBe(false);
 fireEvent.click(screen.getByText('清除关联'));await screen.findByText('Storage unavailable');expectGated(h.scope);
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);fireEvent.click(screen.getByText('取消关联修改'));expect(confirm).toHaveBeenCalledOnce();expectGated(h.scope);expect(posts(h.fetch)).toHaveLength(1);
});
