// Inert page-session protocol verification only. No browser, microphone, playback,
// network, listener, actual decoder/recognition or persisted user data.
import React from 'react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {Blob as NodeBlob, File as NodeFile} from 'node:buffer';
import {createHash, webcrypto} from 'node:crypto';
import {LocalTranscription, hashUploadFile} from '../candidate/src/components/LocalTranscription';
import {createUploadReceipt} from '../backend/upload-receipts.mjs';
import {boundedTransport} from '../visual-harness/bounded-transport';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';

const recorder = vi.hoisted(() => ({selection:null as any}));
vi.mock('../candidate/src/components/RecordingDrafts', () => ({RecordingDrafts:({onSelect, disabled}:any) => <button disabled={disabled} onClick={() => onSelect(recorder.selection)}>选择模拟录音</button>}));
const scope='11111111-1111-4111-8111-111111111111', otherScope='22222222-2222-4222-8222-222222222222';
const job='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const model={maxSeconds:100,maxBytes:2097152,deadlineSeconds:100,chunkSeconds:30,overlapSeconds:1};
const bytes=Uint8Array.from({length:96},(_,i)=>i*17%256);
const sha=(input:Uint8Array)=>createHash('sha256').update(input).digest('hex');
const file=(data:Uint8Array=bytes)=>new NodeFile([data],'synthetic-upload.wav',{type:'audio/wav'}) as unknown as File;
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name,exact:true}));
const choose=(selected:File)=>fireEvent.change(screen.getByLabelText('选择音频文件'),{target:{files:[selected]}});
const disabled=(name:string)=>expect((screen.getByRole('button',{name,exact:true}) as HTMLButtonElement).disabled).toBe(true);
function harness(){
 const calls:{path:string;init:RequestInit}[]=[];
 let response:unknown=null, responseStatus=200, responseScope=scope, listScope=scope, losePost=true, postResponse:unknown=null, postStatus=200;
 const fetcher=vi.fn(async(input:any,init:RequestInit={})=>{
  const path=String(input); calls.push({path,init});
  if(path.startsWith('/api/local-asr/jobs?')) return new Response(JSON.stringify({jobs:[],model,total:0,activeJobCount:0}),{headers:{'X-Transcription-Store-Id':listScope}});
  if(!/^\/api\/local-asr\/transcribe(?:\?operationId=[a-f0-9-]{36})?$/.test(path))throw Error('Unexpected inert route '+path);
  if(init.method==='POST'&&losePost)throw Error('Deliberate transport ACK loss');
  return new Response(JSON.stringify(init.method==='POST'?postResponse:response),{status:init.method==='POST'?postStatus:responseStatus,headers:{'X-Transcription-Store-Id':responseScope}});
 });
 vi.stubGlobal('fetch',fetcher);
 return {fetcher,calls,posts:()=>calls.filter(c=>c.init.method==='POST'),
  set(value:unknown,status=200,scopeValue=scope){response=value;responseStatus=status;responseScope=scopeValue;},
  setPost(value:unknown,status=200){postResponse=value;postStatus=status;losePost=false;},
  setListScope(value:string){listScope=value;},
  committed(operationId:string,replayed:boolean,deleted=false){return {operationId,state:'committed',reconciliationFinal:true,id:job,status:'completed',filename:'synthetic-upload.wav',uploadOrigin:'file-selection',receipt:JSON.parse(createUploadReceipt({sha256:sha(bytes),byteLength:bytes.length,mime:'audio/wav',format:'wav',language:'zh',...model})),deleted,replayed};},
 };
}
beforeEach(()=>{
 vi.stubGlobal('File',NodeFile);vi.stubGlobal('Blob',NodeBlob);vi.stubGlobal('crypto',webcrypto);
 history.replaceState(null,'','/?transcriptStoreId='+scope);recorder.selection=null;
 vi.spyOn(window,'confirm').mockReturnValue(true);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();history.replaceState(null,'','/');});

