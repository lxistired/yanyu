import {forgetUploadRecoveryRecord, makeUploadRecoveryRecord, readUploadRecoveryRecord, retainUploadRecoveryRecord, type UploadRecoveryRecord} from './upload-refresh-recovery';
import {recordingClockGuard} from '../recording/recording-draft-store';
import {TranscriptionStoreBoundary, useTranscriptionStore} from './TranscriptionStoreBoundary';
import {createdDateBounds, storedCreatedInstant, type CreatedDateQuery, type CreatedDateSelection} from './transcription-created-date.mjs';
import './local-transcription.css';
import {StagedStatusFilter, type FilterGroup, type FilterSelection} from './staged-status-filter/StagedStatusFilter';
import {RecordingDrafts, type RecordingSelection} from './RecordingDrafts';
import {FailedTranscriptionRetry, type RetryOperations} from './FailedTranscriptionRetry';
import {allowLeavingUnsavedWork, useUnsavedWork, hasUnsavedWork, UnsavedWorkScope, writeUnsavedHistory} from './unsaved-work';
import {TranscriptRelationshipEditor, transcriptUrl, type TranscriptRelationship} from './TranscriptRelationships';
import {TranscriptEditor} from './TranscriptEditor';
import {useEffect, useRef, useState} from 'react';

type ModelLimits = {retentionSeconds?: number; pendingQuota?: number; maxSeconds: number; maxBytes: number; chunkSeconds: number; overlapSeconds: number; deadlineSeconds: number};
type UploadOrigin = 'unknown' | 'file-selection' | 'recording-draft';
const originLabel = {unknown: '来源未知', 'file-selection': '选择音频文件', 'recording-draft': '录音面板（当前录音或已保存草稿）'};
type LocalStatus = 'interrupted' | 'processing' | 'completed' | 'cancelled' | 'failed';
type Job = {
  id: string; filename: string; title?: string; library_revision?: number; deleted_at?: string | null; status: LocalStatus;
  uploadOrigin?: UploadOrigin; uploadOriginAssurance?: 'unknown' | 'client-declared';
  relationship?: TranscriptRelationship | null;
  requested_language?: string;
  pending_expires_at?: number; created: string; error: string | null;
  progress?: {completedChunks: number; totalChunks: number; durationSeconds: number};
  result: {text: string; text_preview_truncated?: boolean; duration_seconds: number; inference_seconds: number; language: string; language_source?: string; language_probability?: number | null; boundaries_truncated?: boolean; boundaries?: {offset: number; method: string}[]} | null;
};
type JobsResponse = {jobs: Job[]; model: ModelLimits; total?: number; offset?: number; limit?: number; hasMore?: boolean; activeJobCount?: number};
const sizeLabel = (bytes: number) => `${(bytes / 1048576).toLocaleString(undefined, {maximumFractionDigits: 1})} MiB`;
const languageLabel = (value?: string) => ({auto: '自动检测', zh: '中文', en: '英文'}[value ?? ''] ?? value ?? '未记录');
const statusLabel = {interrupted: '已中断，等待手动继续',processing: '识别中', completed: '转写完成', cancelled: '已取消', failed: '转写失败'};

// Matches the existing local library API offset ceiling; this is not unlimited pagination.
const MAX_LIBRARY_OFFSET = 1000;
const LIBRARY_PAGE_SIZE = 10;

const statusOrder: readonly LocalStatus[] = ['interrupted', 'processing', 'completed', 'cancelled', 'failed'];
const statusGroups: readonly FilterGroup<'status', LocalStatus>[] = [{id: 'status', label: '任务状态', choices: statusOrder.map(value => ({value, label: statusLabel[value]}))}];

// File bytes remain page-session only. Opt-in metadata recovers an exact receipt
// after same-tab refresh; it never confers retry authority or proves a job exists.
type PendingUpload = Readonly<{operationId: string; scope: string; file: File | null; filename: string; byteLength: number; mime: string; format: string; sha256: string; language: string; origin: Exclude<UploadOrigin, 'unknown'>; expiresAt?: number; checkpoint: boolean; recoveryRecord?: UploadRecoveryRecord}>;
const uploadUuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(value);
const uploadObject = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const requestedRecognizer = {model:'faster-whisper-small',device:'cpu',computeType:'int8',beamSize:5,temperature:0,vadFilter:false,conditionOnPreviousText:false,wordTimestamps:true,cpuThreads:4,numWorkers:1,windowSeconds:30,strideSeconds:29,seedPolicy:'ctranslate2-sha256-source-chunk-v1'};
function confirmedUpload(value: unknown, pending: PendingUpload, status: number, lookup: boolean): {id: string; deleted: boolean} {
  const invalid = () => {throw Error('上传回执与本次操作不符，已保留待确认记录。');};
  if (!uploadObject(value, ['operationId','state','reconciliationFinal','id','status','filename','uploadOrigin','receipt','deleted','replayed'])) return invalid();
  if (value.operationId !== pending.operationId || value.state !== 'committed' || value.reconciliationFinal !== true || !uploadUuid(value.id) ||
    !statusOrder.includes(value.status as LocalStatus) || value.filename !== pending.filename || value.uploadOrigin !== pending.origin || typeof value.deleted !== 'boolean' ||
    !(lookup ? status === 200 && value.replayed === false : (status === 202 && value.replayed === false) || (status === 200 && value.replayed === true))) return invalid();
  const receipt = value.receipt;
  if (!uploadObject(receipt, ['version','sha256','byteLength','declaredMime','acceptedFormat','language','settings']) || receipt.version !== 1 || receipt.sha256 !== pending.sha256 ||
    receipt.byteLength !== pending.byteLength || pending.byteLength < 44 || receipt.declaredMime !== pending.mime || receipt.acceptedFormat !== pending.format || receipt.language !== pending.language) return invalid();
  const settings = receipt.settings;
  if (!uploadObject(settings, ['profile','maxSeconds','maxBytes','deadlineSeconds','requestedRecognizer']) || settings.profile !== 'local-asr-upload-v1' ||
    !Number.isInteger(settings.maxSeconds) || (settings.maxSeconds as number) < 1 || (settings.maxSeconds as number) > 14400 ||
    !Number.isInteger(settings.maxBytes) || (settings.maxBytes as number) < pending.byteLength || (settings.maxBytes as number) > 536870912 ||
    !Number.isInteger(settings.deadlineSeconds) || (settings.deadlineSeconds as number) < 1 || (settings.deadlineSeconds as number) > 28800 ||
    !uploadObject(settings.requestedRecognizer, Object.keys(requestedRecognizer)) || Object.entries(requestedRecognizer).some(([key, expected]) => (settings.requestedRecognizer as Record<string, unknown>)[key] !== expected)) return invalid();
  return {id: value.id, deleted: value.deleted};
}

