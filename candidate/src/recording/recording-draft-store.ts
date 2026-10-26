import { isOwnedPcmWav } from './validate-wav';
import { resolveCaptureLimits } from './controller.mjs';
import { createMonoPcm16WavBuilder } from './pcm-wav';
/** Standalone foundation. No recorder, UI, upload, or fallback integration. */
export const POLICY = Object.freeze({ slots: 2, maxBytes: 16 * 1024 * 1024, maxSeconds: 300, ttlMs: 24 * 60 * 60 * 1000 });
export const DATABASE = 'yanyu-opt-in-recording-drafts-v1';
const STORE = 'completed-drafts';
const SEGMENTS = 'recording-segments';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type Draft = Readonly<{ schema: 1; id: string; revision: string; createdAt: number; expiresAt: number; durationSeconds: number; size: number; mimeType: string; sha256: string; blob: Blob }>;
export type PreparedDraft = Readonly<{ id: string; revision: string }>;
type StoredDraft = Omit<Draft,'blob'> & { readonly bytes: ArrayBuffer };
const prepared = new WeakMap<PreparedDraft, StoredDraft>();
export class DraftError extends Error {
  constructor(public readonly code: 'invalid' | 'unavailable' | 'blocked' | 'closed' | 'capacity' | 'conflict' | 'expired' | 'aborted', message: string) { super(message); }
}
const validTime = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
function validateBlob(blob: unknown): blob is Blob {
  return blob instanceof Blob && blob.size > 0 && blob.size <= POLICY.maxBytes && blob.type.length <= 255 && /^[\x20-\x7e]*$/.test(blob.type);
}
// Intrinsic brand validation accepts genuine cross-realm ArrayBuffers returned by IDB,
// but rejects SharedArrayBuffer, proxies and prototype/Symbol.toStringTag lookalikes.
const arrayBufferByteLengthGetter=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength')!.get!;
function arrayBufferByteLength(value:unknown):number|null {
  try { return arrayBufferByteLengthGetter.call(value) as number; } catch { return null; }
}
function validRecord(value: unknown, now: number): value is StoredDraft {
  if (!value || typeof value !== 'object') return false;
  const r = value as StoredDraft, byteLength=arrayBufferByteLength((value as StoredDraft).bytes);
  const keys = ['schema','id','revision','createdAt','expiresAt','durationSeconds','size','mimeType','sha256','bytes'];
  return Object.keys(r).length === keys.length && keys.every(k => Object.hasOwn(r,k)) && r.schema === 1 && typeof r.id === 'string' && typeof r.revision === 'string' && UUID.test(r.id) && UUID.test(r.revision)
    && validTime(r.createdAt) && validTime(r.expiresAt) && r.createdAt <= now && r.expiresAt === r.createdAt + POLICY.ttlMs
    && Number.isFinite(r.durationSeconds) && r.durationSeconds > 0 && r.durationSeconds <= POLICY.maxSeconds
    && byteLength !== null && byteLength > 0 && byteLength <= POLICY.maxBytes && r.size === byteLength
    && typeof r.mimeType === 'string' && r.mimeType.length <= 255 && r.mimeType === r.mimeType.toLowerCase() && /^[\x20-\x7e]*$/.test(r.mimeType) && typeof r.sha256 === 'string' && /^[a-f0-9]{64}$/.test(r.sha256);
}
async function digest(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2,'0')).join('');
}
/** Explicit opt-in, only after caller has completed its Blob. Duration is caller metadata, not verified audio. */
export async function prepareCompletedDraft(input: { preserve: true; blob: Blob; durationSeconds: number }, now = Date.now()): Promise<PreparedDraft> {
  if (input.preserve !== true || !validateBlob(input.blob) || !Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0 || input.durationSeconds > POLICY.maxSeconds || !validTime(now) || !validTime(now + POLICY.ttlMs)) throw new DraftError('invalid','Invalid completed draft');
  // Snapshot caller metadata before awaiting; Blob bytes are immutable. No IDB transaction is active here.
  const blob = input.blob, durationSeconds = input.durationSeconds;
  const id = crypto.randomUUID(), revision = crypto.randomUUID();
  const bytes = (await Blob.prototype.arrayBuffer.call(blob)).slice(0);
  const sha256 = await digest(bytes);
  const token = Object.freeze({id, revision});
  prepared.set(token, Object.freeze({schema:1,id,revision,createdAt:now,expiresAt:now+POLICY.ttlMs,durationSeconds,size:blob.size,mimeType:blob.type,sha256,bytes}));
  return token;
}
function same(a: StoredDraft,b: StoredDraft): boolean { return a.id===b.id && a.revision===b.revision && a.createdAt===b.createdAt && a.expiresAt===b.expiresAt && a.durationSeconds===b.durationSeconds && a.size===b.size && a.mimeType===b.mimeType && a.sha256===b.sha256 && equalBytes(a.bytes,b.bytes); }
function equalBytes(a:ArrayBuffer,b:ArrayBuffer):boolean {
  const left=new Uint8Array(a),right=new Uint8Array(b);
  if(left.byteLength!==right.byteLength) return false;
  for(let i=0;i<left.length;i++) if(left[i]!==right[i]) return false;
  return true;
}
export type CaptureLimitsInput = { maxDurationSeconds?: number; maxWavBytes?: number };
export type FrozenLimits = Readonly<{ maxFrames: number; maxWavBytes: number; maxDurationSeconds: number }>;
export type CheckpointStatus = 'capturing' | 'sealed' | 'interrupted';
export type StopReason = 'user-stop' | 'limit' | 'duration-limit' | 'hidden' | 'pagehide'
  | 'track-ended' | 'context-interrupted' | 'capture-failed' | 'invalid-pcm'
  | 'capture-stalled' | 'persistence-failed' | 'disposed';
export type CheckpointIdentity = Readonly<{ schema: 2; id: string; writerEpoch: string }>;
export type CheckpointDeleteTarget = CheckpointIdentity & Readonly<{ revision: number }>;
export type LegacyDeleteTarget = Readonly<{ schema: 1; id: string; revision: string }>;
export type DraftDeleteTarget = LegacyDeleteTarget | CheckpointDeleteTarget;
// Opaque runtime tokens are issued/recognized through module WeakMaps. Object cloning,
// JSON or a structurally identical object does NOT confer writer/preparation authority.
declare const preparedReservationBrand: unique symbol;
declare const writerBrand: unique symbol;
declare const segmentBrand: unique symbol;
declare const terminalBrand: unique symbol;
export type PreparedReservation = Readonly<{ id: string; writerEpoch: string;
  [preparedReservationBrand]: true }>;
