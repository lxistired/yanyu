import React from 'react';
import {createHash} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {LocalDocuments} from '../candidate/src/components/LocalDocuments';
import {DOCUMENT_UPLOAD_ATTEMPT_TIMEOUT_MS} from '../candidate/src/components/document-upload-attempt';
import {readUploadRecords,retainUploadRecord,UPLOAD_JOURNAL_PREFIX,type UploadRecord} from '../candidate/src/components/document-upload-journal';

// Synthetic fault injection only. These regressions are authored, NOT executed.
const scope='10000000-0000-4000-8000-000000000001';
const otherScope='20000000-0000-4000-8000-000000000002';
const operationId='30000000-0000-4000-8000-000000000003';
const documentId='40000000-0000-4000-8000-000000000004';
const folderId='50000000-0000-4000-8000-000000000005';
const content='SYNTHETIC_UPLOAD_DEADLINE_CONTENT';
const sha256=createHash('sha256').update(content).digest('hex');
const pending=():UploadRecord=>({version:1,scope,operationId,name:'synthetic.md',format:'md',bytes:Buffer.byteLength(content),sha256,workspaceId:null,folderId:null,createdAt:'2026-10-22T12:00:00.000Z'});
const key=(record:UploadRecord)=>`${UPLOAD_JOURNAL_PREFIX}${record.scope}:${record.operationId}`;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
function saved(record:UploadRecord){
 const {scope:ignored,version,...fields}=record;
 return {scope:record.scope,operationId:record.operationId,outcome:'committed',receipt:{...fields,documentId},document:{id:documentId,sha256:record.sha256,trashedAt:null}};
}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j});return {promise,resolve,reject};}
function heldResponse(phase:'headers'|'body',status=200){
 const headers=deferred<Response>(),body=deferred<unknown>();
 const cancel=vi.fn(async()=>{}),read=vi.fn(()=>body.promise);
 const response={ok:status>=200&&status<300,status,json:read,body:{cancel}} as unknown as Response;
 const result=phase==='headers'?headers.promise:Promise.resolve(response);
 return {result,read,cancel,releaseHeaders(){headers.resolve(response);},resolve(value:unknown){body.resolve(value);headers.resolve(response);},reject(error:unknown){if(phase==='headers')headers.reject(error);else body.reject(error);}};
}
type Extra=(path:string,init?:RequestInit)=>Promise<Response>|undefined;
function setup(extra:Extra,store=scope){
 const fetcher=vi.fn((input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
  const path=String(input),override=extra(path,init);if(override)return override;
  if(path==='/api/documents/choices')return Promise.resolve(json({uploadScope:store,workspaces:[],folders:[]}));
  if(path.startsWith('/api/documents?'))return Promise.resolve(json({storeScope:store,documents:[],total:0,offset:0,limit:10}));
  throw Error(`Unexpected synthetic request: ${path}`);
 });
 vi.stubGlobal('fetch',fetcher);return {...render(<LocalDocuments/>),fetcher};
}
const posts=(fetcher:ReturnType<typeof setup>['fetcher'])=>fetcher.mock.calls.filter(([path,init])=>String(path).startsWith('/api/documents/upload?')&&init?.method==='POST');
const checks=(fetcher:ReturnType<typeof setup>['fetcher'])=>fetcher.mock.calls.filter(([path])=>String(path).includes('/upload-operations/'));
const checkButton=()=>screen.getByRole('button',{name:'核对上传结果'}) as HTMLButtonElement;
const retryButton=()=>screen.getByRole('button',{name:'用原操作重试上传'}) as HTMLButtonElement;
const mainInput=()=>screen.getByLabelText('选择文档') as HTMLInputElement;
function file(name='synthetic.md',text=content){const value=new File([text],name);Object.defineProperty(value,'arrayBuffer',{value:async()=>new TextEncoder().encode(text).buffer});return value;}
function selectMain(value=file()){
 const input = mainInput(), nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
 let selected: File | null = value;
 // Model only the FileList surface this leaf reads, including native-style clearing.
 // A bare fireEvent target.files override can survive input.value = '' and mask a bug.
 // These per-node accessors do not patch the prototype or claim native picker coverage.
 Object.defineProperties(input, {
  files: {configurable: true, get: () => selected ? [selected] : []},
  value: {configurable: true,
   get: () => selected ? `C:\\fakepath\\${selected.name}` : nativeValue.get!.call(input),
   set: (value: string) => {nativeValue.set!.call(input, value); if (value === '') selected = null;}},
 });
 fireEvent.change(input);return value;
}
function expectDirty(dirty:boolean){
 const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);
 expect(event.defaultPrevented).toBe(dirty);
}
function submitUpload(){fireEvent.submit(mainInput().closest('form')!);}
async function flush(){await act(async()=>{for(let i=0;i<12;i++)await Promise.resolve();});}
async function ready(){
 await screen.findByText('没有匹配的文档。上传文件，或调整筛选条件。');
 await waitFor(()=>expect(mainInput().closest('fieldset')!.disabled).toBe(false));
 // Keep initial loading and Testing Library's polling on real timers.
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
}
async function expire(){await act(async()=>{await vi.advanceTimersByTimeAsync(DOCUMENT_UPLOAD_ATTEMPT_TIMEOUT_MS);});}
function expectPending(record:UploadRecord,raw:string|null,selected?:File){
 expect(readUploadRecords(localStorage,scope)).toEqual([record]);expect(localStorage.getItem(key(record))).toBe(raw);
 expect(screen.queryByText(/已核实文档已保存到本地/)).toBeNull();if(selected){
  expect(mainInput().files?.[0]).toBe(selected);expect(mainInput().value).toBe(`C:\\fakepath\\${selected.name}`);expectDirty(true);
 }
}
beforeEach(()=>{
 localStorage.clear();let sequence=10;
 // Deterministic in-process digest, avoiding native crypto scheduling under fake timers.
 vi.stubGlobal('crypto',{randomUUID:()=>`60000000-0000-4000-8000-${String(sequence++).padStart(12,'0')}`,subtle:{digest:async(_algorithm:string,data:ArrayBuffer)=>Uint8Array.from(createHash('sha256').update(new Uint8Array(data)).digest()).buffer}});
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear();});