// SHA-256 over bounded File slices. WebCrypto's digest requires one full buffer;
// audio may reach 512 MiB, so retain only a 1 MiB slice plus fixed hash workspace.
export async function hashUploadFile(file: File, assertCurrent: () => void = () => {}) {
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 536870912) throw Error('音频大小不在可核验范围内。');
  const state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const constants = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const words = new Uint32Array(64), tail = new Uint8Array(128);
  const rotate = (x: number, bits: number) => (x >>> bits) | (x << (32 - bits));
  const block = (bytes: Uint8Array, offset: number) => {
    for (let i = 0; i < 16; i++) {const p = offset + i * 4; words[i] = (bytes[p] << 24) | (bytes[p+1] << 16) | (bytes[p+2] << 8) | bytes[p+3];}
    for (let i = 16; i < 64; i++) {const a = words[i-15], b = words[i-2]; words[i] = words[i-16] + (rotate(a,7)^rotate(a,18)^(a>>>3)) + words[i-7] + (rotate(b,17)^rotate(b,19)^(b>>>10));}
    let [a,b,c,d,e,f,g,h] = state;
    for (let i = 0; i < 64; i++) {const t1 = (h + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^(~e&g)) + constants[i] + words[i]) >>> 0; const t2 = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c))) >>> 0; h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;}
    const result = [a,b,c,d,e,f,g,h]; for (let i = 0; i < 8; i++) state[i] += result[i];
  };
  let tailLength = 0;
  for (let offset = 0; offset < file.size; offset += 1048576) {
    assertCurrent();
    const size = Math.min(1048576, file.size - offset), bytes = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer());
    assertCurrent(); if (bytes.byteLength !== size) throw Error('音频读取不完整，未提交。');
    let cursor = 0;
    if (tailLength) {const count = Math.min(64-tailLength, bytes.length); tail.set(bytes.subarray(0,count),tailLength); tailLength += count; cursor += count; if (tailLength === 64) {block(tail,0); tailLength=0;}}
    for (; cursor + 64 <= bytes.length; cursor += 64) block(bytes,cursor);
    if (cursor < bytes.length) {tail.set(bytes.subarray(cursor),tailLength); tailLength += bytes.length-cursor;}
  }
  tail.fill(0,tailLength); tail[tailLength] = 0x80;
  const padded = tailLength < 56 ? 64 : 128, bits = file.size * 8, view = new DataView(tail.buffer);
  view.setUint32(padded-8,Math.floor(bits/4294967296)); view.setUint32(padded-4,bits>>>0);
  block(tail,0); if (padded === 128) block(tail,64);
  assertCurrent(); return Array.from(state, word => word.toString(16).padStart(8,'0')).join('');
}

