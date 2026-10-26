import type {CheckpointSink} from './checkpoint-session';
import {createRecordingController} from './controller.mjs';
import {createMonoPcm16WavBuilder} from './pcm-wav';
// ?url is an exact admitted asset; importing or constructing the controller activates no device.
import workletUrl from './pcm-capture-worklet.js?url';
export function createBrowserRecordingController(options?: {checkpointSink?: CheckpointSink}) {
 return createRecordingController({
  checkpointSink: options?.checkpointSink,
  getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
  createAudioContext: options => new AudioContext(options),
  prepareWorklet: async context => {
   await context.audioWorklet.addModule(workletUrl);
   return new AudioWorkletNode(context,'owned-pcm-capture',{
    numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],channelCount:1,
    channelCountMode:'explicit',channelInterpretation:'discrete',
   });
  },
  createEncoder:createMonoPcm16WavBuilder,
  timers:{setTimeout:(fn,ms)=>window.setTimeout(fn,ms),clearTimeout:id=>window.clearTimeout(id as number)},
  visibility:{isHidden:()=>document.hidden,subscribe:fn=>{document.addEventListener('visibilitychange',fn);return()=>document.removeEventListener('visibilitychange',fn);}},
  pagehide:{subscribe:fn=>{window.addEventListener('pagehide',fn);return()=>window.removeEventListener('pagehide',fn);}},
 });
}
