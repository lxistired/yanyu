import { statSync } from 'node:fs';
import { WorkspaceCommandByteLimitError, workspaceCommandCanonical, isWorkspaceCommandOperation, type WorkspaceCommandOperation, type WorkspaceCommandOutcome } from '../shared/workspace-command-outcome';
import { automationCommandCanonical, isAutomationCommandOperation, type AutomationCommandOperation, type AutomationCommandOutcome } from '../shared/automation-command-outcome';
import { organizationCommandCanonical, isOrganizationCommandOperation, type OrganizationCommandOperation, type OrganizationCommandOutcome } from '../shared/organization-command-outcome';
import { types as nodeTypes } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { checkRequestAuthority } from './request-authority';
import { AdapterError, type ServerContext } from '../shared/contracts';
import type { DomainKind, DomainRecord, DomainTransaction, JsonValue } from '../shared/workspace';
import { reservePrivateDatabaseFile, workspaceDatabasePath } from './database-path';

type OrganizationNegative = {receiptType:'organization-rejection';version:1;operation:OrganizationCommandOperation;requestDigest:string;code:'INVALID_REQUEST'|'CONFLICT';messageKey:'organization-invalid-request'|'organization-conflict'};
const organizationRejected = new WeakMap<object, OrganizationCommandOutcome>();
/** Only this module can mint the brand, after a durable rejection COMMIT or verified replay. */
export function organizationCommandRejection(cause: unknown): OrganizationCommandOutcome | null {
  return cause !== null && typeof cause === 'object' ? organizationRejected.get(cause) ?? null : null;
}
const negativePrefix = 'organization-rejection-v1:';
function readOrganizationNegative(fingerprint: unknown, encoded: unknown): OrganizationNegative {
  const bad = () => new AdapterError('PROVIDER_ERROR', 'Invalid organization command receipt');
  if (typeof fingerprint !== 'string' || !/^organization-rejection-v1:[a-f0-9]{64}$/.test(fingerprint) || typeof encoded !== 'string' || Buffer.byteLength(encoded)>1024) throw bad();
  let value: OrganizationNegative; try { value = JSON.parse(encoded); } catch { throw bad(); }
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).sort().join(',')!=='code,messageKey,operation,receiptType,requestDigest,version' || value.receiptType!=='organization-rejection' || value.version!==1 || !isOrganizationCommandOperation(value.operation) || typeof value.requestDigest!=='string' || fingerprint!==negativePrefix+value.requestDigest || !['INVALID_REQUEST','CONFLICT'].includes(value.code) || value.messageKey!==(value.code==='INVALID_REQUEST'?'organization-invalid-request':'organization-conflict')) throw bad();
  return value;
}

type AutomationNegative = {receiptType:'automation-rejection';version:1;operation:AutomationCommandOperation;requestDigest:string;code:'INVALID_REQUEST'|'CONFLICT';messageKey:'automation-invalid-request'|'automation-conflict'};
const automationRejected = new WeakMap<object, AutomationCommandOutcome>();
/** Only this module can mint the brand, after a durable rejection COMMIT or verified replay. */
export function automationCommandRejection(cause: unknown): AutomationCommandOutcome | null {
  return cause !== null && typeof cause === 'object' ? automationRejected.get(cause) ?? null : null;
}
const automationNegativePrefix = 'automation-rejection-v1:';
function readAutomationNegative(fingerprint: unknown, encoded: unknown): AutomationNegative {
  const bad = () => new AdapterError('PROVIDER_ERROR', 'Invalid automation command receipt');
  if (typeof fingerprint !== 'string' || !/^automation-rejection-v1:[a-f0-9]{64}$/.test(fingerprint) || typeof encoded !== 'string' || Buffer.byteLength(encoded)>1024) throw bad();
  let value: AutomationNegative; try { value = JSON.parse(encoded); } catch { throw bad(); }
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).sort().join(',')!=='code,messageKey,operation,receiptType,requestDigest,version' || value.receiptType!=='automation-rejection' || value.version!==1 || !isAutomationCommandOperation(value.operation) || typeof value.requestDigest!=='string' || fingerprint!==automationNegativePrefix+value.requestDigest || !['INVALID_REQUEST','CONFLICT'].includes(value.code) || value.messageKey!==(value.code==='INVALID_REQUEST'?'automation-invalid-request':'automation-conflict')) throw bad();
  return value;
}

type WorkspaceNegative = {receiptType:'workspace-rejection';version:1;operation:WorkspaceCommandOperation;requestDigest:string;code:'INVALID_REQUEST'|'CONFLICT';messageKey:'workspace-invalid-request'|'workspace-conflict'};
const workspaceRejected = new WeakMap<object, WorkspaceCommandOutcome>();
/** Only this module can mint the brand, after a durable rejection COMMIT or verified replay. */
export function workspaceCommandRejection(cause: unknown): WorkspaceCommandOutcome | null {
  return cause !== null && typeof cause === 'object' ? workspaceRejected.get(cause) ?? null : null;
}
const workspaceNegativePrefix = 'workspace-rejection-v1:';
function readWorkspaceNegative(fingerprint: unknown, encoded: unknown): WorkspaceNegative {
  const bad = () => new AdapterError('PROVIDER_ERROR', 'Invalid workspace command receipt');
  if (typeof fingerprint !== 'string' || !/^workspace-rejection-v1:[a-f0-9]{64}$/.test(fingerprint) || typeof encoded !== 'string' || Buffer.byteLength(encoded)>1024) throw bad();
  let value: WorkspaceNegative; try { value = JSON.parse(encoded); } catch { throw bad(); }
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).sort().join(',')!=='code,messageKey,operation,receiptType,requestDigest,version' || value.receiptType!=='workspace-rejection' || value.version!==1 || !isWorkspaceCommandOperation(value.operation) || typeof value.requestDigest!=='string' || fingerprint!==workspaceNegativePrefix+value.requestDigest || !['INVALID_REQUEST','CONFLICT'].includes(value.code) || value.messageKey!==(value.code==='INVALID_REQUEST'?'workspace-invalid-request':'workspace-conflict')) throw bad();
  return value;
}

export type DomainReadBudget = { maxRows: number; maxBytes: number };
/** Actual encoded rows observed, including an excess row rejected before decoding. */
export type DomainReadUsage = { rows: number; bytes: number };
/** Server-only write transaction aggregate; never exposes SQL or accepts owner overrides. */
export type DomainCapacityUsage = { all: DomainReadUsage; active: DomainReadUsage };
export interface DomainWriteTransaction extends DomainTransaction {
  measureCapacity(kind: DomainKind): DomainCapacityUsage;
}