export function LocalTranscription() {return <TranscriptionStoreBoundary><BoundLocalTranscription/></TranscriptionStoreBoundary>;}
function BoundLocalTranscription() {
  const store = useTranscriptionStore();
  const scopedFetch = store.fetch;
  const [filters, setFilters] = useState(() => {const params = new URL(location.href).searchParams; return {jobId: params.get('transcriptJob') || '', workspaceId: params.get('workspaceId') || '', sessionId: params.get('sessionId') || ''};});
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<'active' | 'trash'>('active');
  const [statuses, setStatuses] = useState<LocalStatus[]>([]);
  const [origin, setOrigin] = useState<UploadOrigin | ''>('');
  const [originDraft, setOriginDraft] = useState<UploadOrigin | ''>('');
  const [originOpen, setOriginOpen] = useState(false);
  const [originError, setOriginError] = useState('');
  const [dates, setDates] = useState<CreatedDateSelection>({createdFrom: '', createdThrough: ''});
  const [dateDraft, setDateDraft] = useState<CreatedDateSelection>({createdFrom: '', createdThrough: ''});
  const [dateOpen, setDateOpen] = useState(false);
  const [dateError, setDateError] = useState('');
  const dateQuery: CreatedDateQuery = {...(dates.createdFrom ? {createdFrom: dates.createdFrom} : {}), ...(dates.createdThrough ? {createdThrough: dates.createdThrough} : {})};
  const [statusOpen, setStatusOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const atPageLimit = offset + LIBRARY_PAGE_SIZE > MAX_LIBRARY_OFFSET;
  const [activeJobCount, setActiveJobCount] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [model, setModel] = useState<ModelLimits | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [recordingEpoch, setRecordingEpoch] = useState(0);
  const selectionOrigin = useRef<Exclude<UploadOrigin, 'unknown'>>('file-selection');
  const selectionExpiry = useRef<number | undefined>(undefined);
  const selectionCheckpoint = useRef(false);
  const [refreshRecovery] = useState(() => {
    try {return {record:readUploadRecoveryRecord(window.sessionStorage,store.scope!), error:''};}
    catch {return {record:null, error:'无法读取本标签页的刷新核对记录；不能把读取失败当作没有旧上传。'};}
  });
  const [skipUnreadableRecovery, setSkipUnreadableRecovery] = useState(false);
  const recoveryReadBlocked = !!refreshRecovery.error && !skipUnreadableRecovery;
  const [retainForRefresh, setRetainForRefresh] = useState(false);
  const [recoverySaved, setRecoverySaved] = useState(!!refreshRecovery.record);
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(() => refreshRecovery.record
    ? Object.freeze({...refreshRecovery.record, expiresAt:refreshRecovery.record.expiresAt ?? undefined, file:null, recoveryRecord:refreshRecovery.record}) : null);
  const pendingUploadRef = useRef<PendingUpload | null>(pendingUpload);
  const [checkingUpload, setCheckingUpload] = useState(false);
  const uploadUncertain = pendingUpload !== null;
  const [uploadedDeleted, setUploadedDeleted] = useState(false);
  const uploadMounted = useRef(true);
  // Both a hidden File and an uncertain operation survive list/selection changes.
  useUnsavedWork(file !== null || pendingUpload !== null);
  const selectionGeneration = useRef(0);
  useEffect(() => {uploadMounted.current = true; return () => {selectionGeneration.current++; uploadMounted.current = false;};}, []);
  const clearSelection = () => {
    selectionGeneration.current++;
    setFile(null);
    setInspectionError('');
    selectionOrigin.current = 'file-selection';
    selectionExpiry.current = undefined; selectionCheckpoint.current = false;
    if (input.current) input.current.value = '';
  };
  const [language, setLanguage] = useState('auto');
  const [inspectionError, setInspectionError] = useState('');
  const [uploadedId, setUploadedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState<string[]>([]);
  const alive = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const cancelRequests = useRef(new Set<string>());

  const retryOperations = useRef<RetryOperations>(new Map());
  const jobsRef = useRef<Job[]>([]);
  const readGeneration = useRef(0);
  const rowScopes = useRef(new Map<string, symbol>());
  const confirmedTrash = useRef(new Set<symbol>());
  const [retainedIds, setRetainedIds] = useState<string[]>([]);
  const rowScope = (id: string) => {
    let scope = rowScopes.current.get(store.key(id));
    if (!scope) {scope = Symbol(id); rowScopes.current.set(store.key(id), scope);}
    return scope;
  };
  const leaveList = () => {
    if (store.blocked) return false;
    if (!allowLeavingUnsavedWork()) return false;
    if (!pendingUploadRef.current) {clearSelection(); setRecordingEpoch(value => value + 1);}
    setError('');
    // An accepted list transition explicitly discards its mounted drafts once.
    readGeneration.current++;
    jobsRef.current = []; setJobs([]); setRetainedIds([]);
    rowScopes.current.clear(); confirmedTrash.current.clear();
    return true;
  };
  const inspectUncertainUpload = (nextScope: 'active' | 'trash') => {
    if (store.blocked || submitting.current || !uploadUncertain) return;
    // Unlike leaveList, this path never discards upload or recording drafts.
    // Refuse to unmount dirty rows, including correction, relationship and retry drafts.
    if ([...rowScopes.current.values()].some(owned => hasUnsavedWork(owned))) {
      setInspectionError('请先保存或取消资料库中未保存的编辑或重试选择，再核对上传结果。' + (pendingUploadRef.current?.file ? '待上传文件仍保留。' : '核对信息仍保留；未恢复音频。'));
      return;
    }
    if (!writeUnsavedHistory(transcriptUrl({transcriptStoreId: store.scope!}), true)) {
      setInspectionError('暂不能切换核对范围，请等待导航恢复后重试。' + (pendingUploadRef.current?.file ? '待上传文件仍保留。' : '核对信息仍保留；未恢复音频。'));
      return;
    }
    readGeneration.current++;
    jobsRef.current = []; setJobs([]); setRetainedIds([]);
    rowScopes.current.clear(); confirmedTrash.current.clear();
    setFilters({jobId: '', workspaceId: '', sessionId: ''});
    setScope(nextScope); setStatuses([]); setStatusOpen(false);
    setOrigin(''); setOriginDraft(''); setOriginOpen(false); setOriginError('');
    setDates({createdFrom: '', createdThrough: ''}); setDateDraft({createdFrom: '', createdThrough: ''}); setDateOpen(false); setDateError('');
    setSearch(''); setQuery(''); setOffset(0); setInspectionError('');
    setRefresh(value => value + 1);
  };
  const commitStatuses = (selection: FilterSelection<'status', LocalStatus>) => {
    const values = selection.status;
    if (!Array.isArray(values) || new Set(values).size !== values.length || values.some(value => !statusOrder.includes(value))) return false;
    const next = statusOrder.filter(value => values.includes(value));
    // A semantic no-op must not discard drafts or reset the current page.
    if (next.length === statuses.length && next.every((value, index) => value === statuses[index])) return true;
    if (!leaveList()) return false;
    setStatuses(next); setOffset(0);
    return true;
  };
  const commitOrigin = () => {
    if (origin === originDraft) {setOriginOpen(false); setOriginError(''); return;}
    if (!leaveList()) {setOriginError('未应用入口筛选，暂存选择仍保留。请先处理未保存内容后重试。'); return;}
    setOrigin(originDraft); setOffset(0); setOriginOpen(false); setOriginError('');
  };
  const commitDates = () => {
    if (!createdDateBounds(dateDraft.createdFrom || undefined, dateDraft.createdThrough || undefined)) {setDateError('请输入有效的 YYYY-MM-DD 日期（0001–9999）；开始日期不能晚于结束日期。'); return;}
    if (dates.createdFrom === dateDraft.createdFrom && dates.createdThrough === dateDraft.createdThrough) {setDateOpen(false); setDateError(''); return;}
    if (!leaveList()) {setDateError('未应用日期筛选，暂存日期仍保留。请先处理未保存内容后重试。'); return;}
    setDates({...dateDraft}); setOffset(0); setDateOpen(false); setDateError('');
  };
  const applyJobs = (data: JobsResponse) => {
    const retained = jobsRef.current.filter(old => {
      if (confirmedTrash.current.has(rowScope(old.id)) || !hasUnsavedWork(rowScope(old.id))) return false;
      const next = data.jobs.find(item => item.id === old.id);
      return !next || (!old.deleted_at && !!next.deleted_at) ||
        (old.status === 'failed' && next.status !== 'failed') || (old.status === 'completed' && next.status !== 'completed') || (!!old.result && !next.result);
    });
    const retainedById = new Map(retained.map(job => [job.id, job]));
    const nextJobs = data.jobs.map(job => retainedById.get(job.id) ?? job);
    nextJobs.push(...retained.filter(job => !data.jobs.some(item => item.id === job.id)));
    jobsRef.current = nextJobs; setJobs(nextJobs); setRetainedIds(retained.map(job => job.id));
    for (const id of rowScopes.current.keys()) if (!nextJobs.some(job => store.key(job.id) === id)) rowScopes.current.delete(id);
    confirmedTrash.current.clear();
    setTotal(data.total ?? data.jobs.length);
    setHasMore(data.hasMore ?? false);
    setActiveJobCount(data.activeJobCount ?? data.jobs.filter(job => job.status === 'processing').length);
    if (!retained.length && data.total !== undefined && offset > 0 && offset >= data.total) setOffset(Math.max(0, Math.floor((data.total - 1) / 10) * 10));
    const limits = data.model;
    setModel(limits && [limits.maxSeconds, limits.maxBytes, limits.chunkSeconds, limits.deadlineSeconds].every(n => Number.isFinite(n) && n > 0)
      && Number.isFinite(limits.overlapSeconds) && limits.overlapSeconds >= 0 ? limits : null);
    for (const id of cancelRequests.current) {
      if (data.jobs.some(job => store.key(job.id) === id && job.status !== 'processing') || data.activeJobCount === 0) cancelRequests.current.delete(id);
    }
    setCancelling([...cancelRequests.current]);
  };

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    const controller = new AbortController();
    const generation = ++readGeneration.current;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await scopedFetch(`/api/local-asr/jobs?${new URLSearchParams({q: search, scope, offset: String(offset), limit: '10', ...(origin ? {origin} : {}), ...dateQuery, ...(statuses.length ? {statuses: statuses.join(',')} : {}), ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value))})}`, {signal: controller.signal});
        if (!response.ok) throw Error('无法读取本地转写记录');
        const data: JobsResponse = await response.json();store.assertActive();
        if (alive.current && !controller.signal.aborted && generation === readGeneration.current) {applyJobs(data); setPollError(''); setLoading(false);}
      } catch (e) {
        if (alive.current && !controller.signal.aborted && generation === readGeneration.current) {setPollError(e instanceof Error ? e.message : '读取失败'); setLoading(false);}
      } finally {
        if (!store.blocked && alive.current && !controller.signal.aborted && generation === readGeneration.current) timer = setTimeout(load, 1000);
      }
    };
    void load();
    return () => {alive.current = false; controller.abort(); clearTimeout(timer);};
  }, [search, scope, offset, refresh, filters, statuses, dates, origin]);

  const latestUploadState = useRef({model, activeJobCount}); latestUploadState.current = {model, activeJobCount};
  const setPending = (pending: PendingUpload | null) => {pendingUploadRef.current = pending; setPendingUpload(pending);};
  const assertRecordingCurrent = (selection: {expiresAt?: number; checkpoint: boolean}) => {
    let now = Date.now();
    if (selection.checkpoint) {try {now = recordingClockGuard.observe(now);} catch {throw Error('录音草稿时钟检查失败，不能上传。请校正时钟后重新核对。');}}
    if (selection.expiresAt !== undefined && (!Number.isSafeInteger(selection.expiresAt) || selection.expiresAt <= now)) throw Error(pendingUploadRef.current ? '录音草稿已过期，不能上传；仍可核对已提交结果。' : '录音草稿已过期，不能上传。请清除待上传文件。');
  };
  const acceptUpload = (pending: PendingUpload, result: {id: string; deleted: boolean}) => {
    if (!uploadMounted.current || pendingUploadRef.current !== pending) return;
    store.assertActive();
    if (pending.recoveryRecord) forgetUploadRecoveryRecord(window.sessionStorage,pending.recoveryRecord);
    setPending(null); setRecoverySaved(false); setRetainForRefresh(false); clearSelection(); setError('');
    setUploadedId(result.id); setUploadedDeleted(result.deleted);
    // Refresh in place: resetting filters could silently discard other editors.
    setRefresh(value => value + 1);
  };
  const postUpload = async (pending: PendingUpload) => {
    store.assertActive();
    if (!uploadMounted.current || pendingUploadRef.current !== pending || store.scope !== pending.scope) throw Error('待确认上传已变化，未重传。');
    if (!pending.file) throw Error('刷新后只恢复了核对信息，没有原文件；本版本不会重传。');
    assertRecordingCurrent(pending);
    if (pending.recoveryRecord) {
      // Synchronous write + exact readback before every possible POST. Failure
      // retains the same in-memory operation and never falls back to a new key.
      retainUploadRecoveryRecord(window.sessionStorage,pending.recoveryRecord);
      setRecoverySaved(true);
    }
    // Storage can take time; preserve the existing expiry check immediately at POST.
    assertRecordingCurrent(pending);
    const response = await scopedFetch('/api/local-asr/transcribe', {method: 'POST',
      headers: {'Content-Type': pending.mime, 'X-Audio-Filename': encodeURIComponent(pending.filename), 'X-Audio-Language': pending.language, 'X-Audio-Origin': pending.origin, 'X-Upload-Operation-Id': pending.operationId}, body: pending.file});
    const data: unknown = await response.json(); store.assertActive();
    acceptUpload(pending, confirmedUpload(data, pending, response.status, false));
  };
  const submit = async () => {
    if (store.blocked || recoveryReadBlocked || pendingUploadRef.current || !file || !model || submitting.current || activeJobCount > 0) return;
    const selectedFile = file, selectedOrigin = selectionOrigin.current, selectedLanguage = language, selectedScope = store.scope!;
    const generation = selectionGeneration.current, recording = {expiresAt: selectionExpiry.current, checkpoint: selectionCheckpoint.current};
    const assertCurrent = () => {
      store.assertActive();
      if (!uploadMounted.current || generation !== selectionGeneration.current || store.scope !== selectedScope || pendingUploadRef.current || latestUploadState.current.activeJobCount > 0 || !latestUploadState.current.model || selectedFile.size > latestUploadState.current.model.maxBytes) throw Error('待上传选择或服务状态已变化，未提交。');
      assertRecordingCurrent(recording);
    };
    submitting.current = true; setError(''); setUploading(true);
    try {
      if (!selectedFile.size || selectedFile.size > model.maxBytes) throw Error(`请选择非空且不超过 ${sizeLabel(model.maxBytes)} 的音频`);
      assertCurrent();
      const extension = selectedFile.name.split('.').pop()?.toLowerCase() ?? '';
      const mime = ({wav:'audio/wav',mp3:'audio/mpeg',m4a:'audio/mp4',ogg:'audio/ogg'} as Record<string,string>)[extension];
      if (!mime || selectedFile.name.length > 180 || /[\x00-\x1f/\\]/.test(selectedFile.name) || !['auto','zh','en'].includes(selectedLanguage)) throw Error('请选择有效的 WAV、MP3、M4A 或 Ogg 音频。');
      const sha256 = await hashUploadFile(selectedFile, assertCurrent);
      assertCurrent();
      const operationId = crypto.randomUUID(); if (!uploadUuid(operationId)) throw Error('无法建立上传操作标识，未提交。');
      const envelope = {operationId, scope:selectedScope, filename:selectedFile.name, byteLength:selectedFile.size, mime, format:extension === 'm4a' ? 'mov' : extension, sha256, language:selectedLanguage, origin:selectedOrigin, ...recording};
      const pending = Object.freeze({...envelope, file:selectedFile, ...(retainForRefresh ? {recoveryRecord:makeUploadRecoveryRecord(envelope)} : {})});
      // Install immutable identity synchronously, before the first possible POST.
      setPending(pending); setRecoverySaved(false); setUploadedId(null); setUploadedDeleted(false);
      await postUpload(pending);
    } catch (e) {if (uploadMounted.current) setError(pendingUploadRef.current ? '上传未获确认。原文件和操作标识仍保留；请核对本次结果或明确使用原操作重试，不会自动重传。' + (e instanceof Error ? ' ' + e.message : '') : e instanceof Error ? e.message : '上传失败');}
    finally {submitting.current = false; if (uploadMounted.current) setUploading(false);}
  };
  const recoverUpload = async (retry: boolean) => {
    const pending = pendingUploadRef.current;
    if (!pending || store.blocked || submitting.current) return;
    submitting.current = true; setError(''); if (retry) setUploading(true); else setCheckingUpload(true);
    try {
      store.assertActive();
      if (store.scope !== pending.scope) throw Error('上传来源已变化。');
      {
        const response = await scopedFetch(`/api/local-asr/transcribe?operationId=${pending.operationId}`, {method:'GET'});
        const data: unknown = await response.json(); store.assertActive();
        if (response.status === 200 && uploadObject(data, ['operationId','state','reconciliationFinal']) && data.operationId === pending.operationId && data.state === 'unconfirmed' && data.reconciliationFinal === false) {
          // Exact GET support is required before any retry. An older service may
          // ignore the operation header; never replay against an unknown contract.
          if (retry) await postUpload(pending);
          else if (uploadMounted.current && pendingUploadRef.current === pending) setError('尚未确认本次上传；未查到不代表未执行。原操作仍保留，不会自动重传。');
        } else acceptUpload(pending, confirmedUpload(data,pending,response.status,true));
      }
    } catch (e) {if (uploadMounted.current && pendingUploadRef.current === pending) setError((e instanceof Error ? e.message : '暂时无法核验本次上传。') + ' 待确认操作仍保留；不会改用普通上传。');}
    finally {submitting.current = false; if (uploadMounted.current) {setUploading(false); setCheckingUpload(false);}}
  };
  const abandonUpload = () => {
    const pending = pendingUploadRef.current;
    if (!pending || submitting.current || !window.confirm('放弃追踪会移除本次操作的本页及刷新核对记录，不会取消已发出的上传或识别，也不会删除录音草稿。再次普通上传可能创建重复任务。是否仍要放弃？')) return;
    if (pendingUploadRef.current !== pending || submitting.current) return;
    try {
      if (pending.recoveryRecord) forgetUploadRecoveryRecord(window.sessionStorage,pending.recoveryRecord);
      setPending(null); setRecoverySaved(false); setRetainForRefresh(false); clearSelection(); setError('已放弃本次追踪；未取消服务器上可能已提交的任务。');
    } catch (e) {setError((e instanceof Error ? e.message : '未能移除刷新核对记录。') + ' 本次追踪仍保留。');}
  };

  const cancel = async (id: string) => {
    if (store.blocked || cancelRequests.current.has(store.key(id))) return;
    cancelRequests.current.add(store.key(id)); setCancelling([...cancelRequests.current]); setError('');
    try {
      const response = await scopedFetch(`/api/local-asr/jobs/${encodeURIComponent(id)}/cancel`, {method: 'POST'});
      if (!response.ok) {
        const data = await response.json();store.assertActive();
        throw Error(data.error?.message || '取消失败');
      }
      store.assertActive();
      // Keep the pending state until polling confirms a terminal job status.
    } catch (e) {
      cancelRequests.current.delete(store.key(id));
      if (alive.current) {setCancelling([...cancelRequests.current]); setError(e instanceof Error ? e.message : '取消失败');}
    }
  };

  const resumeRequests = useRef(new Set<string>());
  const resume = async (id: string) => {
    if (store.blocked || resumeRequests.current.has(store.key(id))) return;
    resumeRequests.current.add(store.key(id)); setError('');
    try {
      const response = await scopedFetch(`/api/local-asr/jobs/${encodeURIComponent(id)}/resume`, {method: 'POST'});
      if (!response.ok) {const data = await response.json();store.assertActive(); throw Error(data.error?.message || '继续失败，请重新上传');}
      store.assertActive();
      setRefresh(value => value + 1);
    } catch (e) {setError(e instanceof Error ? e.message : '继续失败');}
    finally {resumeRequests.current.delete(store.key(id));}
  };
  const busy = store.blocked || recoveryReadBlocked || uploading || uploadUncertain || checkingUpload || activeJobCount > 0;
  const selectRecording = ({file: next, expiresAt, checkpoint}: RecordingSelection) => {
    if (busy || pendingUploadRef.current || !model || submitting.current) return false;
    const validTime=()=>{
      try {const now=checkpoint?recordingClockGuard.observe(Date.now()):Date.now();
        if(expiresAt!==undefined && expiresAt<=now){setError('录音草稿已过期，不能选用。');return false;}
        return true;
      } catch {setError('录音草稿时钟检查失败，不能选用。请校正时钟后重新核对。');return false;}
    };
    if(!validTime())return false;
    if (file && !window.confirm('将当前待上传文件替换为此录音？其他未保存编辑不会被丢弃。')) return false;
    // Confirmation may block across expiry or a wall-clock adjustment.
    if(!validTime())return false;
    selectionGeneration.current++; selectionCheckpoint.current = checkpoint===true; selectionExpiry.current = expiresAt; selectionOrigin.current = 'recording-draft'; setFile(next); setInspectionError(''); setError('');
    if (input.current) input.current.value = '';
    return true;
  };
  const selectedRecording: RecordingSelection | undefined = file && selectionOrigin.current === 'recording-draft' && selectionExpiry.current !== undefined
    ? {file, expiresAt: selectionExpiry.current, ...(selectionCheckpoint.current ? {checkpoint: true as const} : {})} : undefined;
  const takeSelectedRecording = (selection: RecordingSelection) => {
    if (busy || pendingUploadRef.current || submitting.current || !model || selectionOrigin.current !== 'recording-draft' ||
      file !== selection.file || selectionExpiry.current !== selection.expiresAt || selectionCheckpoint.current !== (selection.checkpoint === true) ||
      !file.size || file.size > model.maxBytes) return false;
    // Explicit transfer clears only the upload choice, never the persisted shelf.
    clearSelection(); setError(''); return true;
  };
  return <section className="local-transcription" aria-label="本地音频转写">
    <h2>音频转写</h2>
    <p>本地模型：faster-whisper-small · CPU int8 · 离线识别 · 支持自动检测、中文或英文选择</p>
    <p>支持 16 kHz 单声道 PCM16 WAV、带 Xing/Info 长度的 MP3、完整 M4A 和单流 Ogg。音频在本地处理，临时音频处理后删除；文件名、任务状态和转写文本保存在本地 SQLite，刷新后可继续查看。</p>
    {model ? <p>当前配置上限：{model.maxSeconds.toLocaleString()} 秒、{sizeLabel(model.maxBytes)}；按 {model.chunkSeconds} 秒分段，重叠 {model.overlapSeconds} 秒。任务处理时限 {model.deadlineSeconds.toLocaleString()} 秒，超时会失败。时长由服务端校验，上限是资源配置，不代表同等时长已验证。</p> : <p role="status">{loading ? '正在读取服务端音频限制…' : '未取得有效的服务端音频限制，暂不可上传'}</p>}
    <p>此版本使用温度 0 的确定性束搜索，不使用随机温度回退；与早期版本的文字可能不同，不能据此认为识别准确率提高。</p>
    <p>中断后不会自动继续。待处理音频从上传完成起最多保留 {model?.retentionSeconds ?? 86400} 秒；到期、完成、取消或失败时删除。应用关闭期间无法清理，到下次启动才清理。继续前会校验模型、算法、设置和音频；校验失败请重新上传。</p>
    <p>长音频分段流程已用 75 秒的合成英文音频验证，尚未完成数小时录音的稳定性或准确率验证。CPU 处理可能较慢；识别文字可能漏词、重复或添加原音频中没有的词，分段边界也可能不准确，结果需要人工核对。</p>
    <p>麦克风录音处于本地模拟验证阶段，尚未完成真实浏览器或设备验收；未接入流式转写或说话人区分。此页面不会播放音频。</p>
    <p>自动模式只检测首段并固定用于整个任务，可能判断错误，不支持逐段切换语言；已知语言时建议手动选择。中文仅用一段 4.20 秒公开普通话朗读样本验证，不代表嘈杂会议、方言或中英混说准确率。</p>
    {refreshRecovery.error && <div role="alert"><p>{refreshRecovery.error} 原记录不会被删除或覆盖。当前页方式不支持刷新恢复；再次上传可能产生重复任务。</p>
      {!skipUnreadableRecovery && <button disabled={store.blocked || uploading} onClick={() => {
        if (window.confirm('无法核对旧上传。仅使用当前页方式不会取消旧上传或删除旧记录；新上传可能重复。仍要继续？')) setSkipUnreadableRecovery(true);
      }}>明确继续仅当前页上传（可能重复）</button>}
    </div>}
    <label><input type="checkbox" checked={retainForRefresh} disabled={busy || !!refreshRecovery.error} onChange={event => setRetainForRefresh(event.target.checked)}/>本次上传保留刷新核对信息（不保存音频）</label>
    <p>默认不勾选。勾选后仅在当前浏览器地址及本标签页会话保存操作编号、文件名、摘要、语言和来源等核对信息；刷新后可手动核对结果，不会自动核对或重传。最多保留 16 个来源的各一项，确认或明确放弃后移除；不按录音到期时间删除。关闭标签页、清理浏览器数据、换地址或端口后不保证恢复，不保证加密。</p>
    <RecordingDrafts key={recordingEpoch} limits={model ? {maxDurationSeconds:model.maxSeconds,maxWavBytes:model.maxBytes} : null} disabled={busy} onSelect={selectRecording}/>
    <label className="local-asr-field">识别语言 <select value={language} disabled={busy || !model} onChange={e => setLanguage(e.target.value)}><option value="auto">自动检测</option><option value="zh">中文</option><option value="en">英文</option></select></label>
    <label>选择音频文件 <input ref={input} type="file" accept=".wav,.mp3,.m4a,.ogg,audio/wav,audio/mpeg,audio/mp4,audio/ogg" disabled={busy || !model} onChange={e => {if (pendingUploadRef.current || submitting.current || store.blocked) return; selectionGeneration.current++; selectionExpiry.current = undefined; selectionCheckpoint.current = false; selectionOrigin.current = 'file-selection'; setFile(e.target.files?.[0] ?? null); setInspectionError(''); setError('');}}/></label>
    {file && <p>待上传：{file.name} · {sizeLabel(file.size)}（{file.size.toLocaleString()} 字节）</p>}
    {file && <button disabled={uploading} onClick={() => {clearSelection(); setError('');}}>清除待上传文件</button>}
    <button disabled={!file || busy || !model} onClick={() => void submit()}>{uploading ? '正在上传…' : '上传并本地转写'}</button>
    {uploadedId && uploadedDeleted && <p role="status">已确认本次上传任务 {uploadedId}，但任务已在回收站；不会重新创建或启动识别。</p>}
    {uploadedId && !uploadedDeleted && <p role="status">最近一次已确认上传的任务（上传成功不会重置资料库筛选）：<a href={transcriptUrl({transcriptStoreId: store.scope!, jobId: uploadedId})} onClick={event => {event.preventDefault(); if (!leaveList()) return; setFilters({jobId: uploadedId, workspaceId: '', sessionId: ''}); setScope('active'); setStatuses([]); setOrigin(''); setOriginDraft(''); setOriginOpen(false); setOriginError(''); setDates({createdFrom: '', createdThrough: ''}); setDateDraft({createdFrom: '', createdThrough: ''}); setDateOpen(false); setDateError(''); setSearch(''); setQuery(''); setOffset(0); writeUnsavedHistory(transcriptUrl({transcriptStoreId: store.scope!, jobId: uploadedId}), true); setRefresh(value => value + 1);}}>查看新提交任务</a></p>}
    {file && <p>待上传文件仅保留在当前页面内存中；刷新或关闭后无法恢复，请勿依赖浏览器一定显示离开提示。</p>}
    {error && <p role="alert">{error}</p>}
    {pendingUpload && <div aria-label="未确认上传核对">
      <p>待确认操作：{pendingUpload.operationId} · {pendingUpload.filename} · {pendingUpload.byteLength.toLocaleString()} 字节 · {languageLabel(pendingUpload.language)}。{pendingUpload.file ? '原文件标识、语言、入口和来源已固定；清除可见选择或切换资料库筛选不会放弃此操作。' : '核对信息已恢复，未恢复音频；切换资料库筛选不会放弃此操作。'}</p>
      <button disabled={store.blocked || uploading || checkingUpload} onClick={() => void recoverUpload(false)}>{checkingUpload ? '正在核对本次上传…' : '核对本次上传结果'}</button>
      {pendingUpload.file && <button disabled={store.blocked || uploading || checkingUpload} onClick={() => void recoverUpload(true)}>用原操作重试上传</button>}
      <button disabled={uploading || checkingUpload} onClick={abandonUpload}>放弃追踪本次上传</button>
      <p>不会自动重传。只有有效的本次操作回执才能确认提交；核对未找到不代表没有执行。</p>
      {pendingUpload.recoveryRecord
        ? <p>{recoverySaved ? '本次核对信息已在本标签页会话确认保存，音频未随之保存。' : '本次核对信息尚未确认保存，不能依赖刷新恢复；存储确认前不会发出本次上传。'}{!pendingUpload.file && '刷新后仅恢复核对信息，没有可重试的原文件；本版本只核对回执，不支持刷新后重传。录音草稿到期不妨碍核对已经提交的结果。'}</p>
        : <p>原操作及文件仅保留在当前页面内存，刷新、关闭或离开页面后无法恢复；届时只能人工核对资料库，不能保证再次上传不重复。</p>}
      <p>本次提交结果未确认，不等于转写失败。以下操作仅查看当前同一资料源，不会重传音频；会清除搜索、状态、日期、提交入口和关联范围筛选并回到第一页，{pendingUpload.file ? '待上传文件及录音面板保持不变。' : '核对信息及录音面板保持不变，音频未恢复。'}</p>
      <button disabled={store.blocked || uploading} onClick={() => inspectUncertainUpload('active')}>{pendingUpload.file ? '核对同源资料库（保留文件）' : '核对同源资料库（保留核对信息）'}</button>
      <button disabled={store.blocked || uploading} onClick={() => inspectUncertainUpload('trash')}>{pendingUpload.file ? '核对同源回收站（保留文件）' : '核对同源回收站（保留核对信息）'}</button>
      <p>请人工核对文件名、创建时间、状态和可用内容。这些线索不能证明属于本次提交；未找到也不代表没有提交成功。放弃追踪后的新上传仍可能创建重复任务。</p>
      {inspectionError && <p role="alert">{inspectionError}</p>}
    </div>}
    {pollError && <p role="alert">{pollError}{store.blocked ? '；已停止请求，不会自动重试' : '，正在重试'}；以下任务状态可能不是最新状态</p>}
    {loading && <p role="status">读取已保存转写…</p>}
    {(uploading || activeJobCount > 0) && <p role="status">正在使用本地 CPU 识别；离开页面不会取消已经提交的任务，可使用任务的取消按钮停止处理</p>}
    <h2>转写资料库</h2>
    <StagedStatusFilter optionPresentation="trailing-check" groups={statusGroups} value={{status: statuses}} open={statusOpen}
      onCommit={commitStatuses} onOpenChange={open => {setStatusOpen(open); return true;}}
      labels={{trigger: '状态筛选', title: '筛选任务状态', all: '全部状态', reset: '重置', confirm: '确认筛选', cancel: '取消筛选', badge: '个已选状态', rejected: '未应用筛选，暂存选择仍保留。请先处理未保存内容后重试。'}}/>
    <p>提交入口（客户端声明）：{origin ? originLabel[origin] : '全部入口'}</p>
    <button aria-expanded={originOpen} onClick={() => {if (!originOpen) {setOriginDraft(origin); setOriginError('');} setOriginOpen(!originOpen);}}>提交入口筛选</button>
    {originOpen && <form aria-label="提交入口筛选（客户端声明）" onSubmit={event => {event.preventDefault(); commitOrigin();}}>
      <label>提交入口（客户端声明）<select aria-label="提交入口（客户端声明）" value={originDraft} onChange={event => {setOriginDraft(event.target.value as UploadOrigin | ''); setOriginError('');}}>
        <option value="">全部入口</option>
        <option value="file-selection">选择音频文件</option>
        <option value="recording-draft">录音面板（当前录音或已保存草稿）</option>
        <option value="unknown">来源未知</option>
      </select></label>
      <button type="submit">应用入口筛选</button>
      <button type="button" onClick={() => {setOriginDraft(''); setOriginError('');}}>重置暂存入口</button>
      <button type="button" onClick={() => {setOriginDraft(origin); setOriginOpen(false); setOriginError('');}}>取消入口筛选</button>
      <p>重置后需点击应用才会改变结果；来源未知包括旧记录和未声明入口的记录。</p>
      {originError && <p role="alert">{originError}</p>}
    </form>}
    <p>来源仅记录首次提交时客户端声明的入口，不证明音频实际录制来源；旧记录或未声明的记录为未知。重试沿用首次声明。</p>
    <p>创建日期（UTC）：{dates.createdFrom || '不限开始'} 至 {dates.createdThrough || '不限结束'}（包含结束当天）。仅筛选本地保存记录的创建日期，不是录音或最后编辑时间。</p>
    <button aria-expanded={dateOpen} onClick={() => {if (!dateOpen) {setDateDraft({...dates}); setDateError('');} setDateOpen(!dateOpen);}}>创建日期筛选</button>
    {dateOpen && <form aria-label="创建日期筛选（UTC）" onSubmit={event => {event.preventDefault(); commitDates();}}>
      <label>开始日期（UTC）<input aria-label="开始日期（UTC）" placeholder="YYYY-MM-DD" maxLength={10} value={dateDraft.createdFrom} onChange={event => {setDateDraft({...dateDraft, createdFrom: event.target.value}); setDateError('');}}/></label>
      <label>结束日期（UTC，含当天）<input aria-label="结束日期（UTC，含当天）" placeholder="YYYY-MM-DD" maxLength={10} value={dateDraft.createdThrough} onChange={event => {setDateDraft({...dateDraft, createdThrough: event.target.value}); setDateError('');}}/></label>
      <button type="submit">应用日期筛选</button>
      <button type="button" onClick={() => {setDateDraft({createdFrom: '', createdThrough: ''}); setDateError('');}}>重置暂存日期</button>
      <button type="button" onClick={() => {setDateDraft({...dates}); setDateOpen(false); setDateError('');}}>取消日期筛选</button>
      <p>空白表示不限；重置后需点击应用才会改变结果。旧的纯日期记录按 UTC 午夜处理；日期格式无法确认的历史记录在日期筛选时不显示。</p>
      {dateError && <p role="alert">{dateError}</p>}
    </form>}
    {Object.values(filters).some(Boolean) && <p>当前筛选：{filters.jobId ? '指定转写' : filters.sessionId ? '指定会话' : '指定工作区'} <button onClick={() => {if(!leaveList())return;setFilters({jobId: '', workspaceId: '', sessionId: ''}); setOffset(0); writeUnsavedHistory(transcriptUrl({transcriptStoreId: store.scope!, }), true);}}>显示全部关联范围</button></p>}
    <form onSubmit={event => {event.preventDefault(); if (new TextEncoder().encode(query).length > 512) {setError('搜索内容不能超过 512 UTF-8 字节'); return;} if((search === query && offset === 0) || !leaveList())return; setError(''); setSearch(query); setOffset(0);}}>
      <label>搜索转写<input aria-label="搜索转写" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <button type="submit">搜索</button>
      <button type="button" onClick={() => {if(!search && offset === 0){setQuery('');return;} if(!leaveList())return;setQuery(''); setSearch(''); setOffset(0);}}>清除搜索</button>
    </form>
    <p>搜索标题、原文件名、原文和已保存校对文本；按连续文字匹配，英文字母不区分大小写。切换搜索、分页或回收站前，请先保存校对修改。</p>
    <div aria-label="资料库范围"><button aria-pressed={scope === 'active'} onClick={() => {if((scope === 'active' && offset === 0) || !leaveList())return;setScope('active'); setOffset(0);}}>全部转写</button><button aria-pressed={scope === 'trash'} onClick={() => {if((scope === 'trash' && offset === 0) || !leaveList())return;setScope('trash'); setOffset(0);}}>回收站</button></div>
    {scope === 'trash' && <p>回收站中的转写可以恢复；原文和已保存校对仍保留。</p>}
    <p role="status">共 {total} 条记录{total > 0 ? ` · 第 ${Math.floor(offset / 10) + 1} 页` : ''}</p>
    <button disabled={loading || offset === 0} onClick={() => {if(leaveList())setOffset(value => Math.max(0, value - 10));}}>上一页</button>
    <button disabled={loading || !hasMore || atPageLimit} onClick={() => {if(loading || !hasMore || atPageLimit)return;if(leaveList())setOffset(value => value + LIBRARY_PAGE_SIZE);}}>下一页</button>
    {hasMore && atPageLimit && <p role="status">已达到当前翻页范围，仍有更多匹配记录。请缩小搜索或筛选范围后继续查看。</p>}
    {!loading && !jobs.length && !pollError && <p>{filters.jobId ? '此转写不存在、已移到回收站、当前不可访问或不符合当前筛选' : origin || dates.createdFrom || dates.createdThrough || statuses.length || search || filters.workspaceId || filters.sessionId ? '没有匹配的转写记录' : scope === 'trash' ? '回收站为空' : '还没有转写记录'}</p>}
    <div aria-label="转写记录">{jobs.map(job => {
      const ownedScope = rowScope(job.id);
      const metadataChanged = (discard = false) => {
        // A response from a discarded row must never authorize dropping a newer draft.
        if (rowScopes.current.get(store.key(job.id)) !== ownedScope) return;
        if (discard) confirmedTrash.current.add(ownedScope);
        setRefresh(value => value + 1);
      };
      const progress = job.progress;
      const total = Math.max(0, progress?.totalChunks ?? 0);
      const completed = Math.min(total, Math.max(0, progress?.completedChunks ?? 0));
      return <UnsavedWorkScope key={store.key(job.id)} value={ownedScope}><article style={{padding: '16px', marginTop: '12px', border: '1px solid #d9e2df', borderRadius: 12}}>
        {retainedIds.includes(job.id) && <p role="status">此记录已不在最新结果中或状态已变化；以下是为保留未保存修改而暂留的旧记录，不代表当前服务端状态。保存或取消修改后将刷新移除。</p>}
        <h3>{job.title || job.filename}</h3>
        <p>原文件名：{job.filename}</p>
        <p>首次提交来源：{job.uploadOriginAssurance === 'client-declared' && (job.uploadOrigin === 'file-selection' || job.uploadOrigin === 'recording-draft') ? `${originLabel[job.uploadOrigin]}（客户端声明，非来源证明）` : originLabel.unknown}</p>
        {!job.deleted_at && <a href={transcriptUrl({transcriptStoreId: store.scope!, jobId: job.id})}>打开此转写的固定链接</a>}
        {!job.deleted_at && job.status === 'completed' && <TranscriptRelationshipEditor id={job.id} relationship={job.relationship} onChanged={metadataChanged}/>}
        <LibraryActions job={job} retained={retainedIds.includes(job.id)} onChanged={metadataChanged}/>
        <p>{statusLabel[job.status]} · {new Date(job.created).toLocaleString()}</p>
        {(dates.createdFrom || dates.createdThrough) && <p>创建日期（UTC）：{storedCreatedInstant(job.created) === null ? '无法确认（暂留旧记录）' : job.created.slice(0, 10)}</p>}
        <p>请求语言：{languageLabel(job.requested_language)}</p>
        {progress && <p>已完成 {completed} / {total} 段{progress.durationSeconds > 0 ? ` · 音频时长 ${progress.durationSeconds.toFixed(2)} 秒` : ' · 正在读取音频时长'}</p>}
        {job.status === 'processing' && <>
          {total > 0 ? <progress aria-label={`${job.filename} 分段进度`} max={total} value={completed}/> : <p>正在准备音频…</p>}
          <button disabled={store.blocked || cancelling.includes(store.key(job.id))} onClick={() => void cancel(job.id)}>{cancelling.includes(store.key(job.id)) ? '正在取消…' : '取消转写'}</button>
        </>}
        {job.status === 'interrupted' && <><p>临时音频到期：{job.pending_expires_at ? new Date(job.pending_expires_at).toLocaleString() : '按上传时保存的期限'}；取消可立即删除</p><button disabled={busy} onClick={() => void resume(job.id)}>从已保存分段继续</button><button disabled={store.blocked} onClick={() => void cancel(job.id)}>取消并删除临时音频</button></>}
        {job.status === 'failed' && <FailedTranscriptionRetry id={job.id} language={job.requested_language} maxBytes={model?.maxBytes} operations={retryOperations.current} selectedRecording={selectedRecording} takeSelectedRecording={takeSelectedRecording} disabled={!!job.deleted_at || retainedIds.includes(job.id) || !!pollError || loading || busy} onChanged={metadataChanged}/> }
        {job.status === 'cancelled'  && <p>任务已停止；未完成的转写不作为完整结果展示</p>}
        {job.error && <p role="alert">{job.error}</p>}
        {!job.deleted_at && job.status === 'completed' && job.result && <>
          <p>音频时长 {job.result.duration_seconds.toFixed(2)} 秒 · 推理用时 {job.result.inference_seconds.toFixed(2)} 秒 · 识别语言：{languageLabel(job.result.language)}{job.result.language_source === 'first-chunk-detection' ? '（首段自动检测）' : job.result.language_source === 'user-selected' ? '（用户指定）' : ''}</p>
          {!!job.result.boundaries?.some(boundary => boundary.method === 'uncertain-midpoint') && <p>有 {job.result.boundaries.filter(boundary => boundary.method === 'uncertain-midpoint').length} 处分段边界未能可靠对齐，已使用中点合并；请重点核对这些位置：{job.result.boundaries.filter(boundary => boundary.method === 'uncertain-midpoint').map(boundary => `${boundary.offset.toFixed(2)} 秒`).join('、')}</p>}
          {!!job.result.boundaries_truncated && <p>边界列表仅展示前 32 处，以上计数可能不完整；长音频仍需逐段人工核对。</p>}
          <TranscriptEditor id={job.id} raw={job.result.text} rawPreview={job.result.text_preview_truncated} explicitOpenDisabled={loading || !!pollError || retainedIds.includes(job.id)}/>
        </>}
      </article></UnsavedWorkScope>;
    })}</div>
  </section>;
}

