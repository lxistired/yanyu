import {isOwnedPcmWav} from '../recording/validate-wav';
import {useEffect, useRef, useState} from 'react';
import {useUnsavedWork} from './unsaved-work';
import {createBrowserRecordingController} from '../recording/browser-adapter';
import type {CaptureSnapshot, RecordingController} from '../recording/controller.mjs';
import {RecordingDraftStore, prepareCompletedDraft, type Draft, type PreparedDraft, prepareRecordingReservation, recordingClockGuard, type RecordingClockGuard, type PreparedReservation, type RecoveryView, type CheckpointDeleteTarget, type EmptyCheckpointReservation} from '../recording/recording-draft-store';

import {createCheckpointSession, type CheckpointSession, type CheckpointSink} from '../recording/checkpoint-session';

export type RecordingSelection = {file:File; expiresAt?:number; checkpoint?:true};
export type RecordingServices = {
 createController:(options?:{checkpointSink?:CheckpointSink})=>RecordingController;
 clockGuard?:RecordingClockGuard;
 prepareReservation?:typeof prepareRecordingReservation;
 createSession?:typeof createCheckpointSession;
 openStore:()=>Promise<RecordingDraftStore>;
 prepare:typeof prepareCompletedDraft;
 now:()=>number;
};
const services:RecordingServices = {
 createController:createBrowserRecordingController,
 openStore:()=>RecordingDraftStore.open(indexedDB),
 prepare:prepareCompletedDraft,
 now:()=>Date.now(),
};
const empty:CaptureSnapshot = {state:'idle',artifact:null,error:null,reason:null};
const labels = {idle:'未开始',requesting:'等待麦克风权限',preparing:'准备录音',recording:'录音中',pausing:'正在请求暂停',paused:'已暂停采集',resuming:'正在请求继续',stopping:'正在停止并校验',ready:'录音已完成',error:'录音失败',cancelled:'录音已取消'};
const activeStates = new Set(['requesting','preparing','recording','pausing','paused','resuming','stopping']);
export function RecordingDrafts({limits, disabled, onSelect, runtime=services}: {
 limits:{maxDurationSeconds:number;maxWavBytes:number}|null;disabled:boolean;
 onSelect:(selection:RecordingSelection)=>boolean;runtime?:RecordingServices;
}) {
 const [capture,setCapture]=useState<CaptureSnapshot>(empty);
 const [optIn,setOptIn]=useState(false);
 const [checkpoints,setCheckpoints]=useState<readonly RecoveryView[]>([]);
 const [emptyReservations,setEmptyReservations]=useState<readonly EmptyCheckpointReservation[]>([]);
 const [integrityBlocked,setIntegrityBlocked]=useState(false);
 const [reservationPending,setReservationPending]=useState(false);
 const [checkpointAttempt,setCheckpointAttempt]=useState(false);
 const [discardPending,setDiscardPending]=useState(false);
 const session=useRef<CheckpointSession|null>(null);
 const reservation=useRef<{token:PreparedReservation;limits:{maxDurationSeconds:number;maxWavBytes:number}}|null>(null);
 const attempt=useRef(0);
 const currentLimits=useRef(limits);currentLimits.current=limits;
 const [drafts,setDrafts]=useState<Draft[]>([]);
 const [unrestorable,setUnrestorable]=useState(0);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const controller=useRef<RecordingController|null>(null);
 const unsubscribe=useRef<(()=>void)|null>(null);
 const owned=useRef(0);
 const lock=useRef(false);
 const store=useRef<RecordingDraftStore|null>(null);
 const token=useRef<PreparedDraft|null>(null);
 const active=activeStates.has(capture.state);
 useUnsavedWork(active || capture.state==='ready' || busy);
 const reset=()=>{
  unsubscribe.current?.();unsubscribe.current=null;
  controller.current?.dispose();controller.current=null;
  // An explicit end releases this writer connection; a future attempt opens fresh.
  // Never rebind the old session to a replacement connection.
  if(session.current||reservation.current){store.current?.close();store.current=null;}
  token.current=null;session.current=null;reservation.current=null;attempt.current++;setCapture(empty);setCheckpointAttempt(false);setReservationPending(false);setDiscardPending(false);setOptIn(false);
 };
 useEffect(()=>{
  const generation=++owned.current;
  return()=>{if(owned.current===generation)owned.current++;unsubscribe.current?.();controller.current?.dispose();store.current?.close();};
 },[]);
 const attachController=(next:RecordingController,generation:number)=>{
  const captureAttempt=++attempt.current;
  controller.current=next;
  unsubscribe.current=next.subscribe(snapshot=>{
   if(owned.current===generation && attempt.current===captureAttempt && controller.current===next)setCapture(snapshot);
  });
 };
 const start=()=>{
  if(lock.current || !limits || disabled || session.current || controller.current && (activeStates.has(controller.current.getSnapshot().state)||controller.current.getSnapshot().state==='ready'))return;
  if(!optIn && !reservation.current){
   reset();setError('');setNotice('');
   const next=runtime.createController();attachController(next,owned.current);void next.start({...limits});return;
  }
  void operation(async generation=>{
   // Freeze once per explicit attempt. Failed reservation retries retain this exact token.
   if(!reservation.current){
    reset();setCheckpointAttempt(true);setOptIn(true);setReservationPending(true);
    const frozen={...limits};
    reservation.current={token:(runtime.prepareReservation??prepareRecordingReservation)({preserveDuringCapture:true,limits:frozen},runtime.now()),limits:frozen};
   }
   const prepared=reservation.current;
   const connection=await open(generation);
   if(owned.current!==generation)return;
   const reserved=await connection.reserveRecording(prepared.token);
   if(owned.current!==generation)return;
   const nextSession=(runtime.createSession??createCheckpointSession)(connection,reserved);
   session.current=nextSession;setReservationPending(false);
   const latest=currentLimits.current;
   if(!latest||latest.maxDurationSeconds<prepared.limits.maxDurationSeconds||latest.maxWavBytes<prepared.limits.maxWavBytes){
    setCapture({...empty,state:'cancelled'});setError('服务端限制已收紧，未启动录音。请结束本次尝试，再明确开始新录音；已有预留仍保留。');return;
   }
   const next=runtime.createController({checkpointSink:nextSession.sink});attachController(next,generation);
   // Microphone acquisition is strictly after acknowledged reservation.
   void next.start(prepared.limits).catch(()=>{if(owned.current===generation&&controller.current===next)setError('录音启动未获确认；本机预留仍保留，请核对后结束本次尝试。');});
  });
 };
 const open=async(generation:number)=>{
  if(owned.current!==generation)throw Error('stale');
  if(store.current)return store.current;
  const next=await runtime.openStore();
  if(owned.current!==generation){next.close();throw Error('stale');}
  store.current=next;return next;
 };
 // Synchronous lock prevents double clicks; generation fences all UI commits after unmount.
 const operation=async(work:(generation:number)=>Promise<void>)=>{
  if(lock.current)return;
  lock.current=true;setBusy(true);setError('');setNotice('');const generation=owned.current;
  try {await work(generation);} catch {if(owned.current===generation){if(!session.current&&!reservation.current){store.current?.close();store.current=null;}setError('本机草稿操作未获确认。未确认保存或删除前不会清空当前录音；分段预留失败不会自动改为普通录音。结果不确定时请明确核对同一本次操作或刷新草稿架。不会自动上传或使用其他存储。');}}
  finally {if(owned.current===generation){lock.current=false;setBusy(false);}}
 };
 const refreshShelf=async(generation:number)=>{
  if(owned.current!==generation)return;
  const connection=await open(generation);
  if(owned.current!==generation)return;
  const result=await connection.restore();
  if(owned.current!==generation)return;
  const shelf=await connection.restoreCheckpoints();
  if(owned.current!==generation)return;
  const checked=await Promise.all(result.drafts.map(async draft=>({draft,valid:await isOwnedPcmWav(draft)})));
  if(owned.current===generation){setDrafts(checked.filter(row=>row.valid).map(row=>row.draft));setUnrestorable(result.unrestorableCount+checked.filter(row=>!row.valid).length+shelf.unrestorableCount);setCheckpoints(shelf.checkpoints);setEmptyReservations(shelf.emptyReservations);setIntegrityBlocked(shelf.integrityBlocked);}
 };
 const preserve=()=>operation(async generation=>{
  const snapshot=controller.current?.getSnapshot();
  if(session.current||reservation.current)return;
  if(snapshot?.state!=='ready'||!snapshot.artifact||!snapshot.frames)return;
  if(!token.current){
   const prepared=await runtime.prepare({preserve:true,blob:new Blob([new Uint8Array(snapshot.artifact)],{type:'audio/wav'}),durationSeconds:snapshot.frames/16000},runtime.now());
   if(owned.current!==generation)return;
   token.current=prepared;
  }
  const connection=await open(generation);
  if(owned.current!==generation)return;
  await connection.preserve(token.current);
  if(owned.current!==generation)return;
  // The storage transaction acknowledgment is the only save path that clears A.
  reset();setNotice('已确认保存到本机草稿架。下一段需要再次点击开始录音。');
  try {await refreshShelf(generation);} catch {if(owned.current===generation){store.current?.close();store.current=null;setError('录音已确认保存，但草稿架刷新失败。请点击读取或刷新本机草稿架核对，不要重复创建录音。');}}
 });
 const choose=(blob:Blob,expiresAt?:number,checkpoint=false,partial=false)=>{
  if(disabled||lock.current)return;
  try {
   const now=checkpoint?(runtime.clockGuard??recordingClockGuard).observe(runtime.now()):runtime.now();
   if(expiresAt!==undefined && expiresAt<=now){setError('草稿已过期，不能选用或上传。请刷新草稿架。');return;}
   onSelect({file:new File([blob],partial?'recording-recovered-partial.wav':'recording.wav',{type:'audio/wav'}),expiresAt,...(checkpoint?{checkpoint:true as const}:{})});
  } catch {setError('录音草稿时钟检查失败，不能选用或上传。请校正时钟后重新核对。');}
 };
 const removeCheckpoint=async(target:CheckpointDeleteTarget,generation:number)=>{
  const connection=await open(generation);
  if(owned.current!==generation)return false;
  try {
   const exact={schema:2 as const,id:target.id,writerEpoch:target.writerEpoch,revision:target.revision};
   const result=await connection.removeCheckpoint(exact);
   if(!result.removed&&!result.absent)throw Error('unconfirmed');
  } catch(error) {
   // An unknown acknowledgment may have committed. Inspect the SAME identity only;
   // never refresh a revision and silently delete someone else's newer contents.
   if(owned.current!==generation)throw error;
   if((error as {outcome?:string}).outcome!=='unknown')throw error;
   if(await connection.inspectCheckpoint({schema:2,id:target.id,writerEpoch:target.writerEpoch})!==null)throw error;
  }
  return owned.current===generation;
 };
 const ownsCheckpoint=(identity:{id:string;writerEpoch:string})=>{
  const current=session.current?.sink.identity??reservation.current?.token;
  return !!current&&current.id===identity.id&&current.writerEpoch===identity.writerEpoch;
 };
 const removeEmptyReservation=(item:EmptyCheckpointReservation)=>{
  if(lock.current || ownsCheckpoint(item)&&activeStates.has(controller.current?.getSnapshot().state??'idle'))return;
  const memoryDisclosure=ownsCheckpoint(item)?'删除确认后也会清空本次内存中的录音；删除未确认时保留当前内存录音。':'';
  if(!window.confirm('删除这个分段预留？它只是读取时尚无确认音频的快照，内容可能已变化，其他页面也可能正在录音。删除可能中断该页面的分段保存；只删除此确切版本，不会自动删除较新内容。'+memoryDisclosure))return;
  void operation(async generation=>{
   const own=ownsCheckpoint(item);
   if(own){
    // Retire local capture callbacks before deletion without awaiting a hung digest.
    // Already-started writes still face the exact revision/absent-record fence.
    unsubscribe.current?.();unsubscribe.current=null;
    controller.current?.dispose();attempt.current++;
   }
   if(await removeCheckpoint(item,generation)){
    if(own)reset();
    setNotice('已核对该分段预留不再存在。');
    await refreshShelf(generation);
   }
  });
 };
 const discard=()=>{
  if(lock.current)return;
  if(session.current){
   if(!window.confirm('停止并放弃本次录音？本机已保存的分段也需要删除。停止后请点击核对并删除，删除未获确认前仍会保留。'))return;
   controller.current?.stop();setDiscardPending(true);setNotice('已请求停止；尚未删除本机分段。停止完成后请明确核对并删除。');return;
  }
  if(window.confirm('放弃当前录音？未保存的录音会丢失。')){reset();setNotice('已放弃当前录音。');}
 };
 const deleteAttempt=()=>operation(async generation=>{
  const current=session.current;
  if(!current||activeStates.has(controller.current?.getSnapshot().state??'idle'))return;
  const receipt=await current.reconcile();
  if(owned.current!==generation||session.current!==current)return;
  if(await removeCheckpoint(receipt,generation)){
   reset();setNotice('已核对本次分段草稿不再存在；当前录音已清空。');await refreshShelf(generation);
  }
 });
 const reconcile=()=>operation(async generation=>{
  const current=session.current;if(!current)return;
  const receipt=await current.reconcile();
  if(owned.current!==generation||session.current!==current)return;
  setCapture(previous=>({...previous,persistedFrames:receipt.committedFrames,persistenceStatus:receipt.status==='sealed'?'sealed':receipt.status==='interrupted'?'interrupted':previous.persistenceStatus}));
  setNotice(`已核对本次分段：确认保存 ${(receipt.committedFrames/16000).toFixed(2)} 秒。不会恢复录音。`);
  await refreshShelf(generation);
 });
 return <section aria-label="录音与本机草稿">
  <h3>录音与本机草稿</h3>
  <p>仅点击开始才申请麦克风。16 kHz 单声道 PCM16 WAV；最多 300 秒、16 MiB，并取服务端更小限制。限制是资源策略，不代表设备验收。不会播放音频或自动上传。</p>
  <p role="status">录音状态：{labels[capture.state]}</p>
  <label><input type="checkbox" checked={optIn} disabled={busy||active||capture.state==='ready'||checkpointAttempt} onChange={event=>setOptIn(event.target.checked)}/>本次录音分段保存到本机，以便中断后恢复已确认保存的部分</label>
  <p>默认不勾选，每次新录音需重新选择。分段与已完成草稿共用两条额度，预留起固定 24 小时；未确认保存的末尾可能丢失。停止录音不删除分段。</p>
  <button disabled={disabled||!limits||active||capture.state==='ready'||busy||!!session.current} onClick={start}>开始录音</button>
  {reservationPending&&<><p>本次分段预留尚未确认，不会申请麦克风。开始录音将核对同一预留。</p><button disabled={busy} onClick={()=>{reset();setNotice('已结束本次准备；可能已经保存的预留不会被删除，请刷新草稿架核对。');}}>结束本次准备并保留可能的预留</button></>}
  {checkpointAttempt&&<p role="status">已接收 {((capture.receivedFrames??capture.frames??0)/16000).toFixed(2)} 秒；已确认保存 {((capture.persistedFrames??0)/16000).toFixed(2)} 秒。尚未确认保存的末尾可能丢失。保存状态：{capture.persistenceStatus??'reserving'}</p>}
  {session.current&&!active&&<button disabled={busy} onClick={()=>void reconcile()}>核对本次分段保存结果</button>}
  {discardPending&&!active&&<button disabled={busy||capture.persistenceStatus==='draining'} onClick={()=>void deleteAttempt()}>核对并删除本次分段草稿</button>}
  {active && <p>暂停经采集处理器确认后生效，暂停期间不保存新音频，但麦克风仍占用。暂停间隔不计入音频；从开始起的总时限不延长。隐藏页面或设备中断仍会停止，不会自动继续。</p>}
  {capture.state==='recording'&&controller.current?.pause&&<button disabled={busy} onClick={()=>controller.current?.pause?.()}>暂停录音</button>}
  {capture.state==='paused'&&controller.current?.resume&&<button disabled={busy} onClick={()=>controller.current?.resume?.()}>继续录音</button>}
  {active && <><button disabled={capture.state==='stopping'} onClick={()=>controller.current?.stop()}>停止录音</button><button disabled={busy} onClick={discard}>放弃当前录音</button></>}
  {capture.state==='ready' && <>
   {!!capture.pauseCount&&<p>本次确认暂停 {capture.pauseCount} 次，暂停间隔未写入音频；各段按接收顺序拼接，不代表连续会议录音。</p>}
   <p>已接收并校验 {((capture.frames??0)/16000).toFixed(2)} 秒。{capture.interrupted?'录音因页面或设备中断而停止，仅保留已收到的片段。':'未观察到中断信号，但不保证真实采集连续。'}{capture.reachedLimit?'已达到录音限制。':''}</p>
   <button disabled={disabled||busy} onClick={()=>capture.artifact&&choose(new Blob([new Uint8Array(capture.artifact)],{type:'audio/wav'}))}>选用当前录音作为待上传文件</button>
   {!checkpointAttempt&&<button disabled={busy} onClick={()=>void preserve()}>保留到本机草稿架并清空当前录音</button>}
   {checkpointAttempt&&<button disabled={busy||capture.persistenceStatus==='draining'} onClick={()=>{reset();setNotice('已清空当前内存录音，本机分段仍保留。下一次录音需重新选择是否分段保存。');}}>清空当前录音并保留本机分段</button>}
   <button disabled={busy} onClick={discard}>放弃已完成录音</button>
  </>}
  {capture.state==='error' && <p role="alert">无法完成录音（{capture.error}）。未生成可上传录音；可重新点击开始，不会自动重试。</p>}
  <p>本机草稿最多两条，已完成草稿与分段预留共用额度；满额不会覆盖。固定从首次准备保留起期限为 24 小时，到期不可恢复或上传，清理依赖下次访问，不保证关页后台精确删除，也不保证加密。浏览器可能清理数据，请勿作为唯一备份。</p>
  <p>草稿仅属于当前浏览器和来源（包含端口）；启动时随机端口可能让旧草稿不可见。这里不会更改端口或网络配置。读取草稿不会开启麦克风、消费草稿或自动上传。离开页面不保证取消已发起的保存操作，返回后可明确读取核对。</p>
  <button disabled={busy} onClick={()=>void operation(refreshShelf)}>读取或刷新本机草稿架</button>
  {unrestorable>0 && <p>有 {unrestorable} 条记录无法安全恢复，仍可能占用空间；不会覆盖或删除未知记录。</p>}
  {emptyReservations.length>0&&<><p>有 {emptyReservations.length} 条读取时尚无已确认音频的预留，仍占用额度；不是可恢复录音，也不代表已放弃或已崩溃。</p>
   <ul>{emptyReservations.map(item=><li key={`${item.id}:${item.writerEpoch}`}>
    分段预留 · 读取时已确认 0 秒 · 到期 {new Date(item.expiresAt).toLocaleString()}
    <p>这是只读版本快照，内容可能已经变化；其他页面可能仍在录音。当前页面正在录音时，请先停止再删除。</p>
    <button disabled={busy||ownsCheckpoint(item)&&active} onClick={()=>removeEmptyReservation(item)}>删除此分段预留</button>
   </li>)}</ul>
  </>}
  {integrityBlocked&&<p role="alert">草稿完整性检查受阻，不能安全恢复或新增分段；未知记录不会被删除。</p>}
  {checkpointAttempt&&(capture.state==='error'||capture.state==='cancelled')&&<><button disabled={busy} onClick={discard}>放弃本次分段录音</button><button disabled={busy} onClick={()=>{reset();setNotice('当前尝试已结束，本机已保存分段仍保留。');}}>结束本次录音并保留本机分段</button></>}
  <ul>{checkpoints.map(item=><li key={`${item.id}:${item.writerEpoch}`}>
   {item.completion==='sealed'?'已封存分段录音（不保证真实采集连续）':'中断录音的已保存部分（结尾是否完整未知，不代表完整会议）'} · {item.durationSeconds.toFixed(2)} 秒 · 到期 {new Date(item.expiresAt).toLocaleString()}
   <p>只读已确认前缀快照，可能仍有其他页面在录音；不会恢复麦克风或接续录音。</p>
   <button disabled={disabled||busy} onClick={()=>choose(item.blob,item.expiresAt,true,item.completion!=='sealed')}>选用此分段快照作为待上传文件</button>
   <button disabled={busy} onClick={()=>{if(window.confirm('删除这条本机分段录音及其已保存音频？此操作不可恢复。'))void operation(async generation=>{if(await removeCheckpoint(item,generation)){setNotice('已核对该分段草稿不再存在。');await refreshShelf(generation);}});}}>删除此分段草稿</button>
  </li>)}</ul>
  <ul>{drafts.map(draft=><li key={draft.id}>录音草稿 · {draft.durationSeconds.toFixed(2)} 秒 · 到期 {new Date(draft.expiresAt).toLocaleString()}
   <button disabled={disabled||busy} onClick={()=>choose(draft.blob,draft.expiresAt)}>选用此草稿作为待上传文件</button>
   <button disabled={busy} onClick={()=>{if(window.confirm('删除这条本机录音草稿？此操作不可恢复。'))void operation(async generation=>{const connection=await open(generation);if(owned.current!==generation)return;await connection.remove(draft.id,draft.revision);await refreshShelf(generation);});}}>删除此草稿</button>
  </li>)}</ul>
  {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
 </section>;
}
