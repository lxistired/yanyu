import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { AdapterError, type ServerContext } from '../shared/contracts';
import type { DomainTransaction, JsonValue } from '../shared/workspace';
import { effectiveManualPlanLinks, manualPlanSourceKey, MANUAL_PLAN_STATES, MANUAL_PLAN_LIMITS as L, type ManualPlanData,
  type ManualPlanFields, type ManualPlanState, type ManualPlanRecord, type ManualPlanPage,
  type CreateManualPlan, type UpdateManualPlan, type SetManualPlanState,
  type ManualPlanSourceLink, type AddManualPlanMaterialLinks, type RemoveManualPlanMaterialLink,
  type ManualPlanMutation, type GetManualPlan, type ListManualPlans, type SetManualPlanSessionLink,
  type SetManualPlanMaterialLink, type ManualPlanMaterialLink, type SetManualPlanDocumentLink, type ManualPlanDocumentLink,
  type ManualPlanSessionChoicesRequest, type ManualPlanSessionChoices, type ManualPlanSessionTarget,
  type ManualPlanSessionLink, type ManualPlanLinkedSessionRequest, type ManualPlanLinkedSession, type ManualPlanLinkedSessionMessage } from '../shared/manual-plans';
import { DomainStore, type DomainWriteTransaction } from './workspace-store';
import type { WorkspaceData, SessionData, MessageData } from './workspace-domain';
const KIND = 'manual-research-plan' as const;
const invalid = () => new AdapterError('INVALID_REQUEST', 'Invalid manual plan request');
// A scope failure says nothing about a command previously sent to another store.
const scopeUnavailable = () => new AdapterError('PROVIDER_ERROR', 'Local plan store scope unavailable; original command outcome is not determined');
const conflict = () => new AdapterError('CONFLICT', 'Manual plan changed or operation is not allowed; refresh and review');
const fields = ['title', 'objective', 'notes', 'targetDate'] as const;
const mutationFields = ['idempotencyKey', 'id', 'expectedRevision'];
const budget = { maxRows: L.scanRows, maxBytes: L.scanBytes };
/** Protect both list views independently. Legacy excess may stay level or decrease
 * per dimension, but cannot increase above its cap. Trash counts in all; restore
 * must also fit active. The surrounding write rolls back both entity and receipt. */
function withinCapacity<T>(tx: DomainWriteTransaction, action: () => T): T {
  const before = tx.measureCapacity(KIND);
  const result = action();
  const after = tx.measureCapacity(KIND);
  for (const view of ['all', 'active'] as const) {
    if ((after[view].rows > L.scanRows && after[view].rows > before[view].rows) ||
        (after[view].bytes > L.scanBytes && after[view].bytes > before[view].bytes))
      throw new AdapterError('RATE_LIMITED', 'Manual plan storage exceeds the local list capacity; reduce existing data before adding more');
  }
  return result;
}

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw invalid();
    const d = descriptors[key];
    if (!d.enumerable || !('value' in d) || d.value === undefined) throw invalid();
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max ||
      (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw invalid();
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw invalid();
  return value;
}
function scopeId(value:unknown):string { if(typeof value!=='string'||value.length!==64||! /^[a-f0-9]{64}$/.test(value))throw invalid();return value; }
/** Match the transcript store's UUIDv4 identity and library job ID contracts without
 * importing a browser client or treating a well-formed shortcut as an existing target. */
