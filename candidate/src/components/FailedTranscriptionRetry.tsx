import {useTranscriptionStore} from './TranscriptionStoreBoundary';
import {recordingClockGuard} from '../recording/recording-draft-store';
import type {RecordingSelection} from './RecordingDrafts';
import {useEffect, useRef, useState} from 'react';
import {allowLeavingUnsavedWork, useUnsavedWork} from './unsaved-work';
import {transcriptUrl} from './TranscriptRelationships';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const validId = (value: string) => value.length === 36 && uuid.test(value);
const statuses = ['interrupted', 'processing', 'completed', 'cancelled', 'failed'];
type Child = {id: string; status: string};
type Phase = 'idle' | 'checking' | 'ready' | 'uploading' | 'unknown' | 'recovery' | 'confirmed' | 'blocked';
export type RetryOperation = {phase: Phase; generation: number; child?: Child; uncertain?: boolean; linkedUnavailable?: boolean; recoveryEligible?: boolean; message?: string};
export type RetryOperations = Map<string, RetryOperation>;
const messages: Record<string, string> = {
 NOT_FOUND: '原任务已不可用。', INVALID_STATE: '只有未删除的失败任务可以重试。',
 RECEIPT_UNAVAILABLE: '此旧任务没有可核验的上传凭据，请使用上方普通上传。',
 UPLOAD_MISMATCH: '文件与原上传不一致，请重新选择原文件。', SETTINGS_MISMATCH: '当前服务设置与原任务不一致，暂不可重试。',
 RETRY_UNAVAILABLE: '已有重试任务不可访问，请勿再次上传。', BUSY: '本地服务忙，请稍后核对。',
 INVALID_REQUEST: '上传请求未通过校验。', HISTORY_LIMIT: '本地任务数量已达上限。', DISK_LIMIT: '本地存储空间或上传配额不足。',
 UNAVAILABLE: '暂时无法核对本地服务。',
};
function safeError(data: unknown) {
 const code = (data as {error?: {code?: unknown}})?.error?.code;
 return typeof code === 'string' && Object.hasOwn(messages, code) ? messages[code] : '返回结果无法核验。';
}
function childValue(value: unknown, parent: string): value is Child {
 const child = value as Child | null;
 return !!child && typeof child.id === 'string' && validId(child.id) && child.id !== parent && statuses.includes(child.status);
}
export function parseRetryCheck(value: unknown, parent: string) {
 const data = value as {parentId?: unknown; state?: unknown; reconciliationFinal?: unknown; child?: unknown; eligible?: unknown} | null;
 if (!data || data.parentId !== parent || typeof data.eligible !== 'boolean') throw Error('invalid');
 if (data.state === 'created' && data.reconciliationFinal === true && data.eligible === false && childValue(data.child, parent)) return {child: data.child, eligible: false};
 if ((data.state === 'pending' || data.state === 'uncommitted') && data.reconciliationFinal === false && data.child === null && (data.state !== 'pending' || data.eligible === false)) return {child: null, eligible: data.eligible};
 throw Error('invalid');
}
export function parseRetryPost(value: unknown, parent: string, status: number): Child {
 const data = value as {parentId?: unknown; replayed?: unknown; id: string; status: string};
 if (!data || data.parentId !== parent || !childValue(data, parent) ||
     !((status === 202 && data.replayed === false && data.status === 'processing') || (status === 200 && data.replayed === true))) throw Error('invalid');
 return {id: data.id, status: data.status};
}