it.each(['headers','body'] as const)('expires pending upload POST %s while retaining exact journal and selection, without automatic work',async phase=>{
 const held=heldResponse(phase);let signal:AbortSignal|null|undefined;
 const {fetcher}=setup((path,init)=>{if(path.startsWith('/api/documents/upload?')){signal=init?.signal;return held.result;}});
 await ready();const selected=selectMain();submitUpload();await flush();
 expect(posts(fetcher)).toHaveLength(1);const record=readUploadRecords(localStorage,scope)[0],raw=localStorage.getItem(key(record));expect(record).toBeTruthy();
 expect(checkButton().disabled).toBe(true);await expire();
 expect(signal?.aborted).toBe(true);expect(checkButton().disabled).toBe(false);expectPending(record,raw,selected);
 expect(screen.getByText(/本次等待已超时/).textContent).toContain('不代表服务端操作已取消');
 expect(posts(fetcher)).toHaveLength(1);expect(checks(fetcher)).toHaveLength(0);
 await expire();expect(posts(fetcher)).toHaveLength(1);expect(checks(fetcher)).toHaveLength(0);
 if(phase==='headers')held.cancel.mockImplementationOnce(()=>new Promise<void>(()=>{}));
 await act(async()=>held.resolve(saved(record)));expectPending(record,raw,selected);expect(checkButton().disabled).toBe(false);
 if(phase==='headers'){expect(held.read).not.toHaveBeenCalled();expect(held.cancel).toHaveBeenCalledOnce();}
});

it.each(['headers','body'] as const)('expires explicit recovery GET %s, preserves retry selection, and permits another explicit check',async phase=>{
 const record=pending();retainUploadRecord(localStorage,record);const raw=localStorage.getItem(key(record)),held=heldResponse(phase),second=heldResponse('headers');let calls=0,signal:AbortSignal|null|undefined;
 const {fetcher}=setup((path,init)=>{if(path.includes('/upload-operations/')){signal=init?.signal;return ++calls===1?held.result:second.result;}});
 await ready();const selected=selectMain(file('newer.md','SYNTHETIC_NEWER_SELECTION'));
 fireEvent.change(screen.getByLabelText(`为${record.name}重新选择原文件`),{target:{files:[file()]}});
 fireEvent.click(checkButton());await flush();expect(checkButton().disabled).toBe(true);await expire();
 expect(signal?.aborted).toBe(true);expect(checkButton().disabled).toBe(false);expect(retryButton().disabled).toBe(false);expectPending(record,raw,selected);
 expect(checks(fetcher)).toHaveLength(1);expect(posts(fetcher)).toHaveLength(0);
 fireEvent.click(checkButton());await flush();expect(checks(fetcher)).toHaveLength(2);
 await act(async()=>held.resolve(saved(record)));expectPending(record,raw,selected);expect(checkButton().disabled).toBe(true);expect(posts(fetcher)).toHaveLength(0);
 fireEvent.click(checkButton());fireEvent.click(retryButton());expect(checks(fetcher)).toHaveLength(2);expect(posts(fetcher)).toHaveLength(0);
 await act(async()=>second.resolve({scope,operationId,outcome:'absent'}));expect(checkButton().disabled).toBe(false);expectPending(record,raw,selected);
 expect(screen.getByText(/不能据此认定上传失败/)).toBeTruthy();
});

