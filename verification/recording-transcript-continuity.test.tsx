import {initialUploadAccepted} from './initial-upload-fixture';
// Coherent frontend flow with real RecordingDrafts/store, LocalTranscription,
// FailedTranscriptionRetry and TranscriptEditor. Synthetic transport only.
import React from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {IDBFactory} from 'fake-indexeddb';
import {Blob as NodeBlob,File as NodeFile} from 'node:buffer';
import {webcrypto} from 'node:crypto';
import {LocalTranscription} from '../candidate/src/components/LocalTranscription';
import {RecordingDraftStore,prepareCompletedDraft} from '../candidate/src/recording/recording-draft-store';
import {createMonoPcm16WavBuilder} from '../candidate/src/recording/pcm-wav';
import {fixtureStoreHeaders,fixtureStoreUrl,FIXTURE_STORE_ID} from './transcription-store-fixture';
const parent='11111111-1111-4111-8111-111111111111',child='22222222-2222-4222-8222-222222222222';
const model={maxSeconds:60,maxBytes:1920044,chunkSeconds:30,overlapSeconds:1,deadlineSeconds:120};
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name,exact:true}));
const reply=(data:unknown,status=200)=>({headers:fixtureStoreHeaders(),ok:status<300,status,json:async()=>data});
let factory:IDBFactory;
beforeEach(()=>{
 factory=new IDBFactory();vi.stubGlobal('indexedDB',factory);vi.stubGlobal('Blob',NodeBlob);vi.stubGlobal('File',NodeFile);vi.stubGlobal('crypto',webcrypto);
 history.replaceState(null,'',fixtureStoreUrl());
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn(()=>{throw Error('No microphone permitted');})}});
});
afterEach(()=>{cleanup();expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function savedRecording(){
 const encoder=createMonoPcm16WavBuilder({maxDurationSeconds:1,maxBytes:32044});
 encoder.appendPcm16(Int16Array.from({length:160},(_,i)=>i-80));const bytes=encoder.finalize(160).bytes;
 const store=await RecordingDraftStore.open(factory);
 await store.preserve(await prepareCompletedDraft({preserve:true,blob:new Blob([bytes],{type:'audio/wav'}),durationSeconds:0.01}));store.close();return bytes;
}
it('saved draft → explicit upload ACK → interrupted resume → failed-parent retry recovery → child transcript',async()=>{
 const bytes=await savedRecording();let state:'empty'|'interrupted'|'failed'='empty',committed=false;
 let original:File|undefined,retried:File|undefined;
 const job=(id:string,status:string)=>({id,filename:'recording.wav',title:id===parent?'Saved recording parent':'Recovered recording child',status,requested_language:'zh',created:'2026-10-23T09:00:00Z',library_revision:1,deleted_at:null,error:null,uploadOrigin:'recording-draft',uploadOriginAssurance:'client-declared',result:status==='completed'?{text:'Synthetic recovered transcript.',duration_seconds:0.01,inference_seconds:0.1,language:'zh'}:null});
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
  expect(new Headers(init?.headers).get('X-Transcription-Store-Id')).toBe(FIXTURE_STORE_ID);
  if(url==='/api/local-asr/transcribe') {original=init?.body as File;expect(new Headers(init?.headers).get('X-Audio-Origin')).toBe('recording-draft');expect(new Headers(init?.headers).get('X-Audio-Language')).toBe('zh');state='interrupted';return initialUploadAccepted(init!,{id:parent});}
  if(url===`/api/local-asr/jobs/${parent}/resume`) {state='failed';return reply({id:parent,status:'processing'},202);}
  if(url===`/api/local-asr/jobs/${parent}/retry`) {
   if(init?.method==='POST'){retried=init.body as File;expect(new Uint8Array(await retried.arrayBuffer())).toEqual(new Uint8Array(await original!.arrayBuffer()));expect(new Headers(init.headers).get('X-Audio-Language')).toBe('zh');committed=true;throw Error('Synthetic lost retry ACK after child commit');}
   return reply(committed?{parentId:parent,state:'created',reconciliationFinal:true,child:{id:child,status:'completed'},eligible:false}:{parentId:parent,state:'uncommitted',reconciliationFinal:false,child:null,eligible:true});
  }
  if(url===`/api/local-asr/jobs/${child}/transcript`)return reply({raw:'Synthetic recovered transcript.',corrected:null,revision:0,updated:null});
  if(url.startsWith('/api/local-asr/jobs?')){
   const filter=new URL(url,'http://localhost').searchParams.get('jobId');const jobs=filter===child?[job(child,'completed')]:state==='empty'?[]:[job(parent,state)];
   return reply({jobs,model,total:jobs.length,offset:0,limit:10,hasMore:false,activeJobCount:0});
  }
  throw Error(`Unexpected synthetic route: ${url}`);
 });vi.stubGlobal('fetch',fetcher);
 let view=render(<LocalTranscription/>);await screen.findByText('还没有转写记录');
 click('读取或刷新本机草稿架');await screen.findByText(/录音草稿 · 0.01 秒/);click('选用此草稿作为待上传文件');
 expect(fetcher.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);
 fireEvent.change(screen.getByLabelText('识别语言'),{target:{value:'zh'}});click('上传并本地转写');
 await screen.findByRole('link',{name:'查看新提交任务'});await screen.findByRole('button',{name:'从已保存分段继续'});
 expect(screen.queryByText(/待上传：/)).toBeNull();expect(new Uint8Array(await original!.arrayBuffer())).toEqual(bytes);
 expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/resume'))).toHaveLength(0);
 click('从已保存分段继续');await screen.findByRole('button',{name:'核对重试资格与结果'});
 // The original draft is retained; selecting it must not create a new ordinary job.
 click('选用此草稿作为待上传文件');click('核对重试资格与结果');await screen.findByText(/可重新选择原文件/);
 expect((screen.getByRole('button',{name:'用原文件重试此失败任务'}) as HTMLButtonElement).disabled).toBe(true);
 click('将上方已选录音移入此任务重试');
 expect(screen.queryByText(/待上传：/)).toBeNull();expect(screen.getByText(/待重新上传：recording.wav/)).toBeTruthy();
 click('用原文件重试此失败任务');await screen.findByRole('button',{name:'核对重试结果'});
 expect(screen.queryByText(/待重新上传：/)).toBeNull();click('核对重试结果');
 const link=await screen.findByRole('link',{name:'查看重试任务'});const href=link.getAttribute('href')!;
 expect(new URL(href,'http://localhost').searchParams.get('transcriptJob')).toBe(child);
 expect(new URL(href,'http://localhost').searchParams.get('transcriptStoreId')).toBe(FIXTURE_STORE_ID);
 // Browser navigation is out of scope. Remount at the actual link destination.
 view.unmount();history.replaceState(null,'',href);view=render(<LocalTranscription/>);
 await screen.findByDisplayValue('Synthetic recovered transcript.');click('查看正文');expect(document.activeElement).toBe(screen.getByLabelText('校对文本'));
 expect(fetcher.mock.calls.filter(([url])=>url==='/api/local-asr/transcribe')).toHaveLength(1);
 expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/resume'))).toHaveLength(1);
 expect(fetcher.mock.calls.filter(([url,init])=>url.endsWith('/retry')&&init?.method==='POST')).toHaveLength(1);
 expect(retried).not.toBe(original);expect(new Uint8Array(await retried!.arrayBuffer())).toEqual(bytes);
 const store=await RecordingDraftStore.open(factory);expect((await store.restore()).drafts).toHaveLength(1);store.close();
 expect(document.querySelector('audio')).toBeNull();
},15000);

