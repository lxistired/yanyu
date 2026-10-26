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
  const controller=createRecordingController(deps);
  return {controller,stream,track,extra,node,source,gain,links,context,jobs,advance,get gumCalls(){return gumCalls;},get encoderCalls(){return encoderCalls;},emit(data){node.port.onmessage?.({data});},hide(){hidden=true;visibility?.();},pagehide(){pagehide?.();}};
}
const chunk=(seq=0,length=128)=>({type:'chunk',seq,pcm:new Int16Array(length)});
const final=(chunkCount=1,totalFrames=128,reason='user-stop')=>({type:'final',chunkCount,totalFrames,reason});

test('imports/creation never acquire a device; explicit start is idempotent and graph silent',async()=>{
 const f=fixture();assert.equal(f.gumCalls,0);const p=f.controller.start();assert.equal(f.controller.start(),p);await p;
 assert.equal(f.gumCalls,1);assert.equal(f.controller.getSnapshot().state,'recording');assert.equal(f.gain.gain.value,0);
 assert.deepEqual(f.links,[['source',f.node],['worklet',f.gain],['gain',f.context.destination]]);assert.equal(f.source.channelCount,1);assert.equal(f.node.channelCountMode,'explicit');
 f.emit(chunk());f.controller.stop();assert.ok(f.track.stopped);assert.ok(f.extra.stopped);assert.equal(f.controller.getSnapshot().state,'stopping');f.emit(final());
 assert.equal(f.controller.getSnapshot().state,'ready');assert.equal(f.controller.getSnapshot().artifact.length,300);assert.equal(f.jobs.size,0);
});
test('late permission after cancel stops every returned track and cannot replace next attempt',async()=>{
 const permission=deferred();const f=fixture({permission});const p=f.controller.start();f.controller.cancel();permission.resolve(f.stream);await p;
 assert.equal(f.controller.getSnapshot().state,'cancelled');assert.ok(f.track.stopped);assert.ok(f.extra.stopped);
});
test('late preparation after dispose is cleaned, not resumed',async()=>{
 const preparation=deferred();const f=fixture({preparation});const p=f.controller.start();await Promise.resolve();f.controller.dispose();preparation.resolve(f.node);await p;
 assert.equal(f.controller.getSnapshot().state,'cancelled');assert.equal(f.links.length,0);assert.ok(f.track.stopped);assert.equal(f.context.state,'closed');
});
test('hidden during pending permission fences late success',async()=>{
 const permission=deferred();const f=fixture({permission});const p=f.controller.start();f.hide();permission.resolve(f.stream);await p;assert.equal(f.controller.getSnapshot().state,'cancelled');assert.ok(f.track.stopped);
});
test('unsupported actual sample rate fails closed before worklet graph',async()=>{
 const f=fixture({sampleRate:48000});await f.controller.start();assert.equal(f.controller.getSnapshot().error,'unsupported-audio');assert.equal(f.links.length,0);assert.ok(f.track.stopped);
});
for (const [label,payload] of [['missing',chunk(1)],['empty',chunk(0,0)],['oversized',chunk(0,129)],['wrong-type',{type:'chunk',seq:0,pcm:new Float32Array(1)}],['inconsistent',final(0,128)],['unexpected-final',final(0,0)]]) test(`rejects ${label} data`,async()=>{const f=fixture();await f.controller.start();f.emit(payload);assert.equal(f.controller.getSnapshot().error,'invalid-pcm');assert.ok(f.track.stopped);});
test('duplicate chunk poisons capture',async()=>{const f=fixture();await f.controller.start();f.emit(chunk());f.emit(chunk());assert.equal(f.controller.getSnapshot().error,'invalid-pcm');});
test('frozen server frame/byte caps reject overflow',async()=>{const limits={maxWavBytes:46};const f=fixture();await f.controller.start(limits);limits.maxWavBytes=1000;f.emit(chunk(0,2));assert.equal(f.controller.getSnapshot().error,'invalid-pcm');});
test('exact limit has explicit stop reason',async()=>{const f=fixture();await f.controller.start({maxWavBytes:46});f.emit(chunk(0,1));f.emit(final(1,1,'limit'));assert.equal(f.controller.getSnapshot().state,'ready');assert.equal(f.controller.getSnapshot().reason,'limit');assert.ok(f.track.stopped);});
for(const cause of ['hide','pagehide','track','context']) test(`${cause} stops hardware and marks received segment interrupted`,async()=>{const f=fixture();await f.controller.start();f.emit(chunk());if(cause==='track')f.track.events.get('ended')();else if(cause==='context'){f.context.state='suspended';f.context.onstatechange();}else f[cause]();assert.ok(f.track.stopped);f.emit(final());assert.equal(f.controller.getSnapshot().state,'ready');assert.equal(f.controller.getSnapshot().interrupted,true);});
test('processor error, no chunks, and missing final timeout fail closed',async()=>{for(const mode of ['processor','stall','final']){const f=fixture();await f.controller.start();if(mode==='processor')f.node.onprocessorerror();else{if(mode==='final'){f.emit(chunk());f.controller.stop();}f.advance(2001);}assert.equal(f.controller.getSnapshot().state,'error');assert.ok(f.track.stopped);assert.equal(f.jobs.size,0);}});
test('limit resolution rejects invalid values and includes WAV header',()=>{assert.equal(resolveCaptureLimits({maxWavBytes:46}).maxFrames,1);assert.equal(resolveCaptureLimits().maxFrames,4800000);for(const n of [0,-1,NaN,Infinity])assert.throws(()=>resolveCaptureLimits({maxDurationSeconds:n}));});