it.each(['headers','body'] as const)('expires explicit retry POST %s and retransmits the same immutable operation only after another click',async phase=>{
 const record=pending();retainUploadRecord(localStorage,record);const raw=localStorage.getItem(key(record)),first=heldResponse(phase),second=heldResponse('headers');let calls=0;
 const {fetcher}=setup(path=>path.startsWith('/api/documents/upload?')?(++calls===1?first.result:second.result):undefined);
 await ready();const selected=file();fireEvent.change(screen.getByLabelText(`为${record.name}重新选择原文件`),{target:{files:[selected]}});
 fireEvent.click(retryButton());await flush();await expire();expectPending(record,raw);expect(retryButton().disabled).toBe(false);
 expect(posts(fetcher)).toHaveLength(1);expect(checks(fetcher)).toHaveLength(0);
 fireEvent.click(retryButton());await flush();expect(posts(fetcher)).toHaveLength(2);
 for(const [,init] of posts(fetcher)){expect(new Headers(init?.headers).get('X-Upload-Operation-Id')).toBe(record.operationId);expect(new Headers(init?.headers).get('X-Upload-Store-Id')).toBe(scope);expect(init?.body).toBe(selected);}
 await act(async()=>first.resolve(saved(record)));expectPending(record,raw);expect(checkButton().disabled).toBe(true);
 fireEvent.click(checkButton());fireEvent.click(retryButton());expect(posts(fetcher)).toHaveLength(2);expect(checks(fetcher)).toHaveLength(0);
 await expire();expect(checkButton().disabled).toBe(false);expect(posts(fetcher)).toHaveLength(2);expectPending(record,raw);
});

it.each(['headers','body'] as const)('late expired POST %s cannot clear a newer operation or unlock its action',async phase=>{
 const old=heldResponse(phase),newer=heldResponse('headers');let calls=0;
 const {fetcher}=setup(path=>path.startsWith('/api/documents/upload?')?(++calls===1?old.result:newer.result):path.includes('/upload-operations/')?Promise.resolve(json(saved(readUploadRecords(localStorage,scope)[0]))):undefined);
 await ready();const originalInput=mainInput(),originalSelection=selectMain();
 expect(originalInput.files?.[0]).toBe(originalSelection);expect(originalInput.value).toBe(`C:\\fakepath\\${originalSelection.name}`);expectDirty(true);
 submitUpload();await flush();const original=readUploadRecords(localStorage,scope)[0];await expire();
 fireEvent.click(checkButton());await flush();expect(readUploadRecords(localStorage,scope)).toEqual([]);
 // Positive control: verified own settlement must clear the modeled native selection and React dirty guard.
 expect(mainInput()).toBe(originalInput);expect(originalInput.files?.length ?? 0).toBe(0);expect(originalInput.value).toBe('');expectDirty(false);
 expect(originalInput.closest('fieldset')!.disabled).toBe(false);expect(screen.getByText(/已核实文档已保存到本地/)).toBeTruthy();
 const selected=selectMain(file('next.md','SYNTHETIC_NEXT_UPLOAD'));submitUpload();await flush();
 const current=readUploadRecords(localStorage,scope)[0],raw=localStorage.getItem(key(current));expect(current.operationId).not.toBe(original.operationId);
 await act(async()=>old.resolve(saved(original)));expectPending(current,raw,selected);expect(checkButton().disabled).toBe(true);
 submitUpload();fireEvent.click(checkButton());expect(posts(fetcher)).toHaveLength(2);expect(checks(fetcher)).toHaveLength(1);
 await expire();expect(checkButton().disabled).toBe(false);expectPending(current,raw,selected);
});