export type RecordingWriter = CheckpointIdentity & Readonly<{ [writerBrand]: true }>;
export type PreparedPcmSegment = Readonly<{ id: string; writerEpoch: string; segmentIndex: number;
  [segmentBrand]: true }>;
export type PreparedTerminal = Readonly<{ id: string; writerEpoch: string; operationId: string;
  [terminalBrand]: true }>;
export type CheckpointReceipt = CheckpointDeleteTarget & Readonly<{
  result: 'committed' | 'already-committed';
  status: CheckpointStatus; committedFrames: number; committedSegmentCount: number;
  committedPcmBytes: number; createdAt: number; expiresAt: number;
  lastCommittedAt: number; limits: FrozenLimits;
}>;
export type ReservedRecording = Readonly<{ writer: RecordingWriter; receipt: CheckpointReceipt }>;
export type FinalAccounting = Readonly<{
  receivedFrames: number; receivedChunkCount: number;
  finalChunkCount: number; finalTotalFrames: number;
  processorReason: 'user-stop' | 'limit'; stopReason: StopReason;
}>;
export type TerminalIntent =
  | Readonly<{ kind: 'sealed'; accounting: FinalAccounting }>
  | Readonly<{ kind: 'interrupted'; reason: StopReason; observedReceivedFrames: number }>;
export type TerminalRecord = Readonly<{ operationId: string; intent: TerminalIntent }>;
export type RecoveryView = CheckpointDeleteTarget & Readonly<{
  createdAt: number; expiresAt: number; status: CheckpointStatus;
  committedFrames: number; committedSegmentCount: number; limits: FrozenLimits;
  completion: 'sealed' | 'partial-unconfirmed' | 'partial-interrupted';
  terminal: TerminalRecord | null;
  durationSeconds: number; size: number; mimeType: 'audio/wav'; sha256: string; blob: Blob;
}>;
export type EmptyCheckpointReservation = CheckpointDeleteTarget & Readonly<{
  createdAt:number; expiresAt:number; status:CheckpointStatus;
}>;
export type CheckpointShelfResult = Readonly<{
  emptyReservations: readonly EmptyCheckpointReservation[];
  checkpoints: readonly RecoveryView[]; unrestorableCount: number;
  emptyReservationCount: number; integrityBlocked: boolean;
}>;
export type CheckpointErrorCode = 'invalid' | 'unavailable' | 'blocked' | 'closed' | 'capacity'
  | 'conflict' | 'expired' | 'aborted' | 'quota' | 'uncertain' | 'not-found'
  | 'clock-rollback' | 'integrity' | 'retired';
export type MutationOutcome = 'not-started' | 'aborted' | 'unknown';
// Errors expose only bounded sanitized fields, never DOM exception/device details/PCM.
export interface CheckpointOperationError extends Error {
  readonly code: CheckpointErrorCode; readonly outcome: MutationOutcome;
}

export type RecordingClockGuard = { observe(now: number): number };
export class CheckpointError extends Error implements CheckpointOperationError {
  constructor(readonly code: CheckpointErrorCode, readonly outcome: MutationOutcome = 'not-started') {
    super(code); this.name = 'CheckpointOperationError';
  }
}
export function createRecordingClockGuard(): RecordingClockGuard {
  let high = -1;
  return Object.freeze({observe(now: number) {
    if (!validTime(now)) throw new CheckpointError('invalid');
    if (now < high) throw new CheckpointError('clock-rollback');
    high = now; return now;
  }});
}
export const recordingClockGuard = createRecordingClockGuard();
type Manifest = CheckpointDeleteTarget & {
  createdAt: number; expiresAt: number; lastCommittedAt: number;
  sampleRate: 16000; channels: 1; bitsPerSample: 16; byteOrder: 'little-endian';
  maxFrames: number; maxWavBytes: number; durationLimitSeconds: number;
  committedFrames: number; committedSegmentCount: number; committedPcmBytes: number;
  status: CheckpointStatus; terminal: TerminalRecord | null;
};
type Segment = {
  schema: 2; draftId: string; writerEpoch: string; segmentIndex: number;
  startFrame: number; frameCount: number; byteLength: number; sha256: string; bytes: ArrayBuffer;
};
type ReservationState = {manifest: Manifest; state: 'fresh' | 'pending' | 'known-aborted' | 'uncertain' | 'committed' | 'retired';
  promise?: Promise<ReservedRecording>; writer?: RecordingWriter};