it('requires replacement consent and fresh explicit shelf transfer after an uncertain retry',async()=>{
 const bytes=await savedRecording();let posts=0;
 const eligible={parentId:parent,state:'uncommitted',reconciliationFinal:false,child:null,eligible:true};
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
  if(url.endsWith('/retry')){
   if(init?.method==='POST'){posts++;expect(new Uint8Array(await (init.body as File).arrayBuffer())).toEqual(bytes);return posts===1?reply({},500):reply({parentId:parent,id:child,status:'processing',replayed:false},202);}
   return reply(eligible);
  }
  if(url.startsWith('/api/local-asr/jobs?'))return reply({jobs:[{id:parent,filename:'original.wav',status:'failed',requested_language:'en',created:'2026-10-23',error:null,result:null}],model,total:1,activeJobCount:0});
  throw Error(`Unexpected route: ${url}`);
 });vi.stubGlobal('fetch',fetcher);render(<LocalTranscription/>);
 await screen.findByRole('button',{name:'核对重试资格与结果'});click('读取或刷新本机草稿架');await screen.findByText(/录音草稿 · 0.01 秒/);
 click('选用此草稿作为待上传文件');click('核对重试资格与结果');await screen.findByText(/可重新选择原文件/);
 const originalChoice=new File(['separate user selection'],'old-choice.wav');fireEvent.change(screen.getByLabelText('为此失败任务重新选择原文件'),{target:{files:[originalChoice]}});
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);click('将上方已选录音移入此任务重试');
 expect(confirm).toHaveBeenCalledOnce();expect(screen.getByText(/待上传：recording.wav/)).toBeTruthy();expect(screen.getByText(/待重新上传：old-choice.wav/)).toBeTruthy();expect(posts).toBe(0);
 confirm.mockReturnValue(true);click('将上方已选录音移入此任务重试');expect(screen.queryByText(/待上传：/)).toBeNull();expect(screen.getByText(/待重新上传：recording.wav/)).toBeTruthy();expect(posts).toBe(0);
 click('用原文件重试此失败任务');await screen.findByRole('button',{name:'核对重试结果'});expect(posts).toBe(1);expect(screen.queryByText(/待重新上传：/)).toBeNull();
 click('核对重试结果');await screen.findByRole('button',{name:'重新选择原文件以安全重试同一父任务'});
 click('选用此草稿作为待上传文件');expect((screen.getByRole('button',{name:'将上方已选录音移入此任务重试'}) as HTMLButtonElement).disabled).toBe(true);
 click('重新选择原文件以安全重试同一父任务');click('将上方已选录音移入此任务重试');expect(posts).toBe(1);
 click('用原文件重试此失败任务');await screen.findByRole('link',{name:'查看重试任务'});expect(posts).toBe(2);
 expect(fetcher.mock.calls.filter(([url,init])=>init?.method==='POST').every(([url])=>url===`/api/local-asr/jobs/${parent}/retry`)).toBe(true);
 expect(fetcher.mock.calls.some(([url])=>url==='/api/local-asr/transcribe')).toBe(false);
});