it.each(['upload','check','retry'] as const)('bounds pending HTTP error body for %s and ignores its late rejection',async kind=>{
 const held=heldResponse('body',503);if(kind!=='upload')retainUploadRecord(localStorage,pending());
 const {fetcher}=setup(path=>(path.startsWith('/api/documents/upload?')||path.includes('/upload-operations/'))?held.result:undefined);
 await ready();const selected=kind==='upload'?selectMain():undefined;
 if(kind==='upload'){submitUpload();}else if(kind==='check')fireEvent.click(checkButton());else{fireEvent.change(screen.getByLabelText('为synthetic.md重新选择原文件'),{target:{files:[file()]}});fireEvent.click(retryButton());}
 await flush();const record=readUploadRecords(localStorage,scope)[0],raw=localStorage.getItem(key(record));await expire();
 expect(checkButton().disabled).toBe(false);expectPending(record,raw,selected);
 await act(async()=>held.reject(new Error('synthetic late body failure')));expectPending(record,raw,selected);expect(screen.queryByText('synthetic late body failure')).toBeNull();expect(checkButton().disabled).toBe(false);
 expect(posts(fetcher)).toHaveLength(kind==='check'?0:1);expect(checks(fetcher)).toHaveLength(kind==='check'?1:0);
});

it.each(['headers','body'] as const)('unmount fences pending %s before a fresh different-store page, without settling either journal',async phase=>{
 const held=heldResponse(phase);let signal:AbortSignal|null|undefined;
 const first=setup((path,init)=>{if(path.startsWith('/api/documents/upload?')){signal=init?.signal;return held.result;}});
 await ready();selectMain();submitUpload();await flush();const original=readUploadRecords(localStorage,scope)[0],raw=localStorage.getItem(key(original));first.unmount();expect(signal?.aborted).toBe(true);
 const foreign={...pending(),scope:otherScope};retainUploadRecord(localStorage,foreign);vi.useRealTimers();const second=setup(()=>undefined,otherScope);await ready();const selected=selectMain(file('different-store.md'));
 await act(async()=>held.resolve(saved(original)));expectPending(original,raw,selected);expect(readUploadRecords(localStorage,otherScope)).toEqual([foreign]);
 expect(checkButton().disabled).toBe(false);expect(posts(second.fetcher)).toHaveLength(0);expect(checks(second.fetcher)).toHaveLength(0);expect(screen.queryByText(/本次等待已超时/)).toBeNull();
});

it('does not add a global timeout to an unrelated pending folder action',async()=>{
 const held=heldResponse('headers');let signal:AbortSignal|null|undefined;
 setup((path,init)=>{if(path==='/api/documents/folders'){signal=init?.signal;return held.result;}});await ready();
 const input=screen.getByLabelText('新文件夹名称') as HTMLInputElement;fireEvent.change(input,{target:{value:'synthetic folder'}});fireEvent.submit(input.closest('form')!);await flush();
 await expire();await expire();expect(signal?.aborted).toBe(false);expect(input.closest('fieldset')!.disabled).toBe(true);expect(input.value).toBe('synthetic folder');expect(screen.queryByText(/本次等待已超时/)).toBeNull();
 await act(async()=>held.resolve({folder:{id:folderId,name:'synthetic folder',workspaceId:null}}));expect(input.closest('fieldset')!.disabled).toBe(false);expect(screen.getByText('本地文件夹已创建')).toBeTruthy();
});

it('uses one deadline across headers and body rather than resetting the budget',async()=>{
 const held=heldResponse('headers');const {fetcher}=setup(path=>path.startsWith('/api/documents/upload?')?held.result:undefined);
 await ready();const selected=selectMain();submitUpload();await flush();const record=readUploadRecords(localStorage,scope)[0],raw=localStorage.getItem(key(record));
 await act(async()=>{await vi.advanceTimersByTimeAsync(DOCUMENT_UPLOAD_ATTEMPT_TIMEOUT_MS-1);});
 expect(checkButton().disabled).toBe(true);await act(async()=>held.releaseHeaders());expect(held.read).toHaveBeenCalledOnce();
 await act(async()=>{await vi.advanceTimersByTimeAsync(1);});expect(checkButton().disabled).toBe(false);expectPending(record,raw,selected);
 expect(posts(fetcher)).toHaveLength(1);expect(checks(fetcher)).toHaveLength(0);
});