function LibraryActions({job, retained, onChanged}: {job: Job; retained: boolean; onChanged: (discard?: boolean) => void}) {
  const store = useTranscriptionStore();
  const scopedFetch = store.fetch;
  const [edit, setEdit] = useState<{title: string; revision: number; initialTitle: string} | null>(null);
  const [confirmTrash, setConfirmTrash] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const lock = useRef(false);
  // Retained draft rows can carry an old terminal status after polling observes interruption.
  const trashBlocked = retained || job.status === 'processing' || job.status === 'interrupted';
  // Capture each opening, not changing polling props; compare raw input, including whitespace.
  const dirty = edit !== null && edit.title !== edit.initialTitle;
  useUnsavedWork(dirty);
  const openTitle = () => ({title: job.title || job.filename, initialTitle: job.title || job.filename, revision: job.library_revision ?? 0});
  async function reloadTitle() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      // Retained rows may have frozen props; read the exact record instead of
      // presenting an old polling snapshot as the latest title/revision.
      const response = await scopedFetch(`/api/local-asr/jobs?${new URLSearchParams({jobId: job.id, scope: job.deleted_at ? 'trash' : 'active', limit: '1'})}`);
      if (!response.ok) throw Error('无法读取最新记录，请重试');
      const data = await response.json();store.assertActive();
      const current: Job | undefined = data.jobs?.find((item: Job) => item.id === job.id);
      if (!current || !!current.deleted_at !== !!job.deleted_at) throw Error('此记录已不在原范围内；请先保存或取消其他修改，再切换资料库范围');
      if (dirty && !allowLeavingUnsavedWork()) return;
      if (edit) setEdit({title: current.title || current.filename, initialTitle: current.title || current.filename, revision: current.library_revision ?? 0});
      setConflict(false); setConfirmTrash(null); onChanged();
    } catch (e) {setError(e instanceof Error ? e.message : '读取失败');}
    finally {lock.current = false; setBusy(false);}
  }
  async function change(action: 'rename' | 'trash' | 'restore') {
    if (lock.current || (action === 'trash' && (trashBlocked || conflict || confirmTrash === null))) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const response = await scopedFetch(`/api/local-asr/jobs/${encodeURIComponent(job.id)}/${action}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({expectedRevision: action === 'rename' ? edit?.revision : action === 'trash' ? confirmTrash : job.library_revision ?? 0, ...(action === 'rename' ? {title: edit?.title} : {})})});
      const data = await response.json();store.assertActive();
      if (!response.ok) {
        if (response.status === 409) {setConflict(true); onChanged();}
        throw Error(data.error?.message || '资料库操作失败');
      }
      setEdit(null); setConfirmTrash(null); setConflict(false); onChanged(action === 'trash');
    } catch (e) {setError(e instanceof Error ? e.message : '资料库操作失败');}
    finally {lock.current = false; setBusy(false);}
  }
  return <div aria-label={`${job.title || job.filename} 资料库操作`}>
    {edit ? <form onSubmit={event => {event.preventDefault(); void change('rename');}}>
      <label>转写标题<input aria-label="转写标题" value={edit.title} disabled={busy} onChange={event => setEdit({...edit, title: event.target.value})}/></label>
      <button disabled={store.blocked || busy || conflict || !edit.title.trim()} type="submit">保存标题</button>
      <button disabled={busy} type="button" onClick={() => {if (dirty && !allowLeavingUnsavedWork()) return; setEdit(null); setConflict(false); setError('');}}>取消重命名</button>
    </form> : <button disabled={busy || !!job.deleted_at} onClick={() => {setEdit(openTitle()); setConflict(false); setError('');}}>重命名</button>}
    {job.deleted_at ? <button disabled={store.blocked || busy || conflict} onClick={() => void change('restore')}>恢复转写</button> : <button disabled={store.blocked || busy || trashBlocked || conflict} onClick={() => setConfirmTrash(job.library_revision ?? 0)}>移到回收站</button>}
    {job.status === 'processing' && <p>识别中的任务需先取消转写，停止后才能移到回收站。</p>}
    {job.status === 'interrupted' && <p>中断任务不能移到回收站。请先手动继续并等待完成，或明确取消转写；取消会删除临时音频。</p>}
    {retained && <p>暂留记录的状态可能已变化，暂不能移到回收站。请先保存或取消未保存修改，等待最新记录刷新后再操作。</p>}
    {confirmTrash !== null && <div role="alertdialog" aria-label="确认移到回收站"><p>将“{job.title || job.filename}”移到回收站？可以恢复，原文和已保存校对会保留；未保存修改会丢失。</p><button disabled={store.blocked || busy || trashBlocked || conflict} onClick={() => void change('trash')}>确认移到回收站</button><button disabled={busy} onClick={() => setConfirmTrash(null)}>保留转写</button></div>}
    {conflict && <p>记录已更改或状态发生变化，请核对最新标题和状态后重试。<button disabled={store.blocked || busy} onClick={() => void reloadTitle()}>使用最新记录</button></p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
