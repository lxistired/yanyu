// @vitest-environment node
// Synthetic source-authored suite. Do not execute before source-review GO.
import {describe,it,expect,vi} from 'vitest';
import {runInNewContext} from 'node:vm';
import {IDBFactory,IDBObjectStore,IDBDatabase} from 'fake-indexeddb';
import {
  DATABASE,POLICY,RecordingDraftStore,prepareCompletedDraft,prepareRecordingReservation,
  preparePcmSegment,prepareTerminal,createRecordingClockGuard,CHECKPOINT_OPERATION_TIMEOUT_MS,
  type PreparedReservation,type RecordingWriter,
} from '../candidate/src/recording/recording-draft-store';
import {createCheckpointSession} from '../candidate/src/recording/checkpoint-session';
const START=1_800_000_000_000;
const pcm=(n=16000)=>Int16Array.from({length:n},(_,i)=>(i%65536)-32768);
async function fixture(){
  const factory=new IDBFactory(),clockGuard=createRecordingClockGuard();let now=START;
  const store=await RecordingDraftStore.open(factory,()=>now,{clockGuard});
  const token=prepareRecordingReservation({preserveDuringCapture:true,limits:{}},now);
  return {factory,store,token,clockGuard,setNow:(at:number)=>{now=at;},getNow:()=>now};
}
async function raw(factory:IDBFactory,fn:(tx:IDBTransaction)=>void){
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=factory.open(DATABASE);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction(['completed-drafts','recording-segments'],'readwrite');tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);fn(tx);});}finally{db.close();}
}
describe('checkpoint store/session synthetic contract',()=>{
  for(const mode of ['append','inspect','restore'] as const)for(const mismatch of [false,true]) {
    it(`stops abandoned ${mode} prefix hashing after the first deferred digest (mismatch=${mismatch})`,async()=>{
      const f=await fixture(),r=await f.store.reserveRecording(f.token),segmentCount=mode==='inspect'?3:2;
      for(let i=0;i<segmentCount;i++)await f.store.appendSegment(await preparePcmSegment(r.writer,{segmentIndex:i,startFrame:i*16000,pcm:pcm()}),i);
      const next=await preparePcmSegment(r.writer,{segmentIndex:segmentCount,startFrame:segmentCount*16000,pcm:pcm()});
      // A later legacy digest must not start either, even when the first hash mismatches.
      await f.store.preserve(await prepareCompletedDraft({preserve:true,blob:new Blob(['synthetic']),durationSeconds:1},START));
      let release!:()=>void,entered!:()=>void;
      const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
      const realDigest=crypto.subtle.digest.bind(crypto.subtle);
      const digestSpy=vi.spyOn(crypto.subtle,'digest').mockImplementationOnce(async(...args)=>{
        const value=await realDigest(...args);entered();await gate;
        if(mismatch)new Uint8Array(value)[0]^=1;return value;
      });
      const innerName=mode==='restore'?'restoreCheckpointsInner':'checkpointAccessInner';
      const realInner=(f.store as any)[innerName].bind(f.store);
      let settled:Promise<unknown>|undefined;
      const innerSpy=vi.spyOn(f.store as any,innerName).mockImplementation((...args:unknown[])=>{
        const pending=realInner(...args);settled=pending.then(()=>({success:true}),(e:unknown)=>e);return pending;
      });
      const transactionSpy=vi.spyOn(IDBDatabase.prototype,'transaction');
      vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
      try{
        const pending=mode==='append'?f.store.appendSegment(next,2):mode==='inspect'?f.store.inspectCheckpoint(r.writer):f.store.restoreCheckpoints();
        const rejected=expect(pending).rejects.toMatchObject({code:'uncertain',outcome:'unknown'});
        await started;await vi.advanceTimersByTimeAsync(CHECKPOINT_OPERATION_TIMEOUT_MS);await rejected;
        release();expect(await settled).toMatchObject({code:'uncertain',outcome:'unknown'});
        expect(digestSpy).toHaveBeenCalledTimes(1);
        expect(transactionSpy.mock.calls).toHaveLength(1);
        expect(transactionSpy.mock.calls[0][1]).toBe('readonly');
      }finally{release();vi.useRealTimers();digestSpy.mockRestore();innerSpy.mockRestore();transactionSpy.mockRestore();}
      try{
        expect(await f.store.inspectCheckpoint(r.writer)).toMatchObject({revision:segmentCount,committedFrames:segmentCount*16000,committedSegmentCount:segmentCount});
        expect((await f.store.restoreCheckpoints()).checkpoints).toHaveLength(1);
        // Exact prepared identity remains usable only through an explicit fresh operation.
        if(mode==='append')expect(await f.store.appendSegment(next,2)).toMatchObject({revision:3,committedFrames:48000});
      }finally{f.store.close();}
    });
  }
  for(const corrupt of [false,true])for(const mode of ['append','restore'] as const) {
    it(`retains all prefix checks without timeout for ${mode} (second segment corrupt=${corrupt})`,async()=>{
      const f=await fixture(),r=await f.store.reserveRecording(f.token);
      for(let i=0;i<2;i++)await f.store.appendSegment(await preparePcmSegment(r.writer,{segmentIndex:i,startFrame:i*16000,pcm:pcm()}),i);
      const next=await preparePcmSegment(r.writer,{segmentIndex:2,startFrame:32000,pcm:pcm()});
      if(corrupt)await raw(f.factory,tx=>{const store=tx.objectStore('recording-segments'),read=store.get([r.writer.id,r.writer.writerEpoch,1]);read.onsuccess=()=>{const row=read.result;new Uint8Array(row.bytes)[0]^=1;store.put(row);};});
      const digestSpy=vi.spyOn(crypto.subtle,'digest');
      try{
        if(mode==='append'){
          if(corrupt)await expect(f.store.appendSegment(next,2)).rejects.toMatchObject({code:'integrity'});
          else expect(await f.store.appendSegment(next,2)).toMatchObject({revision:3,committedFrames:48000});
          expect(digestSpy).toHaveBeenCalledTimes(2);
        }else{
          const shelf=await f.store.restoreCheckpoints();
          expect(shelf.checkpoints).toHaveLength(corrupt?0:1);expect(shelf.unrestorableCount).toBe(corrupt?1:0);
          expect(digestSpy).toHaveBeenCalledTimes(corrupt?2:3);
        }
        expect(digestSpy.mock.calls.slice(0,2).map(call=>(call[1] as ArrayBuffer).byteLength)).toEqual([32000,32000]);
      }finally{digestSpy.mockRestore();f.store.close();}
    });
  }
  it('stops abandoned legacy-only checkpoint snapshot after its first digest',async()=>{
    const f=await fixture();
    for(let i=0;i<2;i++)await f.store.preserve(await prepareCompletedDraft({preserve:true,blob:new Blob(['synthetic']),durationSeconds:1},START));
    let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const realDigest=crypto.subtle.digest.bind(crypto.subtle),digestSpy=vi.spyOn(crypto.subtle,'digest').mockImplementationOnce(async(...args)=>{const value=await realDigest(...args);entered();await gate;return value;});
    const real=(f.store as any).restoreCheckpointsInner.bind(f.store);let settled:Promise<unknown>|undefined;
    const innerSpy=vi.spyOn(f.store as any,'restoreCheckpointsInner').mockImplementation((...args:unknown[])=>{const pending=real(...args);settled=pending.then(()=>({success:true}),(e:unknown)=>e);return pending;});
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    try{
      const pending=f.store.restoreCheckpoints(),rejected=expect(pending).rejects.toMatchObject({code:'uncertain',outcome:'unknown'});
      await started;await vi.advanceTimersByTimeAsync(CHECKPOINT_OPERATION_TIMEOUT_MS);await rejected;
      release();expect(await settled).toMatchObject({code:'uncertain',outcome:'unknown'});expect(digestSpy).toHaveBeenCalledTimes(1);
    }finally{release();vi.useRealTimers();digestSpy.mockRestore();innerSpy.mockRestore();}
    try{expect((await f.store.restore()).drafts).toHaveLength(2);}finally{f.store.close();}
  });
  it('shares the recovery deadline with nested expired-prefix cleanup and does not start a late write',async()=>{
    const f=await fixture(),r=await f.store.reserveRecording(f.token);
    await f.store.appendSegment(await preparePcmSegment(r.writer,{segmentIndex:0,startFrame:0,pcm:pcm()}),0);
    f.setNow(START+POLICY.ttlMs);
    let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const realDigest=crypto.subtle.digest.bind(crypto.subtle);let count=0;
    const digestSpy=vi.spyOn(crypto.subtle,'digest').mockImplementation(async(...args)=>{const value=await realDigest(...args);if(++count===2){entered();await gate;}return value;});
    const real=(f.store as any).restoreCheckpointsInner.bind(f.store);let settled:Promise<unknown>|undefined;
    const innerSpy=vi.spyOn(f.store as any,'restoreCheckpointsInner').mockImplementation((...args:unknown[])=>{const pending=real(...args);settled=pending.then(()=>({success:true}),(e:unknown)=>e);return pending;});
    const transactionSpy=vi.spyOn(IDBDatabase.prototype,'transaction');vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    try{
      const pending=f.store.restoreCheckpoints(),rejected=expect(pending).rejects.toMatchObject({code:'uncertain',outcome:'unknown'});
      await started;await vi.advanceTimersByTimeAsync(CHECKPOINT_OPERATION_TIMEOUT_MS);await rejected;
      release();expect(await settled).toMatchObject({code:'uncertain',outcome:'unknown'});
      expect(digestSpy).toHaveBeenCalledTimes(2);expect(transactionSpy.mock.calls.map(call=>call[1])).toEqual(['readonly','readonly']);
    }finally{release();vi.useRealTimers();digestSpy.mockRestore();innerSpy.mockRestore();transactionSpy.mockRestore();}
    try{
      let storedManifest:unknown,storedSegment:unknown;
      await raw(f.factory,tx=>{const manifest=tx.objectStore('completed-drafts').get(r.writer.id),segment=tx.objectStore('recording-segments').get([r.writer.id,r.writer.writerEpoch,0]);
        manifest.onsuccess=()=>{storedManifest=manifest.result;};segment.onsuccess=()=>{storedSegment=segment.result;};});
      expect(storedManifest).toMatchObject({revision:1,committedFrames:16000});expect(storedSegment).toMatchObject({byteLength:32000});
      expect((await f.store.restoreCheckpoints()).checkpoints).toHaveLength(0);
    }finally{f.store.close();}
  });
  for(const phase of ['wav-digest','wav-validation'] as const) {
    it(`does not continue recovery after timeout during ${phase}`,async()=>{
      const f=await fixture();
      for(let i=0;i<2;i++){
        const r=await f.store.reserveRecording(i===0?f.token:prepareRecordingReservation({preserveDuringCapture:true,limits:{}},START));
        await f.store.appendSegment(await preparePcmSegment(r.writer,{segmentIndex:0,startFrame:0,pcm:pcm()}),0);
      }
      let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
      const realDigest=crypto.subtle.digest.bind(crypto.subtle);let digestCount=0;
      const digestSpy=vi.spyOn(crypto.subtle,'digest').mockImplementation(async(...args)=>{
        const value=await realDigest(...args);
        if(++digestCount===3&&phase==='wav-digest'){entered();await gate;}return value;
      });
      const realArrayBuffer=Blob.prototype.arrayBuffer;let blobCount=0;
      const blobSpy=vi.spyOn(Blob.prototype,'arrayBuffer').mockImplementation(async function(this:Blob){
        const value=await realArrayBuffer.call(this);
        if(++blobCount===1&&phase==='wav-validation'){entered();await gate;}return value;
      });
      const real=(f.store as any).restoreCheckpointsInner.bind(f.store);let settled:Promise<unknown>|undefined;
      const innerSpy=vi.spyOn(f.store as any,'restoreCheckpointsInner').mockImplementation((...args:unknown[])=>{const pending=real(...args);settled=pending.then(()=>({success:true}),(e:unknown)=>e);return pending;});
      const transactionSpy=vi.spyOn(IDBDatabase.prototype,'transaction');vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
      try{
        const pending=f.store.restoreCheckpoints(),rejected=expect(pending).rejects.toMatchObject({code:'uncertain',outcome:'unknown'});
        await started;await vi.advanceTimersByTimeAsync(CHECKPOINT_OPERATION_TIMEOUT_MS);await rejected;
        release();expect(await settled).toMatchObject({code:'uncertain',outcome:'unknown'});
        expect(digestSpy).toHaveBeenCalledTimes(3);expect(blobSpy).toHaveBeenCalledTimes(phase==='wav-digest'?0:1);
        expect(transactionSpy.mock.calls).toHaveLength(1);expect(transactionSpy.mock.calls[0][1]).toBe('readonly');
      }finally{release();vi.useRealTimers();digestSpy.mockRestore();blobSpy.mockRestore();innerSpy.mockRestore();transactionSpy.mockRestore();}
      try{expect((await f.store.restoreCheckpoints()).checkpoints).toHaveLength(2);}finally{f.store.close();}
    });
  }

  it('deduplicates concurrent reservation and rejects cloned authority',async()=>{
    const f=await fixture(),a=f.store.reserveRecording(f.token),b=f.store.reserveRecording(f.token);
    expect(a).toBe(b);const reserved=await a;expect(reserved.receipt.revision).toBe(0);
    await expect(f.store.reserveRecording({...f.token} as PreparedReservation)).rejects.toMatchObject({code:'invalid'});
    await expect(preparePcmSegment({...reserved.writer} as RecordingWriter,{segmentIndex:0,startFrame:0,pcm:pcm()})).rejects.toMatchObject({code:'invalid'});f.store.close();
  });
  it('uses exact effective controller limits and snapshots caller limits',async()=>{
    const f=await fixture(),limits={maxDurationSeconds:900,maxWavBytes:46};
    const token=prepareRecordingReservation({preserveDuringCapture:true,limits},START);limits.maxWavBytes=99999;
    const r=await f.store.reserveRecording(token);expect(r.receipt.limits).toEqual({maxFrames:1,maxWavBytes:46,maxDurationSeconds:1/16000});f.store.close();
  });
  it('shares two slots with legacy completed blobs and empty reservations',async()=>{
    const f=await fixture(),legacy=await prepareCompletedDraft({preserve:true,blob:new Blob(['synthetic']),durationSeconds:1},START);
    await f.store.preserve(legacy);await f.store.reserveRecording(f.token);
    await expect(f.store.reserveRecording(prepareRecordingReservation({preserveDuringCapture:true,limits:{}},START))).rejects.toMatchObject({code:'capacity'});
    expect((await f.store.restoreCheckpoints()).emptyReservationCount).toBe(1);expect((await f.store.restore()).drafts).toHaveLength(1);f.store.close();
  });
  it('copies PCM, commits exact prefix and reconciles stale append after seal',async()=>{
    const f=await fixture(),r=await f.store.reserveRecording(f.token),samples=pcm(),copy=samples.slice();
    const preparing=preparePcmSegment(r.writer,{segmentIndex:0,startFrame:0,pcm:samples});samples.fill(0);const token=await preparing;
    const first=await f.store.appendSegment(token,0);expect(first.committedFrames).toBe(16000);
    const terminal=prepareTerminal(r.writer,{kind:'sealed',accounting:{receivedFrames:16000,receivedChunkCount:125,finalChunkCount:125,finalTotalFrames:16000,processorReason:'user-stop',stopReason:'user-stop'}});
    const sealed=await f.store.commitTerminal(terminal,1);expect(sealed.revision).toBe(2);
    expect(await f.store.appendSegment(token,0)).toMatchObject({result:'already-committed',revision:2,status:'sealed'});
    expect(await f.store.commitTerminal(terminal,0)).toMatchObject({result:'already-committed',revision:2});
    const recovered=(await f.store.restoreCheckpoints()).checkpoints[0],view=new DataView(await recovered.blob.arrayBuffer());
    expect(recovered.completion).toBe('sealed');for(let i=0;i<copy.length;i++)expect(view.getInt16(44+i*2,true)).toBe(copy[i]);f.store.close();
  });
  it('conflicts altered tuple, future revision and short-tail continuation',async()=>{
    const f=await fixture(),r=await f.store.reserveRecording(f.token);
    const one=await preparePcmSegment(r.writer,{segmentIndex:0,startFrame:0,pcm:pcm(7)});await f.store.appendSegment(one,0);
    await expect(f.store.appendSegment(one,99)).rejects.toMatchObject({code:'conflict'});
    const altered=await preparePcmSegment(r.writer,{segmentIndex:0,startFrame:0,pcm:new Int16Array(7)});
    await expect(f.store.appendSegment(altered,0)).rejects.toMatchObject({code:'conflict'});
    const next=await preparePcmSegment(r.writer,{segmentIndex:1,startFrame:16000,pcm:pcm(1)});
    await expect(f.store.appendSegment(next,1)).rejects.toMatchObject({code:'conflict'});
    expect((await f.store.restoreCheckpoints()).checkpoints[0].completion).toBe('partial-unconfirmed');f.store.close();
  });
  it('requires coherent exact final accounting and freezes terminal intent',async()=>{
    const f=await fixture(),r=await f.store.reserveRecording(f.token);
    const p=await preparePcmSegment(r.writer,{segmentIndex:0,startFrame:0,pcm:pcm(8)});await f.store.appendSegment(p,0);
    expect(()=>prepareTerminal(r.writer,{kind:'sealed',accounting:{receivedFrames:8,receivedChunkCount:1,finalChunkCount:2,finalTotalFrames:8,processorReason:'user-stop',stopReason:'user-stop'}})).toThrow();
    const limit=prepareTerminal(r.writer,{kind:'sealed',accounting:{receivedFrames:8,receivedChunkCount:1,finalChunkCount:1,finalTotalFrames:8,processorReason:'limit',stopReason:'limit'}});
    await expect(f.store.commitTerminal(limit,1)).rejects.toMatchObject({code:'invalid'});
    const intent={kind:'interrupted' as const,reason:'hidden' as const,observedReceivedFrames:8};const terminal=prepareTerminal(r.writer,intent);intent.observedReceivedFrames=0;
    await f.store.commitTerminal(terminal,1);expect((await f.store.restoreCheckpoints()).checkpoints[0].terminal?.intent).toEqual({kind:'interrupted',reason:'hidden',observedReceivedFrames:8});f.store.close();
  });
  it('deletes exact revision and never resurrects committed reservation or writer',async()=>{
    const f=await fixture(),r=await f.store.reserveRecording(f.token),p=await preparePcmSegment(r.writer,{segmentIndex:0,startFrame:0,pcm:pcm(1)});
    const appended=await f.store.appendSegment(p,0);await expect(f.store.removeCheckpoint(r.receipt)).rejects.toMatchObject({code:'conflict'});
    expect(await f.store.removeCheckpoint(appended)).toEqual({removed:true,absent:false});expect(await f.store.inspectCheckpoint(r.writer)).toBeNull();
    await expect(f.store.reserveRecording(f.token)).rejects.toMatchObject({code:'retired'});await expect(f.store.appendSegment(p,0)).rejects.toMatchObject({code:'not-found'});
    expect(await f.store.removeCheckpoint(appended)).toEqual({removed:false,absent:true});f.store.close();
  });
  it('rolls back segment and manifest when segment request succeeds then transaction aborts',async()=>{
    const f=await fixture(),r=await f.store.reserveRecording(f.token),p=await preparePcmSegment(r.writer,{segmentIndex:0,startFrame:0,pcm:pcm()});
    const original=IDBObjectStore.prototype.add;const spy=vi.spyOn(IDBObjectStore.prototype,'add').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['add']>){
      const request=original.apply(this,args);if(this.name==='recording-segments')request.addEventListener('success',()=>this.transaction.abort(),{once:true});return request;
    });
    try{await expect(f.store.appendSegment(p,0)).rejects.toMatchObject({outcome:'aborted'});}finally{spy.mockRestore();}
    expect(await f.store.inspectCheckpoint(r.writer)).toMatchObject({committedFrames:0,revision:0});expect((await f.store.restoreCheckpoints()).integrityBlocked).toBe(false);
    expect(await f.store.appendSegment(p,0)).toMatchObject({revision:1});f.store.close();
  });
  it('restores committed bytes after lost outward receipt without acquiring writer authority',async()=>{
    const f=await fixture(),r=await f.store.reserveRecording(f.token),session=createCheckpointSession(f.store,r),real=f.store.appendSegment.bind(f.store);
    const spy=vi.spyOn(f.store,'appendSegment').mockImplementationOnce(async(token,revision)=>{await real(token,revision);throw {code:'uncertain',outcome:'unknown'};});
    await expect(session.sink.append({segmentIndex:0,startFrame:0,pcm:pcm(8)})).rejects.toMatchObject({outcome:'unknown'});expect(session.getReceipt().committedFrames).toBe(0);spy.mockRestore();
    expect(await session.reconcile()).toMatchObject({result:'already-committed',committedFrames:8});f.store.close();
    const reopen=await RecordingDraftStore.open(f.factory,f.getNow,{clockGuard:f.clockGuard});expect((await reopen.restoreCheckpoints()).checkpoints[0].committedFrames).toBe(8);reopen.close();
  });
  it('rejects overlapping session mutation while digest/store preparation is outstanding',async()=>{
    const f=await fixture(),r=await f.store.reserveRecording(f.token),session=createCheckpointSession(f.store,r);
    const first=session.sink.append({segmentIndex:0,startFrame:0,pcm:pcm()});
    await expect(session.sink.finish({kind:'interrupted',reason:'hidden',observedReceivedFrames:16000})).rejects.toMatchObject({code:'conflict',outcome:'not-started'});await first;f.store.close();
  });
  it('fails metadata count over600 before any segment payload read',async()=>{
    const f=await fixture();await f.store.reserveRecording(f.token);
    await raw(f.factory,tx=>{for(let i=0;i<601;i++)tx.objectStore('recording-segments').add({draftId:f.token.id,writerEpoch:f.token.writerEpoch,segmentIndex:i});});
    const get=vi.spyOn(IDBObjectStore.prototype,'get');
    try{await expect(f.store.restoreCheckpoints()).rejects.toMatchObject({code:'integrity'});expect(get.mock.contexts.filter(s=>s.name==='recording-segments')).toHaveLength(0);}finally{get.mockRestore();}f.store.close();
  });
  it('orphan key blocks absent proof and checkpoint admission but not valid legacy restore/removal',async()=>{
    const f=await fixture(),legacy=await prepareCompletedDraft({preserve:true,blob:new Blob(['synthetic']),durationSeconds:1},START);await f.store.preserve(legacy);
    await raw(f.factory,tx=>tx.objectStore('recording-segments').add({draftId:f.token.id,writerEpoch:f.token.writerEpoch,segmentIndex:0}));
    await expect(f.store.reserveRecording(f.token)).rejects.toMatchObject({code:'integrity'});
    await expect(f.store.inspectCheckpoint({schema:2,id:f.token.id,writerEpoch:f.token.writerEpoch})).rejects.toMatchObject({code:'integrity'});
    expect((await f.store.restore()).drafts).toHaveLength(1);expect(await f.store.remove(legacy.id,legacy.revision)).toBe(true);f.store.close();
  });
  it('detects hash corruption without silently shortening a claimed prefix',async()=>{
    const f=await fixture(),r=await f.store.reserveRecording(f.token),p=await preparePcmSegment(r.writer,{segmentIndex:0,startFrame:0,pcm:pcm()});await f.store.appendSegment(p,0);
    await raw(f.factory,tx=>{const store=tx.objectStore('recording-segments'),read=store.get([r.writer.id,r.writer.writerEpoch,0]);read.onsuccess=()=>{const row=read.result;new Uint8Array(row.bytes)[0]^=1;store.put(row);};});
    const shelf=await f.store.restoreCheckpoints();expect(shelf.checkpoints).toHaveLength(0);expect(shelf.unrestorableCount).toBe(1);
    await expect(f.store.removeCheckpoint({...r.receipt,revision:1})).rejects.toMatchObject({code:'integrity'});f.store.close();
  });
  it('keeps original TTL, rejects rollback across reopen and expiry even for idempotent append',async()=>{
    const f=await fixture(),r=await f.store.reserveRecording(f.token),p=await preparePcmSegment(r.writer,{segmentIndex:0,startFrame:0,pcm:pcm(1)});
    f.setNow(START+100);expect((await f.store.appendSegment(p,0)).expiresAt).toBe(START+POLICY.ttlMs);f.store.close();f.setNow(START+99);
    await expect(RecordingDraftStore.open(f.factory,f.getNow,{clockGuard:f.clockGuard})).rejects.toMatchObject({code:'clock-rollback'});
    f.setNow(START+POLICY.ttlMs);const reopened=await RecordingDraftStore.open(f.factory,f.getNow,{clockGuard:f.clockGuard});
    await expect(reopened.appendSegment(p,0)).rejects.toMatchObject({code:'expired'});f.setNow(START+101);await expect(reopened.inspectCheckpoint(r.writer)).rejects.toMatchObject({code:'clock-rollback'});reopened.close();
  });
  it('bounds unresolved snapshot as unknown and retires an observed committed reservation after delete',async()=>{
    const f=await fixture(),r=await f.store.reserveRecording(f.token);
    // Lost outward acknowledgment must not undo the module-owned committed lifecycle.
    await f.store.removeCheckpoint(r.receipt);await expect(f.store.reserveRecording(f.token)).rejects.toMatchObject({code:'retired'});
    const token=prepareRecordingReservation({preserveDuringCapture:true,limits:{}},START);
    const spy=vi.spyOn(f.store as any,'checkpointSnapshot').mockImplementationOnce(()=>new Promise(()=>{}));
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});try{
      const pending=f.store.reserveRecording(token);const check=expect(pending).rejects.toMatchObject({code:'uncertain',outcome:'unknown'});await vi.advanceTimersByTimeAsync(CHECKPOINT_OPERATION_TIMEOUT_MS);await check;
    }finally{vi.useRealTimers();spy.mockRestore();}
    await expect(f.store.reserveRecording(token)).rejects.toMatchObject({code:'not-found',outcome:'unknown'});f.store.close();
  });
  it('never starts a write transaction after a pre-transaction timeout is released',async()=>{
    const f=await fixture();
    const real=(f.store as any).checkpointSnapshot.bind(f.store);
    let release!:()=>void,entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const spy=vi.spyOn(f.store as any,'checkpointSnapshot').mockImplementationOnce(async(deadline:{timedOut:boolean})=>{
      const snapshot=await real(deadline);entered();await gate;return snapshot;
    });
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    try{
      const pending=f.store.reserveRecording(f.token);const rejected=expect(pending).rejects.toMatchObject({code:'uncertain',outcome:'unknown'});
      // Real IDB setup completes before advancing only the operation deadline.
      await started;
      await vi.advanceTimersByTimeAsync(CHECKPOINT_OPERATION_TIMEOUT_MS);await rejected;
      spy.mockRestore();vi.useRealTimers();
      expect(await f.store.inspectCheckpoint({schema:2,id:f.token.id,writerEpoch:f.token.writerEpoch})).toBeNull();
      release();await Promise.resolve();await Promise.resolve();
      await expect(f.store.reserveRecording(f.token)).rejects.toMatchObject({code:'not-found',outcome:'unknown'});
      expect(await f.store.inspectCheckpoint({schema:2,id:f.token.id,writerEpoch:f.token.writerEpoch})).toBeNull();
    }finally{release();spy.mockRestore();vi.useRealTimers();f.store.close();}
  });
  it('explicit shelf access reclaims two expired checkpoints for ordinary completed save',async()=>{
    const f=await fixture();await f.store.reserveRecording(f.token);
    await f.store.reserveRecording(prepareRecordingReservation({preserveDuringCapture:true,limits:{}},START));
    f.setNow(START+POLICY.ttlMs);expect((await f.store.restoreCheckpoints()).checkpoints).toHaveLength(0);
    const legacy=await prepareCompletedDraft({preserve:true,blob:new Blob(['new synthetic']),durationSeconds:1},f.getNow());
    await f.store.preserve(legacy);expect((await f.store.restore()).drafts).toHaveLength(1);f.store.close();
  });
  it('upgrades exact schema1 without changing its stored bytes or metadata',async()=>{
    const factory=new IDBFactory(),token=await prepareCompletedDraft({preserve:true,blob:new Blob(['schema1 synthetic']),durationSeconds:1},START);
    // Materialize a canonical schema1 row using the public legacy API, then transplant it into an exact v1 fixture.
    const source=await RecordingDraftStore.open(new IDBFactory(),()=>START,{clockGuard:createRecordingClockGuard()});await source.preserve(token);
    const draft=(await source.restore()).drafts[0],{blob,...metadata}=draft,row={...metadata,bytes:await blob.arrayBuffer()};source.close();
    const old=await new Promise<IDBDatabase>((resolve,reject)=>{const r=factory.open(DATABASE,1);r.onupgradeneeded=()=>r.result.createObjectStore('completed-drafts',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    await new Promise<void>((resolve,reject)=>{const tx=old.transaction('completed-drafts','readwrite');tx.objectStore('completed-drafts').add(row);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});old.close();
    const upgraded=await RecordingDraftStore.open(factory,()=>START,{clockGuard:createRecordingClockGuard()});
    const restored=(await upgraded.restore()).drafts[0],{blob:restoredBlob,...restoredMetadata}=restored;
    expect(restoredMetadata).toEqual(metadata);expect(new Uint8Array(await restoredBlob.arrayBuffer())).toEqual(new Uint8Array(row.bytes));upgraded.close();
  });

  it('retries the same reservation after a conclusively aborted first insertion',async()=>{
    const f=await fixture(),original=IDBObjectStore.prototype.add;
    const spy=vi.spyOn(IDBObjectStore.prototype,'add').mockImplementationOnce(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['add']>){
      const request=original.apply(this,args);request.addEventListener('success',()=>this.transaction.abort(),{once:true});return request;
    });
    try{await expect(f.store.reserveRecording(f.token)).rejects.toMatchObject({outcome:'aborted'});}finally{spy.mockRestore();}
    const reserved=await f.store.reserveRecording(f.token);expect(reserved.writer.id).toBe(f.token.id);expect(reserved.receipt.createdAt).toBe(START);f.store.close();
  });
  it('keeps committed prefix after a synthetic quota exception',async()=>{
    const f=await fixture(),r=await f.store.reserveRecording(f.token),p=await preparePcmSegment(r.writer,{segmentIndex:0,startFrame:0,pcm:pcm()});
    const original=IDBObjectStore.prototype.add,spy=vi.spyOn(IDBObjectStore.prototype,'add').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['add']>){
      if(this.name==='recording-segments')throw new DOMException('synthetic quota','QuotaExceededError');return original.apply(this,args);
    });
    try{await expect(f.store.appendSegment(p,0)).rejects.toMatchObject({code:'quota',outcome:'aborted'});}finally{spy.mockRestore();}
    expect(await f.store.inspectCheckpoint(r.writer)).toMatchObject({committedFrames:0,revision:0});expect(await f.store.appendSegment(p,0)).toMatchObject({committedFrames:16000});f.store.close();
  });
  it('never exceeds two slots across three simultaneous connections, allowing fail-closed contention',async()=>{
    const f=await fixture(),other=await RecordingDraftStore.open(f.factory,f.getNow,{clockGuard:f.clockGuard}),third=await RecordingDraftStore.open(f.factory,f.getNow,{clockGuard:f.clockGuard});
    const stores=[f.store,other,third],tokens=stores.map(()=>prepareRecordingReservation({preserveDuringCapture:true,limits:{}},START));
    const results=await Promise.allSettled(stores.map((store,i)=>store.reserveRecording(tokens[i])));
    expect(results.filter(r=>r.status==='fulfilled').length).toBeGreaterThanOrEqual(1);expect(results.filter(r=>r.status==='fulfilled').length).toBeLessThanOrEqual(2);
    // A concurrent unrelated change may fail closed; retry exact identities serially, never replace tokens.
    for(let i=0;i<stores.length;i++)try{await stores[i].reserveRecording(tokens[i]);}catch(e){expect(e).toMatchObject({code:'capacity'});}
    expect((await f.store.restoreCheckpoints()).emptyReservationCount).toBe(2);stores.forEach(store=>store.close());
  });
  it('rejects expiry crossing a deferred integrity digest before append transaction',async()=>{
    const f=await fixture(),r=await f.store.reserveRecording(f.token),first=await preparePcmSegment(r.writer,{segmentIndex:0,startFrame:0,pcm:pcm()});await f.store.appendSegment(first,0);
    const next=await preparePcmSegment(r.writer,{segmentIndex:1,startFrame:16000,pcm:pcm()});
    let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const real=crypto.subtle.digest.bind(crypto.subtle),spy=vi.spyOn(crypto.subtle,'digest').mockImplementationOnce(async(...args)=>{const value=await real(...args);entered();await gate;return value;});
    try{const pending=f.store.appendSegment(next,1),rejected=expect(pending).rejects.toMatchObject({code:'expired'});await started;f.setNow(START+POLICY.ttlMs);release();await rejected;}finally{release();spy.mockRestore();f.store.close();}
  });

  it('bounds session digest preparation and never starts a late write without explicit reconciliation',async()=>{
    const f=await fixture(),reserved=await f.store.reserveRecording(f.token),session=createCheckpointSession(f.store,reserved);
    let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const real=crypto.subtle.digest.bind(crypto.subtle),digestSpy=vi.spyOn(crypto.subtle,'digest').mockImplementationOnce(async(...args)=>{const value=await real(...args);entered();await gate;return value;});
    const appendSpy=vi.spyOn(f.store,'appendSegment');vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    try{
      const pending=session.sink.append({segmentIndex:0,startFrame:0,pcm:pcm(8)}),rejected=expect(pending).rejects.toMatchObject({code:'uncertain',outcome:'unknown'});
      await started;await vi.advanceTimersByTimeAsync(CHECKPOINT_OPERATION_TIMEOUT_MS);await rejected;vi.useRealTimers();
      await expect(session.reconcile()).rejects.toMatchObject({code:'conflict',outcome:'not-started'});
      expect(await f.store.inspectCheckpoint(reserved.writer)).toMatchObject({committedFrames:0});expect(appendSpy).not.toHaveBeenCalled();
      release();await Promise.resolve();await Promise.resolve();await Promise.resolve();
      expect(await f.store.inspectCheckpoint(reserved.writer)).toMatchObject({committedFrames:0});expect(appendSpy).not.toHaveBeenCalled();
      expect(await session.reconcile()).toMatchObject({committedFrames:8});
    }finally{release();vi.useRealTimers();digestSpy.mockRestore();appendSpy.mockRestore();f.store.close();}
  });

  it('lists exact empty reservation metadata after reload and permits explicit deletion without resurrection',async()=>{
    const f=await fixture(),reserved=await f.store.reserveRecording(f.token);f.store.close();
    const reopened=await RecordingDraftStore.open(f.factory,f.getNow,{clockGuard:f.clockGuard});
    const shelf=await reopened.restoreCheckpoints();expect(shelf.emptyReservationCount).toBe(1);expect(shelf.checkpoints).toHaveLength(0);
    const target=shelf.emptyReservations[0];expect(target).toEqual({schema:2,id:reserved.writer.id,writerEpoch:reserved.writer.writerEpoch,revision:0,createdAt:START,expiresAt:START+POLICY.ttlMs,status:'capturing'});
    expect(Object.isFrozen(target)).toBe(true);expect(Object.isFrozen(shelf.emptyReservations)).toBe(true);
    expect(await reopened.removeCheckpoint(target)).toEqual({removed:true,absent:false});
    await expect(reopened.reserveRecording(f.token)).rejects.toMatchObject({code:'retired'});
    expect((await reopened.restoreCheckpoints()).emptyReservationCount).toBe(0);reopened.close();
  });
  it('rejects stale empty-shelf deletion after a first append without deleting committed PCM',async()=>{
    const f=await fixture(),reserved=await f.store.reserveRecording(f.token),target=(await f.store.restoreCheckpoints()).emptyReservations[0];
    const segment=await preparePcmSegment(reserved.writer,{segmentIndex:0,startFrame:0,pcm:pcm(8)});await f.store.appendSegment(segment,0);
    await expect(f.store.removeCheckpoint(target)).rejects.toMatchObject({code:'conflict'});
    const shelf=await f.store.restoreCheckpoints();expect(shelf.emptyReservations).toHaveLength(0);expect(shelf.emptyReservationCount).toBe(0);expect(shelf.checkpoints[0].committedFrames).toBe(8);f.store.close();
  });
  it('lists interrupted zero-frame reservation and old prepared append cannot recreate it after deletion',async()=>{
    const f=await fixture(),reserved=await f.store.reserveRecording(f.token),segment=await preparePcmSegment(reserved.writer,{segmentIndex:0,startFrame:0,pcm:pcm(8)});
    const terminal=prepareTerminal(reserved.writer,{kind:'interrupted',reason:'capture-failed',observedReceivedFrames:0});await f.store.commitTerminal(terminal,0);
    const shelf=await f.store.restoreCheckpoints();expect(shelf.emptyReservations[0]).toMatchObject({status:'interrupted',revision:1});
    await f.store.removeCheckpoint(shelf.emptyReservations[0]);await expect(f.store.appendSegment(segment,0)).rejects.toMatchObject({code:'not-found'});expect(await f.store.inspectCheckpoint(reserved.writer)).toBeNull();f.store.close();
  });
  it('deletes empty shelf reservation while timed-out preparation is pending and cannot resurrect on release',async()=>{
    const f=await fixture(),reserved=await f.store.reserveRecording(f.token),session=createCheckpointSession(f.store,reserved);
    let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const real=crypto.subtle.digest.bind(crypto.subtle),spy=vi.spyOn(crypto.subtle,'digest').mockImplementationOnce(async(...args)=>{const value=await real(...args);entered();await gate;return value;});
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    try{
      const pending=session.sink.append({segmentIndex:0,startFrame:0,pcm:pcm(8)}),rejected=expect(pending).rejects.toMatchObject({outcome:'unknown'});
      await started;await vi.advanceTimersByTimeAsync(CHECKPOINT_OPERATION_TIMEOUT_MS);await rejected;vi.useRealTimers();
      const target=(await f.store.restoreCheckpoints()).emptyReservations[0];expect(await f.store.removeCheckpoint(target)).toMatchObject({removed:true});
      release();await Promise.resolve();await Promise.resolve();await Promise.resolve();
      expect(await f.store.inspectCheckpoint(reserved.writer)).toBeNull();
      await expect(session.reconcile()).rejects.toMatchObject({code:'not-found'});
      expect(await f.store.inspectCheckpoint(reserved.writer)).toBeNull();await expect(f.store.reserveRecording(f.token)).rejects.toMatchObject({code:'retired'});
    }finally{release();spy.mockRestore();vi.useRealTimers();f.store.close();}
  });

  it('accepts genuine foreign-realm payload bytes at the IDB read boundary without weakening integrity',async()=>{
    const f=await fixture(),reserved=await f.store.reserveRecording(f.token),segment=await preparePcmSegment(reserved.writer,{segmentIndex:0,startFrame:0,pcm:pcm(8)});await f.store.appendSegment(segment,0);
    const original=IDBObjectStore.prototype.get;let injected=0;
    const spy=vi.spyOn(IDBObjectStore.prototype,'get').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['get']>){
      const request=original.apply(this,args);
      if(this.name==='recording-segments')request.addEventListener('success',()=>{
        const row=request.result;if(!row)return;
        const foreign=runInNewContext('new ArrayBuffer(16)') as ArrayBuffer;
        expect(foreign instanceof ArrayBuffer).toBe(false);
        new Uint8Array(foreign).set(new Uint8Array(row.bytes));row.bytes=foreign;injected++;
      },{once:true});
      return request;
    });
    try{
      expect(await f.store.inspectCheckpoint(reserved.writer)).toMatchObject({committedFrames:8});
      expect(await f.store.appendSegment(segment,0)).toMatchObject({result:'already-committed',committedFrames:8});
      const recovered=(await f.store.restoreCheckpoints()).checkpoints[0];expect(recovered.committedFrames).toBe(8);expect(injected).toBeGreaterThan(0);
    }finally{spy.mockRestore();f.store.close();}
  });
  it('rejects shared, proxy, prototype-spoofed and detached payloads at the same read boundary',async()=>{
    const f=await fixture(),reserved=await f.store.reserveRecording(f.token),segment=await preparePcmSegment(reserved.writer,{segmentIndex:0,startFrame:0,pcm:pcm(8)});await f.store.appendSegment(segment,0);
    const detached=new ArrayBuffer(16);structuredClone(detached,{transfer:[detached]});
    const malformed=[new SharedArrayBuffer(16),new Proxy(new ArrayBuffer(16),{}),Object.create(ArrayBuffer.prototype),{byteLength:16,[Symbol.toStringTag]:'ArrayBuffer'},detached];
    const original=IDBObjectStore.prototype.get;
    for(const bytes of malformed){
      const spy=vi.spyOn(IDBObjectStore.prototype,'get').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['get']>){
        const request=original.apply(this,args);if(this.name==='recording-segments')request.addEventListener('success',()=>{if(request.result)request.result.bytes=bytes;},{once:true});return request;
      });
      try{await expect(f.store.inspectCheckpoint(reserved.writer)).rejects.toMatchObject({code:'integrity'});}finally{spy.mockRestore();}
    }
    expect(await f.store.inspectCheckpoint(reserved.writer)).toMatchObject({committedFrames:8});f.store.close();
  });
  it('counts malformed schema2 legacy-shaped rows once without hiding or deleting them',async()=>{
    const f=await fixture(),token=await prepareCompletedDraft({preserve:true,blob:new Blob(['synthetic invalid tag']),durationSeconds:1},START);await f.store.preserve(token);
    await raw(f.factory,tx=>{const store=tx.objectStore('completed-drafts'),request=store.get(token.id);request.onsuccess=()=>store.put({...request.result,schema:2});});
    const legacy=await f.store.restore(),checkpoint=await f.store.restoreCheckpoints();
    expect(legacy.drafts).toHaveLength(0);expect(legacy.unrestorableCount).toBe(1);
    expect(checkpoint.integrityBlocked).toBe(true);expect(checkpoint.checkpoints).toHaveLength(0);expect(checkpoint.emptyReservations).toHaveLength(0);expect(checkpoint.unrestorableCount).toBe(0);
    expect(legacy.unrestorableCount+checkpoint.unrestorableCount).toBe(1);
    await expect(f.store.remove(token.id,token.revision)).rejects.toMatchObject({code:'conflict'});expect((await f.store.restore()).unrestorableCount).toBe(1);f.store.close();
  });

});
