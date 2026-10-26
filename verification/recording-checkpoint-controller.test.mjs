import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingController, resolveCaptureLimits } from '../candidate/src/recording/controller.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import { createMonoPcm16WavBuilder } from '../candidate/src/recording/pcm-wav.ts';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
function fixture(options = {}) {
  let hidden = false, visibility, pagehide, gumCalls = 0, encoderCalls = 0;
  let time = 0, next = 0; const jobs = new Map();
  const timers = { setTimeout(fn, ms) { const id=++next; jobs.set(id,{at:time+ms,fn}); return id; }, clearTimeout(id) { jobs.delete(id); } };
  const advance = ms => { time+=ms; for(const [id,j] of [...jobs]) if(j.at<=time) { jobs.delete(id); j.fn(); } };
  const track = { readyState:'live', stopped:0, events:new Map(), stop(){this.stopped++;this.readyState='ended';}, addEventListener(k,f){this.events.set(k,f);},removeEventListener(k){this.events.delete(k);} };
  const extra = { stopped:0, stop(){this.stopped++;} };
  const stream = {getTracks:()=>[track,extra],getAudioTracks:()=>[track]};
  const links=[];
  const node = { port:{onmessage:null, sent:[], postMessage(m){this.sent.push(m);},close(){}}, connect(n){links.push(['worklet',n]);},disconnect(){} };
  const source={connect(n){links.push(['source',n]);},disconnect(){}};
  const gain={gain:{value:1},connect(n){links.push(['gain',n]);},disconnect(){}};
  const context={sampleRate:options.sampleRate??16000,state:'running',destination:{},onstatechange:null,close(){this.state='closed';return Promise.resolve();},createMediaStreamSource(){return source;},createGain(){return gain;}};
  const deps={getUserMedia(){gumCalls++;return options.permission?.promise??Promise.resolve(stream);},createAudioContext(){return context;},prepareWorklet(){return options.preparation?.promise??Promise.resolve(node);},timers,
    visibility:{isHidden:()=>hidden,subscribe(fn){visibility=fn;return()=>{visibility=null;};}},pagehide:{subscribe(fn){pagehide=fn;return()=>{pagehide=null;};}},
    createEncoder(limits){encoderCalls++;if(options.createEncoder)return options.createEncoder(limits);let count=0;return {appendPcm16(pcm){count+=pcm.length;}, finalize(expected){assert.equal(expected,count);return {bytes:new Uint8Array(44+count*2),frameCount:count};},abort(){}};}};
  deps.checkpointSink = options.checkpointSink;
  const controller=createRecordingController(deps);
  return {controller,stream,track,extra,node,source,gain,links,context,jobs,advance,get gumCalls(){return gumCalls;},get encoderCalls(){return encoderCalls;},emit(data){node.port.onmessage?.({data});},hide(){hidden=true;visibility?.();},pagehide(){pagehide?.();}};
}
const chunk=(seq=0,length=128)=>({type:'chunk',seq,pcm:new Int16Array(length)});
const final=(chunkCount=1,totalFrames=128,reason='user-stop')=>({type:'final',chunkCount,totalFrames,reason});