import {prepareRecordingReservation} from '../candidate/src/recording/recording-draft-store';
import {createCheckpointSession} from '../candidate/src/recording/checkpoint-session';
it('a recovered checkpoint keeps its TTL through transfer and blocks POST if it expires during preflight',async()=>{
 const started=1_800_000_000_000;const now=vi.spyOn(Date,'now').mockReturnValue(started);
 const store=await RecordingDraftStore.open(factory);const reserved=await store.reserveRecording(prepareRecordingReservation({preserveDuringCapture:true,limits:{maxDurationSeconds:2,maxWavBytes:64044}},started));
 await createCheckpointSession(store,reserved).sink.append({segmentIndex:0,startFrame:0,pcm:new Int16Array(16000)});store.close();
 let reads=0,finish!:(response:unknown)=>void;
 const eligible={parentId:parent,state:'uncommitted',reconciliationFinal:false,child:null,eligible:true};
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
  if(url.endsWith('/retry')){if(init?.method==='POST')throw Error('Expired checkpoint must never POST');if(++reads===1)return reply(eligible);return new Promise(resolve=>finish=resolve);}
  if(url.startsWith('/api/local-asr/jobs?'))return reply({jobs:[{id:parent,filename:'recording-recovered-partial.wav',status:'failed',requested_language:'en',created:'2026-10-23',error:null,result:null}],model,total:1,activeJobCount:0});
  throw Error(`Unexpected route: ${url}`);
 });vi.stubGlobal('fetch',fetcher);render(<LocalTranscription/>);await screen.findByRole('button',{name:'核对重试资格与结果'});
 click('读取或刷新本机草稿架');await screen.findByText(/中断录音的已保存部分/);click('选用此分段快照作为待上传文件');click('核对重试资格与结果');await screen.findByText(/可重新选择原文件/);
 click('将上方已选录音移入此任务重试');expect(screen.getByText(/待重新上传：recording-recovered-partial.wav/)).toBeTruthy();
 click('用原文件重试此失败任务');await waitFor(()=>expect(finish).toBeTypeOf('function'));
 now.mockReturnValue(reserved.receipt.expiresAt);await act(async()=>finish(reply(eligible)));
 await screen.findByText(/录音草稿已过期，不能用于重试/);expect(screen.getByText(/待重新上传：recording-recovered-partial.wav/)).toBeTruthy();
 expect(fetcher.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);
});
