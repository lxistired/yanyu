import {fixtureStoreHeaders, fixtureStoreUrl} from './transcription-store-fixture';
import {initialUploadAccepted as accepted, initialUploadUnconfirmed} from './initial-upload-fixture';
import {beforeEach,afterEach, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {LocalTranscription} from '../candidate/src/components/LocalTranscription';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {allowLeavingUnsavedWork, writeUnsavedHistory} from '../candidate/src/components/unsaved-work';
vi.mock('../candidate/src/components/ServiceReportsEntry',()=>({ServiceReportsEntry:()=>null}));
const id='11111111-1111-4111-8111-111111111111';
const model={maxSeconds:7200,maxBytes:1024,chunkSeconds:30,overlapSeconds:1,deadlineSeconds:14400};
const job={id:'one',filename:'source.wav',title:'Original',library_revision:0,status:'completed',created:'2026-10-15',error:null,result:{text:'Source',duration_seconds:1,inference_seconds:1,language:'en'}};
const ok=(data:unknown,status=200)=>({headers:fixtureStoreHeaders(),ok:true,status,json:async()=>data});
const file=(name='selected.wav',size=80)=>new File([new Uint8Array(size)],name,{type:'audio/wav'});
const select=(value:File|null)=>fireEvent.change(screen.getByLabelText('选择音频文件'),{target:{files:value?[value]:[]}});
const blocked=()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;};
const posts=(f:ReturnType<typeof vi.fn>)=>f.mock.calls.filter(([url])=>url==='/api/local-asr/transcribe');
function transport(write:(init:RequestInit)=>unknown=accepted,rows:unknown[]=[]){const f=vi.fn(async(url:string,options?:RequestInit)=>{
 if(options?.method==='POST')return write(options);
 if(url.startsWith('/api/local-asr/transcribe?operationId='))return initialUploadUnconfirmed(url);
 if(url.endsWith('/transcript'))return ok({raw:'Source',corrected:null,revision:0,updated:null});
 return ok({jobs:rows,model,total:21,hasMore:true,activeJobCount:0});
});vi.stubGlobal('fetch',f);return f;}
async function start(){render(<LocalTranscription/>);await waitFor(()=>expect((screen.getByLabelText('选择音频文件') as HTMLInputElement).disabled).toBe(false));}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();history.replaceState(null,'','/');});
it('selection is not upload: marks close/route guard, explicit clear cleans, reselection and unmount clean only owned token',async()=>{
 const f=transport();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);await start();
 expect(blocked()).toBe(false);select(file());expect(blocked()).toBe(true);expect(allowLeavingUnsavedWork()).toBe(false);expect(posts(f)).toHaveLength(0);
 fireEvent.click(screen.getByText('清除待上传文件'));expect(blocked()).toBe(false);expect((screen.getByLabelText('选择音频文件') as HTMLInputElement).value).toBe('');
 select(file('next.wav'));expect(blocked()).toBe(true);cleanup();expect(blocked()).toBe(false);confirm.mockClear();expect(allowLeavingUnsavedWork()).toBe(true);expect(confirm).not.toHaveBeenCalled();
});
it.each(['回收站','下一页','搜索','显示全部关联范围'])('list %s Stay preserves exact File; Leave discards only after confirmation',async(action)=>{
 history.replaceState(null,'',fixtureStoreUrl('/?page=files&workspaceId=synthetic'));const f=transport();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);await start();const selected=file();select(selected);
 fireEvent.change(screen.getByLabelText('搜索转写'),{target:{value:'needle'}});fireEvent.click(screen.getByText(action));expect(confirm).toHaveBeenCalledTimes(1);expect(blocked()).toBe(true);
 fireEvent.click(screen.getByText('上传并本地转写'));await waitFor(()=>expect(posts(f)).toHaveLength(1));expect(posts(f)[0][1].body).toBe(selected);await screen.findByText('查看新提交任务');
 select(file('discard.wav'));confirm.mockReturnValue(true);fireEvent.click(screen.getByText(action));await waitFor(()=>expect(screen.queryByText(/待上传：/)).toBeNull());expect(blocked()).toBe(false);
});
it.each(['route','history','refresh'])('real app %s Stay retains exact file and Leave removes draft',async(action)=>{
 history.replaceState(null,'',fixtureStoreUrl('/?page=files'));const f=transport();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);render(<OrdinaryNavigationShell lifetime={new OrdinaryRequestLifetime()}/>);await waitFor(()=>expect((screen.getByLabelText('选择音频文件') as HTMLInputElement).disabled).toBe(false));if(action==='history')act(()=>{writeUnsavedHistory('/?page=home');writeUnsavedHistory(fixtureStoreUrl('/?page=files'))});const selected=file();select(selected);
 const navigate=async()=>{if(action==='history')await act(async()=>{history.back();await new Promise(resolve=>setTimeout(resolve,65))});else fireEvent.click(action==='refresh'?screen.getByText('替换当前路由并刷新'):screen.getByRole('button',{name:'首页',exact:true}));};
 await navigate();expect(location.search).toBe(new URL(fixtureStoreUrl('/?page=files'),'http://localhost').search);expect(blocked()).toBe(true);expect(screen.getByText(/待上传：selected.wav/)).toBeTruthy();
 fireEvent.click(screen.getByText('上传并本地转写'));await screen.findByText('查看新提交任务');expect(posts(f)[0][1].body).toBe(selected);
 select(file('leave.wav'));confirm.mockReturnValue(true);await navigate();expect(screen.queryByText(/待上传：/)).toBeNull();expect(blocked()).toBe(false);
});
it.each(['failure','network','json','malformed','wrong-status'])('%s retains exact File and identity until explicit same-operation retry',async(mode)=>{
 let fail=true;const f=transport(async(init)=>{if(!fail)return accepted(init, {replayed:true}, 200);if(mode==='network')throw Error('offline');if(mode==='json')return {headers:fixtureStoreHeaders(),ok:true,status:202,json:async()=>{throw Error('broken JSON');}};if(mode==='failure')return {headers:fixtureStoreHeaders(),ok:false,status:500,json:async()=>({error:{message:'failed'}})};return mode==='malformed'?ok({},202):accepted(init,{replayed:false},200);});await start();const selected=file();select(selected);fireEvent.click(screen.getByText('上传并本地转写'));await screen.findByRole('alert');expect(blocked()).toBe(true);expect(screen.queryByText('查看新提交任务')).toBeNull();expect(posts(f)).toHaveLength(1);expect(screen.getByRole('alert').textContent).toContain('原文件和操作标识仍保留');expect(screen.getByLabelText('未确认上传核对').textContent).toContain('重复任务');
 const original=posts(f)[0][1],operationId=new Headers(original.headers).get('X-Upload-Operation-Id');
 // Ordinary upload and synthetic picker changes cannot turn uncertainty into a new operation.
 expect((screen.getByText('上传并本地转写') as HTMLButtonElement).disabled).toBe(true);
 select(file('replacement.wav'));fireEvent.click(screen.getByText('上传并本地转写'));expect(posts(f)).toHaveLength(1);expect(screen.getByText(/待上传：selected.wav/)).toBeTruthy();
 fail=false;fireEvent.click(screen.getByText('用原操作重试上传'));await screen.findByText('查看新提交任务');expect(posts(f)).toHaveLength(2);expect(posts(f)[1][1].body).toBe(selected);expect(new Headers(posts(f)[1][1].headers).get('X-Upload-Operation-Id')).toBe(operationId);expect([...new Headers(posts(f)[1][1].headers)]).toEqual([...new Headers(original.headers)]);
 expect(f.mock.calls.filter(([url])=>url===`/api/local-asr/transcribe?operationId=${operationId}`)).toHaveLength(1);
 // The success DOM commits before useUnsavedWork's passive-effect listener cleanup.
 await waitFor(()=>expect(blocked()).toBe(false));
});
it.each([0,1025])('invalid size %s retains selection, explicit clear does not clear correction marker',async(size)=>{
 const f=transport(accepted,[job]);await start();const correction=await screen.findByLabelText('校对文本');fireEvent.change(correction,{target:{value:'Correction'}});select(file('invalid.wav',size));fireEvent.click(screen.getByText('上传并本地转写'));await screen.findByRole('alert');expect(posts(f)).toHaveLength(0);expect(screen.getByText(/待上传：invalid.wav/)).toBeTruthy();fireEvent.click(screen.getByText('清除待上传文件'));expect(blocked()).toBe(true);fireEvent.change(correction,{target:{value:'Source'}});expect(blocked()).toBe(false);
});
it('confirmed upload retains current filters and simultaneous title/correction drafts; new-task link is guarded',async()=>{
 history.replaceState(null,'',fixtureStoreUrl('/?page=files&workspaceId=synthetic'));const f=transport(accepted,[job]);const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);await start();fireEvent.click(screen.getByText('重命名'));const title=screen.getByLabelText('转写标题');const correction=await screen.findByLabelText('校对文本');fireEvent.change(title,{target:{value:'Draft title'}});fireEvent.change(correction,{target:{value:'Correction'}});select(file());fireEvent.click(screen.getByText('上传并本地转写'));const link=await screen.findByText('查看新提交任务');expect(confirm).not.toHaveBeenCalled();expect(location.search).toContain('workspaceId=synthetic');expect((title as HTMLInputElement).value).toBe('Draft title');expect((correction as HTMLTextAreaElement).value).toBe('Correction');expect(blocked()).toBe(true);expect(posts(f)).toHaveLength(1);
 fireEvent.click(link);expect(confirm).toHaveBeenCalledTimes(1);expect(location.search).toContain('workspaceId=synthetic');expect((title as HTMLInputElement).value).toBe('Draft title');confirm.mockReturnValue(true);fireEvent.click(link);expect(location.search).toContain(`transcriptJob=${id}`);await waitFor(()=>expect(screen.queryByLabelText('转写标题')).toBeNull());expect(blocked()).toBe(false);
});
it.each(['success','failure'])('late %s after a list change preserves the original operation and never adopts a newer selection',async(outcome)=>{
 let resolve!:(value:unknown)=>void,committed:unknown;const f=transport(async(init)=>{committed=await accepted(init);return new Promise(r=>{resolve=r;});});vi.spyOn(window,'confirm').mockReturnValue(true);await start();const original=file('old.wav');select(original);fireEvent.click(screen.getByText('上传并本地转写'));await waitFor(()=>expect(resolve).toBeTypeOf('function'));fireEvent.click(screen.getByText('回收站'));await waitFor(()=>expect(f.mock.calls.some(([url])=>url.includes('scope=trash'))).toBe(true));
 // List confirmation discards editor drafts, not the pending upload identity. Even a
 // synthetic native change while disabled must not replace its retained File.
 select(file('new.wav'));expect(screen.getByText(/待上传：old.wav/)).toBeTruthy();expect(screen.queryByText(/待上传：new.wav/)).toBeNull();
 await act(async()=>resolve(outcome==='success'?committed:{headers:fixtureStoreHeaders(),ok:false,status:500,json:async()=>({error:{message:'stale'}})}));
 expect(screen.getByText('回收站').getAttribute('aria-pressed')).toBe('true');expect(posts(f)).toHaveLength(1);expect(posts(f)[0][1].body).toBe(original);
 if(outcome==='success'){await screen.findByText('查看新提交任务');expect(screen.queryByRole('alert')).toBeNull();expect(screen.queryByText(/待上传：/)).toBeNull();await waitFor(()=>expect(blocked()).toBe(false));}
 else{await screen.findByRole('alert');expect(screen.getByText(/待上传：old.wav/)).toBeTruthy();expect(screen.queryByText('查看新提交任务')).toBeNull();expect(blocked()).toBe(true);}
});
it('late success after unmount does not affect a newly mounted upload draft',async()=>{
 let resolve!:(value:unknown)=>void,committed:unknown;transport(async(init)=>{committed=await accepted(init);return new Promise(r=>{resolve=r;});});await start();select(file('old.wav'));fireEvent.click(screen.getByText('上传并本地转写'));await waitFor(()=>expect(resolve).toBeTypeOf('function'));cleanup();await start();select(file('new.wav'));await act(async()=>resolve(committed));expect(screen.getByText(/待上传：new.wav/)).toBeTruthy();expect(blocked()).toBe(true);expect(screen.queryByText('查看新提交任务')).toBeNull();
});