function worklet() {
 let Processor;const sent=[];const sandbox={Float32Array,Int16Array,Number,Math,sampleRate:16000,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>sent.push(m),onmessage:null};}},registerProcessor(name,p){assert.equal(name,'owned-pcm-capture');Processor=p;}};
 vm.runInNewContext(fs.readFileSync(new URL('../candidate/src/recording/pcm-capture-worklet.js',import.meta.url),'utf8'),sandbox);
 const processor=new Processor();return {processor,sent,send:data=>processor.port.onmessage({data}),process:(input=[new Float32Array(128)])=>{const output=new Float32Array(128).fill(1);const result=processor.process([input],[[output]]);assert.ok(output.every(x=>x===0));return result;}};
}
test('VM worklet is silent before/after start, PCM16 clips, counts exact cap',()=>{const w=worklet();w.process();assert.equal(w.sent.length,0);w.send({type:'start',maxFrames:3});w.process([new Float32Array([-2,0,2])]);assert.deepEqual([...w.sent[0].pcm],[-32768,0,32767]);assert.equal(w.sent[1].reason,'limit');assert.equal(w.sent[1].totalFrames,3);w.process();assert.equal(w.sent.length,2);});
test('VM worklet rejects stereo, empty, invalid samples, wrong ack and queue overflow',()=>{for(const mode of ['stereo','empty','nan','ack','queue']){const w=worklet();w.send({type:'start',maxFrames:10000});if(mode==='stereo')w.process([new Float32Array(1),new Float32Array(1)]);if(mode==='empty')w.process([]);if(mode==='nan')w.process([new Float32Array([NaN])]);if(mode==='ack')w.send({type:'ack',seq:0});if(mode==='queue')for(let i=0;i<33;i++)w.process();assert.equal(w.sent.at(-1).type,'error');}});
test('VM worklet acknowledges bounded sequential delivery then final count',()=>{const w=worklet();w.send({type:'start',maxFrames:10000});for(let i=0;i<40;i++){w.process();w.send({type:'ack',seq:i});}w.send({type:'stop'});assert.equal(w.sent.at(-1).chunkCount,40);assert.equal(w.sent.at(-1).totalFrames,5120);});