// Synthetic-only: every media/audio object above is a plain injected fixture.
const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
function sinkFixture(input = {}) {
 const limits=resolveCaptureLimits(input), identity=Object.freeze({schema:2,id:'11111111-1111-4111-8111-111111111111',writerEpoch:'22222222-2222-4222-8222-222222222222'});
 const calls=[], terminals=[]; let frames=0,count=0,revision=0;
 const receipt=(status='capturing')=>({...identity,revision:++revision,result:'committed',status,committedFrames:frames,committedSegmentCount:count,committedPcmBytes:frames*2,createdAt:1,expiresAt:86400001,lastCommittedAt:2,limits});
 const sink={identity,expiresAt:86400001,limits,append(value){const d=deferred();calls.push({value,d,commit(){frames+=value.pcm.length;count++;d.resolve(receipt());}});return d.promise;},finish(intent){const d=deferred();terminals.push({intent,d,commit(){d.resolve(receipt(intent.kind));}});return d.promise;}};
 return {sink,calls,terminals};
}
function emitFrames(f, frames, startSeq=0, width=128) { let seq=startSeq; for(let i=0;i<frames;i+=width)f.emit(chunk(seq++,Math.min(width,frames-i)));return seq; }
test('checkpoint exact reserved/start limits gate all media and encoder calls',async()=>{
 for(const limits of [{maxWavBytes:46},{maxDurationSeconds:2}]) { const k=sinkFixture();const f=fixture({checkpointSink:k.sink});await f.controller.start(limits);assert.equal(f.gumCalls,0);assert.equal(f.encoderCalls,0);assert.equal(f.controller.getSnapshot().error,'invalid-limits'); }
});
test('worklet ACK is not durability; segment snapshot is copied and receipt alone advances saved prefix',async()=>{
 const k=sinkFixture();const f=fixture({checkpointSink:k.sink});await f.controller.start();
 const pcm=new Int16Array(128).fill(-32768);f.emit({type:'chunk',seq:0,pcm});pcm.fill(7);emitFrames(f,15872,1);
 assert.equal(k.calls.length,1);assert.equal(k.calls[0].value.pcm[0],-32768);assert.equal(f.controller.getSnapshot().receivedFrames,16000);assert.equal(f.controller.getSnapshot().persistedFrames,0);assert.equal(f.node.port.sent.filter(x=>x.type==='ack').length,125);
 k.calls[0].commit();await flush();assert.equal(f.controller.getSnapshot().persistedFrames,16000);f.controller.dispose();
});
test('one in-flight segment and one buffer; saturation stops fake hardware without third operation',async()=>{
 const k=sinkFixture();const f=fixture({checkpointSink:k.sink});await f.controller.start();const seq=emitFrames(f,32000);assert.equal(k.calls.length,1);f.emit(chunk(seq,1));
 assert.ok(f.track.stopped);assert.equal(f.controller.getSnapshot().error,'persistence-failed');assert.equal(f.controller.getSnapshot().receivedFrames,32000);assert.equal(k.calls.length,1);k.calls[0].commit();await flush();assert.equal(k.calls.length,1);assert.equal(f.controller.getSnapshot().persistedFrames,16000);assert.equal(f.controller.getSnapshot().persistenceStatus,'failed');assert.equal(f.jobs.size,0);
});
test('variable chunk boundary and terminal tail drain serially before exact seal',async()=>{
 const k=sinkFixture();const f=fixture({checkpointSink:k.sink,createEncoder:createMonoPcm16WavBuilder});await f.controller.start();const seq=emitFrames(f,16009,0,127);f.controller.stop();f.emit(final(seq,16009));
 assert.equal(f.controller.getSnapshot().state,'ready');assert.equal(f.controller.getSnapshot().persistenceStatus,'draining');assert.equal(k.calls.length,1);assert.equal(k.terminals.length,0);
 k.calls[0].commit();await flush();assert.equal(k.calls.length,2);assert.equal(k.calls[1].value.startFrame,16000);assert.equal(k.calls[1].value.segmentIndex,1);assert.equal(k.calls[1].value.pcm.length,9);
 k.calls[1].commit();await flush();assert.equal(k.terminals.length,1);assert.deepEqual(k.terminals[0].intent,{kind:'sealed',accounting:{receivedFrames:16009,receivedChunkCount:seq,finalChunkCount:seq,finalTotalFrames:16009,processorReason:'user-stop',stopReason:'user-stop'}});
 k.terminals[0].commit();await flush();assert.equal(f.controller.getSnapshot().persistenceStatus,'sealed');assert.equal(f.controller.getSnapshot().persistedFrames,16009);assert.equal(f.jobs.size,0);
 const builder=createMonoPcm16WavBuilder({maxDurationSeconds:300,maxBytes:16*1024*1024});for(const c of k.calls)builder.appendPcm16(c.value.pcm);assert.deepEqual(builder.finalize(16009).bytes,f.controller.getSnapshot().artifact);
});
test('timeout is uncertain and delayed receipt cannot adopt durability or launch new operations',async()=>{
 const k=sinkFixture();const f=fixture({checkpointSink:k.sink});await f.controller.start();const seq=emitFrames(f,16001);f.controller.stop();f.emit(final(seq,16001));f.advance(20999);
 assert.equal(f.controller.getSnapshot().persistenceStatus,'draining');f.advance(1);
 assert.equal(f.controller.getSnapshot().state,'ready');assert.equal(f.controller.getSnapshot().persistenceStatus,'uncertain');k.calls[0].commit();await flush();assert.equal(f.controller.getSnapshot().persistedFrames,0);assert.equal(k.calls.length,1);assert.equal(k.terminals.length,0);assert.equal(f.jobs.size,0);
});
test('known append abort stops capture; uncertain rejection remains distinguishable',async()=>{
 for(const outcome of ['aborted','not-started','unknown']){const k=sinkFixture();const f=fixture({checkpointSink:k.sink});await f.controller.start();emitFrames(f,16000);k.calls[0].d.reject({outcome,code:'quota',message:'private details'});await flush();assert.ok(f.track.stopped);assert.equal(f.controller.getSnapshot().persistenceStatus,outcome==='unknown'?'uncertain':'failed');assert.equal(k.terminals.length,0);assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes('private details'));assert.equal(f.jobs.size,0);}
});
test('coherent hidden stop is interrupted, not sealed',async()=>{
 const k=sinkFixture();const f=fixture({checkpointSink:k.sink});await f.controller.start();f.emit(chunk(0,1));f.hide();f.emit(final(1,1));k.calls[0].commit();await flush();assert.deepEqual(k.terminals[0].intent,{kind:'interrupted',reason:'hidden',observedReceivedFrames:1});k.terminals[0].commit();await flush();assert.equal(f.controller.getSnapshot().persistenceStatus,'interrupted');
});
test('invalid stream retains validated prefix only and cannot seal',async()=>{
 const k=sinkFixture();const f=fixture({checkpointSink:k.sink});await f.controller.start();f.emit(chunk(0,4));f.emit(chunk(0,4));assert.equal(f.controller.getSnapshot().error,'invalid-pcm');assert.equal(k.calls[0].value.pcm.length,4);k.calls[0].commit();await flush();assert.equal(k.terminals[0].intent.kind,'interrupted');assert.equal(k.terminals[0].intent.observedReceivedFrames,4);k.terminals[0].commit();await flush();assert.equal(f.jobs.size,0);
});
test('dispose fences late receipt and starts no tail or terminal mutation',async()=>{
 const k=sinkFixture();const f=fixture({checkpointSink:k.sink});await f.controller.start();emitFrames(f,16001);f.controller.dispose();const s=f.controller.getSnapshot();k.calls[0].commit();await flush();assert.equal(f.controller.getSnapshot(),s);assert.equal(k.calls.length,1);assert.equal(k.terminals.length,0);assert.equal(f.jobs.size,0);
});
test('one-frame/odd byte cap and frozen cumulative cap do not reset on segments',async()=>{
 for(const maxWavBytes of [46,47,32047]){const input={maxWavBytes};const k=sinkFixture(input);const f=fixture({checkpointSink:k.sink});await f.controller.start(input);input.maxWavBytes=999999;const frames=k.sink.limits.maxFrames,seq=emitFrames(f,frames);f.emit(final(seq,frames,'limit'));assert.equal(f.controller.getSnapshot().frames,frames);let i=0;while(i<k.calls.length){k.calls[i++].commit();await flush();}k.terminals[0].commit();await flush();assert.equal(f.controller.getSnapshot().persistedFrames,frames);assert.equal(f.controller.getSnapshot().artifact.length,44+2*frames);await f.controller.start({maxWavBytes});assert.equal(f.gumCalls,1);}
});
test('malformed receipt cannot advance persisted accounting',async()=>{
 const k=sinkFixture();const f=fixture({checkpointSink:k.sink});await f.controller.start();emitFrames(f,16000);k.calls[0].d.resolve({committedFrames:16000});await flush();assert.equal(f.controller.getSnapshot().persistedFrames,0);assert.equal(f.controller.getSnapshot().persistenceStatus,'uncertain');assert.ok(f.track.stopped);
});