it('hashes real File bytes with bounded slices across SHA padding and 1 MiB boundaries',async()=>{
 for(const size of [44,56,64,1048576+57]){
  const input=Uint8Array.from({length:size},(_,i)=>(i*131+19)%256),selected=file(input);
  const slice=vi.spyOn(selected,'slice');
  vi.spyOn(selected,'arrayBuffer').mockImplementation(()=>{throw Error('Unbounded File allocation forbidden');});
  expect(await hashUploadFile(selected)).toBe(sha(input));
  expect(slice.mock.calls.every(([start,end])=>(end!-start!)<=1048576)).toBe(true);
  expect(slice).toHaveBeenCalledTimes(Math.ceil(size/1048576));
 }
});

it('retains exact pending identity through misses, malformed ACK, filters and clear; explicitly replays and admits a later new operation',async()=>{
 const f=harness();render(<LocalTranscription/>);await screen.findByText('还没有转写记录');
 const selected=file();choose(selected);fireEvent.change(screen.getByLabelText('识别语言'),{target:{value:'zh'}});
 click('上传并本地转写');await screen.findByText(/上传未获确认。原文件和操作标识/);
 expect(f.posts()).toHaveLength(1);const first=f.posts()[0];const operationId=new Headers(first.init.headers).get('X-Upload-Operation-Id')!;
 expect(operationId).toMatch(/^[a-f0-9-]{36}$/);expect(first.init.body).toBe(selected);
 disabled('上传并本地转写');expect((screen.getByLabelText('选择音频文件') as HTMLInputElement).disabled).toBe(true);
 f.set({operationId,state:'unconfirmed',reconciliationFinal:false});click('核对本次上传结果');await screen.findByText(/尚未确认本次上传；未查到不代表未执行/);
 expect(f.posts()).toHaveLength(1);
 // Legacy success is never accepted as keyed proof or downgraded to ordinary POST.
 f.set({id:job,status:'processing'},200);click('用原操作重试上传');await screen.findByText(/上传回执与本次操作不符/);
 expect(f.posts()).toHaveLength(1);
 const wrong=f.committed(operationId,false);wrong.receipt.sha256='0'.repeat(64);f.set(wrong);click('核对本次上传结果');await waitFor(()=>expect(f.calls.filter(c=>c.path.includes('?operationId=')).length).toBe(3));
 expect(screen.queryByRole('link',{name:'查看新提交任务'})).toBeNull();expect(screen.getByLabelText('未确认上传核对').textContent).toContain(operationId);
 click('回收站');await screen.findByText('回收站为空');click('清除待上传文件');expect(screen.queryByText(/待上传：synthetic-upload.wav/)).toBeNull();
 expect(screen.getByLabelText('未确认上传核对').textContent).toContain(operationId);disabled('上传并本地转写');
 // A programmatic stale change cannot replace the retained immutable File.
 choose(file(new Uint8Array(90)));f.set({operationId,state:'unconfirmed',reconciliationFinal:false});f.setPost(f.committed(operationId,true));click('用原操作重试上传');
 await screen.findByRole('link',{name:'查看新提交任务'});expect(screen.queryByLabelText('未确认上传核对')).toBeNull();
 expect(f.posts()).toHaveLength(2);expect(f.posts()[1].init.body).toBe(selected);expect(new Headers(f.posts()[1].init.headers).get('X-Audio-Language')).toBe('zh');
 expect(f.posts().every(c=>new Headers(c.init.headers).get('X-Upload-Operation-Id')===operationId)).toBe(true);
 // An intentional same-byte upload after confirmation receives a fresh identity.
 choose(selected);f.setPost({id:job,status:'processing'},202);click('上传并本地转写');await screen.findByText(/上传未获确认。原文件和操作标识/);
 expect(f.posts()).toHaveLength(3);const secondId=new Headers(f.posts()[2].init.headers).get('X-Upload-Operation-Id')!;expect(secondId).not.toBe(operationId);
 f.set(f.committed(secondId,false,true));click('核对本次上传结果');await screen.findByText(/但任务已在回收站/);
 expect(screen.queryByRole('link',{name:'查看新提交任务'})).toBeNull();expect(screen.queryByLabelText('未确认上传核对')).toBeNull();
 expect(f.posts()).toHaveLength(3);
});