test('stale permission completion cannot clear a newer ready draft',async()=>{
 const first=deferred(),second=deferred();let call=0;
 // Share controller dependencies but return independent owned streams per attempt.
 let node;const streams=[0,1].map(()=>{const t={readyState:'live',stopped:0,stop(){this.stopped++;this.readyState='ended';},addEventListener(){},removeEventListener(){}};return {getTracks:()=>[t],getAudioTracks:()=>[t]};});
 const c=createRecordingController({getUserMedia:()=>++call===1?first.promise:second.promise,createAudioContext:()=>({sampleRate:16000,state:'running',close(){},createMediaStreamSource:()=>({connect(){},disconnect(){}}),createGain:()=>({gain:{},connect(){},disconnect(){}}),destination:{}}),prepareWorklet:async()=>node={port:{postMessage(){},close(){}},connect(){},disconnect(){}},visibility:{isHidden:()=>false,subscribe:()=>()=>{}},pagehide:{subscribe:()=>()=>{}},timers:{setTimeout:()=>0,clearTimeout(){}},createEncoder:()=>({appendPcm16(){},finalize:n=>({bytes:new Uint8Array(44+n*2),frameCount:n}),abort(){}})});
 const old=c.start();c.cancel();const next=c.start();second.resolve(streams[1]);await next;node.port.onmessage({data:chunk()});c.stop();node.port.onmessage({data:final()});const artifact=c.getSnapshot().artifact;first.resolve(streams[0]);await old;assert.equal(c.getSnapshot().state,'ready');assert.equal(c.getSnapshot().artifact,artifact);assert.ok(streams[0].getTracks()[0].stopped);
});
test('reported stereo device is rejected even before explicit graph downmix',async()=>{const f=fixture();f.track.getSettings=()=>({channelCount:2});await f.controller.start();assert.equal(f.controller.getSnapshot().error,'unsupported-audio');assert.equal(f.links.length,0);});
test('wall-clock cap is explicit and partial coherent segment is marked interrupted',async()=>{const f=fixture();await f.controller.start({maxDurationSeconds:0.01});f.emit(chunk(0,1));f.advance(10);assert.ok(f.track.stopped);assert.equal(f.controller.getSnapshot().reason,'duration-limit');f.emit(final(1,1));assert.equal(f.controller.getSnapshot().interrupted,true);assert.equal(f.controller.getSnapshot().reachedLimit,true);});
test('fixed permission error never exposes device exception details',async()=>{const permission=deferred();const f=fixture({permission});const p=f.controller.start();permission.reject(new Error('secret device ID 123'));await p;assert.equal(f.controller.getSnapshot().error,'permission-unavailable');assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes('secret'));});
test('invalid/duplicate start and out-of-order acknowledgement fail the VM processor',()=>{for(const mode of ['invalid','duplicate','order']){const w=worklet();w.send({type:'start',maxFrames:mode==='invalid'?4800001:1000});if(mode==='duplicate')w.send({type:'start',maxFrames:1000});if(mode==='order'){w.process();w.process();w.send({type:'ack',seq:1});}assert.equal(w.sent.at(-1).type,'error');}});

test('actual encoder agrees with exact 1001-frame byte-derived limit',async()=>{const f=fixture({createEncoder:createMonoPcm16WavBuilder});await f.controller.start({maxWavBytes:2046});for(let i=0;i<7;i++)f.emit(chunk(i,128));f.emit(chunk(7,105));f.emit(final(8,1001,'limit'));const s=f.controller.getSnapshot();assert.equal(s.state,'ready');assert.equal(s.frames,1001);assert.equal(s.artifact.byteLength,2046);const view=new DataView(s.artifact.buffer);assert.equal(view.getUint32(24,true),16000);assert.equal(view.getUint32(40,true),2002);});
test('permission timeout logically cancels and stops late stream',async()=>{const permission=deferred();const f=fixture({permission});const p=f.controller.start();f.advance(30000);assert.equal(f.controller.getSnapshot().error,'capture-stalled');permission.resolve(f.stream);await p;assert.equal(f.controller.getSnapshot().state,'error');assert.ok(f.track.stopped);assert.ok(f.extra.stopped);assert.equal(f.jobs.size,0);});
test('reentrant stop before processor start cancels without capture start or timer leak',async()=>{const f=fixture();f.controller.subscribe(s=>{if(s.state==='recording')f.controller.stop();});await f.controller.start();assert.equal(f.controller.getSnapshot().state,'cancelled');assert.ok(f.track.stopped);assert.ok(!f.node.port.sent.some(m=>m.type==='start'));assert.equal(f.jobs.size,0);});
test('actual encoder/controller compose across awkward byte boundaries',async()=>{for(const frames of [1003,1005,1007,65535,65537]){const f=fixture({createEncoder:createMonoPcm16WavBuilder});await f.controller.start({maxWavBytes:44+frames*2});let remaining=frames,seq=0;while(remaining){const count=Math.min(128,remaining);f.emit(chunk(seq++,count));remaining-=count;}f.emit(final(seq,frames,'limit'));assert.equal(f.controller.getSnapshot().state,'ready',`frames ${frames}`);assert.equal(f.controller.getSnapshot().artifact.byteLength,44+frames*2);}});