export type DomainScopedReadBudget = DomainReadBudget & DomainReadUsage;
type ReadMeter = DomainScopedReadBudget & {
  usage?: DomainReadUsage;
  scopedRows?: number;
  scopedBytes?: number;
};
type ScopedReadMeter = DomainScopedReadBudget & { usage: DomainScopedReadBudget };
type ReadScope = {
  parent?: ReadScope;
  meter: ScopedReadMeter;
  signals: Set<AbortSignal>;
  active: boolean;
  failure?: AdapterError;
};

function readMeter(budget: DomainReadBudget): ReadMeter {
  if (!budget || typeof budget !== 'object') throw new AdapterError('INVALID_REQUEST', '无效的本地读取预算');
  const { maxRows, maxBytes } = budget;
  if (
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > 10000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 128 * 1024 * 1024
  )
    throw new AdapterError('INVALID_REQUEST', '无效的本地读取预算');
  return { maxRows, maxBytes, rows: 0, bytes: 0 };
}
function assertReadUsage(usage: DomainReadUsage) {
  if (
    !usage ||
    typeof usage !== 'object' ||
    !Number.isSafeInteger(usage.rows) ||
    usage.rows < 0 ||
    !Number.isSafeInteger(usage.bytes) ||
    usage.bytes < 0
  )
    throw new AdapterError('INVALID_REQUEST', '无效的本地读取计量');
}
function chargeRead(meter: ReadMeter | undefined, encoded: unknown) {
  if (!meter) return;
  meter.rows++;
  meter.bytes += Buffer.byteLength(String(encoded));
  assertReadBudget(meter);
}
function assertReadBudget(meter: ReadMeter | undefined) {
  if (!meter) return;
  if (meter.rows > meter.maxRows || meter.bytes > meter.maxBytes)
    throw new AdapterError('RATE_LIMITED', '本地元数据读取超过有界预算；未返回部分汇总');
}

const APPLICATION_ID = 0x4f524457;
const kinds = new Set<DomainKind>([
  'workspace',
  'session-group',
  'session',
  'message',
  'watchlist',
  'watchlist-item',
  'skill',
  'data-source',
  'schedule',
  'schedule-run',
  'notification',
  'manual-research-plan',
  'research-plan',
  'research-plan-version',
  'research-interaction',
  'research-run',
  'research-event',
  'research-artifact',
  'research-schedule-binding',
  'research-schedule-occurrence',
  'research-scheduled-artifact',
  'ingestion-file',
  'ingestion-version',
  'document-folder',
  'document-placement',
  'session-attachment',
  'conversation-turn',
  'conversation-event',
  'asr-task-metadata',
  'user-preferences',
  'feedback-record',
  'feedback-control',
  'transcript-edition',
  'transcript-revision',
  'transcript-revision-part',
  'transcript-budget',
  'search-history',
  'catalog-search-snapshot',
  'catalog-search-snapshot-part',
  'organization',
  'person',
  'meeting',
  'meeting-registration',
  'meeting-reminder',
  'meeting-reminder-occurrence',
  'crm-contact',
  'service-record',
  'bookmark',
  'reading-record',
  'source-bookmark',
  'reading-position',
  'report-attachment',
  'source-entity-association',
  'entity-material-follow',
  'access-request',
  'share-draft',
]);
const error = (message: string) => new AdapterError('INVALID_REQUEST', message);
const id = (value: string) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw error('无效的本地资料 ID');
  return value;
};
function json(value: unknown): string {
  const seen = new Set<object>();
  const check = (current: unknown, depth: number): void => {
    if (depth > 16) throw error('本地记录嵌套过深');
    if (current === null || typeof current === 'boolean' || typeof current === 'string') return;
    if (typeof current === 'number' && Number.isFinite(current)) return;
    if (typeof current !== 'object' || current === undefined || seen.has(current))
      throw error('本地记录必须是有界 JSON 数据');
    seen.add(current);
    if (Array.isArray(current)) for (const item of current) check(item, depth + 1);
    else {
      if (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null)
        throw error('本地记录包含不受支持的对象');
      for (const [key, item] of Object.entries(current)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype')
          throw error('不安全的记录字段');
        check(item, depth + 1);
      }
    }
    seen.delete(current);
  };
  check(value, 0);
  const result = JSON.stringify(value);
  if (Buffer.byteLength(result) > 1024 * 1024) throw error('单条本地记录超过 1 MiB');
  return result;
}
const copy = <T>(value: T): T => JSON.parse(json(value)) as T;

