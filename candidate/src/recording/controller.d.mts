import type { CheckpointSink } from './checkpoint-session';
import type { CheckpointIdentity } from './recording-draft-store';
export type PersistenceStatus = 'disabled'|'reserving'|'active'|'draining'|'sealed'|'interrupted'|'uncertain'|'failed';
export type CaptureSnapshot = Readonly<{state: 'idle'|'requesting'|'preparing'|'recording'|'pausing'|'paused'|'resuming'|'stopping'|'ready'|'error'|'cancelled'; artifact: Uint8Array|null; error: string|null; reason: string|null; pauseCount?: number; frames?: number; sampleRate?: number; interrupted?: boolean; reachedLimit?: boolean; receivedFrames?: number; persistedFrames?: number; persistenceStatus?: PersistenceStatus; checkpointIdentity?: CheckpointIdentity; checkpointExpiresAt?: number}>;
export interface RecordingController {
 getSnapshot(): CaptureSnapshot;
 subscribe(fn:(snapshot:CaptureSnapshot)=>void):()=>void;
 start(limits?:{maxDurationSeconds?:number;maxWavBytes?:number}):Promise<void>;
 pause?():void; resume?():void; stop():void; cancel():void; dispose():void;
}
export function createRecordingController(deps: {
 checkpointSink?: CheckpointSink;
 getUserMedia(constraints:MediaStreamConstraints):Promise<MediaStream>;
 createAudioContext(options:AudioContextOptions):AudioContext;
 prepareWorklet(context:AudioContext):Promise<AudioWorkletNode>;
 createEncoder(options:{maxDurationSeconds:number;maxBytes:number}): {appendPcm16(pcm:Int16Array):void;finalize(frames:number):{bytes:Uint8Array;frameCount:number};abort():void};
 timers:{setTimeout(callback:()=>void,ms:number):unknown;clearTimeout(id:unknown):void};
 visibility:{isHidden():boolean;subscribe(callback:()=>void):()=>void};
 pagehide:{subscribe(callback:()=>void):()=>void};
}):RecordingController;

export function resolveCaptureLimits(server?: {maxDurationSeconds?:number;maxWavBytes?:number}): Readonly<{maxFrames:number;maxWavBytes:number;maxDurationSeconds:number;encoderDurationSeconds:number}>;