test('saturated outstanding operation with no receipt stays uncertain, never invents abort',async()=>{
 const k=sinkFixture();const f=fixture({checkpointSink:k.sink});await f.controller.start();const seq=emitFrames(f,32000);f.emit(chunk(seq,1));assert.equal(f.controller.getSnapshot().persistenceStatus,'uncertain');f.advance(10000);assert.equal(f.controller.getSnapshot().persistenceStatus,'uncertain');assert.equal(k.calls.length,1);assert.equal(f.jobs.size,0);f.controller.dispose();
});
test('ready subscriber disposal prevents even the first terminal tail operation',async()=>{
 const k=sinkFixture();const f=fixture({checkpointSink:k.sink});f.controller.subscribe(s=>{if(s.state==='ready')f.controller.dispose();});await f.controller.start();f.emit(chunk(0,1));f.controller.stop();f.emit(final(1,1));assert.equal(k.calls.length,0);assert.equal(k.terminals.length,0);assert.equal(f.jobs.size,0);
});

test('outer receipt watchdog allows both bounded session stages and cleans up on delivery',async()=>{
 const k=sinkFixture();const f=fixture({checkpointSink:k.sink});await f.controller.start();const seq=emitFrames(f,16000);f.controller.stop();f.emit(final(seq,16000));
 f.advance(10000);assert.equal(f.controller.getSnapshot().persistenceStatus,'draining');
 f.advance(10000);assert.equal(f.controller.getSnapshot().persistenceStatus,'draining');
 k.calls[0].commit();await flush();assert.equal(f.controller.getSnapshot().persistedFrames,16000);
 k.terminals[0].commit();await flush();f.advance(1000);assert.equal(f.controller.getSnapshot().persistenceStatus,'sealed');assert.equal(f.jobs.size,0);
});