const reservations = new WeakMap<PreparedReservation, ReservationState>();
const writers = new WeakMap<RecordingWriter, CheckpointIdentity>();
const segments = new WeakMap<PreparedPcmSegment, Segment>();
const terminals = new WeakMap<PreparedTerminal, {identity: CheckpointIdentity; record: TerminalRecord}>();
const reasons: readonly StopReason[] = ['user-stop','limit','duration-limit','hidden','pagehide','track-ended','context-interrupted','capture-failed','invalid-pcm','capture-stalled','persistence-failed','disposed'];
const exactKeys = (v: object, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
const identityValid = (v: CheckpointIdentity) => v && v.schema === 2 && typeof v.id === 'string' && UUID.test(v.id) && typeof v.writerEpoch === 'string' && UUID.test(v.writerEpoch);
function limitsOf(m: Manifest): FrozenLimits { return Object.freeze({maxFrames:m.maxFrames,maxWavBytes:m.maxWavBytes,maxDurationSeconds:m.durationLimitSeconds}); }
function freezeLimits(input: CaptureLimitsInput): FrozenLimits {
  try {
    const limits=resolveCaptureLimits(input);
    return Object.freeze({maxFrames:limits.maxFrames,maxWavBytes:limits.maxWavBytes,maxDurationSeconds:limits.maxDurationSeconds});
  } catch { throw new CheckpointError('invalid'); }
}
function validIntent(intent: TerminalIntent): boolean {
  if (!intent || typeof intent !== 'object') return false;
  if (intent.kind === 'interrupted') return exactKeys(intent,['kind','reason','observedReceivedFrames']) && reasons.includes(intent.reason) && validTime(intent.observedReceivedFrames) && intent.observedReceivedFrames <= POLICY.maxSeconds*16000;
  if (intent.kind !== 'sealed' || !exactKeys(intent,['kind','accounting'])) return false;
  const a=intent.accounting;
  return !!a && exactKeys(a,['receivedFrames','receivedChunkCount','finalChunkCount','finalTotalFrames','processorReason','stopReason']) &&
    validTime(a.receivedFrames) && a.receivedFrames>0 && a.receivedFrames<=POLICY.maxSeconds*16000 &&
    validTime(a.receivedChunkCount) && a.receivedChunkCount>0 && a.receivedChunkCount<=a.receivedFrames &&
    a.finalChunkCount===a.receivedChunkCount && a.finalTotalFrames===a.receivedFrames &&
    (a.processorReason==='user-stop'||a.processorReason==='limit') && reasons.includes(a.stopReason);
}
function validManifest(value: unknown, now: number): value is Manifest {
  if (!value || typeof value!=='object') return false;
  const m=value as Manifest;
  if (!exactKeys(m,['schema','id','writerEpoch','revision','createdAt','expiresAt','lastCommittedAt','sampleRate','channels','bitsPerSample','byteOrder','maxFrames','maxWavBytes','durationLimitSeconds','committedFrames','committedSegmentCount','committedPcmBytes','status','terminal']) || !identityValid(m) || !validTime(m.revision) || !validTime(m.createdAt) || !validTime(m.expiresAt) || m.expiresAt!==m.createdAt+POLICY.ttlMs || !validTime(m.lastCommittedAt) || m.lastCommittedAt<m.createdAt || now<m.lastCommittedAt || m.sampleRate!==16000 || m.channels!==1 || m.bitsPerSample!==16 || m.byteOrder!=='little-endian') return false;
  let limits: FrozenLimits;
  try { limits=freezeLimits({maxDurationSeconds:POLICY.maxSeconds,maxWavBytes:m.maxWavBytes}); } catch { return false; }
  if(!validTime(m.maxFrames)||m.maxFrames<1||m.maxFrames>limits.maxFrames||m.durationLimitSeconds!==m.maxFrames/16000||m.maxWavBytes!==limits.maxWavBytes || !validTime(m.committedFrames) || m.committedFrames>m.maxFrames || !validTime(m.committedSegmentCount) || m.committedSegmentCount>300 || m.committedSegmentCount!==Math.ceil(m.committedFrames/16000) || m.committedPcmBytes!==m.committedFrames*2) return false;
  if(m.status==='capturing') return m.terminal===null && m.revision===m.committedSegmentCount;
  if((m.status!=='sealed'&&m.status!=='interrupted') || !m.terminal || !exactKeys(m.terminal,['operationId','intent']) || typeof m.terminal.operationId!=='string' || !UUID.test(m.terminal.operationId) || !validIntent(m.terminal.intent) || m.terminal.intent.kind!==m.status || m.revision!==m.committedSegmentCount+1) return false;
  return m.terminal.intent.kind==='sealed' ? m.terminal.intent.accounting.receivedFrames===m.committedFrames && (m.terminal.intent.accounting.processorReason!=='limit'||m.committedFrames===m.maxFrames) : m.terminal.intent.observedReceivedFrames>=m.committedFrames && m.terminal.intent.observedReceivedFrames<=m.maxFrames;
}
function segmentValid(v: unknown, m: Manifest, index: number): v is Segment {
  if(!v || typeof v!=='object') return false;
  const s=v as Segment, frames=Math.min(16000,m.committedFrames-index*16000), byteLength=arrayBufferByteLength((v as Segment).bytes);
  return exactKeys(s,['schema','draftId','writerEpoch','segmentIndex','startFrame','frameCount','byteLength','sha256','bytes']) && s.schema===2 && s.draftId===m.id && s.writerEpoch===m.writerEpoch && s.segmentIndex===index && s.startFrame===index*16000 && frames>0 && s.frameCount===frames && s.byteLength===frames*2 && byteLength!==null && byteLength>0 && byteLength===s.byteLength && typeof s.sha256==='string' && /^[a-f0-9]{64}$/.test(s.sha256);
}
const segmentKey = (s: Segment): IDBValidKey => [s.draftId,s.writerEpoch,s.segmentIndex];
const sameSegment = (a: Segment,b: Segment) => a.schema===b.schema && a.draftId===b.draftId && a.writerEpoch===b.writerEpoch && a.segmentIndex===b.segmentIndex && a.startFrame===b.startFrame && a.frameCount===b.frameCount && a.byteLength===b.byteLength && a.sha256===b.sha256 && equalBytes(a.bytes,b.bytes);
function sameManifest(a: Manifest,b: Manifest): boolean { return JSON.stringify(a)===JSON.stringify(b); }
function receipt(m: Manifest, result: CheckpointReceipt['result']='committed'): CheckpointReceipt {
  return Object.freeze({schema:2,id:m.id,writerEpoch:m.writerEpoch,revision:m.revision,result,status:m.status,committedFrames:m.committedFrames,committedSegmentCount:m.committedSegmentCount,committedPcmBytes:m.committedPcmBytes,createdAt:m.createdAt,expiresAt:m.expiresAt,lastCommittedAt:m.lastCommittedAt,limits:limitsOf(m)});
}
function checkpointUuid():string {
  try { return crypto.randomUUID(); } catch { throw new CheckpointError('unavailable'); }
}
export function prepareRecordingReservation(input: Readonly<{preserveDuringCapture:true;limits:CaptureLimitsInput}>, now=Date.now()): PreparedReservation {
  if(!input || input.preserveDuringCapture!==true || !validTime(now) || !validTime(now+POLICY.ttlMs)) throw new CheckpointError('invalid');
  const limits=freezeLimits(input.limits), id=checkpointUuid(), writerEpoch=checkpointUuid();
  const token=Object.freeze({id,writerEpoch}) as PreparedReservation;
  const manifest:Manifest={schema:2,id,writerEpoch,revision:0,createdAt:now,expiresAt:now+POLICY.ttlMs,lastCommittedAt:now,sampleRate:16000,channels:1,bitsPerSample:16,byteOrder:'little-endian',maxFrames:limits.maxFrames,maxWavBytes:limits.maxWavBytes,durationLimitSeconds:limits.maxDurationSeconds,committedFrames:0,committedSegmentCount:0,committedPcmBytes:0,status:'capturing',terminal:null};
  reservations.set(token,{manifest,state:'fresh'}); return token;
}
export async function preparePcmSegment(writer:RecordingWriter,input:Readonly<{segmentIndex:number;startFrame:number;pcm:Int16Array}>):Promise<PreparedPcmSegment> {
  const identity=writers.get(writer);
  if(!identity || !input || !validTime(input.segmentIndex) || input.segmentIndex>=300 || input.startFrame!==input.segmentIndex*16000) throw new CheckpointError('invalid');
  const index=input.segmentIndex,start=input.startFrame;
  let bytes:ArrayBuffer;
  // The existing builder validates intrinsic typed-array slots and rejects SharedArrayBuffer.
  try {
    const b=createMonoPcm16WavBuilder({maxDurationSeconds:1}); b.appendPcm16(input.pcm);
    const n=b.snapshot().frameCount; bytes=b.finalize(n).bytes.slice(44).buffer as ArrayBuffer;
  } catch { throw new CheckpointError('invalid'); }
  let sha256:string;
  try { sha256=await digest(bytes); } catch { throw new CheckpointError('unavailable'); }
  const token=Object.freeze({id:identity.id,writerEpoch:identity.writerEpoch,segmentIndex:index}) as PreparedPcmSegment;
  segments.set(token,{schema:2,draftId:identity.id,writerEpoch:identity.writerEpoch,segmentIndex:index,startFrame:start,frameCount:bytes.byteLength/2,byteLength:bytes.byteLength,sha256,bytes}); return token;
}
export function prepareTerminal(writer:RecordingWriter,intent:TerminalIntent):PreparedTerminal {
  const identity=writers.get(writer);
  if(!identity || !validIntent(intent)) throw new CheckpointError('invalid');
  const copy:TerminalIntent=intent.kind==='sealed'?Object.freeze({kind:'sealed',accounting:Object.freeze({...intent.accounting})}):Object.freeze({...intent});
  const operationId=checkpointUuid(),token=Object.freeze({id:identity.id,writerEpoch:identity.writerEpoch,operationId}) as PreparedTerminal;
  terminals.set(token,{identity,record:Object.freeze({operationId,intent:copy})});return token;
}
export const CHECKPOINT_OPERATION_TIMEOUT_MS = 10_000;
function bounded<T>(operation:Promise<T>, onTimeout?:()=>void):Promise<T> {
  return new Promise<T>((resolve,reject)=>{
    const timer=setTimeout(()=>{onTimeout?.();reject(new CheckpointError('uncertain','unknown'));},CHECKPOINT_OPERATION_TIMEOUT_MS);
    operation.then(value=>{clearTimeout(timer);resolve(value);},error=>{
      clearTimeout(timer);
      reject(error instanceof CheckpointError||error instanceof DraftError?error:new CheckpointError('unavailable','unknown'));
    });
  });
}
type OperationDeadline = {timedOut:boolean};
// Stop scheduling work after abandonment; an already-started digest/transaction is not canceled.
function assertCheckpointActive(deadline:OperationDeadline):void {
  if(deadline.timedOut)throw new CheckpointError('uncertain','unknown');
}
type CheckpointSnapshot = { rows: unknown[]; manifests: Manifest[]; payloads: Map<string,Segment[]>; checked: Set<string>; legacyChecked: StoredDraft[]; integrityBlocked:boolean };
export class RecordingDraftStore {
  private closed = false;
  private constructor(private db: IDBDatabase, private now: () => number, private clockGuard: RecordingClockGuard) {
    db.onversionchange = () => this.close();
    db.onclose = () => { this.closed = true; };
  }
  /** Opens only this dedicated opt-in database. Never migrates or touches existing application stores. */
  static open(factory: IDBFactory, now: () => number = Date.now, options: {clockGuard?:RecordingClockGuard} = {}): Promise<RecordingDraftStore> {
    try { (options.clockGuard ?? recordingClockGuard).observe(now()); } catch(e) { return Promise.reject(e); }
    return new Promise((resolve,reject) => {
      let settled = false, upgradeInvalid=false;
      const timer=setTimeout(()=>fail(new CheckpointError('uncertain','unknown')),CHECKPOINT_OPERATION_TIMEOUT_MS);
      const fail = (e: unknown) => { clearTimeout(timer); settled=true; reject(e); };
      let req: IDBOpenDBRequest;
      try { req = factory.open(DATABASE,2); } catch { fail(new DraftError('unavailable','Storage unavailable')); return; }
      req.onblocked = () => fail(new DraftError('blocked','Storage open blocked'));
      req.onerror = () => fail(new CheckpointError(upgradeInvalid?'invalid':'unavailable'));
      req.onupgradeneeded = event => {
        if (settled || (event.oldVersion !== 0 && event.oldVersion !== 1)) { req.transaction?.abort(); return; }
        const db=req.result;
        if(event.oldVersion===1) {
          if(db.objectStoreNames.length!==1 || !db.objectStoreNames.contains(STORE)) {upgradeInvalid=true;req.transaction?.abort();return;}
          const old=req.transaction!.objectStore(STORE);
          if(old.keyPath!=='id'||old.autoIncrement||old.indexNames.length) {upgradeInvalid=true;req.transaction?.abort();return;}
        } else db.createObjectStore(STORE,{keyPath:'id'});
        db.createObjectStore(SEGMENTS,{keyPath:['draftId','writerEpoch','segmentIndex']});
      };
      req.onsuccess = () => {
        if (settled) { req.result.close(); return; }
        const db=req.result;
        if (db.objectStoreNames.length!==2 || !db.objectStoreNames.contains(STORE) || !db.objectStoreNames.contains(SEGMENTS)) { db.close(); fail(new DraftError('invalid','Unknown database schema')); return; }
        const store=db.transaction(STORE).objectStore(STORE);
        if (store.keyPath!=='id' || store.autoIncrement || store.indexNames.length) { db.close(); fail(new DraftError('invalid','Unknown store schema')); return; }
        const segmentStore=db.transaction(SEGMENTS).objectStore(SEGMENTS);
        if(JSON.stringify(segmentStore.keyPath)!==JSON.stringify(['draftId','writerEpoch','segmentIndex'])||segmentStore.autoIncrement||segmentStore.indexNames.length) {db.close();fail(new CheckpointError('integrity'));return;}
        clearTimeout(timer); settled=true; resolve(new RecordingDraftStore(db,now,options.clockGuard ?? recordingClockGuard));
      };
    });
  }
  close(): void { this.closed=true; this.db.close(); }
  private async access<T>(action: (store: IDBObjectStore, records: unknown[], now: number, checked: StoredDraft[]) => T): Promise<T> {
    const at=this.available();
    // Legacy operations do not require unrelated checkpoint payload integrity.
    const rows=await new Promise<unknown[]>((resolve,reject)=>{
      let tx:IDBTransaction;
      try{tx=this.db.transaction(STORE,'readonly');}catch{reject(new DraftError('closed','Storage closed'));return;}
      let result:unknown[]=[],reason:unknown;
      tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(reason??new DraftError('aborted','Snapshot aborted'));
      const store=tx.objectStore(STORE),count=store.count();
      count.onsuccess=()=>{if(count.result>POLICY.slots){reason=new CheckpointError('integrity');tx.abort();return;}
        const read=store.getAll();read.onsuccess=()=>{result=read.result;};};
    });
    const checked:StoredDraft[]=[];
    for(const row of rows)if(validRecord(row,at)){
      if(await digest(row.bytes)===row.sha256)checked.push(row);
      this.time();
    }
    this.available();
    return new Promise<T>((resolve,reject)=>{
      let tx:IDBTransaction;
      try{tx=this.db.transaction(STORE,'readwrite');}catch{reject(new DraftError('closed','Storage closed'));return;}
      let value:T,reason:unknown;
      tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(reason??new DraftError('aborted','Transaction aborted'));
      const store=tx.objectStore(STORE),count=store.count();
      count.onsuccess=()=>{
        if(count.result>POLICY.slots){reason=new CheckpointError('integrity');tx.abort();return;}
        const read=store.getAll();read.onsuccess=()=>{try{
          const now=this.time(),retained:unknown[]=[];
          for(const row of read.result){
            if(validRecord(row,now)&&row.expiresAt<=now&&checked.some(old=>same(old,row)))store.delete(row.id);
            else retained.push(row);
          }
          value=action(store,retained,now,checked);
        }catch(e){reason=e;tx.abort();}};
      };
    });
  }
  /** Keep and retry the same token after failure or uncertain commit. Never create a replacement identity for a retry. */
  async preserve(token: PreparedDraft): Promise<Pick<Draft,'id'|'revision'|'expiresAt'>> {
    const draft=prepared.get(token);
    if(!draft) throw new DraftError('invalid','Unknown prepared identity');
    const persisted=await this.access((store,rows,now)=>{
      if(!validRecord(draft,now)) throw new DraftError('invalid','Invalid draft metadata');
      if(draft.expiresAt<=now) throw new DraftError('expired','Draft expired');
      const existing=rows.find(r => (r as Draft)?.id===draft.id);
      if(existing) {
        if(!validRecord(existing,now) || !same(existing,draft)) throw new DraftError('conflict','Identity conflict');
      } else {
        if(rows.length>=POLICY.slots) throw new DraftError('capacity','Two draft slots already occupied');
        store.add(draft);
      }
      return existing ? existing as StoredDraft : draft;
    });
    this.time();
    if(await digest(persisted.bytes)!==draft.sha256) throw new DraftError('conflict','Stored bytes do not match prepared identity');
    if(this.time()>=draft.expiresAt) throw new DraftError('expired','Draft expired');
    return {id:draft.id,revision:draft.revision,expiresAt:draft.expiresAt};
  }
  /** Non-consuming. Does not refresh TTL, write a replacement, or imply playable/valid audio. */
  async restore(): Promise<{drafts: Draft[]; unrestorableCount: number}> {
    const snapshot=await this.access((_store,rows,now)=>({rows,now}));
    const drafts:Draft[]=[];
    let unrestorableCount=0;
    for(const row of snapshot.rows) {
      if(validManifest(row,snapshot.now)) continue;
      try {
        if(validRecord(row,snapshot.now) && await digest(row.bytes)===row.sha256 && validRecord(row,this.time()) && row.expiresAt>this.time()) {
          const {bytes,...metadata}=row;
          const blob=new Blob([bytes],{type:row.mimeType});
          if(!validateBlob(blob)||blob.size!==row.size||blob.type!==row.mimeType) {unrestorableCount++;continue;}
          drafts.push(Object.freeze({...metadata,blob}));
        }
        else unrestorableCount++;
      } catch(e) { if(e instanceof CheckpointError && (e.code==='clock-rollback'||e.code==='invalid'))throw e; unrestorableCount++; }
    }
    this.time(); return {drafts,unrestorableCount};
  }
  /** Only a validated exact revision can be deleted. There is deliberately no clear/replace-oldest API. */
  remove(id:string, revision:string):Promise<boolean> {
    if(typeof id!=='string'||typeof revision!=='string'||!UUID.test(id)||!UUID.test(revision)) return Promise.reject(new DraftError('invalid','Invalid identity'));
    return this.access((store,rows,now,checked)=>{
      const row=rows.find(r=>(r as Draft)?.id===id);
      if(!row) return false;
      if(!validRecord(row,now)||row.revision!==revision||!checked.some(c=>same(c,row))) throw new DraftError('conflict','Revision conflict');
      store.delete(id); return true;
    });
  }
  private time(): number { return this.clockGuard.observe(this.now()); }
  private available(): number {
    if(this.closed) throw new CheckpointError('closed');
    return this.time();
  }
  /** Metadata counts and keys are checked before any segment payload request. */
  private collect(tx: IDBTransaction, at: number, done:(snapshot:CheckpointSnapshot)=>void, fail:(e:unknown)=>void): void {
    const manifests=tx.objectStore(STORE), chunks=tx.objectStore(SEGMENTS);
    let manifestCount:number|undefined,segmentCount:number|undefined;
    const mc=manifests.count(),sc=chunks.count();
    const proceed=()=>{
      if(manifestCount===undefined||segmentCount===undefined)return;
      if(manifestCount>POLICY.slots||segmentCount>600){fail(new CheckpointError('integrity'));return;}
      const request=manifests.getAll();
      request.onsuccess=()=>{
        const rows:unknown[]=request.result, recognized=rows.filter((r):r is Manifest=>validManifest(r,at));
        const result:CheckpointSnapshot={rows,manifests:recognized,payloads:new Map(),checked:new Set(),legacyChecked:[],integrityBlocked:false};
        // Malformed checkpoint rows remain stored, but cannot authorize a segment fetch.
        if(rows.some(r=>(r as {schema?:unknown})?.schema===2&&!recognized.includes(r as Manifest)))result.integrityBlocked=true;
        let visits=0,keys:IDBValidKey[]=[];
        const cursor=chunks.openKeyCursor();
        cursor.onsuccess=()=>{
          const c=cursor.result;
          if(c){
            if(++visits>600){fail(new CheckpointError('integrity'));return;}
            const key=c.primaryKey;
            if(!Array.isArray(key)||key.length!==3 || !recognized.some(m=>key[0]===m.id&&key[1]===m.writerEpoch&&validTime(key[2])&&key[2]<m.committedSegmentCount)) result.integrityBlocked=true;
            keys.push(key); c.continue(); return;
          }
          const declared=recognized.reduce((n,m)=>n+m.committedSegmentCount,0);
          if(keys.length!==declared)result.integrityBlocked=true;
          if(result.integrityBlocked){done(result);return;}
          let remaining=declared;
          for(const m of recognized)result.payloads.set(m.id,[]);
          if(!remaining){done(result);return;}
          for(const m of recognized)for(let i=0;i<m.committedSegmentCount;i++){
            const read=chunks.get([m.id,m.writerEpoch,i]);
            read.onsuccess=()=>{
              if(!segmentValid(read.result,m,i))result.integrityBlocked=true;
              else result.payloads.get(m.id)![i]=read.result;
              if(--remaining===0)done(result);
            };
          }
        };
      };
    };
    mc.onsuccess=()=>{manifestCount=mc.result;proceed();};sc.onsuccess=()=>{segmentCount=sc.result;proceed();};
  }
  private async checkpointSnapshot(deadline:OperationDeadline):Promise<CheckpointSnapshot> {
    assertCheckpointActive(deadline);
    const at=this.available();
    const snapshot=await new Promise<CheckpointSnapshot>((resolve,reject)=>{
      let tx:IDBTransaction;
      try {tx=this.db.transaction([STORE,SEGMENTS],'readonly');}catch{reject(new CheckpointError('closed'));return;}
      let result:CheckpointSnapshot, reason:unknown;
      tx.oncomplete=()=>resolve(result);
      tx.onabort=()=>reject(reason??new CheckpointError('aborted','aborted'));
      const fail=(e:unknown)=>{reason=e;tx.abort();};
      this.collect(tx,at,s=>{result=s;},fail);
    });
    assertCheckpointActive(deadline);
    for(const m of snapshot.manifests){
      const list=snapshot.payloads.get(m.id);
      if(!list||list.length!==m.committedSegmentCount)continue;
      let valid=true;
      for(const s of list){
        assertCheckpointActive(deadline);
        if(!s){valid=false;break;}
        const sha256=await digest(s.bytes);
        assertCheckpointActive(deadline);
        if(sha256!==s.sha256){valid=false;break;}
        this.time();
      }
      if(valid)snapshot.checked.add(m.id);
    }
    for(const row of snapshot.rows)if(validRecord(row,at)){
      assertCheckpointActive(deadline);
      const sha256=await digest(row.bytes);
      assertCheckpointActive(deadline);
      if(sha256===row.sha256)snapshot.legacyChecked.push(row);
      this.time();
    }
    assertCheckpointActive(deadline);
    this.time(); return snapshot;
  }
  private checkpointAccess<T>(action:(snapshot:CheckpointSnapshot,tx:IDBTransaction,at:number)=>T, mutation=true, committed?:()=>void):Promise<T> {
    const deadline={timedOut:false};
    return bounded(this.checkpointAccessInner(action,mutation,committed,deadline),()=>{deadline.timedOut=true;});
  }
  private async checkpointAccessInner<T>(action:(snapshot:CheckpointSnapshot,tx:IDBTransaction,at:number)=>T, mutation=true, committed?:()=>void, deadline={timedOut:false}):Promise<T> {
    this.available();
    const checked=await this.checkpointSnapshot(deadline);
    if(checked.integrityBlocked || checked.manifests.some(m=>!checked.checked.has(m.id)))throw new CheckpointError('integrity');
    const at=this.available();
    if(deadline.timedOut)throw new CheckpointError('uncertain','unknown');
    return new Promise<T>((resolve,reject)=>{
      let tx:IDBTransaction;
      try{tx=this.db.transaction([STORE,SEGMENTS],mutation?'readwrite':'readonly');}catch{reject(new CheckpointError('closed'));return;}
      let value:T, reason:unknown;
      tx.oncomplete=()=>{committed?.();resolve(value);};
      tx.onabort=()=>reject(reason instanceof DraftError?reason:reason instanceof CheckpointError?new CheckpointError(reason.code,'aborted'):new CheckpointError(tx.error?.name==='QuotaExceededError'?'quota':'aborted','aborted'));
      const fail=(e:unknown)=>{reason=e instanceof DOMException&&e.name==='QuotaExceededError'?new CheckpointError('quota'):e;try{tx.abort();}catch{reject(new CheckpointError('uncertain','unknown'));}};
      this.collect(tx,at,current=>{
        try{
          const now=this.time();
          if(deadline.timedOut)throw new CheckpointError('uncertain','unknown');
          if(current.integrityBlocked || current.manifests.some(m=>{
            const old=checked.manifests.find(c=>c.id===m.id);
            return !old || !sameManifest(m,old) || !checked.checked.has(m.id) || !(current.payloads.get(m.id)??[]).every((s,i)=>sameSegment(s,checked.payloads.get(m.id)![i]));
          }))throw new CheckpointError('conflict');
          current.legacyChecked=checked.legacyChecked.filter(old=>current.rows.some(row=>validRecord(row,now)&&same(old,row)));
          value=action(current,tx,now);
        }catch(e){fail(e);}
      },fail);
    });
  }
  private cleanup(snapshot:CheckpointSnapshot,tx:IDBTransaction,at:number):unknown[] {
    return snapshot.rows.filter(row=>{
      if(validManifest(row,at)&&row.expiresAt<=at){
        tx.objectStore(STORE).delete(row.id);
        for(let i=0;i<row.committedSegmentCount;i++)tx.objectStore(SEGMENTS).delete([row.id,row.writerEpoch,i]);
        return false;
      }
      if(validRecord(row,at)&&row.expiresAt<=at&&snapshot.legacyChecked.some(old=>same(old,row))){
        tx.objectStore(STORE).delete(row.id);return false;
      }
      return true;
    });
  }
  private live(snapshot:CheckpointSnapshot,identity:CheckpointIdentity,at:number):Manifest {
    if(!identityValid(identity))throw new CheckpointError('invalid');
    const row=snapshot.rows.find(r=>(r as {id?:unknown})?.id===identity.id);
    if(!row)throw new CheckpointError('not-found');
    if(!validManifest(row,at))throw new CheckpointError('integrity');
    if(row.writerEpoch!==identity.writerEpoch)throw new CheckpointError('conflict');
    if(row.expiresAt<=at)throw new CheckpointError('expired');
    return row;
  }
  reserveRecording(token:PreparedReservation):Promise<ReservedRecording> {
    const state=reservations.get(token);
    if(!state)return Promise.reject(new CheckpointError('invalid'));
    if(state.state==='pending')return state.promise!;
    if(state.state==='retired')return Promise.reject(new CheckpointError('retired'));
    const previous=state.state;
    state.state='pending'; // Set synchronously, before any asynchronous admission work.
    const operation=this.checkpointAccess((snapshot,tx,at)=>{
      const original=state.manifest;
      if(!validManifest(original,at))throw new CheckpointError('invalid');
      if(original.expiresAt<=at)throw new CheckpointError('expired');
      const existing=snapshot.rows.find(r=>(r as {id?:unknown})?.id===original.id);
      let current:Manifest;
      if(existing){
        if(!validManifest(existing,at)||existing.writerEpoch!==original.writerEpoch||existing.createdAt!==original.createdAt||existing.expiresAt!==original.expiresAt||existing.maxFrames!==original.maxFrames||existing.maxWavBytes!==original.maxWavBytes||existing.durationLimitSeconds!==original.durationLimitSeconds)throw new CheckpointError('conflict');
        current=existing;
      } else {
        if(previous==='committed'||previous==='uncertain')throw new CheckpointError(previous==='committed'?'retired':'not-found',previous==='uncertain'?'unknown':'not-started');
        // Delete only exact, fully validated expired checkpoint prefixes in this same transaction.
        const retained=this.cleanup(snapshot,tx,at);
        if(retained.length>=POLICY.slots)throw new CheckpointError('capacity');
        current={...original,lastCommittedAt:at};tx.objectStore(STORE).add(current);
      }
      return {current,already:!!existing};
    },previous!=='committed'&&previous!=='uncertain',()=>{state.state='committed';});
    state.promise=operation.then(({current,already})=>{
      state.state='committed';
      if(!state.writer){state.writer=Object.freeze({schema:2,id:current.id,writerEpoch:current.writerEpoch}) as RecordingWriter;writers.set(state.writer,Object.freeze({schema:2,id:current.id,writerEpoch:current.writerEpoch}));}
      return Object.freeze({writer:state.writer,receipt:receipt(current,already?'already-committed':'committed')});
    },error=>{
      if(state.state==='committed')throw error;
      if(error instanceof CheckpointError&&error.code==='retired')state.state='retired';
      else if(previous==='committed')state.state='committed';
      else if(previous==='uncertain'||!(error instanceof CheckpointError)||error.outcome==='unknown')state.state='uncertain';
      else state.state=error.outcome==='aborted'?'known-aborted':'fresh';
      // Preserve unknown absent reconciliation semantics, not the read transaction's abort classification.
      if(previous==='uncertain'&&error instanceof CheckpointError&&error.code==='not-found')throw new CheckpointError('not-found','unknown');
      throw error;
    });
    return state.promise;
  }
  appendSegment(token:PreparedPcmSegment,expectedRevision:number):Promise<CheckpointReceipt> {
    const segment=segments.get(token);
    if(!segment||!validTime(expectedRevision))return Promise.reject(new CheckpointError('invalid'));
    return this.checkpointAccess((snapshot,tx,at)=>{
      const m=this.live(snapshot,{schema:2,id:segment.draftId,writerEpoch:segment.writerEpoch},at);
      if(expectedRevision>m.revision)throw new CheckpointError('conflict');
      const old=snapshot.payloads.get(m.id)![segment.segmentIndex];
      if(old){if(!sameSegment(old,segment))throw new CheckpointError('conflict');return receipt(m,'already-committed');}
      if(m.revision!==expectedRevision||m.status!=='capturing'||m.committedFrames%16000!==0||segment.segmentIndex!==m.committedSegmentCount||segment.startFrame!==m.committedFrames)throw new CheckpointError('conflict');
      if(m.revision===Number.MAX_SAFE_INTEGER||segment.frameCount<1||segment.frameCount>16000||m.committedFrames+segment.frameCount>m.maxFrames||44+m.committedPcmBytes+segment.byteLength>m.maxWavBytes)throw new CheckpointError('invalid');
      const next:Manifest={...m,revision:m.revision+1,committedFrames:m.committedFrames+segment.frameCount,committedPcmBytes:m.committedPcmBytes+segment.byteLength,committedSegmentCount:m.committedSegmentCount+1,lastCommittedAt:at};
      tx.objectStore(SEGMENTS).add(segment);tx.objectStore(STORE).put(next);return receipt(next);
    });
  }
  commitTerminal(token:PreparedTerminal,expectedRevision:number):Promise<CheckpointReceipt> {
    const prepared=terminals.get(token);
    if(!prepared||!validTime(expectedRevision))return Promise.reject(new CheckpointError('invalid'));
    return this.checkpointAccess((snapshot,tx,at)=>{
      const m=this.live(snapshot,prepared.identity,at);
      if(expectedRevision>m.revision)throw new CheckpointError('conflict');
      if(m.terminal){
        if(JSON.stringify(m.terminal)!==JSON.stringify(prepared.record))throw new CheckpointError('conflict');
        return receipt(m,'already-committed');
      }
      if(m.revision!==expectedRevision||m.status!=='capturing')throw new CheckpointError('conflict');
      const next:Manifest={...m,status:prepared.record.intent.kind,terminal:prepared.record,revision:m.revision+1,lastCommittedAt:at};
      if(!validManifest(next,at))throw new CheckpointError('invalid');
      tx.objectStore(STORE).put(next);return receipt(next);
    });
  }
  inspectCheckpoint(identity:CheckpointIdentity):Promise<CheckpointReceipt|null> {
    if(!identityValid(identity))return Promise.reject(new CheckpointError('invalid'));
    return this.checkpointAccess((snapshot,_tx,at)=>{
      if(!snapshot.rows.some(r=>(r as {id?:unknown})?.id===identity.id))return null;
      return receipt(this.live(snapshot,identity,at),'already-committed');
    },false);
  }
  removeCheckpoint(target:CheckpointDeleteTarget):Promise<{removed:boolean;absent:boolean}> {
    if(!identityValid(target)||!validTime(target.revision))return Promise.reject(new CheckpointError('invalid'));
    return this.checkpointAccess((snapshot,tx,at)=>{
      if(!snapshot.rows.some(r=>(r as {id?:unknown})?.id===target.id))return {removed:false,absent:true};
      const m=snapshot.manifests.find(m=>m.id===target.id);
      if(!m||!validManifest(m,at)||m.writerEpoch!==target.writerEpoch||m.revision!==target.revision)throw new CheckpointError('conflict');
      tx.objectStore(STORE).delete(m.id);
      for(let i=0;i<m.committedSegmentCount;i++)tx.objectStore(SEGMENTS).delete([m.id,m.writerEpoch,i]);
      return {removed:true,absent:false};
    });
  }
  restoreCheckpoints():Promise<CheckpointShelfResult> {
    const deadline={timedOut:false};return bounded(this.restoreCheckpointsInner(deadline),()=>{deadline.timedOut=true;});
  }
  private async restoreCheckpointsInner(deadline:{timedOut:boolean}):Promise<CheckpointShelfResult> {
    const snapshot=await this.checkpointSnapshot(deadline),checkpoints:RecoveryView[]=[],emptyReservations:EmptyCheckpointReservation[]=[];
    assertCheckpointActive(deadline);
    let emptyReservationCount=0,unrestorableCount=0;
    if(snapshot.integrityBlocked)return Object.freeze({checkpoints:Object.freeze(checkpoints),emptyReservations:Object.freeze(emptyReservations),unrestorableCount:snapshot.manifests.length,emptyReservationCount,integrityBlocked:true});
    if(deadline.timedOut)throw new CheckpointError('uncertain','unknown');
    if(snapshot.manifests.some(m=>m.expiresAt<=this.time()) && snapshot.manifests.every(m=>snapshot.checked.has(m.id))) {
      // Explicit shelf access makes expired, validated slots reclaimable for ordinary mode too.
      await this.checkpointAccessInner((current,tx,at)=>{this.cleanup(current,tx,at);},true,undefined,deadline);
    }
    for(const m of snapshot.manifests){
      assertCheckpointActive(deadline);
      const now=this.time();
      if(m.expiresAt<=now)continue;
      if(!snapshot.checked.has(m.id)){unrestorableCount++;continue;}
      if(!m.committedFrames){
        emptyReservations.push(Object.freeze({schema:2,id:m.id,writerEpoch:m.writerEpoch,revision:m.revision,createdAt:m.createdAt,expiresAt:m.expiresAt,status:m.status}));
        continue;
      }
      try{
        const builder=createMonoPcm16WavBuilder({maxDurationSeconds:POLICY.maxSeconds,maxBytes:m.maxWavBytes});
        for(const s of snapshot.payloads.get(m.id)!){
          const pcm=new Int16Array(s.frameCount),view=new DataView(s.bytes);
          for(let i=0;i<pcm.length;i++)pcm[i]=view.getInt16(i*2,true);
          builder.appendPcm16(pcm);
        }
        const wav=builder.finalize(m.committedFrames),bytes=wav.bytes.slice().buffer as ArrayBuffer;
        assertCheckpointActive(deadline);
        const sha256=await digest(bytes);
        assertCheckpointActive(deadline);
        if(this.time()>=m.expiresAt)throw new CheckpointError('expired');
        const blob=new Blob([bytes],{type:'audio/wav'});
        // Format-only adapter: checkpoint identity is never cast to a legacy Draft.
        assertCheckpointActive(deadline);
        const validWav=await isOwnedPcmWav({blob,mimeType:'audio/wav',size:bytes.byteLength,durationSeconds:m.committedFrames/16000});
        assertCheckpointActive(deadline);
        if(!validWav)throw new CheckpointError('integrity');
        if(this.time()>=m.expiresAt)throw new CheckpointError('expired');
        checkpoints.push(Object.freeze({schema:2,id:m.id,writerEpoch:m.writerEpoch,revision:m.revision,createdAt:m.createdAt,expiresAt:m.expiresAt,status:m.status,committedFrames:m.committedFrames,committedSegmentCount:m.committedSegmentCount,limits:limitsOf(m),completion:m.status==='sealed'?'sealed':m.status==='interrupted'?'partial-interrupted':'partial-unconfirmed',terminal:m.terminal,durationSeconds:m.committedFrames/16000,size:bytes.byteLength,mimeType:'audio/wav',sha256,blob}));
      }catch(e){assertCheckpointActive(deadline);if(e instanceof CheckpointError&&e.code==='clock-rollback')throw e;unrestorableCount++;}
    }
    assertCheckpointActive(deadline);
    const returnedAt=this.time();
    const liveEmpty=Object.freeze(emptyReservations.filter(item=>item.expiresAt>returnedAt));
    return Object.freeze({checkpoints:Object.freeze(checkpoints.filter(item=>item.expiresAt>returnedAt)),emptyReservations:liveEmpty,unrestorableCount,emptyReservationCount:liveEmpty.length,integrityBlocked:false});
  }

}