/** One app-owned local domain database. Feature modules never receive its SQL handle. */
export class DomainStore {
  private db: DatabaseSync;
  private readonly openedPath: string;
  private readonly openedFile: {dev:number;ino:number};
  private inventoryScope = '';
  private closed = false;
  private active = false;
  private readonly readScopes = new AsyncLocalStorage<ReadScope>();
  constructor(root: string, relative = 'data/local-workspace.sqlite') {
    const path = workspaceDatabasePath(root, relative);
    reservePrivateDatabaseFile(path);
    this.openedPath = path;
    this.openedFile = statSync(path);
    this.db = new DatabaseSync(path, { timeout: 200, allowExtension: false });
    try {
      const app = Number(this.db.prepare('PRAGMA application_id').get()?.application_id);
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
      const tables = this.db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
      if (!(app === APPLICATION_ID && version === 1) && !(app === 0 && version === 0 && tables.length === 0))
        throw error('此数据库不属于本地工作区，或版本不受支持');
      this.db.exec(
        'PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;',
      );
      if (version === 0)
        this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE entities(tenant TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, data TEXT NOT NULL, PRIMARY KEY(tenant,owner,kind,id)) STRICT;
        CREATE TABLE commands(tenant TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(tenant,owner,key)) STRICT;
        PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`);
      this.db
        .prepare(
          'SELECT tenant,owner,kind,id,revision,created_at,updated_at,deleted_at,data FROM entities LIMIT 0',
        )
        .all();
      this.db.prepare('SELECT tenant,owner,key,fingerprint,result FROM commands LIMIT 0').all();
      this.initializeManualInventory();
    } catch (cause) {
      this.db.close();
      throw cause instanceof AdapterError
        ? cause
        : new AdapterError('PROVIDER_ERROR', '本地工作区存储无法打开；请检查版本、备份和单进程占用');
    }
  }
  private initializeManualInventory() {
    // Startup only. A partial or unknown feature schema is never repaired in a request.
    const names = ['manual_inventory_feature','manual_inventory_receipts','manual_inventory_results'];
    const present = names.filter(name => this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (present.length === 0) {
        this.db.exec(`CREATE TABLE manual_inventory_feature(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,store_scope TEXT NOT NULL) STRICT;
          CREATE TABLE manual_inventory_receipts(tenant TEXT NOT NULL,owner TEXT NOT NULL,operation_id TEXT NOT NULL,request_digest TEXT NOT NULL,state TEXT NOT NULL,proof_json TEXT NOT NULL,PRIMARY KEY(tenant,owner,operation_id)) STRICT;
          CREATE TABLE manual_inventory_results(tenant TEXT NOT NULL,owner TEXT NOT NULL,result_id TEXT NOT NULL,run_id TEXT NOT NULL,payload_json TEXT NOT NULL,payload_sha256 TEXT NOT NULL,payload_bytes INTEGER NOT NULL,PRIMARY KEY(tenant,owner,result_id),UNIQUE(tenant,owner,run_id)) STRICT;`);
        this.db.prepare('INSERT INTO manual_inventory_feature VALUES(1,1,?)').run(randomUUID());
      } else if (present.length !== 3) throw error('Invalid inventory feature schema');
      const columns = [
        ['singleton:INTEGER:1','version:INTEGER:0','store_scope:TEXT:0'],
        ['tenant:TEXT:1','owner:TEXT:2','operation_id:TEXT:3','request_digest:TEXT:0','state:TEXT:0','proof_json:TEXT:0'],
        ['tenant:TEXT:1','owner:TEXT:2','result_id:TEXT:3','run_id:TEXT:0','payload_json:TEXT:0','payload_sha256:TEXT:0','payload_bytes:INTEGER:0'],
      ];
      names.forEach((name,index)=>{
        const actual=this.db.prepare('PRAGMA table_info('+name+')').all().map(r=>`${r.name}:${r.type}:${r.pk}`);
        if(JSON.stringify(actual)!==JSON.stringify(columns[index]))throw error('Invalid inventory feature schema');
        const meta=this.db.prepare('PRAGMA table_list').all().find(r=>r.name===name);
        if(meta?.strict!==1)throw error('Invalid inventory feature schema');
        const info=this.db.prepare('PRAGMA table_info('+name+')').all();
        if(info.some(r=>r.name!=='singleton'&&r.notnull!==1))throw error('Invalid inventory feature schema');
        if(this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name=? LIMIT 1").get(name))throw error('Invalid inventory feature schema');
        const indexes=this.db.prepare('PRAGMA index_list('+name+')').all();
        if(indexes.length!==(index===0?0:index===1?1:2))throw error('Invalid inventory feature schema');
        const keys=indexes.filter(r=>r.unique===1&&r.partial===0).map(r=>this.db.prepare('PRAGMA index_info('+JSON.stringify(r.name)+')').all().map(c=>c.name).join(','));
        if(index===1&&(keys.length!==1||!keys.includes('tenant,owner,operation_id')))throw error('Invalid inventory feature schema');
        if(index===2&&(keys.length!==2||!keys.includes('tenant,owner,result_id')||!keys.includes('tenant,owner,run_id')))throw error('Invalid inventory feature schema');
        if(index===0){const schema=this.db.prepare("SELECT CASE WHEN length(CAST(sql AS BLOB))<=1024 THEN sql ELSE NULL END AS sql FROM sqlite_schema WHERE type='table' AND name=?").get(name);if(typeof schema?.sql!=='string'||!schema.sql.replace(/\s/g,'').includes('CHECK(singleton=1)'))throw error('Invalid inventory feature schema');}

      });
      const rows=this.db.prepare("SELECT singleton,version,CASE WHEN typeof(store_scope)='text' AND length(CAST(store_scope AS BLOB))=36 THEN store_scope ELSE NULL END AS store_scope FROM manual_inventory_feature LIMIT 2").all();
      if(rows.length!==1||rows[0].singleton!==1||rows[0].version!==1||typeof rows[0].store_scope!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(rows[0].store_scope))throw error('Invalid inventory feature identity');
      this.inventoryScope=rows[0].store_scope;
      this.db.exec('COMMIT');
    } catch(cause){try{this.db.exec('ROLLBACK')}catch{}throw cause;}
  }
  manualInventoryIdentity(context: ServerContext): string {
    this.scope(context);
    const file=statSync(this.openedPath);
    if(file.dev!==this.openedFile.dev||file.ino!==this.openedFile.ino)throw error('Inventory store unavailable');
    const row=this.db.prepare("SELECT version,CASE WHEN typeof(store_scope)='text' AND length(CAST(store_scope AS BLOB))=36 THEN store_scope ELSE NULL END AS store_scope FROM manual_inventory_feature WHERE singleton=1").get();
    if(row?.version!==1||row.store_scope!==this.inventoryScope)throw error('Inventory store unavailable');
    return this.inventoryScope;
  }
  /** Bounded plan links reuse the existing persistent database UUID. No new table,
   * migration, authentication scheme or inventory operation is introduced. */
  manualPlanScope(context:ServerContext):string {
    let storeId:string;try{storeId=this.manualInventoryIdentity(context);}catch{throw new AdapterError('PROVIDER_ERROR','Local plan store identity unavailable');}
    return createHash('sha256').update(JSON.stringify(['manual-plan-session-v1',storeId,
      context.principal.tenantId,context.principal.subjectId])).digest('hex');
  }
  manualInventoryWorkspaceExists(context:ServerContext,key:string):boolean {
    const scope=this.scope(context);
    if(typeof key!=='string'||key.length>160)throw error('Invalid workspace identifier');
    return !!this.db.prepare("SELECT 1 FROM entities WHERE tenant=? AND owner=? AND kind='workspace' AND id=? AND deleted_at IS NULL").get(...scope,key);
  }
  manualInventoryDefinitions(context:ServerContext,scheduleId:string,skillId:string):{schedule:any;skill:any} {
    const scope=this.scope(context);
    const get=(kind:string,key:string)=>{const row=this.db.prepare(`SELECT revision,CASE WHEN length(CAST(data AS BLOB))<=32768 THEN data ELSE NULL END AS data FROM entities WHERE tenant=? AND owner=? AND kind=? AND id=? AND deleted_at IS NULL`).get(...scope,kind,key);if(!row)return null;if(typeof row.data!=='string')throw error('Definition metadata unavailable');return {revision:row.revision,data:JSON.parse(row.data)};};
    return {schedule:get('schedule',scheduleId),skill:get('skill',skillId)};
  }
  private combinedCapacity(scope:[string,string]) {
    const row=this.db.prepare(`SELECT
      (SELECT count(*) FROM entities)+(SELECT count(*) FROM manual_inventory_results) AS rows,
      (SELECT count(*) FROM commands)+(SELECT count(*) FROM manual_inventory_receipts) AS commands,
      (SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM entities)+
      (SELECT coalesce(sum(length(CAST(result AS BLOB))),0) FROM commands)+
      (SELECT coalesce(sum(length(CAST(payload_json AS BLOB))),0) FROM manual_inventory_results)+
      (SELECT coalesce(sum(length(CAST(proof_json AS BLOB))),0) FROM manual_inventory_receipts) AS bytes`).get()!;
    const own=this.db.prepare(`SELECT (SELECT count(*) FROM manual_inventory_results WHERE tenant=? AND owner=?) AS results,
      (SELECT count(*) FROM manual_inventory_receipts WHERE tenant=? AND owner=?) AS receipts`).get(...scope,...scope)!;
    if(Object.values(row).some(v=>!Number.isSafeInteger(v)||Number(v)<0)||Number(row.rows)>10000||Number(row.commands)>50000||Number(row.bytes)>128*1024*1024||Number(own.results)>1000||Number(own.receipts)>5000)throw new AdapterError('RATE_LIMITED','Local storage capacity exhausted');
  }
  private inventoryProof(scope:[string,string],operationId:string,requestDigest:string,decode:(value:unknown)=>any):any|null {
    const row=this.db.prepare(`SELECT CASE WHEN typeof(request_digest)='text' AND length(CAST(request_digest AS BLOB))=64 THEN request_digest ELSE NULL END AS request_digest,CASE WHEN typeof(state)='text' AND length(CAST(state AS BLOB))<=9 THEN state ELSE NULL END AS state,CASE WHEN typeof(proof_json)='text' AND length(CAST(proof_json AS BLOB))<=2048 THEN proof_json ELSE NULL END AS proof FROM manual_inventory_receipts WHERE tenant=? AND owner=? AND operation_id=?`).get(...scope,operationId);
    if(!row)return null;
    if(typeof row.request_digest!=='string'||!/^[a-f0-9]{64}$/.test(row.request_digest)||!['committed','rejected'].includes(String(row.state)))throw error('Inventory receipt unavailable');
    if(row.request_digest!==requestDigest)throw Object.assign(new Error('Manual inventory request conflict'),{code:'KEY_CONFLICT'});
    if(typeof row.proof!=='string')throw error('Inventory receipt unavailable');
    const proof=decode(JSON.parse(row.proof));
    if(proof.operationId!==operationId||proof.requestDigest!==requestDigest||proof.state!==row.state)throw error('Inventory receipt unavailable');
    if(proof.state==='committed'&&!this.db.prepare('SELECT 1 FROM manual_inventory_results WHERE tenant=? AND owner=? AND result_id=? AND run_id=?').get(...scope,proof.resultId,proof.runId))throw error('Inventory receipt unavailable');
    return proof;
  }
  readManualInventoryProof(context:ServerContext,operationId:string,requestDigest:string,decode:(value:unknown)=>any) {
    this.manualInventoryIdentity(context);
    const proof=this.inventoryProof(this.scope(context),operationId,requestDigest,decode);
    this.manualInventoryIdentity(context);return proof;
  }
  writeManualInventoryCommand(context:ServerContext,input:{operationId:string;requestDigest:string},ports:{
    decodeProof:(value:unknown)=>any; check:()=>void;
    prepare:()=>{proof:any;resultId:string;runId:string;payload:string;runData:JsonValue;completedAt:string;check:()=>void;close:()=>void};
    rejection:(cause:unknown)=>any|null;
  }):any {
    this.assertOutsideReadScope();this.manualInventoryIdentity(context);ports.check();
    const scope=this.scope(context);if(this.active)throw error('Nested inventory transaction');
    this.db.exec('BEGIN IMMEDIATE');this.active=true;
    let open=true,commitAttempted=false,prepared:ReturnType<typeof ports.prepare>|undefined;
    const commit=()=>{commitAttempted=true;this.db.exec('COMMIT');open=false;};
    try {
      const old=this.inventoryProof(scope,input.operationId,input.requestDigest,ports.decodeProof);
      if(old){ports.check();this.manualInventoryIdentity(context);commit();return old;}
      this.db.exec('SAVEPOINT inventory_command');
      let proof:any;
      try {
        prepared=ports.prepare();
        const bytes=Buffer.byteLength(prepared.payload);
        if(bytes>262144)throw error('Invalid inventory artifact bound');
        const run=json(prepared.runData);if(Buffer.byteLength(run)>4096)throw error('Invalid inventory run bound');
        this.db.prepare('INSERT INTO manual_inventory_results VALUES(?,?,?,?,?,?,?)').run(...scope,prepared.resultId,prepared.runId,prepared.payload,createHash('sha256').update(prepared.payload).digest('hex'),bytes);
        this.db.prepare("INSERT INTO entities VALUES(?,?,'schedule-run',?,1,?,?,NULL,?)").run(...scope,prepared.runId,prepared.completedAt,prepared.completedAt,run);
        proof=prepared.proof;
        const encoded=JSON.stringify(ports.decodeProof(proof));if(Buffer.byteLength(encoded)>2048)throw error('Invalid proof bound');
        this.db.prepare('INSERT INTO manual_inventory_receipts VALUES(?,?,?,?,?,?)').run(...scope,input.operationId,input.requestDigest,proof.state,encoded);
        this.combinedCapacity(scope);prepared.check();ports.check();this.manualInventoryIdentity(context);
        commit();return proof;
      } catch(cause) {
        if(commitAttempted)throw cause;
        const rejection=ports.rejection(cause);if(!rejection)throw cause;
        this.db.exec('ROLLBACK TO inventory_command');
        const encoded=JSON.stringify(ports.decodeProof(rejection));if(Buffer.byteLength(encoded)>2048)throw error('Invalid proof bound');
        this.db.prepare('INSERT INTO manual_inventory_receipts VALUES(?,?,?,?,?,?)').run(...scope,input.operationId,input.requestDigest,rejection.state,encoded);
        this.combinedCapacity(scope);ports.check();this.manualInventoryIdentity(context);commit();return rejection;
      }
    } finally {
      if(open)try{this.db.exec('ROLLBACK')}catch{}
      this.active=false;prepared?.close();
    }
  }
  readManualInventoryResult(context:ServerContext,runId:string,resultId:string):string {
    this.manualInventoryIdentity(context);const scope=this.scope(context);
    const row=this.db.prepare(`SELECT CASE WHEN typeof(payload_sha256)='text' AND length(CAST(payload_sha256 AS BLOB))=64 THEN payload_sha256 ELSE NULL END AS payload_sha256,payload_bytes,CASE WHEN typeof(payload_json)='text' AND payload_bytes BETWEEN 1 AND 262144 AND length(CAST(payload_json AS BLOB))=payload_bytes THEN payload_json ELSE NULL END AS payload FROM manual_inventory_results WHERE tenant=? AND owner=? AND result_id=? AND run_id=?`).get(...scope,resultId,runId);
    if(!row||typeof row.payload!=='string'||Buffer.byteLength(row.payload)!==row.payload_bytes||createHash('sha256').update(row.payload).digest('hex')!==row.payload_sha256)throw error('Inventory result unavailable');
    this.manualInventoryIdentity(context);return row.payload;
  }
  listManualInventoryHistory(context:ServerContext,input:{scheduleId:string|null;cursor:{completedAt:string;runId:string}|null;limit:number}):unknown[] {
    this.manualInventoryIdentity(context);const scope=this.scope(context);
    // JSON extraction stays in SQLite; no artifact payload is queried here.
    const rows=this.db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB))=36 THEN id ELSE NULL END AS id,CASE WHEN length(CAST(updated_at AS BLOB)) IN (24,27) THEN updated_at ELSE NULL END AS updated_at,CASE WHEN length(CAST(data AS BLOB))<=4096 THEN data ELSE NULL END AS data FROM entities
      WHERE tenant=? AND owner=? AND kind='schedule-run' AND json_extract(data,'$.manualInventory.protocol')='manual-inventory-v1'
      AND (? IS NULL OR json_extract(data,'$.scheduleId')=?)
      AND (? IS NULL OR updated_at<? OR (updated_at=? AND id<? COLLATE BINARY))
      ORDER BY updated_at DESC,id COLLATE BINARY DESC LIMIT ?`).all(...scope,input.scheduleId,input.scheduleId,input.cursor?.completedAt??null,input.cursor?.completedAt??null,input.cursor?.completedAt??null,input.cursor?.runId??null,input.limit+1);
    this.manualInventoryIdentity(context);
    return rows.map(row=>{if(typeof row.data!=='string')throw error('Inventory history unavailable');return {runId:row.id,completedAt:row.updated_at,data:JSON.parse(row.data)};});
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
  private poisonReadScope(frame: ReadScope | undefined, failure: AdapterError) {
    for (let current = frame; current; current = current.parent) current.failure ??= failure;
  }
  private scopedMeters(frame = this.readScopes.getStore()): ScopedReadMeter[] {
    const meters = new Set<ScopedReadMeter>();
    try {
      for (let current = frame; current; current = current.parent) {
        if (!current.active) throw error('有界只读作用域已结束');
        if (current.failure) throw current.failure;
        for (const signal of current.signals)
          if (signal.aborted) throw new AdapterError('CANCELLED', '操作已取消');
        meters.add(current.meter);
      }
      for (const meter of meters) {
        assertReadUsage(meter.usage);
        // Trusted callers may account for earlier stages, but cannot refund observed rows.
        if (meter.usage.rows < meter.rows || meter.usage.bytes < meter.bytes)
          throw error('有界只读计量不能回退');
        meter.rows = Math.max(meter.rows, meter.usage.rows);
        meter.bytes = Math.max(meter.bytes, meter.usage.bytes);
        meter.usage.rows = meter.rows;
        meter.usage.bytes = meter.bytes;
        assertReadBudget(meter);
      }
      return [...meters];
    } catch (cause) {
      if (cause instanceof AdapterError) this.poisonReadScope(frame, cause);
      throw cause;
    }
  }
  private chargeScopedRead(meter: ReadMeter | undefined, encoded: unknown) {
    const frame = this.readScopes.getStore();
    const scoped = this.scopedMeters(frame);
    if (!scoped.length) {
      chargeRead(meter, encoded);
      return;
    }
    const bytes = Buffer.byteLength(String(encoded));
    // Reserve every private counter before publishing usage or decoding. Reentrant reads
    // cannot spend the same remaining budget, including reads made by result getters.
    if (meter) {
      meter.rows++;
      meter.bytes += bytes;
    }
    for (const scopedMeter of scoped) {
      scopedMeter.rows++;
      scopedMeter.bytes += bytes;
    }
    if (meter?.usage && scoped.some((scopedMeter) => scopedMeter.usage === meter.usage)) {
      meter.scopedRows = (meter.scopedRows ?? 0) + 1;
      meter.scopedBytes = (meter.scopedBytes ?? 0) + bytes;
    }
    try {
      for (const scopedMeter of scoped) {
        scopedMeter.usage.rows = scopedMeter.rows;
        scopedMeter.usage.bytes = scopedMeter.bytes;
      }
      assertReadBudget(meter);
      for (const scopedMeter of scoped) assertReadBudget(scopedMeter);
    } catch (cause) {
      if (cause instanceof AdapterError) this.poisonReadScope(frame, cause);
      throw cause;
    }
  }
  private assertOutsideReadScope() {
    if (this.readScopes.getStore()) {
      this.scopedMeters();
      throw error('有界只读作用域不能写入或重放命令');
    }
  }
  /** Trusted server-only read scope; async context is not supplied by request payloads.
   * All reads on this store charge every distinct ancestor budget before parsing.
   * Detached work inherits an expired frame and fails closed after the action settles.
   */
  withReadBudget<T>(budget: DomainScopedReadBudget, action: () => T): T {
    if (this.closed) throw new AdapterError('PROVIDER_ERROR', '本地工作区存储已关闭');
    const parent = this.readScopes.getStore();
    const ancestors = this.scopedMeters(parent);
    let meter = ancestors.find((entry) => entry.usage === budget);
    if (!meter) {
      const limits = readMeter(budget);
      assertReadUsage(budget);
      meter = { ...limits, rows: budget.rows, bytes: budget.bytes, usage: budget };
    }
    const frame: ReadScope = { parent, meter, signals: new Set(), active: true };
    const finish = () => {
      this.scopedMeters(frame);
      if (this.closed) throw new AdapterError('PROVIDER_ERROR', '本地工作区存储已关闭');
    };
    return this.readScopes.run(frame, () => {
      try {
        finish();
        const result = action();
        if (
          result !== null &&
          (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function'
        ) {
          return Promise.resolve(result).then(
            (value) => {
              try {
                finish();
                return value;
              } finally {
                frame.active = false;
              }
            },
            (cause: unknown) => {
              frame.active = false;
              throw cause;
            },
          ) as T;
        }
        finish();
        frame.active = false;
        return result;
      } catch (cause) {
        frame.active = false;
        throw cause;
      }
    });
  }
  private scope(context: ServerContext): [string, string] {
    if (this.closed) throw new AdapterError('PROVIDER_ERROR', '本地工作区存储已关闭');
    const readScope = this.readScopes.getStore();
    try {
      checkRequestAuthority(context);
    } catch (cause) {
      if (cause instanceof AdapterError) this.poisonReadScope(readScope, cause);
      throw cause;
    }
    for (let frame = readScope; frame; frame = frame.parent) frame.signals.add(context.signal);
    if (context.signal.aborted) {
      const cause = new AdapterError('CANCELLED', '操作已取消');
      this.poisonReadScope(readScope, cause);
      throw cause;
    }
    this.scopedMeters(readScope);
    const { tenantId, subjectId } = context.principal;
    if (!tenantId || !subjectId || tenantId.length > 100 || subjectId.length > 100)
      throw new AdapterError('UNAUTHENTICATED', '需要有效的本地身份');
    return [tenantId, subjectId];
  }
  private transaction(
    scope: [string, string],
    writable: boolean,
    alive: () => boolean,
    meter?: ReadMeter,
  ): DomainWriteTransaction {
    const kindCheck = (kind: DomainKind) => {
      if (!alive()) throw error('事务已结束');
      this.scopedMeters();
      if (!kinds.has(kind)) throw error('不支持的本地记录类型');
    };
    const charge = (row: Record<string, unknown>) => {
      // Charge encoded UTF-8 payload before JSON.parse. Repeated reads count again.
      this.chargeScopedRead(meter, row.data);
    };
    const decode = <T extends JsonValue>(row: Record<string, unknown>): DomainRecord<T> => ({
      id: String(row.id),
      kind: String(row.kind) as DomainKind,
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
      data: JSON.parse(String(row.data)) as T,
    });
    const get = <T extends JsonValue>(
      kind: DomainKind,
      key: string,
      includeDeleted = false,
    ): DomainRecord<T> => {
      kindCheck(kind);
      id(key);
      const row = this.db
        .prepare('SELECT * FROM entities WHERE tenant=? AND owner=? AND kind=? AND id=?')
        .get(...scope, kind, key);
      if (!row || (!includeDeleted && row.deleted_at !== null))
        throw new AdapterError('NOT_FOUND', '本地记录不存在或已移至回收站');
      charge(row);
      return decode<T>(row);
    };
    const requireWrite = () => {
      this.assertOutsideReadScope();
      if (!alive() || !writable || !this.active) throw error('只读操作不能修改记录');
    };
    const save = <T extends JsonValue>(
      kind: DomainKind,
      key: string,
      revision: number,
      data: T,
      deletedAt: string | null,
    ): DomainRecord<T> => {
      requireWrite();
      const previous = get<T>(kind, key, true);
      if (!Number.isSafeInteger(revision) || previous.revision !== revision)
        throw new AdapterError('CONFLICT', '本地记录已更改，请刷新后重试');
      const encoded = json(data);
      const now = new Date().toISOString();
      this.db
        .prepare(
          'UPDATE entities SET revision=revision+1,updated_at=?,deleted_at=?,data=? WHERE tenant=? AND owner=? AND kind=? AND id=?',
        )
        .run(now, deletedAt, encoded, ...scope, kind, key);
      return get<T>(kind, key, true);
    };
    return {
      measureCapacity: (kind: DomainKind): DomainCapacityUsage => {
        requireWrite();
        kindCheck(kind);
        // Aggregate encoded UTF-8 bytes without materializing or parsing JSON.
        // Scope and kind are bound parameters from the authorized transaction.
        const row = this.db.prepare(`SELECT count(*) AS all_rows,
          coalesce(sum(length(CAST(data AS BLOB))),0) AS all_bytes,
          coalesce(sum(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END),0) AS active_rows,
          coalesce(sum(CASE WHEN deleted_at IS NULL THEN length(CAST(data AS BLOB)) ELSE 0 END),0) AS active_bytes
          FROM entities WHERE tenant=? AND owner=? AND kind=?`).get(...scope, kind)!;
        const usage = {
          all: { rows: Number(row.all_rows), bytes: Number(row.all_bytes) },
          active: { rows: Number(row.active_rows), bytes: Number(row.active_bytes) },
        };
        assertReadUsage(usage.all);
        assertReadUsage(usage.active);
        return usage;
      },
      get,
      list: <T extends JsonValue>(kind: DomainKind, includeDeleted = false): DomainRecord<T>[] => {
        kindCheck(kind);
        const statement = this.db.prepare(
          `SELECT * FROM entities WHERE tenant=? AND owner=? AND kind=? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY created_at,id`,
        );
        if (!meter && !this.readScopes.getStore())
          return statement.all(...scope, kind).map((row) => decode<T>(row));
        const rows: DomainRecord<T>[] = [];
        for (const row of statement.iterate(...scope, kind)) {
          kindCheck(kind);
          charge(row);
          rows.push(decode<T>(row));
        }
        return rows;
      },
      create: <T extends JsonValue>(kind: DomainKind, data: T, key = randomUUID()): DomainRecord<T> => {
        requireWrite();
        kindCheck(kind);
        id(key);
        if (
          this.db
            .prepare('SELECT 1 FROM entities WHERE tenant=? AND owner=? AND kind=? AND id=?')
            .get(...scope, kind, key)
        )
          throw new AdapterError('CONFLICT', '本地记录 ID 已存在');
        const now = new Date().toISOString();
        this.db
          .prepare('INSERT INTO entities VALUES(?,?,?,?,1,?,?,NULL,?)')
          .run(...scope, kind, key, now, now, json(data));
        return get<T>(kind, key);
      },
      update: <T extends JsonValue>(kind: DomainKind, key: string, revision: number, data: T) => {
        this.assertOutsideReadScope();
        const previous = get(kind, key);
        return save(kind, key, revision, data, previous.deletedAt);
      },
      softDelete: (kind, key, revision) => {
        this.assertOutsideReadScope();
        const previous = get(kind, key, true);
        return save(kind, key, revision, previous.data, previous.deletedAt ?? new Date().toISOString());
      },
      restore: (kind, key, revision) => {
        this.assertOutsideReadScope();
        const previous = get(kind, key, true);
        return save(kind, key, revision, previous.data, null);
      },
    };
  }
  read<T>(context: ServerContext, action: (tx: DomainTransaction) => T): T {
    let alive = true;
    try {
      const result = action(this.transaction(this.scope(context), false, () => alive));
      this.scope(context);
      const copied = copy(result);
      this.scope(context);
      // A getter invoked by copy may read again and catch an exhausted scope.
      this.scopedMeters();
      if (this.readScopes.getStore()) this.scope(context);
      return copied;
    } finally {
      alive = false;
    }
  }
  /** Cumulative per-request row and encoded UTF-8 payload limits. No partial result is returned.
   * Iteration prevents materializing a whole owner's JSON bodies before checking the budget.
   * This bounds allocations/parsing, not a query-planner or wall-clock guarantee.
   */
  readBounded<T>(
    context: ServerContext,
    budget: DomainReadBudget,
    action: (tx: DomainTransaction) => T,
    usage?: DomainReadUsage,
  ): T {
    const meter = readMeter(budget);
    if (usage) assertReadUsage(usage);
    meter.usage = usage;
    let alive = true;
    try {
      const result = action(this.transaction(this.scope(context), false, () => alive, meter));
      this.scope(context);
      assertReadBudget(meter);
      const copied = copy(result);
      // Serialization can invoke a trusted callback's getter; exhaustion cannot be swallowed.
      assertReadBudget(meter);
      this.scope(context);
      return copied;
    } finally {
      alive = false;
      if (usage) {
        usage.rows += meter.rows - (meter.scopedRows ?? 0);
        usage.bytes += meter.bytes - (meter.scopedBytes ?? 0);
      }
    }
  }
  /** Receipt lookup does not authorize any source content cached in that receipt. Callers recheck it. */
  replay<T>(
    context: ServerContext,
    key: string,
    request: JsonValue,
    budget?: DomainReadBudget,
  ): { found: false } | { found: true; result: T } {
    this.assertOutsideReadScope();
    const meter = budget ? readMeter(budget) : undefined;
    const scope = this.scope(context);
    if (typeof key !== 'string' || key.length < 1 || key.length > 100) throw error('需要有界幂等键');
    const fingerprint = createHash('sha256').update(json(request)).digest('hex');
    const existing = this.db
      .prepare('SELECT fingerprint,result FROM commands WHERE tenant=? AND owner=? AND key=?')
      .get(...scope, key);
    if (!existing) {
      checkRequestAuthority(context);
      return { found: false };
    }
    if (existing.fingerprint !== fingerprint) throw new AdapterError('CONFLICT', '幂等键已被另一操作使用');
    chargeRead(meter, existing.result);
    const result = JSON.parse(String(existing.result)) as T;
    checkRequestAuthority(context);
    return { found: true, result };
  }
  /** Optional budget covers this transaction's entity reads, including implicit mutation reads,
   * or its existing receipt decode. Other authorization stages retain their own budgets. */
  write<T>(
    context: ServerContext,
    key: string,
    request: JsonValue,
    action: (tx: DomainWriteTransaction) => T,
    budget?: DomainReadBudget,
    beforeCommit?: () => void,
  ): T {
    // Keep the legacy normalized fingerprint and eager request serialization contract.
    const outcome = this.writeEngine(context, key, () => ({fingerprint:createHash('sha256').update(json(request)).digest('hex'), action}), budget, beforeCommit);
    if ('rejection' in outcome) throw new AdapterError('PROVIDER_ERROR','Unexpected organization rejection');
    return outcome.value;
  }

  /** Server-only opt-in. The lazy prepare/action is serialized under the SAME receipt lock. */
  writeOrganizationCommand<T>(context: ServerContext, key: string, operation: OrganizationCommandOperation,
    input: unknown, prepare: () => {request: JsonValue; action: (tx: DomainWriteTransaction) => T},
    eligible: (cause: unknown) => boolean): T {
    let canonical: string;
    try {
      let inspected=0; const inspect=(value:unknown,depth:number):void=>{if(++inspected>8192||depth>16)throw new TypeError('Command structure limit');if(value!==null&&typeof value==='object'){if(nodeTypes.isProxy(value))throw new TypeError('Proxy command');for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))){if(!('value' in descriptor))throw new TypeError('Accessor command');inspect(descriptor.value,depth+1);}}};
      inspect(input,0);
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.getOwnPropertyDescriptor(input,'idempotencyKey')?.value!==key)throw new TypeError('Command key mismatch');
      canonical = organizationCommandCanonical(operation, input);
    }
    catch { throw new AdapterError('INVALID_REQUEST','Invalid organization command envelope'); }
    const requestDigest = createHash('sha256').update(canonical).digest('hex');
    const outcome = this.writeEngine(context,key,()=>{const prepared=prepare();return {fingerprint:createHash('sha256').update(json(prepared.request)).digest('hex'),action:prepared.action};},undefined,undefined,{family:'organization',operation,requestDigest,eligible});
    if ('value' in outcome) return outcome.value;
    const rejection=outcome.rejection;
    const cause = new AdapterError(rejection.code,rejection.code==='INVALID_REQUEST'?'Invalid organization request':'Organization record conflict');
    organizationRejected.set(cause,Object.freeze({version:1,state:'rejected',operation,idempotencyKey:key,requestDigest}));
    throw cause;
  }

  /** Server-only opt-in. The lazy prepare/action is serialized under the SAME receipt lock. */
  writeAutomationDefinitionCommand<T>(context: ServerContext, key: string, operation: AutomationCommandOperation,
    input: unknown, prepare: () => {request: JsonValue; action: (tx: DomainWriteTransaction) => T},
    eligible: (cause: unknown) => boolean): T {
    let canonical: string;
    try {
      let inspected=0; const inspect=(value:unknown,depth:number):void=>{if(++inspected>8192||depth>16)throw new TypeError('Command structure limit');if(value!==null&&typeof value==='object'){if(nodeTypes.isProxy(value))throw new TypeError('Proxy command');for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))){if(!('value' in descriptor))throw new TypeError('Accessor command');inspect(descriptor.value,depth+1);}}};
      inspect(input,0);
      if(!input||typeof input!=='object'||Array.isArray(input)||typeof Object.getOwnPropertyDescriptor(input,'idempotencyKey')?.value!=='string'||(Object.getOwnPropertyDescriptor(input,'idempotencyKey')?.value as string).length>100||(Object.getOwnPropertyDescriptor(input,'idempotencyKey')?.value as string).trim()!==key)throw new TypeError('Command key mismatch');
      canonical = automationCommandCanonical(operation, input);
    }
    catch { throw new AdapterError('INVALID_REQUEST','Invalid automation command envelope'); }
    const requestDigest = createHash('sha256').update(canonical).digest('hex');
    const outcome = this.writeEngine(context,key,()=>{const prepared=prepare();return {fingerprint:createHash('sha256').update(json(prepared.request)).digest('hex'),action:prepared.action};},undefined,undefined,{family:'automation-definition',operation,requestDigest,eligible});
    if ('value' in outcome) return outcome.value;
    const rejection=outcome.rejection;
    const cause = new AdapterError(rejection.code,rejection.code==='INVALID_REQUEST'?'Invalid automation request':'Automation record conflict');
    automationRejected.set(cause,Object.freeze({version:1,state:'rejected',operation,idempotencyKey:(input as {idempotencyKey:string}).idempotencyKey,requestDigest}));
    throw cause;
  }

  /** Server-only opt-in. The lazy prepare/action is serialized under the SAME receipt lock. */
  writeWorkspaceCommand<T>(context: ServerContext, key: string, operation: WorkspaceCommandOperation,
    input: unknown, prepare: () => {request: JsonValue; action: (tx: DomainWriteTransaction) => T},
    eligible: (cause: unknown) => boolean): T {
    let canonical: string | undefined;
    try {
      let inspected=0; const inspect=(value:unknown,depth:number):void=>{if(++inspected>8192||depth>16)throw new TypeError('Command structure limit');if(value!==null&&typeof value==='object'){if(nodeTypes.isProxy(value))throw new TypeError('Proxy command');for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))){if(!('value' in descriptor))throw new TypeError('Accessor command');inspect(descriptor.value,depth+1);}}};
      inspect(input,0);
      if(!input||typeof input!=='object'||Array.isArray(input)||typeof Object.getOwnPropertyDescriptor(input,'idempotencyKey')?.value!=='string'||(Object.getOwnPropertyDescriptor(input,'idempotencyKey')?.value as string).length>100||Object.getOwnPropertyDescriptor(input,'idempotencyKey')?.value!==key||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(key))throw new TypeError('Command key mismatch');
      canonical = workspaceCommandCanonical(operation, input);
    }
    catch (cause) {
      if (!(cause instanceof WorkspaceCommandByteLimitError)) throw new AdapterError('INVALID_REQUEST','Invalid workspace command envelope');
      // Safe JSON whose raw text exceeds only the proof budget retains legacy behavior.
      // No terminal brand is minted, even when its original validators reject it.
      const prepared = prepare();
      return this.write(context, key, prepared.request, prepared.action);
    }
    const requestDigest = createHash('sha256').update(canonical).digest('hex');
    const outcome = this.writeEngine(context,key,()=>{const prepared=prepare();return {fingerprint:createHash('sha256').update(json(prepared.request)).digest('hex'),action:prepared.action};},undefined,undefined,{family:'workspace',operation,requestDigest,eligible});
    if ('value' in outcome) return outcome.value;
    const rejection=outcome.rejection;
    const cause = new AdapterError(rejection.code,rejection.code==='INVALID_REQUEST'?'Invalid workspace request':'Workspace record conflict');
    workspaceRejected.set(cause,Object.freeze({version:1,state:'rejected',operation,idempotencyKey:(input as {idempotencyKey:string}).idempotencyKey,requestDigest}));
    throw cause;
  }

  private writeEngine<T>(context: ServerContext,key: string,
    prepare: () => {fingerprint:string;action:(tx:DomainWriteTransaction)=>T},
    budget?:DomainReadBudget,beforeCommit?:()=>void,
    organization?:({family:'organization';operation:OrganizationCommandOperation}|{family:'automation-definition';operation:AutomationCommandOperation}|{family:'workspace';operation:WorkspaceCommandOperation}) & {requestDigest:string;eligible:(cause:unknown)=>boolean},
  ): {value:T}|{rejection:OrganizationNegative|AutomationNegative|WorkspaceNegative} {
    this.assertOutsideReadScope();
    const meter = budget ? readMeter(budget) : undefined;
    const scope = this.scope(context);
    if (this.active) throw error('不支持嵌套写入');
    if (typeof key !== 'string' || key.length < 1 || key.length > 100) throw error('需要有界幂等键');
    const eager = organization ? undefined : prepare();
    this.db.exec('BEGIN IMMEDIATE');
    this.active = true;
    let alive = true, transactionOpen = true;
    const finalCheck = () => {
      const value: unknown = beforeCommit?.();
      if (value !== undefined) {
        void Promise.resolve(value).catch(() => undefined);
        throw new AdapterError('PROVIDER_ERROR', '提交核对必须同步完成');
      }
      this.scope(context);
      assertReadBudget(meter);
    };
    const commit = () => { this.db.exec('COMMIT'); transactionOpen=false; };
    try {
      const existing = this.db.prepare('SELECT fingerprint,result FROM commands WHERE tenant=? AND owner=? AND key=?').get(...scope,key);
      if (existing) {
        if (organization && typeof existing.fingerprint==='string' && existing.fingerprint.startsWith(organization.family==='organization'?negativePrefix:organization.family==='workspace'?workspaceNegativePrefix:automationNegativePrefix)) {
          const rejection=organization.family==='organization'?readOrganizationNegative(existing.fingerprint,existing.result):organization.family==='workspace'?readWorkspaceNegative(existing.fingerprint,existing.result):readAutomationNegative(existing.fingerprint,existing.result);
          if(rejection.operation!==organization.operation || rejection.requestDigest!==organization.requestDigest) throw new AdapterError('CONFLICT','幂等键已被另一操作使用');
          finalCheck();commit();return {rejection};
        }
        // Validation failure here must NEVER replace an already committed positive receipt.
        const prepared=eager ?? prepare();
        if(existing.fingerprint!==prepared.fingerprint)throw new AdapterError('CONFLICT','幂等键已被另一操作使用');
        chargeRead(meter,existing.result);
        const result=JSON.parse(String(existing.result)) as T;
        finalCheck();commit();return {value:result};
      }
      let encoded:string, fingerprint:string, rejection:OrganizationNegative|AutomationNegative|WorkspaceNegative|undefined;
      const savepoint=organization?.family==='automation-definition'?'automation_definition_command':organization?.family==='workspace'?'workspace_command':'organization_command';
      if(organization)this.db.exec('SAVEPOINT '+savepoint);
      try {
        const prepared=eager ?? prepare();fingerprint=prepared.fingerprint;
        const result=prepared.action(this.transaction(scope,true,()=>alive,meter));
        assertReadBudget(meter);encoded=json(result);assertReadBudget(meter);
      } catch(cause) {
        if(!organization || !organization.eligible(cause) || !(cause instanceof AdapterError) || !['INVALID_REQUEST','CONFLICT'].includes(cause.code))throw cause;
        this.db.exec('ROLLBACK TO '+savepoint);
        rejection=organization.family==='organization'
          ? {receiptType:'organization-rejection',version:1,operation:organization.operation,requestDigest:organization.requestDigest,code:cause.code as 'INVALID_REQUEST'|'CONFLICT',messageKey:cause.code==='INVALID_REQUEST'?'organization-invalid-request':'organization-conflict'}
          : organization.family==='workspace' ? {receiptType:'workspace-rejection',version:1,operation:organization.operation,requestDigest:organization.requestDigest,code:cause.code as 'INVALID_REQUEST'|'CONFLICT',messageKey:cause.code==='INVALID_REQUEST'?'workspace-invalid-request':'workspace-conflict'}
          : {receiptType:'automation-rejection',version:1,operation:organization.operation,requestDigest:organization.requestDigest,code:cause.code as 'INVALID_REQUEST'|'CONFLICT',messageKey:cause.code==='INVALID_REQUEST'?'automation-invalid-request':'automation-conflict'};
        fingerprint=(organization.family==='organization'?negativePrefix:organization.family==='workspace'?workspaceNegativePrefix:automationNegativePrefix)+organization.requestDigest;encoded=json(rejection);
      }
      if(organization)this.db.exec('RELEASE '+savepoint);
      this.db.prepare('INSERT INTO commands VALUES(?,?,?,?,?)').run(...scope,key,fingerprint,encoded);
      this.combinedCapacity(scope);
      finalCheck();commit();
      return rejection ? {rejection} : {value:JSON.parse(encoded) as T};
    }catch(cause){
      // A failed COMMIT is uncertain. Cleanup cannot mint a rejection, even if it succeeds.
      if(transactionOpen)try{this.db.exec('ROLLBACK')}catch(rollback){throw new AggregateError([cause,rollback],'Write and rollback failed')}
      throw cause;
    }finally{alive=false;this.active=false;}
  }
}
