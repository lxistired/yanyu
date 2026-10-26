// Actual fake-IDB store/session/controller + real recovery UI. Hardware and transport are inert injections.
// No microphone, playback, HTTP/browser session, private audio, or generated acceptance artifact.
import React,{StrictMode} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {IDBFactory} from 'fake-indexeddb';
import {Blob as NodeBlob,File as NodeFile} from 'node:buffer';
import {webcrypto} from 'node:crypto';
import {RecordingDrafts,type RecordingServices} from '../candidate/src/components/RecordingDrafts';
import {RecordingDraftStore,prepareCompletedDraft,prepareRecordingReservation,createRecordingClockGuard,CheckpointError} from '../candidate/src/recording/recording-draft-store';
import {createCheckpointSession,type CheckpointSink} from '../candidate/src/recording/checkpoint-session';
import {createRecordingController,type RecordingController} from '../candidate/src/recording/controller.mjs';
import {createMonoPcm16WavBuilder} from '../candidate/src/recording/pcm-wav';
const now=1_800_000_000_000,limits={maxDurationSeconds:2,maxWavBytes:64044};
const stores:RecordingDraftStore[]=[],controllers:RecordingController[]=[],timerSets:Map<number,()=>void>[]=[];
beforeEach(()=>{vi.stubGlobal('Blob',NodeBlob);vi.stubGlobal('File',NodeFile);vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('fetch',vi.fn(()=>{throw Error('No network in checkpoint convergence');}));});
afterEach(()=>{cleanup();controllers.splice(0).forEach(c=>c.dispose());timerSets.splice(0).forEach(t=>expect(t.size).toBe(0));stores.splice(0).forEach(s=>s.close());expect(fetch).not.toHaveBeenCalled();vi.restoreAllMocks();vi.unstubAllGlobals();});
function hardware(sink:CheckpointSink,beforeAcquire:()=>Promise<void>){
 // These are not timer-fault tests. Do not race wall-clock deadlines against fake-IDB scheduling.
 const timerJobs=new Map<number,()=>void>();let timerId=0;timerSets.push(timerJobs);
 const track={readyState:'live',stop:vi.fn(function(){track.readyState='ended';}),addEventListener:vi.fn(),removeEventListener:vi.fn()};
 const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
 const port={onmessage:null as null|((event:{data:unknown})=>void),postMessage:vi.fn(),close:vi.fn()};
 const worklet={port,connect:vi.fn(),disconnect:vi.fn()},source={connect:vi.fn(),disconnect:vi.fn()},gain={gain:{value:1},connect:vi.fn(),disconnect:vi.fn()};
 const context={sampleRate:16000,state:'running',destination:{},onstatechange:null,close:vi.fn(async()=>{context.state='closed';}),createMediaStreamSource:()=>source,createGain:()=>gain};
 const acquire=vi.fn(async()=>{await beforeAcquire();return stream as unknown as MediaStream;});
 const controller=createRecordingController({checkpointSink:sink,getUserMedia:acquire,createAudioContext:()=>context as unknown as AudioContext,prepareWorklet:async()=>worklet as unknown as AudioWorkletNode,createEncoder:createMonoPcm16WavBuilder,timers:{setTimeout:f=>{const id=++timerId;timerJobs.set(id,f);return id;},clearTimeout:id=>{timerJobs.delete(id as number);}},visibility:{isHidden:()=>false,subscribe:()=>()=>{}},pagehide:{subscribe:()=>()=>{}}});controllers.push(controller);
 let sequence=0;const chunks:Int16Array[]=[];
 const feed=(frames:number)=>{for(let start=0;start<frames;start+=128){const pcm=Int16Array.from({length:Math.min(128,frames-start)},(_,i)=>((start+i+sequence)%65536)-32768);chunks.push(pcm.slice());port.onmessage?.({data:{type:'chunk',seq:sequence++,pcm}});}};
 const final=()=>port.onmessage?.({data:{type:'final',chunkCount:sequence,totalFrames:chunks.reduce((n,c)=>n+c.length,0),reason:'user-stop'}});
 const acknowledge=(type:'paused'|'resumed')=>port.onmessage?.({data:{type,chunkCount:sequence,totalFrames:chunks.reduce((n,c)=>n+c.length,0)}});
 return{controller,acquire,track,feed,final,chunks,acknowledge};
}
async function opened(factory:IDBFactory,guard:ReturnType<typeof createRecordingClockGuard>){const store=await RecordingDraftStore.open(factory,()=>now,{clockGuard:guard});stores.push(store);return store;}
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name,exact:true}));
it.each(['ordinary','pause-resume','stop-paused'])('opt-in actual store/session/controller/UI full+tail recovery: %s',async mode=>{
 const factory=new IDBFactory(),guard=createRecordingClockGuard();let current:RecordingDraftStore|undefined,h:ReturnType<typeof hardware>|undefined;
 const selected=vi.fn((_value:unknown)=>true);
 const runtime:RecordingServices={openStore:async()=>current=await opened(factory,guard),prepare:prepareCompletedDraft,now:()=>now,clockGuard:guard,createController:options=>{
  expect(options?.checkpointSink).toBeTruthy();const sink=options!.checkpointSink!;
  h=hardware(sink,async()=>{const reserved=await current!.inspectCheckpoint(sink.identity);expect(reserved?.committedFrames).toBe(0);expect(reserved?.limits).toEqual(sink.limits);});return h.controller;
 }};
 const view=render(<StrictMode><RecordingDrafts limits={limits} disabled={false} runtime={runtime} onSelect={selected}/></StrictMode>);
 expect(current).toBeUndefined();expect(h).toBeUndefined();expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
 fireEvent.click(screen.getByRole('checkbox'));click('开始录音');await waitFor(()=>expect(h?.controller.getSnapshot().state).toBe('recording'));
 act(()=>h!.feed(16000));await waitFor(()=>expect(h!.controller.getSnapshot().persistedFrames).toBe(16000));
 if(mode!=='ordinary'){
  click('暂停录音');expect(screen.getByText('录音状态：正在请求暂停')).toBeTruthy();expect(screen.queryByRole('button',{name:'继续录音',exact:true})).toBeNull();
  expect(screen.getByText(/暂停期间不保存新音频，但麦克风仍占用/)).toBeTruthy();
  act(()=>h!.acknowledge('paused'));expect(screen.getByText('录音状态：已暂停采集')).toBeTruthy();expect(h!.track.stop).not.toHaveBeenCalled();
  if(mode==='pause-resume'){
   click('继续录音');expect(screen.getByText('录音状态：正在请求继续')).toBeTruthy();act(()=>h!.acknowledge('resumed'));expect(screen.getByText('录音状态：录音中')).toBeTruthy();
  }
 }
 act(()=>{if(mode!=='stop-paused')h!.feed(145);click('停止录音');h!.final();});await waitFor(()=>expect(h!.controller.getSnapshot().persistenceStatus).toBe('sealed'));
 const frames=mode==='stop-paused'?16000:16145;
 const snap=h!.controller.getSnapshot();expect(snap.receivedFrames).toBe(frames);expect(snap.persistedFrames).toBe(frames);
 if(mode!=='ordinary')expect(screen.getByText(/本次确认暂停 1 次/)).toBeTruthy();
 const expected=createMonoPcm16WavBuilder({maxDurationSeconds:2,maxBytes:64044});h!.chunks.forEach(p=>expected.appendPcm16(p));const wav=expected.finalize(frames).bytes;
 expect(snap.artifact).toEqual(wav);expect(selected).not.toHaveBeenCalled();const firstAcquire=h!.acquire;expect(firstAcquire).toHaveBeenCalledOnce();
 view.unmount();const noCapture=vi.fn(()=>{throw Error('Recovery must not construct a controller');});
 render(<RecordingDrafts limits={limits} disabled={false} runtime={{...runtime,createController:noCapture}} onSelect={selected}/>);
 click('读取或刷新本机草稿架');await screen.findByText(/已封存分段录音/);click('选用此分段快照作为待上传文件');
 expect(selected).toHaveBeenCalledOnce();const choice=selected.mock.calls[0][0] as any;expect(choice.checkpoint).toBe(true);expect(choice.expiresAt).toBe(now+86400000);expect(new Uint8Array(await choice.file.arrayBuffer())).toEqual(wav);expect(noCapture).not.toHaveBeenCalled();expect(firstAcquire).toHaveBeenCalledOnce();
},15000);
it('actual committed append with dropped outward ACK remains uncertain until exact session reconciliation, partial recovery and non-resurrecting delete',async()=>{
 const factory=new IDBFactory(),guard=createRecordingClockGuard(),store=await opened(factory,guard);
 const token=prepareRecordingReservation({preserveDuringCapture:true,limits},now),reserved=await store.reserveRecording(token),session=createCheckpointSession(store,reserved);
 const real=store.appendSegment.bind(store);let drop=true;const delivered=vi.spyOn(store,'appendSegment').mockImplementation(async(...args)=>{const receipt=await real(...args);if(drop){drop=false;throw new CheckpointError('uncertain','unknown');}return receipt;});
 const h=hardware(session.sink,async()=>{expect(await store.inspectCheckpoint(session.sink.identity)).not.toBeNull();});await h.controller.start(limits);h.feed(16000);
 await waitFor(()=>expect(h.controller.getSnapshot().error).toBe('persistence-failed'));expect(h.track.stop).toHaveBeenCalled();expect(h.controller.getSnapshot().persistenceStatus).toBe('uncertain');expect(h.controller.getSnapshot().persistedFrames).toBe(0);expect(session.getReceipt().committedFrames).toBe(0);
 const committed=await store.inspectCheckpoint(session.sink.identity);expect(committed?.committedFrames).toBe(16000);expect(committed?.status).toBe('capturing');
 const receipt=await session.reconcile();expect(receipt.result).toBe('already-committed');expect(receipt.revision).toBe(committed!.revision);expect(receipt.committedFrames).toBe(16000);expect(delivered.mock.calls[1][0]).toBe(delivered.mock.calls[0][0]);expect(delivered.mock.calls[1][1]).toBe(delivered.mock.calls[0][1]);expect(h.acquire).toHaveBeenCalledOnce();
 h.controller.dispose();const selected=vi.fn((_value:unknown)=>true),noCapture=vi.fn(()=>{throw Error('Recovery cannot reacquire');});
 const runtime:RecordingServices={openStore:()=>opened(factory,guard),prepare:prepareCompletedDraft,now:()=>now,clockGuard:guard,createController:noCapture};
 render(<RecordingDrafts limits={limits} disabled={false} runtime={runtime} onSelect={selected}/>);click('读取或刷新本机草稿架');await screen.findByText(/中断录音的已保存部分/);expect(selected).not.toHaveBeenCalled();click('选用此分段快照作为待上传文件');
 expect(selected).toHaveBeenCalledOnce();const choice=selected.mock.calls[0][0] as any;expect(choice.file.name).toBe('recording-recovered-partial.wav');expect(choice.checkpoint).toBe(true);expect(choice.expiresAt).toBe(reserved.receipt.expiresAt);const expected=createMonoPcm16WavBuilder({maxDurationSeconds:2,maxBytes:64044});h.chunks.forEach(p=>expected.appendPcm16(p));expect(new Uint8Array(await choice.file.arrayBuffer())).toEqual(expected.finalize(16000).bytes);expect(noCapture).not.toHaveBeenCalled();
 const removed=await store.removeCheckpoint({schema:2,id:receipt.id,writerEpoch:receipt.writerEpoch,revision:receipt.revision});expect(removed.removed).toBe(true);expect(await store.inspectCheckpoint(session.sink.identity)).toBeNull();await expect(store.reserveRecording(token)).rejects.toMatchObject({code:'retired'});expect(await store.inspectCheckpoint(session.sink.identity)).toBeNull();expect(h.acquire).toHaveBeenCalledOnce();
},15000);