it('does not resend when a legacy service accepts the first POST but lacks exact reconciliation',async()=>{
 const f=harness();f.setPost({id:job,status:'processing'},202);render(<LocalTranscription/>);await screen.findByText('还没有转写记录');choose(file());click('上传并本地转写');await screen.findByText(/上传未获确认。原文件和操作标识/);
 f.set({error:{code:'NOT_FOUND'}},404);click('用原操作重试上传');await screen.findByText(/上传回执与本次操作不符/);expect(f.posts()).toHaveLength(1);expect(screen.getByLabelText('未确认上传核对')).toBeTruthy();disabled('上传并本地转写');
});

it('keeps an uncertain operation when scope fails and requires explicit abandonment confirmation',async()=>{
 const f=harness();render(<LocalTranscription/>);await screen.findByText('还没有转写记录');choose(file());click('上传并本地转写');await screen.findByText(/上传未获确认。原文件和操作标识/);
 const operationId=new Headers(f.posts()[0].init.headers).get('X-Upload-Operation-Id')!;
 f.set({operationId,state:'unconfirmed',reconciliationFinal:false},200,otherScope);click('核对本次上传结果');
 await waitFor(()=>disabled('核对本次上传结果'));expect(screen.getByLabelText('未确认上传核对').textContent).toContain(operationId);disabled('用原操作重试上传');
 vi.mocked(window.confirm).mockReturnValueOnce(false);click('放弃追踪本次上传');expect(screen.getByLabelText('未确认上传核对')).toBeTruthy();
 click('放弃追踪本次上传');expect(screen.queryByLabelText('未确认上传核对')).toBeNull();expect(vi.mocked(window.confirm).mock.lastCall?.[0]).toContain('不会取消已发出的上传或识别');expect(f.posts()).toHaveLength(1);
});

it.each(['selection','scope','recording expiry'] as const)('does not POST after asynchronous hashing loses its %s guard',async(reason)=>{
 const f=harness(),selected=file();let release!:(value:ArrayBuffer)=>void;
 const reading=new Promise<ArrayBuffer>(resolve=>{release=resolve;});
 vi.spyOn(selected,'slice').mockReturnValue({arrayBuffer:()=>reading} as Blob);
 render(<LocalTranscription/>);await screen.findByText('还没有转写记录');
 let expiry:number|undefined;
 if(reason==='recording expiry'){expiry=Date.now()+60000;recorder.selection={file:selected,expiresAt:expiry};click('选择模拟录音');}else choose(selected);
 click('上传并本地转写');expect(f.posts()).toHaveLength(0);
 if(reason==='selection'){click('回收站');await screen.findByText('回收站为空');}
 if(reason==='scope'){f.setListScope(otherScope);click('回收站');await screen.findByText(/本页不会自动切换来源/);}
 if(reason==='recording expiry')vi.spyOn(Date,'now').mockReturnValue(expiry!+1);
 await act(async()=>{release(bytes.slice().buffer);await reading;});
 if(reason!=='scope')await screen.findByText(reason==='selection'?/待上传选择或服务状态已变化/:/录音草稿已过期，不能上传/);
 expect(f.posts()).toHaveLength(0);
});

it('admits only the exact canonical operation lookup in the bounded transport',async()=>{
 const native=vi.fn(async()=>new Response('{}'));const transport=boundedTransport(new OrdinaryRequestLifetime(),native);
 const good='/api/local-asr/transcribe?operationId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 await transport(good);expect(native).toHaveBeenCalledTimes(1);
 for(const path of [good+'&extra=1',good+'&operationId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',good+'#fragment',good+'\n',good.replace('aaaaaaaa','AAAAAAAA')])expect((await transport(path)).status).toBe(503);
 expect((await transport(good,{method:'POST'})).status).toBe(503);expect(native).toHaveBeenCalledTimes(1);
});
