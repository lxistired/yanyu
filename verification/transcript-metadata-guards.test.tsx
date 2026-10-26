import {fixtureStoreHeaders, fixtureStoreUrl} from './transcription-store-fixture';
import {TranscriptionStoreBoundary} from '../candidate/src/components/TranscriptionStoreBoundary';
import {beforeEach,afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {LocalTranscription} from '../candidate/src/components/LocalTranscription';
import {TranscriptRelationshipEditor} from '../candidate/src/components/TranscriptRelationships';
import {allowLeavingUnsavedWork, useUnsavedWork, UnsavedWorkScope, hasUnsavedWork} from '../candidate/src/components/unsaved-work';

// Synthetic transport fixtures only: these are component regressions, not live UI evidence.
const job = {id:'one',filename:'synthetic.wav',title:'Original',library_revision:2,deleted_at:null,status:'completed',created:'2026-10-15T00:00:00Z',error:null,result:{text:'Source',duration_seconds:1,inference_seconds:1,language:'en'}};
const catalog = {workspaces:[{id:'a',name:'Alpha',count:1},{id:'b',name:'Beta',count:1}],sessions:[{id:'s',workspaceId:'a',title:'Session',count:1}]};
const original = {workspaceId:'a',sessionId:null,revision:2,stale:false};
const ok = (data:unknown) => ({headers:fixtureStoreHeaders(),ok:true,status:200,json:async()=>data});
const failure = () => ({headers:fixtureStoreHeaders(),ok:false,status:409,json:async()=>({error:{message:'Synthetic conflict'}})});
function unloadBlocked() {const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}
function successfulWrite(url:string, options:RequestInit) {
 if(!url.endsWith('/relationship'))return ok({});
 const {workspaceId,sessionId,expectedRevision}=JSON.parse(options.body as string);
 return ok({relationship:{workspaceId,sessionId,revision:expectedRevision+1,workspaceName:null,sessionTitle:null,stale:false}});
}
function transport(write: (url:string, options:RequestInit)=>unknown = successfulWrite) {
 const f=vi.fn(async(url:string, options?:RequestInit)=> {
  if(options?.method==='POST') return write(url,options);
  if(url.endsWith('/relationships')) return ok(catalog);
  if(url.endsWith('/transcript')) return ok({raw:'Source',corrected:null,revision:0,updated:null});
  return ok({jobs:[job],model:null,total:21,offset:0,limit:10,hasMore:true,activeJobCount:0});
 });vi.stubGlobal('fetch',f);return f;
}
async function openTitle() {render(<LocalTranscription/>);fireEvent.click(await screen.findByText('重命名'));return screen.getByLabelText('转写标题') as HTMLInputElement;}
async function openRelationship() {fireEvent.click(screen.getByText('关联工作区 / 会话'));return await screen.findByLabelText('关联工作区') as HTMLSelectElement;}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();history.replaceState(null,'','/');});