test('pause and resume retain one checkpoint identity and seal both PCM segments only on stop',async()=>{
 const k=sinkFixture();const f=fixture({checkpointSink:k.sink,createEncoder:createMonoPcm16WavBuilder});await f.controller.start();
 emitFrames(f,16000);k.calls[0].commit();await flush();f.controller.pause();f.emit({type:'paused',chunkCount:125,totalFrames:16000});
 assert.equal(f.controller.getSnapshot().state,'paused');assert.equal(f.controller.getSnapshot().persistedFrames,16000);assert.equal(k.terminals.length,0);
 f.controller.resume();f.emit({type:'resumed',chunkCount:125,totalFrames:16000});emitFrames(f,145,125);f.controller.stop();f.emit(final(127,16145));
 assert.equal(f.controller.getSnapshot().state,'ready');assert.equal(f.controller.getSnapshot().artifact.length,32334);assert.equal(k.calls.length,2);k.calls[1].commit();await flush();
 assert.equal(k.terminals.length,1);assert.equal(k.terminals[0].intent.kind,'sealed');k.terminals[0].commit();await flush();assert.equal(f.controller.getSnapshot().persistenceStatus,'sealed');assert.equal(f.controller.getSnapshot().persistedFrames,16145);assert.equal(f.gumCalls,1);
});