const transitionAck=(type,chunkCount,totalFrames)=>({type,chunkCount,totalFrames});
test('pause/resume require coherent processor ACK and preserve the same capture and PCM',async()=>{
 const f=fixture({createEncoder:createMonoPcm16WavBuilder});await f.controller.start();f.emit(chunk());
 f.controller.pause();f.controller.pause();assert.equal(f.controller.getSnapshot().state,'pausing');assert.equal(f.node.port.sent.filter(m=>m.type==='pause').length,1);
 // Already queued chunks precede the processor pause acknowledgement.
 f.emit(chunk(1,17));f.emit(transitionAck('paused',2,145));assert.equal(f.controller.getSnapshot().state,'paused');assert.equal(f.track.stopped,0);
 f.advance(2001);assert.equal(f.controller.getSnapshot().state,'paused');f.controller.start();assert.equal(f.gumCalls,1);
 f.controller.resume();f.controller.resume();assert.equal(f.controller.getSnapshot().state,'resuming');assert.equal(f.node.port.sent.filter(m=>m.type==='resume').length,1);
 f.emit(transitionAck('resumed',2,145));assert.equal(f.controller.getSnapshot().state,'recording');f.emit(chunk(2,7));f.controller.stop();f.emit(final(3,152));
 assert.equal(f.controller.getSnapshot().state,'ready');assert.equal(f.controller.getSnapshot().pauseCount,1);assert.equal(f.controller.getSnapshot().artifact.length,348);assert.equal(f.gumCalls,1);assert.equal(f.encoderCalls,1);assert.equal(f.jobs.size,0);
});
for(const state of ['pausing','paused','resuming'])test(`stop during ${state} preserves coherent WAV; late ACK cannot revive capture`,async()=>{
 const f=fixture();await f.controller.start();f.emit(chunk());f.controller.pause();
 if(state!=='pausing')f.emit(transitionAck('paused',1,128));if(state==='resuming')f.controller.resume();
 f.controller.stop();assert.ok(f.track.stopped);if(state!=='paused')f.emit(transitionAck(state==='pausing'?'paused':'resumed',1,128));assert.equal(f.controller.getSnapshot().state,'stopping');f.emit(final());
 assert.equal(f.controller.getSnapshot().state,'ready');f.emit(transitionAck('resumed',1,128));assert.equal(f.controller.getSnapshot().state,'ready');assert.equal(f.jobs.size,0);
});
for(const mode of ['pause-timeout','resume-timeout','bad-accounting','paused-chunk'])test(`pause protocol fails closed: ${mode}`,async()=>{
 const f=fixture();await f.controller.start();f.emit(chunk());f.controller.pause();
 if(mode==='bad-accounting')f.emit(transitionAck('paused',0,128));
 else if(mode==='pause-timeout')f.advance(2000);
 else{f.emit(transitionAck('paused',1,128));if(mode==='paused-chunk')f.emit(chunk(1));else{f.controller.resume();f.advance(2000);}}
 assert.equal(f.controller.getSnapshot().state,'error');assert.ok(f.track.stopped);assert.equal(f.jobs.size,0);
});
for(const cause of ['deadline','hide','pagehide','context','track'])test(`paused capture retains existing ${cause} stop boundary`,async()=>{
 const f=fixture();await f.controller.start({maxDurationSeconds:1});f.emit(chunk());f.controller.pause();f.emit(transitionAck('paused',1,128));
 if(cause==='deadline')f.advance(1000);else if(cause==='context'){f.context.state='suspended';f.context.onstatechange();}else if(cause==='track')f.track.events.get('ended')();else f[cause]();
 assert.equal(f.controller.getSnapshot().state,'stopping');f.emit(final());assert.equal(f.controller.getSnapshot().state,'ready');assert.equal(f.controller.getSnapshot().interrupted,true);assert.ok(f.track.stopped);
});
test('VM worklet pause emits accounting, ignores paused input, resumes sequence and can stop paused',()=>{
 for(const resume of [false,true]){
 const w=worklet();w.send({type:'start',maxFrames:10000});w.process();w.send({type:'ack',seq:0});w.send({type:'pause'});
 assert.equal(w.sent.at(-1).type,'paused');assert.equal(w.sent.at(-1).totalFrames,128);const count=w.sent.length;
 for(let i=0;i<40;i++)w.process([]);assert.equal(w.sent.length,count);
 if(resume){w.send({type:'resume'});assert.equal(w.sent.at(-1).type,'resumed');w.process();assert.equal(w.sent.at(-1).seq,1);w.send({type:'ack',seq:1});}
 w.send({type:'stop'});assert.equal(w.sent.at(-1).totalFrames,resume?256:128);assert.equal(w.sent.at(-1).reason,'user-stop');
 }
});
test('resume cannot accept new PCM before processor acknowledgement',async()=>{
 const f=fixture();await f.controller.start();f.emit(chunk());f.controller.pause();f.emit(transitionAck('paused',1,128));f.controller.resume();f.emit(chunk(1));assert.equal(f.controller.getSnapshot().error,'invalid-pcm');assert.ok(f.track.stopped);
});
test('queued exact-limit final can win a pause request without waiting for an impossible ACK',async()=>{
 const f=fixture();await f.controller.start({maxWavBytes:300});f.controller.pause();f.emit(chunk());f.emit(final(1,128,'limit'));assert.equal(f.controller.getSnapshot().state,'ready');assert.equal(f.jobs.size,0);f.emit(transitionAck('paused',1,128));assert.equal(f.controller.getSnapshot().state,'ready');
});