it.each(['upload','retry'] as const)('does not dispatch a late %s after file preparation outlives its attempt',async kind=>{
 const bytes=deferred<ArrayBuffer>();if(kind==='retry')retainUploadRecord(localStorage,pending());
 const {fetcher}=setup(()=>undefined);await ready();
 const selected=new File([content],'synthetic.md');Object.defineProperty(selected,'arrayBuffer',{value:()=>bytes.promise});
 if(kind==='upload'){selectMain(selected);submitUpload();}else{fireEvent.change(screen.getByLabelText('为synthetic.md重新选择原文件'),{target:{files:[selected]}});fireEvent.click(retryButton());}
 await flush();await expire();expect(mainInput().closest('fieldset')!.disabled).toBe(false);
 await act(async()=>bytes.resolve(new TextEncoder().encode(content).buffer));expect(posts(fetcher)).toHaveLength(0);expect(checks(fetcher)).toHaveLength(0);
 expect(readUploadRecords(localStorage,scope)).toEqual(kind==='retry'?[pending()]:[]);
 if(kind==='upload'){
  expect(mainInput().files?.[0]).toBe(selected);expect(mainInput().value).toBe(`C:\\fakepath\\${selected.name}`);expectDirty(true);
 }else expect(retryButton().disabled).toBe(false);
});

// G01 representative terminal recovery paths. Source-authored only, NOT executed.
// Independent cases release the single expired response either before or after
// current verified settlement; a resolved promise is never treated as deliverable twice.
const terminalRecoveryCases = [
 ['check','headers','during-recovery'], ['check','body','during-recovery'],
 ['check','headers','after-commit'], ['check','body','after-commit'],
 ['retry','headers','during-recovery'], ['retry','body','during-recovery'],
 ['retry','headers','after-commit'], ['retry','body','after-commit'],
] as const;