// The parent owns operation identity and uncertainty, never File bytes. A discarded
// row loses its File. An uncertain submission requires fresh selection and explicit
// same-parent recovery; GET absence never proves the previous POST did not execute.
export function FailedTranscriptionRetry({id, language, disabled, maxBytes, operations, onChanged, selectedRecording, takeSelectedRecording}: {
 id: string; language?: string; disabled: boolean; maxBytes?: number; operations: RetryOperations; onChanged: () => void;
 selectedRecording?: RecordingSelection; takeSelectedRecording?: (selection: RecordingSelection) => boolean;
}) {
 const store=useTranscriptionStore(), scopedFetch=store.fetch, operationKey=store.key(id);
 const [file, setFile] = useState<File | null>(null);
 const recording = useRef<RecordingSelection | null>(null);
 const [selectionError, setSelectionError] = useState('');
 const [, render] = useState(0);
 const input = useRef<HTMLInputElement>(null);
 const mounted = useRef(false);
 const row = useRef(Symbol(id));
 const latest = useRef({disabled, language, maxBytes}); latest.current = {disabled, language, maxBytes};
 useUnsavedWork(file !== null);
 useEffect(() => {mounted.current = true; return () => {mounted.current = false; row.current = Symbol(id);};}, [id]);
 const operation = operations.get(operationKey) ?? {phase: 'idle', generation: 0};
 const selectable = ['ready', 'recovery'].includes(operation.phase) && !operation.child && !operation.linkedUnavailable;
 const busy = operation.phase === 'checking' || operation.phase === 'uploading';
 const valid = !store.blocked && !disabled && validId(id) && ['auto', 'zh', 'en'].includes(language ?? '') && Number.isSafeInteger(maxBytes) && maxBytes! > 0;
 const clearFile = () => {setFile(null); recording.current = null; setSelectionError(''); if (input.current) input.current.value = '';};
 const recordingValid = (selection: RecordingSelection) => {
  try {
   const now = selection.checkpoint ? recordingClockGuard.observe(Date.now()) : Date.now();
   if (selection.expiresAt !== undefined && (!Number.isSafeInteger(selection.expiresAt) || selection.expiresAt <= now)) {
    setSelectionError('录音草稿已过期，不能用于重试。请放弃所选文件并重新核对草稿架。'); return false;
   }
   if (!selection.file.size || selection.file.size > maxBytes!) {setSelectionError('录音超过当前文件限制，不能用于重试。'); return false;}
   return true;
  } catch {setSelectionError('录音草稿时钟检查失败，不能用于重试。请校正时钟后重新核对。'); return false;}
 };
 const selectRecording = () => {
  if (!valid || !selectable || !selectedRecording || !takeSelectedRecording) return;
  const selection = selectedRecording;
  if (!recordingValid(selection)) return;
  if (file && !window.confirm('将此失败任务已选的重试文件替换为上方录音？不会提交音频或更改原任务。')) return;
  // Confirmation can span expiry. Transfer only the exact still-selected file.
  if (!recordingValid(selection) || !takeSelectedRecording(selection)) return;
  recording.current = selection; setFile(selection.file); setSelectionError('');
  if (input.current) input.current.value = '';
 };
 async function run(upload: boolean) {
  const previous = operations.get(operationKey) ?? {phase: 'idle', generation: 0};
  if (['checking', 'uploading'].includes(previous.phase) || !valid || (upload && (!['ready', 'recovery'].includes(previous.phase) || previous.child || previous.linkedUnavailable || !file))) return;
  const selected = upload ? file : null;
  const selectedDraft = upload ? recording.current : null;
  if (selectedDraft && !recordingValid(selectedDraft)) return;
  if (selected && (!selected.size || selected.size > maxBytes! || !/\.(wav|mp3|m4a|ogg)$/i.test(selected.name))) return;
  const generation = previous.generation + 1, ownedRow = row.current;
  // Set the shared lock synchronously, before any await or React state update.
  operations.set(operationKey, {...previous, phase: 'checking', recoveryEligible: false, generation}); render(n => n + 1);
  const current = () => operations.get(operationKey)?.generation === generation;
  const visible = () => current() && mounted.current && row.current === ownedRow;
  const put = (next: Omit<RetryOperation, 'generation'>) => {if (current()) operations.set(operationKey, {...next, uncertain: next.uncertain ?? previous.uncertain, linkedUnavailable: next.linkedUnavailable ?? previous.linkedUnavailable, child: next.child ?? previous.child, generation}); if (current() && mounted.current) render(n => n + 1);};
  const confirm = (child: Child) => {
   if (previous.child && previous.child.id !== child.id) throw Error('invalid');
   put({phase: 'confirmed', child});
   if (visible()) {clearFile(); onChanged();}
  };
  let posted = false;
  try {
   const response = await scopedFetch(`/api/local-asr/jobs/${encodeURIComponent(id)}/retry`, {method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error'});
   const data: unknown = await response.json();store.assertActive();
   if (response.status !== 200) {put({phase: previous.uncertain || previous.phase === 'unknown' || previous.child ? 'unknown' : 'blocked', linkedUnavailable: previous.linkedUnavailable || (data as {error?: {code?: unknown}})?.error?.code === 'RETRY_UNAVAILABLE', message: (previous.uncertain || previous.child || previous.linkedUnavailable) && (data as {error?: {code?: unknown}})?.error?.code === 'RECEIPT_UNAVAILABLE' ? '无法核验原上传凭据；请继续核对，不要通过普通上传替代此重试。' : safeError(data)}); return;}
   const check = parseRetryCheck(data, id);
   if (check.child) {confirm(check.child); return;}
   if (previous.child || previous.linkedUnavailable) {put({phase: 'unknown', message: '已有重试任务记录，不能重新上传。请稍后再次核对。'}); return;}
   if ((previous.uncertain || previous.phase === 'unknown') && !(upload && previous.phase === 'recovery')) {put({phase: 'unknown', uncertain: true, recoveryEligible: check.eligible, message: '尚未确认结果；未查到子任务不代表未执行，旧请求可能仍在处理中。可继续核对；符合资格时也可显式重新选择原文件，向同一父任务安全重试。'}); return;}
   if (!upload) {put({phase: check.eligible ? 'ready' : 'blocked', message: check.eligible ? '可重新选择原文件；最终资格由服务器提交时校验。' : '当前不可重试，请稍后核对。'}); return;}
   // Preflight is advisory. A discarded or newly disabled row must not POST.
   if (!visible() || latest.current.disabled || latest.current.language !== language || latest.current.maxBytes !== maxBytes || !check.eligible) {put({phase: 'blocked', message: '任务状态已变化，请重新核对。'}); return;}
   // A deferred eligibility check cannot extend a recording draft's lifetime.
   if (selectedDraft && !recordingValid(selectedDraft)) {put({phase: 'blocked', message: '录音草稿不能继续提交，请放弃所选文件后重新核对。'}); return;}
   put({phase: 'uploading', uncertain: true}); posted = true;
   const mime = ({wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg'} as Record<string, string>)[selected!.name.split('.').pop()!.toLowerCase()];
   const post = await scopedFetch(`/api/local-asr/jobs/${encodeURIComponent(id)}/retry`, {method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: {'Content-Type': mime, 'X-Audio-Filename': encodeURIComponent(selected!.name), 'X-Audio-Language': language!}, body: selected});
   const result: unknown = await post.json();store.assertActive();
   if (!post.ok) {if (visible()) clearFile(); put({phase: 'unknown', uncertain: true, linkedUnavailable: previous.linkedUnavailable || (result as {error?: {code?: unknown}})?.error?.code === 'RETRY_UNAVAILABLE', message: ((result as {error?: {code?: unknown}})?.error?.code === 'RECEIPT_UNAVAILABLE' ? '无法核验原上传凭据；请继续核对，不要通过普通上传替代此重试。' : safeError(result)) + ' 请核对重试结果；不会自动重新上传。'}); return;}
   confirm(parseRetryPost(result, id, post.status));
  } catch {
   if (posted && visible() && !store.blocked) clearFile();
   put({phase: posted || previous.uncertain || previous.child || previous.phase === 'unknown' || previous.phase === 'confirmed' ? 'unknown' : 'blocked', uncertain: posted || previous.uncertain, message: posted ? '上传结果未知，请核对重试结果；不会自动重新上传。' : '暂时无法核对结果，请稍后重试。'});
  }
 }
 return <section aria-label="失败任务重新上传">
  <p>失败任务需重新选择原文件，不会从旧分段继续；原任务保留不变。旧任务没有上传凭据时仍可使用上方普通上传。</p>
  <p>本次固定使用原任务语言：{language ?? '未记录'}。文件仅暂存于本页内存，离开或放弃后需重新选择。</p>
  <button disabled={!valid || busy} onClick={() => void run(false)}>{operation.phase === 'unknown' ? '核对重试结果' : '核对重试资格与结果'}</button>
  {operation.phase === 'unknown' && operation.recoveryEligible && !operation.child && !operation.linkedUnavailable && <button disabled={!valid} onClick={() => {const current = operations.get(operationKey); if (current?.phase !== 'unknown' || !current.recoveryEligible || current.child || current.linkedUnavailable) return; row.current = Symbol(id); clearFile(); operations.set(operationKey, {...current, phase: 'recovery', recoveryEligible: false, generation: current.generation + 1}); render(n => n + 1);}}>重新选择原文件以安全重试同一父任务</button>}
  {operation.phase === 'recovery' && <p>旧请求可能仍在处理中。请选择原文件，再明确点击下方重试；服务器会核验原文件并复用同一父任务已有的子任务，不会创建重复子任务。</p>}
  <label>为此失败任务重新选择原文件<input ref={input} type="file" accept=".wav,.mp3,.m4a,.ogg" disabled={!valid || !selectable} onChange={event => {if (valid && selectable) {recording.current = null; setSelectionError(''); setFile(event.target.files?.[0] ?? null);}}}/></label>
  {selectedRecording && takeSelectedRecording && <><button disabled={!valid || !selectable} onClick={selectRecording}>将上方已选录音移入此任务重试</button><p>仅移动当前明确选中的录音，不按文件名匹配任务，不自动提交；上方普通上传选择将清空，本机已保存草稿不会删除。服务器仍须核验与此原任务的音频字节一致。</p></>}
  {selectionError && <p role="alert">{selectionError}</p>}
  {recording.current && file && <p>此重试保留录音草稿的原到期时间；待提交文件仍仅在本页内存中。</p>}
  {file && <p>待重新上传：{file.name} · {file.size} 字节</p>}
  <button disabled={!valid || !selectable || !file || !file.size || file.size > maxBytes! || !/\.(wav|mp3|m4a|ogg)$/i.test(file.name)} onClick={() => void run(true)}>用原文件重试此失败任务</button>
  {file && <button onClick={() => {if (allowLeavingUnsavedWork()) {row.current = Symbol(id); clearFile();}}}>放弃所选重试文件</button>}
  {busy && <p role="status">{operation.phase === 'uploading' ? '正在重新上传原文件…' : '正在核对重试结果…'}</p>}
  {operation.message && <p role="status">{operation.message}</p>}
  {operation.phase === 'unknown' && <p>不会自动再次提交音频；安全重试必须重新选择文件并明确点击重试。</p>}
  {operation.phase === 'confirmed' && operation.child && <p>已确认重试任务。<a href={transcriptUrl({transcriptStoreId: store.scope!, jobId: operation.child.id})} onClick={event => {if (!allowLeavingUnsavedWork()) event.preventDefault();}}>查看重试任务</a></p>}
 </section>;
}
