import {
  CheckpointError, CHECKPOINT_OPERATION_TIMEOUT_MS, preparePcmSegment, prepareTerminal,
  type RecordingDraftStore, type ReservedRecording, type CheckpointReceipt,
  type PreparedPcmSegment, type PreparedTerminal, type TerminalIntent,
  type CheckpointIdentity, type FrozenLimits,
} from './recording-draft-store';
export type { CheckpointIdentity, FrozenLimits, TerminalIntent, FinalAccounting, StopReason, CheckpointReceipt } from './recording-draft-store';
export type CheckpointSink = Readonly<{
  identity: CheckpointIdentity; expiresAt: number; limits: FrozenLimits;
  append(input: Readonly<{segmentIndex:number;startFrame:number;pcm:Int16Array}>):Promise<CheckpointReceipt>;
  finish(intent:TerminalIntent):Promise<CheckpointReceipt>;
}>;
export interface CheckpointSession {
  readonly sink:CheckpointSink;
  getReceipt():CheckpointReceipt;
  reconcile():Promise<CheckpointReceipt>;
}
type Outstanding = {kind:'segment';token:PreparedPcmSegment;revision:number}|{kind:'terminal';token:PreparedTerminal;revision:number};
/** One operation at a time, including its preparation. Rejection keeps its exact token. */
export function createCheckpointSession(store:RecordingDraftStore,reserved:ReservedRecording):CheckpointSession {
  let latest=reserved.receipt, busy=false, preparing=false, outstanding:Outstanding|null=null;
  const identity=Object.freeze({schema:2 as const,id:reserved.writer.id,writerEpoch:reserved.writer.writerEpoch});
  const run=async(operation:Outstanding):Promise<CheckpointReceipt>=>{
    const next=operation.kind==='segment'?await store.appendSegment(operation.token,operation.revision):await store.commitTerminal(operation.token,operation.revision);
    latest=next;outstanding=null;return next;
  };
  const enter=()=>{if(busy||preparing||outstanding)throw new CheckpointError('conflict');busy=true;};
  const sink:CheckpointSink=Object.freeze({identity,expiresAt:latest.expiresAt,limits:latest.limits,
    async append(input:Readonly<{segmentIndex:number;startFrame:number;pcm:Int16Array}>){
      enter();
      try{
        const revision=latest.revision;
        preparing=true;
        // A timed-out digest may finish, but may only retain its token, never start a write.
        const token=await new Promise<PreparedPcmSegment>((resolve,reject)=>{
          let timedOut=false;
          const timer=setTimeout(()=>{timedOut=true;reject(new CheckpointError('uncertain','unknown'));},CHECKPOINT_OPERATION_TIMEOUT_MS);
          preparePcmSegment(reserved.writer,input).then(prepared=>{
            clearTimeout(timer);preparing=false;
            if(timedOut){outstanding={kind:'segment',token:prepared,revision};return;}
            resolve(prepared);
          },error=>{clearTimeout(timer);preparing=false;reject(error instanceof CheckpointError?error:new CheckpointError('unavailable'));});
        });
        outstanding={kind:'segment',token,revision};
        return await run(outstanding);
      }finally{busy=false;}
    },
    async finish(intent:TerminalIntent){
      enter();
      try{
        const token=prepareTerminal(reserved.writer,intent);
        outstanding={kind:'terminal',token,revision:latest.revision};
        return await run(outstanding);
      }finally{busy=false;}
    },
  });
  return Object.freeze({sink,getReceipt:()=>latest,
    async reconcile(){
      if(busy||preparing)throw new CheckpointError('conflict');
      busy=true;
      try{
        // Always reconcile identity first. Absence is never authorization to recreate.
        const inspected=await store.inspectCheckpoint(identity);
        if(!inspected)throw new CheckpointError('not-found');
        if(outstanding)return await run(outstanding);
        latest=inspected;return latest;
      }finally{busy=false;}
    },
  });
}