it.each(terminalRecoveryCases)('settles timed-out %s through explicit same-operation recovery after %s expiry, with stale delivery %s',async(kind,phase,lateAt)=>{
 const record:UploadRecord={...pending(),workspaceId:'original-workspace',folderId};
 const unrelated:UploadRecord={...pending(),operationId:'70000000-0000-4000-8000-000000000007',name:'unrelated.md',createdAt:'2026-10-22T12:00:01.000Z'};
 const foreign:UploadRecord={...pending(),scope:otherScope,operationId:'80000000-0000-4000-8000-000000000008',name:'foreign.md'};
 for(const item of [record,unrelated,foreign])retainUploadRecord(localStorage,item);
 const raw=new Map([record,unrelated,foreign].map(item=>[key(item),localStorage.getItem(key(item))]));
 const expired=heldResponse(phase),current=heldResponse('body'),otherCurrent=heldResponse('body');
 const signals:Array<AbortSignal|null|undefined>=[];let otherSignal:AbortSignal|null|undefined;
 const {fetcher}=setup((path,init)=>{
  if(path===`/api/documents/upload-operations/${unrelated.operationId}`){otherSignal=init?.signal;return otherCurrent.result;}
  if(kind==='check'?path===`/api/documents/upload-operations/${record.operationId}`:path.startsWith('/api/documents/upload?')){
   signals.push(init?.signal);if(signals.length>2)throw Error('Unexpected automatic or duplicate recovery');
   return signals.length===1?expired.result:current.result;
  }
 });
 await ready();const removals=vi.spyOn(Storage.prototype,'removeItem');
 const button=(item:UploadRecord,name:string)=>within(screen.getByRole('heading',{name:item.name}).parentElement!).getByRole('button',{name}) as HTMLButtonElement;
 const check=(item:UploadRecord)=>button(item,'核对上传结果');
 const retry=(item:UploadRecord)=>button(item,'用原操作重试上传');
 const chooseRetry=(item:UploadRecord)=>{const selected=file(item.name);fireEvent.change(screen.getByLabelText(`为${item.name}重新选择原文件`),{target:{files:[selected]}});return selected;};
 const originalFile=chooseRetry(record);chooseRetry(unrelated);
 let selected=selectMain(file('newer-main.md','SYNTHETIC_UNRELATED_MAIN_DRAFT'));
 const expectMain=()=>{expect(mainInput().files?.[0]).toBe(selected);expect(mainInput().value).toBe(`C:\\fakepath\\${selected.name}`);expectDirty(true);};
 const expectJournal=(settled:boolean)=>{
  expect(readUploadRecords(localStorage,scope)).toEqual(settled?[unrelated]:[record,unrelated]);
  expect(readUploadRecords(localStorage,otherScope)).toEqual([foreign]);
  for(const item of [record,unrelated,foreign])expect(localStorage.getItem(key(item))).toBe(settled&&item===record?null:raw.get(key(item)));
  expect(removals.mock.calls).toEqual(settled?[[key(record)]]:[]);expectMain();
 };
 const expectRequests=(attempts:number,otherChecks=0)=>{
  expect(checks(fetcher)).toHaveLength((kind==='check'?attempts:0)+otherChecks);
  expect(posts(fetcher)).toHaveLength(kind==='retry'?attempts:0);
 };
 const expectNoStaleNotice=()=>{
  expect(screen.queryByText(/已核实文档已保存到本地/)).toBeNull();
  expect(screen.queryByText(/已核实原上传已保存，目前在文档回收站/)).toBeNull();
  expect(screen.queryByText(/本次等待已超时/)).toBeNull();expect(screen.queryByRole('alert')).toBeNull();
 };
 // Both snapshots carry one immutable server receipt, distinct from journal time.
 // Only live document state differs after an intervening restore elsewhere.
 const committed=saved(record);
 committed.receipt.createdAt='2026-10-22T12:01:00.000Z';
 const staleResult={...committed,document:{...committed.document,trashedAt:'2026-10-23T01:00:00.000Z'}};
 const releaseExpired=async()=>{
  await act(async()=>expired.resolve(staleResult));await flush();
  if(phase==='headers'){expect(expired.read).not.toHaveBeenCalled();expect(expired.cancel).toHaveBeenCalledOnce();}
  else{expect(expired.read).toHaveBeenCalledOnce();expect(expired.cancel).not.toHaveBeenCalled();}
 };
 // A retained destination differs from today's empty picker state. A retry must
 // use the journal's destination and the verified File object, never this draft.
 expect((screen.getByLabelText('工作区') as HTMLSelectElement).value).toBe('');
 expect((screen.getByLabelText('本地文件夹') as HTMLSelectElement).value).toBe('');
 expectRequests(0);const initialRequests=fetcher.mock.calls.length;
 fireEvent.click(kind==='check'?check(record):retry(record));await flush();
 expectRequests(1);expect(fetcher.mock.calls).toHaveLength(initialRequests+1);expectJournal(false);
 expect(check(record).disabled).toBe(true);expect(mainInput().closest('fieldset')!.disabled).toBe(true);
 await expire();expect(signals[0]?.aborted).toBe(true);expectJournal(false);
 expect(check(record).disabled).toBe(false);expect(retry(record).disabled).toBe(false);expect(retry(unrelated).disabled).toBe(false);
 expect(mainInput().closest('fieldset')!.disabled).toBe(false);expect(screen.getByText(/本次等待已超时/)).toBeTruthy();
 await expire();expectRequests(1);expect(fetcher.mock.calls).toHaveLength(initialRequests+1);expectJournal(false);

 fireEvent.click(kind==='check'?check(record):retry(record));await flush();expectRequests(2);expectJournal(false);
 expect(fetcher.mock.calls).toHaveLength(initialRequests+2);expect(signals).toHaveLength(2);expect(signals[1]?.aborted).toBe(false);
 expectNoStaleNotice();expect(check(record).disabled).toBe(true);expect(retry(unrelated).disabled).toBe(true);
 if(kind==='retry'){
  const expectedPath=`/api/documents/upload?${new URLSearchParams({name:record.name,workspaceId:record.workspaceId!,folderId:record.folderId!})}`;
  for(const [path,init] of posts(fetcher)){
   expect(String(path)).toBe(expectedPath);expect(init?.method).toBe('POST');expect(init?.body).toBe(originalFile);
   const headers=new Headers(init?.headers);expect(headers.get('Content-Type')).toBe('application/octet-stream');
   expect(headers.get('X-Upload-Operation-Id')).toBe(record.operationId);expect(headers.get('X-Upload-Store-Id')).toBe(record.scope);
   const bytes=new Uint8Array(await (init!.body as File).arrayBuffer());
   // Compare byte values across the JSDOM Uint8Array and Node TextEncoder realms.
   expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode(content)));expect(bytes.byteLength).toBe(record.bytes);
   expect(createHash('sha256').update(bytes).digest('hex')).toBe(record.sha256);
  }
 }else for(const [path,init] of checks(fetcher)){expect(String(path)).toBe(`/api/documents/upload-operations/${record.operationId}`);expect(init?.body).toBeUndefined();}
 if(lateAt==='during-recovery'){
  await releaseExpired();expectJournal(false);expectNoStaleNotice();expect(check(record).disabled).toBe(true);
  expect(mainInput().closest('fieldset')!.disabled).toBe(true);expect(signals[1]?.aborted).toBe(false);
  fireEvent.click(check(record));fireEvent.click(retry(record));fireEvent.click(check(unrelated));submitUpload();await flush();
  expectRequests(2);expect(fetcher.mock.calls).toHaveLength(initialRequests+2);
 }
 await act(async()=>current.resolve(committed));await flush();expectJournal(true);
 expect(current.read).toHaveBeenCalledOnce();expect(signals[1]?.aborted).toBe(false);
 expect(screen.queryByRole('heading',{name:record.name})).toBeNull();expect(screen.queryByLabelText(`为${record.name}重新选择原文件`)).toBeNull();
 expect(check(unrelated).disabled).toBe(false);expect(retry(unrelated).disabled).toBe(false);expect(mainInput().closest('fieldset')!.disabled).toBe(false);
 expect(screen.getAllByText(/已核实文档已保存到本地/)).toHaveLength(1);expect(screen.queryByRole('alert')).toBeNull();
 expect(fetcher.mock.calls.filter(([path])=>String(path).startsWith('/api/documents?'))).toHaveLength(2);
 expectRequests(2);expect(fetcher.mock.calls).toHaveLength(initialRequests+3);
 const success=screen.getByText(/已核实文档已保存到本地/).textContent;
 await expire();expectJournal(true);expect(fetcher.mock.calls).toHaveLength(initialRequests+3);expect(screen.getByText(/已核实文档已保存到本地/).textContent).toBe(success);

 // After settlement, a later main selection and a different current operation
 // must not be cleared or unlocked by the expired original response.
 selected=selectMain(file('later-main.md','SYNTHETIC_LATER_MAIN_DRAFT'));expectMain();
 fireEvent.click(check(unrelated));await flush();expectRequests(2,1);expectNoStaleNotice();
 expect(check(unrelated).disabled).toBe(true);expect(mainInput().closest('fieldset')!.disabled).toBe(true);expect(otherSignal?.aborted).toBe(false);
 if(lateAt==='after-commit')await releaseExpired();
 expectJournal(true);expectNoStaleNotice();expect(check(unrelated).disabled).toBe(true);expect(retry(unrelated).disabled).toBe(true);
 expect(mainInput().closest('fieldset')!.disabled).toBe(true);expect(otherSignal?.aborted).toBe(false);
 fireEvent.click(check(unrelated));fireEvent.click(retry(unrelated));submitUpload();await flush();
 expectRequests(2,1);expect(fetcher.mock.calls).toHaveLength(initialRequests+4);
 await act(async()=>otherCurrent.resolve({scope,operationId:unrelated.operationId,outcome:'absent'}));await flush();expectJournal(true);
 expect(screen.getByText(/不能据此认定上传失败/)).toBeTruthy();expect(screen.queryByText(/已核实文档已保存到本地/)).toBeNull();
 expect(check(unrelated).disabled).toBe(false);expect(retry(unrelated).disabled).toBe(false);expect(mainInput().closest('fieldset')!.disabled).toBe(false);
 await expire();expectJournal(true);expectRequests(2,1);expect(fetcher.mock.calls).toHaveLength(initialRequests+4);

 // Test-owned cross-tab reintroduction is only a retry-cache probe, after all
 // stale-response assertions above. It is not a claim that production recreates
 // a settled journal: the completed row must not inherit its former retry File.
 retainUploadRecord(localStorage,record);
 act(()=>window.dispatchEvent(new StorageEvent('storage',{key:key(record),newValue:raw.get(key(record))!})));
 expect(readUploadRecords(localStorage,scope)).toEqual([record,unrelated]);
 for(const item of [record,unrelated,foreign])expect(localStorage.getItem(key(item))).toBe(raw.get(key(item)));
 expect(retry(record).disabled).toBe(true);expect(retry(unrelated).disabled).toBe(false);expectMain();
 expect(removals.mock.calls).toEqual([[key(record)]]);expectRequests(2,1);expect(fetcher.mock.calls).toHaveLength(initialRequests+4);
});