function materialLink(value: unknown): ManualPlanMaterialLink | null {
  if (value === null) return null;
  const target = object(value, ['kind', 'transcriptStoreId', 'jobId']);
  if (target.kind !== 'transcript' || typeof target.transcriptStoreId !== 'string' ||
      target.transcriptStoreId.length !== 36 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(target.transcriptStoreId) ||
      typeof target.jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}(?![\s\S])/.test(target.jobId)) throw invalid();
  return { kind: 'transcript', transcriptStoreId: target.transcriptStoreId, jobId: target.jobId };
}
/** Match the document UUID contract, not the transcript UUIDv4 restriction. */
function documentLink(value: unknown): ManualPlanDocumentLink | null {
  if (value === null) return null;
  const target = object(value, ['kind', 'documentStoreId', 'documentId']);
  const uuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
  if (target.kind !== 'document' || !uuid(target.documentStoreId) || !uuid(target.documentId)) throw invalid();
  return { kind: 'document', documentStoreId: target.documentStoreId, documentId: target.documentId };
}
/** Validate descriptors before reading fields, including union discrimination. */
function sourceLink(value: unknown): ManualPlanSourceLink {
  const target = object(value, ['kind', 'transcriptStoreId', 'jobId', 'documentStoreId', 'documentId']);
  if (target.kind === 'transcript') return materialLink(target)!;
  if (target.kind === 'document') return documentLink(target)!;
  throw invalid();
}
function materialLinks(value: unknown): ManualPlanSourceLink[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > L.materialLinks) throw invalid();
  const ds = Object.getOwnPropertyDescriptors(value as object);
  if (Reflect.ownKeys(ds).length !== length + 1) throw invalid();
  const result: ManualPlanSourceLink[] = [];
  for (let index = 0; index < length; index++) {
    const d = ds[String(index)];
    if (!d || !d.enumerable || !('value' in d)) throw invalid();
    result.push(sourceLink(d.value));
  }
  return result;
}
function boundedLinks(data: ManualPlanData): ManualPlanData {
  if (effectiveManualPlanLinks(data).length > L.materialLinks) throw invalid();
  return data;
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw invalid();
  return Number(value);
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') throw invalid(); return value; }
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw invalid(); return value as T;
}
/** Date-only Gregorian label. Deliberately does not construct a Date or timezone instant. */
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid();
  const [y,m,d] = value.split('-').map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  if (y < 1970 || y > 2100 || m < 1 || m > 12 || d < 1 || d > [31,leap?29:28,31,30,31,30,31,31,30,31,30,31][m-1]) throw invalid();
  return value;
}
function patch(value: unknown): Partial<ManualPlanFields> {
  const source = object(value, fields), result: Partial<ManualPlanFields> = {};
  // Fixed field order is part of the canonical command fingerprint.
  if (Object.hasOwn(source, 'title')) result.title = text(source.title, L.titleBytes, true).trim();
  if (Object.hasOwn(source, 'objective')) result.objective = text(source.objective, L.textBytes, true);
  if (Object.hasOwn(source, 'notes')) result.notes = text(source.notes, L.textBytes);
  if (Object.hasOwn(source, 'targetDate')) result.targetDate = source.targetDate === null ? null : date(source.targetDate);
  return result;
}
function boundedCommand(value: { [key: string]: JsonValue }): { [key: string]: JsonValue } {
  if (Buffer.byteLength(JSON.stringify(value)) > L.commandBytes) throw invalid();
  return value;
}
function mutation(source: Record<string, unknown>) {
  return { idempotencyKey: id(source.idempotencyKey), id: id(source.id),
    expectedRevision: integer(source.expectedRevision, 1, Number.MAX_SAFE_INTEGER) };
}
function record(tx: DomainTransaction, key: string, includeDeleted = false): ManualPlanRecord {
  return tx.get<ManualPlanData>(KIND, key, includeDeleted) as ManualPlanRecord;
}
const terminal = (state: ManualPlanState) => state === 'completed' || state === 'cancelled';
const transitions: Record<ManualPlanState, readonly ManualPlanState[]> = {
  draft: ['planned','in-progress','completed','cancelled'],
  planned: ['draft','in-progress','completed','cancelled'],
  'in-progress': ['planned','completed','cancelled'], completed: [], cancelled: [],
};
export class ManualPlanDomain {
  constructor(private readonly store: DomainStore) {}
  get(context: ServerContext, request: GetManualPlan): ManualPlanRecord {
    const r = object(request, ['id', 'includeDeleted', 'scope']);
    const storeScope=this.store.manualPlanScope(context);
    if(Object.hasOwn(r,'scope')&&scopeId(r.scope)!==storeScope)throw scopeUnavailable();
    const key = id(r.id), includeDeleted = Object.hasOwn(r, 'includeDeleted') ? bool(r.includeDeleted) : false;
    return this.store.readBounded(context, budget, tx => ({...record(tx, key, includeDeleted),storeScope}));
  }
  list(context: ServerContext, request: ListManualPlans = {}): ManualPlanPage {
    const r = object(request, ['offset','limit','query','state','fromDate','toDate','includeDeleted','sort','direction']);
    const offset = Object.hasOwn(r, 'offset') ? integer(r.offset, 0, L.maxOffset) : 0;
    const limit = Object.hasOwn(r, 'limit') ? integer(r.limit, 1, L.maxLimit) : L.defaultLimit;
    const query = Object.hasOwn(r, 'query') ? text(r.query, L.queryBytes).trim().toLowerCase() : '';
    const state = Object.hasOwn(r, 'state') ? choice(r.state, MANUAL_PLAN_STATES) : null;
    const from = Object.hasOwn(r, 'fromDate') ? date(r.fromDate) : null, to = Object.hasOwn(r, 'toDate') ? date(r.toDate) : null;
    if (from && to && from >= to) throw invalid();
    const deleted = Object.hasOwn(r, 'includeDeleted') ? bool(r.includeDeleted) : false;
    const sort = Object.hasOwn(r, 'sort') ? choice(r.sort, ['targetDate','updatedAt'] as const) : 'updatedAt';
    const direction = Object.hasOwn(r, 'direction') ? choice(r.direction, ['asc','desc'] as const) : 'desc';
    return this.store.readBounded(context, budget, tx => {
      const rows = (tx.list<ManualPlanData>(KIND, deleted) as ManualPlanRecord[]).filter(row => {
        const d = row.data;
        return (!state || d.state === state) && (!query || [d.title,d.objective,d.notes].some(s => s.toLowerCase().includes(query))) &&
          (!from || d.targetDate !== null && d.targetDate >= from) && (!to || d.targetDate !== null && d.targetDate < to);
      });
      rows.sort((a,b) => {
        const x = sort === 'targetDate' ? a.data.targetDate : a.updatedAt;
        const y = sort === 'targetDate' ? b.data.targetDate : b.updatedAt;
        // Null dates always last; ID tie-break always ascending, independent of direction.
        if (x === null && y !== null) return 1;
        if (y === null && x !== null) return -1;
        const compare = x === y ? 0 : x! < y! ? -1 : 1;
        return compare ? compare * (direction === 'asc' ? 1 : -1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      const result: ManualPlanPage = { items: [], total: rows.length, offset, nextOffset: null };
      for (const row of rows.slice(offset, offset + limit)) {
        result.items.push(row);
        result.nextOffset = offset + result.items.length < rows.length ? offset + result.items.length : null;
        if (Buffer.byteLength(JSON.stringify(result)) > L.pageBytes) {
          result.items.pop();
          if (!result.items.length) throw new AdapterError('RATE_LIMITED', 'Manual plan page exceeds the local read limit');
          break;
        }
      }
      result.nextOffset = result.items.length && offset + result.items.length < rows.length ? offset + result.items.length : null;
      return result;
    });
  }
  /** Only active owner-scoped workspaces and sessions; never message content. */
  sessionChoices(context:ServerContext, request:ManualPlanSessionChoicesRequest):ManualPlanSessionChoices {
    const r=object(request,['id','expectedRevision','workspaceId','offset','scope']);
    const key=id(r.id), revision=integer(r.expectedRevision,1,Number.MAX_SAFE_INTEGER);
    const workspaceId=r.workspaceId===null?null:id(r.workspaceId), offset=Object.hasOwn(r,'offset')?integer(r.offset,0,L.maxOffset):0;
    const scope=this.store.manualPlanScope(context);
    if(scopeId(r.scope)!==scope)throw scopeUnavailable();
    return this.store.readBounded(context,budget,tx=>{
      const plan=record(tx,key);if(plan.revision!==revision)throw conflict();
      let currentLink:ManualPlanSessionChoices['currentLink']={status:'none'};
      const link=plan.data.sessionLink;
      if(link){
        currentLink={status:'unavailable'};
        if(link.scope===scope)try{
          const w=tx.get<{name:string}>('workspace',link.workspaceId), session=tx.get<{title:string;workspaceId:string}>('session',link.sessionId);
          if(session.data.workspaceId===w.id)currentLink={status:w.revision===link.workspaceRevision&&session.revision===link.sessionRevision?'available':'stale',workspaceTitle:w.data.name,sessionTitle:session.data.title};
        }catch(error){if(!(error instanceof AdapterError)||error.code!=='NOT_FOUND')throw error;}
      }
      const workspace=workspaceId===null?null:tx.get<{name:string}>('workspace',workspaceId);
      const rows=workspaceId===null?tx.list<{name:string}>('workspace').map(x=>({id:x.id,title:x.data.name,revision:x.revision})):
        tx.list<{title:string;workspaceId:string}>('session').filter(x=>x.data.workspaceId===workspaceId).map(x=>({id:x.id,title:x.data.title,revision:x.revision}));
      rows.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
      const items=rows.slice(offset,offset+25);
      return {scope,planId:plan.id,planRevision:plan.revision,workspace:workspace?{id:workspace.id,title:workspace.data.name,revision:workspace.revision}:null,
        items,total:rows.length,offset,nextOffset:offset+items.length<rows.length?offset+items.length:null,currentLink};
    });
  }
  /** Read only the currently saved manual messages of the exact linked ordinary session.
   * One bounded read, no writes/receipts, no generated turns and no unscoped fallback.
   * Rechecks protect publication; separate page requests are not a frozen snapshot. */
  linkedSession(context:ServerContext, request:ManualPlanLinkedSessionRequest):ManualPlanLinkedSession {
    const r=object(request,['id','expectedRevision','scope','sessionLink','offset','limit']);
    const key=id(r.id), revision=integer(r.expectedRevision,1,Number.MAX_SAFE_INTEGER), scope=scopeId(r.scope);
    const t=object(r.sessionLink,['scope','workspaceId','sessionId','workspaceRevision','sessionRevision']);
    const target:ManualPlanSessionLink={scope:scopeId(t.scope),workspaceId:id(t.workspaceId),sessionId:id(t.sessionId),
      workspaceRevision:integer(t.workspaceRevision,1,Number.MAX_SAFE_INTEGER),sessionRevision:integer(t.sessionRevision,1,Number.MAX_SAFE_INTEGER)};
    const offset=Object.hasOwn(r,'offset')?integer(r.offset,0,L.maxOffset):0;
    const limit=Object.hasOwn(r,'limit')?integer(r.limit,1,L.maxLimit):L.defaultLimit;
    const checkScope=()=>{if(target.scope!==scope||this.store.manualPlanScope(context)!==scope)throw scopeUnavailable();};
    checkScope();
    const result=this.store.readBounded(context,budget,tx=>{
      const current=()=>{
        checkScope();
        const plan=record(tx,key), link=plan.data.sessionLink;
        if(plan.revision!==revision||!link||link.scope!==target.scope||link.workspaceId!==target.workspaceId||
          link.sessionId!==target.sessionId||link.workspaceRevision!==target.workspaceRevision||link.sessionRevision!==target.sessionRevision)throw conflict();
        const workspace=tx.get<WorkspaceData>('workspace',target.workspaceId), session=tx.get<SessionData>('session',target.sessionId);
        if(workspace.revision!==target.workspaceRevision||session.revision!==target.sessionRevision||session.data.workspaceId!==workspace.id)throw conflict();
        return {plan,workspace,session};
      };
      const {plan,workspace,session}=current();
      const rows=tx.list<MessageData>('message').filter(row=>row.data.sessionId===target.sessionId);
      // Exact legacy ordinary-message ordering. Reads never invent or persist a sequence.
      rows.sort((a,b)=>Number(a.data.sequence!==undefined)-Number(b.data.sequence!==undefined)||
        (a.data.sequence??0)-(b.data.sequence??0)||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
      const page:ManualPlanLinkedSession={scope,planId:plan.id,planRevision:plan.revision,sessionLink:target,
        workspace:{id:workspace.id,title:workspace.data.name,revision:workspace.revision},
        session:{id:session.id,title:session.data.title,revision:session.revision,workspaceId:session.data.workspaceId,mode:session.data.mode,model:session.data.model},
        items:[],total:rows.length,offset,nextOffset:null};
      const oversized=()=>Buffer.byteLength(JSON.stringify(page),'utf8')>L.pageBytes;
      const tooLarge=()=>new AdapterError('RATE_LIMITED','Linked session page exceeds the local read limit');
      if(oversized())throw tooLarge();
      for(const row of rows.slice(offset,offset+limit)){
        page.items.push(row as ManualPlanLinkedSessionMessage);
        page.nextOffset=offset+page.items.length<rows.length?offset+page.items.length:null;
        if(oversized()){
          page.items.pop();
          if(!page.items.length)throw tooLarge();
          page.nextOffset=offset+page.items.length<rows.length?offset+page.items.length:null;
          break;
        }
      }
      if(oversized())throw tooLarge();
      current();
      return page;
    });
    checkScope();
    return result;
  }
  setSessionLink(context:ServerContext, request:SetManualPlanSessionLink):ManualPlanRecord {
    const r=object(request,[...mutationFields,'scope','sessionLink']),m=mutation(r),scope=scopeId(r.scope);
    if(scope!==this.store.manualPlanScope(context))throw scopeUnavailable();
    let target:ManualPlanSessionTarget|null=null;
    if(r.sessionLink!==null){const t=object(r.sessionLink,['workspaceId','sessionId','workspaceRevision','sessionRevision']);
      target={workspaceId:id(t.workspaceId),sessionId:id(t.sessionId),workspaceRevision:integer(t.workspaceRevision,1,Number.MAX_SAFE_INTEGER),sessionRevision:integer(t.sessionRevision,1,Number.MAX_SAFE_INTEGER)};}
    return this.write(context,'setSessionLink',m,{scope,sessionLink:target},(tx,row)=>{
      if(terminal(row.data.state))throw conflict();
      if(target){const workspace=tx.get('workspace',target.workspaceId),session=tx.get<{workspaceId:string}>('session',target.sessionId);
        if(workspace.revision!==target.workspaceRevision||session.revision!==target.sessionRevision||session.data.workspaceId!==workspace.id)throw conflict();}
      const sessionLink=target?{scope,...target}:null;
      if(JSON.stringify(row.data.sessionLink??null)===JSON.stringify(sessionLink))return row;
      return tx.update(KIND,row.id,row.revision,{...row.data,sessionLink}) as ManualPlanRecord;
    });
  }
  /** A caller-reviewed local shortcut only. Transcript resolution remains a separate,
   * store-bound read; this domain must not create, edit or assert a transcript target. */
  setMaterialLink(context: ServerContext, request: SetManualPlanMaterialLink): ManualPlanRecord {
    const r = object(request, [...mutationFields, 'scope', 'materialLink']);
    const m = mutation(r), scope = scopeId(r.scope), target = materialLink(r.materialLink);
    if (scope !== this.store.manualPlanScope(context)) throw scopeUnavailable();
    return this.write(context, 'setMaterialLink', m, { scope, materialLink: target }, (tx, row) => {
      if (terminal(row.data.state)) throw conflict();
      if (JSON.stringify(row.data.materialLink ?? null) === JSON.stringify(target)) return row;
      return tx.update(KIND, row.id, row.revision, boundedLinks({ ...row.data, materialLink: target })) as ManualPlanRecord;
    });
  }
  /** Shape and plan authority only. Never asserts document existence or cross-store ownership. */
  setDocumentLink(context: ServerContext, request: SetManualPlanDocumentLink): ManualPlanRecord {
    const r = object(request, [...mutationFields, 'scope', 'documentLink']);
    const m = mutation(r), scope = scopeId(r.scope), target = documentLink(r.documentLink);
    if (scope !== this.store.manualPlanScope(context)) throw scopeUnavailable();
    return this.write(context, 'setDocumentLink', m, { scope, documentLink: target }, (tx, row) => {
      if (terminal(row.data.state)) throw conflict();
      if (JSON.stringify(row.data.documentLink ?? null) === JSON.stringify(target)) return row;
      return tx.update(KIND, row.id, row.revision, boundedLinks({ ...row.data, documentLink: target })) as ManualPlanRecord;
    });
  }
  /** One reviewed batch, one CAS/receipt. Targets are not resolved or mutated here. */
  addMaterialLinks(context: ServerContext, request: AddManualPlanMaterialLinks): ManualPlanRecord {
    const r = object(request, [...mutationFields, 'scope', 'materialLinks']);
    const m = mutation(r), scope = scopeId(r.scope), targets = materialLinks(r.materialLinks);
    if (scope !== this.store.manualPlanScope(context)) throw scopeUnavailable();
    return this.write(context, 'addMaterialLinks', m, { scope, materialLinks: targets }, (tx, row) => {
      if (terminal(row.data.state)) throw conflict();
      const seen = new Set(effectiveManualPlanLinks(row.data).map(manualPlanSourceKey));
      const additions: ManualPlanSourceLink[] = [];
      for (const target of targets) {
        const key = manualPlanSourceKey(target);
        if (!seen.has(key)) { seen.add(key); additions.push(target); }
      }
      if (!additions.length) return row;
      const data = boundedLinks({ ...row.data, materialLinks: [...(row.data.materialLinks ?? []), ...additions] });
      return tx.update(KIND, row.id, row.revision, data) as ManualPlanRecord;
    });
  }
  /** Remove exactly one typed source identity from every representation, not its source. */
  removeMaterialLink(context: ServerContext, request: RemoveManualPlanMaterialLink): ManualPlanRecord {
    const r = object(request, [...mutationFields, 'scope', 'materialLink']);
    const m = mutation(r), scope = scopeId(r.scope), target = sourceLink(r.materialLink);
    if (scope !== this.store.manualPlanScope(context)) throw scopeUnavailable();
    return this.write(context, 'removeMaterialLink', m, { scope, materialLink: target }, (tx, row) => {
      if (terminal(row.data.state)) throw conflict();
      const key = manualPlanSourceKey(target), matches = (link: ManualPlanSourceLink) => manualPlanSourceKey(link) === key;
      if (!effectiveManualPlanLinks(row.data).some(matches)) return row;
      const data = { ...row.data };
      if (data.materialLink && matches(data.materialLink)) data.materialLink = null;
      if (data.documentLink && matches(data.documentLink)) data.documentLink = null;
      if (data.materialLinks) data.materialLinks = data.materialLinks.filter(link => !matches(link));
      return tx.update(KIND, row.id, row.revision, data) as ManualPlanRecord;
    });
  }
  create(context: ServerContext, request: CreateManualPlan): ManualPlanRecord {
    const r = object(request, ['idempotencyKey', ...fields]), key = id(r.idempotencyKey);
    const data: ManualPlanData = { schemaVersion: 1, provenance: 'user-authored-local',
      title: text(r.title, L.titleBytes, true).trim(), objective: text(r.objective, L.textBytes, true),
      notes: Object.hasOwn(r, 'notes') ? text(r.notes, L.textBytes) : '',
      targetDate: Object.hasOwn(r, 'targetDate') && r.targetDate !== null ? date(r.targetDate) : null, state: 'draft' };
    return this.store.write(context, key, boundedCommand({ operation: 'manual-plans.create', data }),
      tx => withinCapacity(tx, () => tx.create(KIND, data, randomUUID()) as ManualPlanRecord), budget);
  }
  update(context: ServerContext, request: UpdateManualPlan): ManualPlanRecord {
    const r = object(request, [...mutationFields, 'patch']), m = mutation(r), change = patch(r.patch);
    if (!Object.keys(change).length) throw invalid();
    return this.write(context, 'update', m, { patch: change }, (tx, row) => {
      if (terminal(row.data.state)) throw conflict();
      const data = { ...row.data, ...change };
      return JSON.stringify(data) === JSON.stringify(row.data) ? row : tx.update(KIND, row.id, row.revision, data) as ManualPlanRecord;
    });
  }
  setState(context: ServerContext, request: SetManualPlanState): ManualPlanRecord {
    const r = object(request, [...mutationFields, 'state']), m = mutation(r), state = choice(r.state, MANUAL_PLAN_STATES);
    return this.write(context, 'setState', m, { state }, (tx, row) => {
      if (row.data.state === state) return row;
      if (!transitions[row.data.state].includes(state)) throw conflict();
      return tx.update(KIND, row.id, row.revision, { ...row.data, state }) as ManualPlanRecord;
    });
  }
  reopen(context: ServerContext, request: ManualPlanMutation): ManualPlanRecord {
    const m = mutation(object(request, mutationFields));
    return this.write(context, 'reopen', m, {}, (tx, row) => {
      if (!terminal(row.data.state)) throw conflict();
      return tx.update(KIND, row.id, row.revision, { ...row.data, state: 'draft' }) as ManualPlanRecord;
    });
  }
  remove(context: ServerContext, request: ManualPlanMutation): ManualPlanRecord {
    const m = mutation(object(request, mutationFields));
    return this.write(context, 'remove', m, {}, (tx, row) => row.deletedAt ? row : tx.softDelete(KIND, row.id, row.revision) as ManualPlanRecord, true);
  }
  restore(context: ServerContext, request: ManualPlanMutation): ManualPlanRecord {
    const m = mutation(object(request, mutationFields));
    return this.write(context, 'restore', m, {}, (tx, row) => !row.deletedAt ? row : tx.restore(KIND, row.id, row.revision) as ManualPlanRecord, true);
  }
  private write(context: ServerContext, operation: string, m: ManualPlanMutation, args: { [key: string]: JsonValue },
    action: (tx: DomainTransaction, row: ManualPlanRecord) => ManualPlanRecord, includeDeleted = false): ManualPlanRecord {
    return this.store.write(context, m.idempotencyKey, boundedCommand({ operation: `manual-plans.${operation}`, id: m.id,
      expectedRevision: m.expectedRevision, ...args }), tx => {
      const row = record(tx, m.id, includeDeleted);
      if (row.revision !== m.expectedRevision) throw conflict();
      return withinCapacity(tx, () => action(tx, row));
    }, budget);
  }
}