it.each(['newline','inherited','array','null','primitive','wrong-state'])('rejects malformed %s acknowledgment without losing selected File',async(name)=>{
 const f=transport(async(init)=>{const response=await accepted(init),valid=await response.json();const invalid=name==='newline'?{...valid,id:id+'\n'}:name==='inherited'?Object.create(valid):name==='array'?[]:name==='null'?null:name==='primitive'?'accepted':{...valid,state:'unconfirmed'};return ok(invalid,202);});await start();const selected=file();select(selected);fireEvent.click(screen.getByText('上传并本地转写'));await screen.findByRole('alert');expect(posts(f)[0][1].body).toBe(selected);expect(screen.getByText(/待上传：selected.wav/)).toBeTruthy();expect(blocked()).toBe(true);expect(screen.queryByText('查看新提交任务')).toBeNull();
});
it('does not expose transport or response error contents',async()=>{
 transport(()=>{throw Error('private/path/secret');});await start();select(file());fireEvent.click(screen.getByText('上传并本地转写'));await screen.findByRole('alert');expect(screen.getByRole('alert').textContent).not.toContain('private/path/secret');
});
it.each(['search','page','trash'])('success refresh preserves committed %s list state',async(mode)=>{
 const f=transport();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);await start();
 if(mode==='search'){fireEvent.change(screen.getByLabelText('搜索转写'),{target:{value:'needle'}});fireEvent.click(screen.getByText('搜索'));}
 if(mode==='page')fireEvent.click(screen.getByText('下一页'));
 if(mode==='trash')fireEvent.click(screen.getByText('回收站'));
 const matches=(url:string)=>mode==='search'?url.includes('q=needle'):mode==='page'?url.includes('offset=10'):url.includes('scope=trash');
 await waitFor(()=>expect(f.mock.calls.some(([url])=>matches(url))).toBe(true));select(file());fireEvent.click(screen.getByText('上传并本地转写'));await screen.findByText('查看新提交任务');await waitFor(()=>expect(matches(f.mock.calls.filter(([url])=>url.startsWith('/api/local-asr/jobs?')).at(-1)![0])).toBe(true));expect(confirm).not.toHaveBeenCalled();expect(blocked()).toBe(false);
});
it('ordinary success preserves simultaneous retry File identity and token',async()=>{
 const parent='22222222-2222-4222-8222-222222222222',child='33333333-3333-4333-8333-333333333333';
 const f=vi.fn(async(url:string,init?:RequestInit)=>{
  if(url==='/api/local-asr/transcribe')return accepted(init!);
  if(url.endsWith('/retry'))return init?.method==='POST'?ok({parentId:parent,id:child,status:'processing',replayed:false},202):ok({parentId:parent,state:'uncommitted',reconciliationFinal:false,child:null,eligible:true});
  return ok({jobs:[{...job,id:parent,status:'failed',requested_language:'en',result:null}],model,activeJobCount:0});
 });vi.stubGlobal('fetch',f);const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);await start();fireEvent.click(screen.getByText('核对重试资格与结果'));await screen.findByText(/可重新选择原文件/);const selected=file('original.wav');fireEvent.change(screen.getByLabelText('为此失败任务重新选择原文件'),{target:{files:[selected]}});
 select(file());fireEvent.click(screen.getByText('上传并本地转写'));await screen.findByText('查看新提交任务');expect((screen.getByLabelText('为此失败任务重新选择原文件') as HTMLInputElement).files?.[0]).toBe(selected);expect(blocked()).toBe(true);expect(confirm).not.toHaveBeenCalled();
 await waitFor(()=>expect((screen.getByText('用原文件重试此失败任务') as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByText('用原文件重试此失败任务'));await screen.findByText('查看重试任务');expect(f.mock.calls.find(([url,init])=>url.endsWith('/retry')&&init?.method==='POST')?.[1]?.body).toBe(selected);expect(blocked()).toBe(false);
});
it('ordinary success and explicit clear leave an independent relationship draft protected',async()=>{
 const f=vi.fn(async(url:string,init?:RequestInit)=>{
  if(init?.method==='POST')return accepted(init);
  if(url.endsWith('/relationships'))return ok({workspaces:[{id:'a',name:'Alpha',count:1}],sessions:[]});
  if(url.endsWith('/transcript'))return ok({raw:'Source',corrected:null,revision:0,updated:null});
  return ok({jobs:[job],model,activeJobCount:0});
 });vi.stubGlobal('fetch',f);await start();fireEvent.click(screen.getByText('关联工作区 / 会话'));const relation=await screen.findByLabelText('关联工作区');fireEvent.change(relation,{target:{value:'a'}});select(file());fireEvent.click(screen.getByText('上传并本地转写'));await screen.findByText('查看新提交任务');expect((relation as HTMLSelectElement).value).toBe('a');expect(blocked()).toBe(true);
 select(file('next.wav'));fireEvent.click(screen.getByText('清除待上传文件'));expect(blocked()).toBe(true);fireEvent.change(relation,{target:{value:''}});expect(blocked()).toBe(false);
});

beforeEach(() => { history.replaceState(null, '', fixtureStoreUrl()); });