it('title opening is clean, raw invalid input is dirty, and exact reversion clears it',async()=>{
 transport();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const input=await openTitle();
 expect(allowLeavingUnsavedWork()).toBe(true);expect(unloadBlocked()).toBe(false);
 fireEvent.change(input,{target:{value:' '}});expect(allowLeavingUnsavedWork()).toBe(false);expect(unloadBlocked()).toBe(true);
 fireEvent.change(input,{target:{value:'Original'}});expect(allowLeavingUnsavedWork()).toBe(true);expect(unloadBlocked()).toBe(false);expect(confirm).toHaveBeenCalledTimes(1);
});
it.each(['回收站','下一页','搜索'])('title alone protects list action %s on Stay and permits Leave',async(action)=>{
 const f=transport();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const input=await openTitle();
 fireEvent.change(input,{target:{value:'Draft'}});fireEvent.change(screen.getByLabelText('搜索转写'),{target:{value:'needle'}});
 await waitFor(()=>expect((screen.getByText('下一页') as HTMLButtonElement).disabled).toBe(false));
 const matches=(url:string)=>action==='回收站'?url.includes('scope=trash'):action==='下一页'?url.includes('offset=10'):url.includes('q=needle');
 fireEvent.click(screen.getByText(action));expect(confirm).toHaveBeenCalled();expect(f.mock.calls.some(([url])=>matches(url))).toBe(false);expect(input.value).toBe('Draft');
 confirm.mockReturnValue(true);fireEvent.click(screen.getByText(action));await waitFor(()=>expect(f.mock.calls.some(([url])=>matches(url))).toBe(true));
});
it('title cancellation asks only when dirty and cleans only after Leave',async()=>{
 transport();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const input=await openTitle();fireEvent.change(input,{target:{value:'Draft'}});
 fireEvent.click(screen.getByText('取消重命名'));expect(input.value).toBe('Draft');expect(unloadBlocked()).toBe(true);
 confirm.mockReturnValue(true);fireEvent.click(screen.getByText('取消重命名'));expect(screen.queryByLabelText('转写标题')).toBeNull();expect(unloadBlocked()).toBe(false);
 fireEvent.click(screen.getByText('重命名'));confirm.mockClear();fireEvent.click(screen.getByText('取消重命名'));expect(confirm).not.toHaveBeenCalled();
});
it('failed title save keeps draft and guard; conflict reload refuses Stay and resets baseline on Leave',async()=>{
 transport(()=>failure());const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const input=await openTitle();fireEvent.change(input,{target:{value:'Draft'}});
 fireEvent.click(screen.getByText('保存标题'));await screen.findByText('Synthetic conflict');expect(input.value).toBe('Draft');expect(unloadBlocked()).toBe(true);
 fireEvent.click(screen.getByText('使用最新记录'));await waitFor(()=>expect(confirm).toHaveBeenCalled());expect(input.value).toBe('Draft');
 confirm.mockReturnValue(true);fireEvent.click(screen.getByText('使用最新记录'));await waitFor(()=>expect(input.value).toBe('Original'));expect(unloadBlocked()).toBe(false);
});
it('successful title save does not clear concurrent correction guard',async()=>{
 transport();vi.spyOn(window,'confirm').mockReturnValue(false);const input=await openTitle();const correction=await screen.findByLabelText('校对文本');
 fireEvent.change(correction,{target:{value:'Correction'}});fireEvent.change(input,{target:{value:'Draft'}});fireEvent.click(screen.getByText('保存标题'));
 await waitFor(()=>expect(screen.queryByLabelText('转写标题')).toBeNull());expect(allowLeavingUnsavedWork()).toBe(false);
 fireEvent.change(correction,{target:{value:'Source'}});expect(unloadBlocked()).toBe(false);
});
it('relationship baseline ignores refreshed props, includes session and empty choices, and exact reversion clears it',async()=>{
 transport();const view=render(<TranscriptionStoreBoundary><TranscriptRelationshipEditor id="one" relationship={original} onChanged={()=>{}}/></TranscriptionStoreBoundary>);const select=await openRelationship();
 expect(unloadBlocked()).toBe(false);fireEvent.change(screen.getByLabelText('关联会话'),{target:{value:'s'}});expect(unloadBlocked()).toBe(true);
 fireEvent.change(screen.getByLabelText('关联会话'),{target:{value:''}});expect(unloadBlocked()).toBe(false);
 fireEvent.change(select,{target:{value:''}});expect(unloadBlocked()).toBe(true);
 view.rerender(<TranscriptionStoreBoundary><TranscriptRelationshipEditor id="one" relationship={{...original,workspaceId:'b',revision:3}} onChanged={()=>{}}/></TranscriptionStoreBoundary>);
 fireEvent.change(select,{target:{value:'b'}});expect(unloadBlocked()).toBe(true);fireEvent.change(select,{target:{value:'a'}});expect(unloadBlocked()).toBe(false);
});
it('relationship cancellation retains Stay and clears on Leave',async()=>{
 transport();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);render(<TranscriptionStoreBoundary><TranscriptRelationshipEditor id="one" relationship={original} onChanged={()=>{}}/></TranscriptionStoreBoundary>);const select=await openRelationship();
 fireEvent.change(select,{target:{value:'b'}});fireEvent.click(screen.getByText('取消关联修改'));expect(select.value).toBe('b');expect(unloadBlocked()).toBe(true);
 confirm.mockReturnValue(true);fireEvent.click(screen.getByText('取消关联修改'));expect(screen.queryByLabelText('关联工作区')).toBeNull();expect(unloadBlocked()).toBe(false);
});
it('relationship failures retain dirty selections and guarded reload captures a new revision',async()=>{
 let fail=true;const f=transport((url,options)=>fail?failure():successfulWrite(url,options));const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 render(<TranscriptionStoreBoundary><TranscriptRelationshipEditor id="one" relationship={original} onChanged={()=>{}}/></TranscriptionStoreBoundary>);const select=await openRelationship();fireEvent.change(select,{target:{value:'b'}});
 fireEvent.click(screen.getByText('保存关联'));await screen.findByText('Synthetic conflict');expect(select.value).toBe('b');expect(unloadBlocked()).toBe(true);
 fireEvent.click(screen.getByText('重新载入关联'));await waitFor(()=>expect(confirm).toHaveBeenCalled());expect(select.value).toBe('b');expect(unloadBlocked()).toBe(true);
 confirm.mockReturnValue(true);fireEvent.click(screen.getByText('重新载入关联'));await waitFor(()=>expect(select.value).toBe(''));expect(unloadBlocked()).toBe(false);
 fail=false;fireEvent.change(select,{target:{value:'a'}});fireEvent.click(screen.getByText('保存关联'));await waitFor(()=>expect(screen.queryByLabelText('关联工作区')).toBeNull());expect(unloadBlocked()).toBe(false);
 expect(JSON.parse(f.mock.calls.filter(([,options])=>options?.method==='POST').at(-1)![1]!.body as string).expectedRevision).toBe(0);
});
it('saving association clears only its token while a title remains dirty',async()=>{
 transport();const input=await openTitle();fireEvent.change(input,{target:{value:'Draft'}});const select=await openRelationship();fireEvent.change(select,{target:{value:'b'}});
 fireEvent.click(screen.getByText('保存关联'));await waitFor(()=>expect(screen.queryByLabelText('关联工作区')).toBeNull());expect(unloadBlocked()).toBe(true);
 fireEvent.change(input,{target:{value:'Original'}});expect(unloadBlocked()).toBe(false);
});
it('unmount removes metadata markers and recoverable trash keeps its existing confirmation flow',async()=>{
 transport();vi.spyOn(window,'confirm').mockReturnValue(false);const input=await openTitle();fireEvent.change(input,{target:{value:'Draft'}});
 fireEvent.click(screen.getByText('移到回收站'));expect(screen.getByRole('alertdialog')).toBeTruthy();fireEvent.click(screen.getByText('保留转写'));expect(input.value).toBe('Draft');expect(unloadBlocked()).toBe(true);
 cleanup();expect(unloadBlocked()).toBe(false);expect(allowLeavingUnsavedWork()).toBe(true);
});
it('successful title-only save clears its guard and reopening captures a clean baseline',async()=>{
 transport();const input=await openTitle();fireEvent.change(input,{target:{value:'Draft'}});fireEvent.click(screen.getByText('保存标题'));
 await waitFor(()=>expect(screen.queryByLabelText('转写标题')).toBeNull());expect(unloadBlocked()).toBe(false);
 fireEvent.click(screen.getByText('重命名'));expect(unloadBlocked()).toBe(false);
});
it('explicit clear association succeeds without clearing another metadata editor',async()=>{
 const f=transport();const input=await openTitle();fireEvent.change(input,{target:{value:'Draft'}});const select=await openRelationship();fireEvent.change(select,{target:{value:'b'}});
 fireEvent.click(screen.getByText('清除关联'));await waitFor(()=>expect(screen.queryByLabelText('关联工作区')).toBeNull());expect(unloadBlocked()).toBe(true);
 const body=JSON.parse(f.mock.calls.find(([url])=>url.endsWith('/relationship'))![1]!.body as string);expect(body.workspaceId).toBeNull();expect(body.sessionId).toBeNull();
 fireEvent.change(input,{target:{value:'Original'}});expect(unloadBlocked()).toBe(false);
});

function disappearingTransport() {
 let changed=false;
 const other={...job,id:'two',title:'Other',filename:'other.wav'};
 const f=vi.fn(async(url:string, options?:RequestInit)=> {
  if(options?.method==='POST') {changed=true;return successfulWrite(url,options);}
  if(url.endsWith('/relationships')) return ok(catalog);
  if(url.endsWith('/transcript')) return ok({raw:'Source',corrected:null,revision:0,updated:null});
  return ok({jobs:changed?[{...other,title:'Other fresh'}]:[job],model:null,total:1,hasMore:false,activeJobCount:0});
 });vi.stubGlobal('fetch',f);return f;
}
it('filtered title save preserves disappearing dirty correction but applies fresh unrelated rows',async()=>{
 const f=disappearingTransport();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const input=await openTitle();
 const correction=await screen.findByLabelText('校对文本');fireEvent.change(correction,{target:{value:'Unsaved correction'}});
 // Establish a title filter, choosing Leave before creating the test drafts.
 confirm.mockReturnValue(true);fireEvent.change(screen.getByLabelText('搜索转写'),{target:{value:'Original'}});fireEvent.click(screen.getByText('搜索'));
 fireEvent.click(await screen.findByText('重命名'));const currentCorrection=await screen.findByLabelText('校对文本');fireEvent.change(currentCorrection,{target:{value:'Unsaved correction'}});
 fireEvent.change(screen.getByLabelText('转写标题'),{target:{value:'Renamed'}});confirm.mockClear();fireEvent.click(screen.getByText('保存标题'));
 await screen.findByText(/此记录已不在最新结果中/);expect((currentCorrection as HTMLTextAreaElement).value).toBe('Unsaved correction');await screen.findByRole('heading',{name:'Other fresh'});expect(confirm).not.toHaveBeenCalled();
 expect(screen.getByText(/共 1 条记录/)).toBeTruthy();expect(f.mock.calls.some(([url])=>url.includes('q=Original'))).toBe(true);
 fireEvent.change(currentCorrection,{target:{value:'Source'}});await waitFor(()=>expect(screen.queryByText(/此记录已不在最新结果中/)).toBeNull(),{timeout:2500});expect(screen.queryByRole('heading',{name:'Original'})).toBeNull();expect(unloadBlocked()).toBe(false);
});
it('workspace-filtered association save retains dirty title; Stay keeps it and accepted navigation discards it',async()=>{
 history.replaceState(null,'',fixtureStoreUrl('/?page=files&workspaceId=a'));disappearingTransport();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const input=await openTitle();fireEvent.change(input,{target:{value:'Unsaved title'}});
 const select=await openRelationship();fireEvent.change(select,{target:{value:'b'}});fireEvent.click(screen.getByText('保存关联'));await screen.findByText(/此记录已不在最新结果中/);expect(input.value).toBe('Unsaved title');
 fireEvent.click(screen.getByText('显示全部关联范围'));expect(input.value).toBe('Unsaved title');expect(location.search).toContain('workspaceId=a');
 confirm.mockReturnValue(true);fireEvent.click(screen.getByText('显示全部关联范围'));await waitFor(()=>expect(screen.queryByLabelText('转写标题')).toBeNull());expect(location.search).toBe(new URL(fixtureStoreUrl('/?page=files'),'http://localhost').search);expect(unloadBlocked()).toBe(false);
});
it('metadata save removes clean filtered rows without retaining or asking',async()=>{
 disappearingTransport();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const input=await openTitle();fireEvent.change(input,{target:{value:'Renamed'}});fireEvent.click(screen.getByText('保存标题'));
 await screen.findByRole('heading',{name:'Other fresh'});expect(screen.queryByRole('heading',{name:'Original'})).toBeNull();expect(screen.queryByText(/此记录已不在最新结果中/)).toBeNull();expect(confirm).not.toHaveBeenCalled();expect(unloadBlocked()).toBe(false);
});
it('unchanged polling and repeated current-scope clicks do not prompt or discard metadata',async()=>{
 const f=transport();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const input=await openTitle();fireEvent.change(input,{target:{value:'Draft'}});fireEvent.click(screen.getByText('全部转写'));
 await waitFor(()=>expect(f.mock.calls.filter(([url])=>url.includes('/jobs?')).length).toBeGreaterThan(1),{timeout:2500});expect(input.value).toBe('Draft');expect(confirm).not.toHaveBeenCalled();expect(screen.queryByText(/此记录已不在最新结果中/)).toBeNull();
});
it('same-id status change retains dirty editor; returning active row reconciles without duplication',async()=>{
 let phase='active';vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/transcript')?ok({raw:'Source',corrected:null,revision:0,updated:null}):ok({jobs:[{...job,status:phase==='gone'?'failed':'completed',result:phase==='gone'?null:job.result,title:phase==='returned'?'Returned':'Original'}],model:null,total:1,hasMore:false,activeJobCount:0})));
 const input=await openTitle();fireEvent.change(input,{target:{value:'Draft'}});phase='gone';await screen.findByText(/此记录已不在最新结果中/,{},{timeout:2500});expect(input.value).toBe('Draft');
 phase='returned';await screen.findByRole('heading',{name:'Returned'},{timeout:2500});expect(screen.queryByText(/此记录已不在最新结果中/)).toBeNull();expect(screen.getAllByLabelText('转写标题')).toHaveLength(1);expect(input.value).toBe('Draft');
});
function ScopedMarker({dirty}:{dirty:boolean}) {useUnsavedWork(dirty);return null;}
it('scoped dirty owners are independent and cleaning one does not release another',()=>{
 const first=Symbol('same-job'), second=Symbol('same-job');
 const view=render(<><UnsavedWorkScope value={first}><ScopedMarker dirty/></UnsavedWorkScope><UnsavedWorkScope value={second}><ScopedMarker dirty/></UnsavedWorkScope></>);
 expect(hasUnsavedWork(first)).toBe(true);expect(hasUnsavedWork(second)).toBe(true);
 view.rerender(<><UnsavedWorkScope value={first}><ScopedMarker dirty={false}/></UnsavedWorkScope><UnsavedWorkScope value={second}><ScopedMarker dirty/></UnsavedWorkScope></>);
 expect(hasUnsavedWork(first)).toBe(false);expect(hasUnsavedWork(second)).toBe(true);expect(unloadBlocked()).toBe(true);
 view.unmount();expect(hasUnsavedWork(second)).toBe(false);expect(unloadBlocked()).toBe(false);
});
it('explicit confirmed trash still removes its dirty row without an extra leave prompt',async()=>{
 disappearingTransport();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const input=await openTitle();fireEvent.change(input,{target:{value:'Draft'}});
 const correction=await screen.findByLabelText('校对文本');fireEvent.change(correction,{target:{value:'Unsaved correction'}});
 fireEvent.click(screen.getByText('移到回收站'));fireEvent.click(screen.getByText('确认移到回收站'));await screen.findByRole('heading',{name:'Other fresh'});
 expect(screen.queryByRole('heading',{name:'Original'})).toBeNull();expect(screen.queryByText(/此记录已不在最新结果中/)).toBeNull();expect(confirm).not.toHaveBeenCalled();expect(unloadBlocked()).toBe(false);
});
it('late old trash success cannot discard a reopened row generation',async()=>{
 let finish!: (value:unknown)=>void;let trashed=false;
 vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=>{
  if(url.endsWith('/trash') && options?.method==='POST') return await new Promise(resolve=>{finish=resolve;});
  if(url.endsWith('/transcript'))return ok({raw:'Source',corrected:null,revision:0,updated:null});
  const isTrash=new URL(url,'http://localhost').searchParams.get('scope')==='trash';
  return ok({jobs:isTrash||trashed?[]:[job],model:null,total:isTrash||trashed?0:1,hasMore:false,activeJobCount:0});
 }));
 vi.spyOn(window,'confirm').mockReturnValue(true);const oldInput=await openTitle();fireEvent.change(oldInput,{target:{value:'Old draft'}});
 fireEvent.click(screen.getByText('移到回收站'));fireEvent.click(screen.getByText('确认移到回收站'));await waitFor(()=>expect(finish).toBeTypeOf('function'));
 fireEvent.click(screen.getByText('回收站'));await screen.findByText('回收站为空');fireEvent.click(screen.getByText('全部转写'));fireEvent.click(await screen.findByText('重命名'));
 const freshInput=screen.getByLabelText('转写标题') as HTMLInputElement;fireEvent.change(freshInput,{target:{value:'New draft'}});
 trashed=true;finish(ok({}));await screen.findByText(/此记录已不在最新结果中/,{},{timeout:2500});expect(freshInput.value).toBe('New draft');expect(unloadBlocked()).toBe(true);
});
it.each(['全部转写','搜索','清除搜索'])('current %s still resets nonzero page after approval',async(action)=>{
 const f=transport();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);await openTitle();
 fireEvent.click(screen.getByText('下一页'));await waitFor(()=>expect(f.mock.calls.some(([url])=>url.includes('offset=10'))).toBe(true));fireEvent.click(await screen.findByText('重命名'));
 const input=screen.getByLabelText('转写标题') as HTMLInputElement;fireEvent.change(input,{target:{value:'Draft'}});
 const readsAtZero=()=>f.mock.calls.filter(([url])=>url.includes('offset=0')).length;const previous=readsAtZero();
 fireEvent.click(screen.getByText(action));expect(confirm).toHaveBeenCalled();expect(input.value).toBe('Draft');expect(readsAtZero()).toBe(previous);
 confirm.mockReturnValue(true);fireEvent.click(screen.getByText(action));await waitFor(()=>expect(readsAtZero()).toBeGreaterThan(previous));expect(screen.queryByLabelText('转写标题')).toBeNull();
});
it('title conflict reload reads exact current revision even when its filtered row is retained',async()=>{
 let saved=false;let failed=false;const latest={...job,title:'Server title',library_revision:8};
 const f=vi.fn(async(url:string,options?:RequestInit)=>{
  if(options?.method==='POST') {if(!saved){saved=true;return ok({});}if(!failed){failed=true;return failure();}return ok({});}
  if(url.endsWith('/transcript'))return ok({raw:'Source',corrected:null,revision:0,updated:null});
  const exact=new URL(url,'http://localhost').searchParams.get('jobId')==='one';
  return ok({jobs:exact?[latest]:saved?[]:[job],model:null,total:saved?0:1,hasMore:false,activeJobCount:0});
 });vi.stubGlobal('fetch',f);vi.spyOn(window,'confirm').mockReturnValue(true);const input=await openTitle();const correction=await screen.findByLabelText('校对文本');fireEvent.change(correction,{target:{value:'Keep correction'}});
 fireEvent.change(input,{target:{value:'First save'}});fireEvent.click(screen.getByText('保存标题'));await screen.findByText(/此记录已不在最新结果中/);
 fireEvent.click(screen.getByText('重命名'));fireEvent.change(screen.getByLabelText('转写标题'),{target:{value:'Next draft'}});fireEvent.click(screen.getByText('保存标题'));await screen.findByText('Synthetic conflict');
 fireEvent.click(screen.getByText('使用最新记录'));await waitFor(()=>expect((screen.getByLabelText('转写标题') as HTMLInputElement).value).toBe('Server title'));expect(unloadBlocked()).toBe(true);
 fireEvent.change(screen.getByLabelText('转写标题'),{target:{value:'Retry'}});fireEvent.click(screen.getByText('保存标题'));await waitFor(()=>expect(f.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(3));
 expect(JSON.parse(f.mock.calls.filter(([,options])=>options?.method==='POST')[2][1]!.body as string).expectedRevision).toBe(8);expect((correction as HTMLTextAreaElement).value).toBe('Keep correction');
});

beforeEach(() => { history.replaceState(null, '', fixtureStoreUrl()); });
