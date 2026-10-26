// RECOVERY: complete retained authored client snapshot through 13:52 UTC, reconstructed and UNVERIFIED.
import type { ResearchDocument } from '../../shared/contracts';
import { readerCanonical, readerDocumentIdentity, type ReaderSourcePin } from '../../shared/reader-reference';
import {
  SERVICE_ACTIVITY_KINDS,
  SERVICE_ACTIVITY_STATUSES,
  SERVICE_REPORT_LIMITS as L,
  type ArchiveServiceActivity,
  type ArchiveServiceReport,
  type CorrectServiceActivity,
  type CreateServiceActivity,
  type CreateServiceReport,
  type ServiceActivity,
  type ServiceActivityInput,
  type ServiceActivityPage,
  type ServiceCustomer,
  type ServiceCustomerPin,
  type ServiceMonth,
  type ServiceReport,
  type ServiceReportCard,
  type ServiceReportFormat,
  type ServiceReportPage,
  type ServiceReportSnapshot,
  type ServiceReportState,
} from '../../shared/service-reports';

/** Browser actor binding is supplied by the host, never a constructed server Principal. */
export type ServiceReportsActor = Readonly<{ binding: string; epoch: number }>;
export type ServiceReportsAuthority = Readonly<{ actor: ServiceReportsActor; scope: string }>;
export type ServiceReportsErrorCode =
  | 'INVALID_REQUEST' | 'INVALID_RESPONSE' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT'
  | 'RATE_LIMITED' | 'PROVIDER_ERROR' | 'CANCELLED' | 'STORAGE' | 'PENDING';
const messages: Record<ServiceReportsErrorCode, string> = {
  INVALID_REQUEST: '服务月报请求无效，未发送',
  INVALID_RESPONSE: '服务月报响应无法验证，已撤回结果',
  FORBIDDEN: '当前身份或访问范围已改变，请重新读取',
  NOT_FOUND: '服务活动或月报当前不可用',
  CONFLICT: '服务活动、月报或分页已改变，请重新读取',
  RATE_LIMITED: '服务月报超过本次操作限制',
  PROVIDER_ERROR: '服务月报请求未能确认，请保留原操作并检查结果',
  CANCELLED: '本次读取已撤回；未确认的操作仍保留',
  STORAGE: '恢复记录无法可靠保存或读取，未确认记录没有删除',
  PENDING: '请先检查、重试或取消未提交的原操作，不能创建另一条未确认操作',
};
export class ServiceReportsClientError extends Error {
  constructor(public readonly code: ServiceReportsErrorCode) {
    super(messages[code]);
    this.name = 'ServiceReportsClientError';
  }
}
const fail = (code: ServiceReportsErrorCode = 'INVALID_REQUEST'): never => { throw new ServiceReportsClientError(code); };
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const same = (a: unknown, b: unknown) => readerCanonical(a) === readerCanonical(b);
const has = (value: object, key: string) => Object.hasOwn(value, key);

function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (required.some((key) => !has(descriptors, key)) || keys.some((key) => typeof key !== 'string' || (!required.includes(key) && !optional.includes(key)))) return fail();
  for (const descriptor of Object.values(descriptors)) {
    if (!('value' in descriptor) || !descriptor.enumerable || descriptor.value === undefined) fail();
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string') return fail();
  if ((!empty && !value.trim()) || value.length > maximum || byteLength(value) > maximum * 4 || Array.from(value).some((character) => (character.charCodeAt(0) < 32 && ![9, 10, 13].includes(character.charCodeAt(0))) || character.charCodeAt(0) === 127) || /[\u202a-\u202e\u2066-\u2069]/u.test(value) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) return fail();
  return value;
}
function id(value: unknown): string {
  const result = text(value, 100);
  if (!/^[A-Za-z0-9_-]+$/u.test(result)) return fail();
  return result;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) return fail();
  return value;
}
function integer(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER - 1): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) return fail();
  return value as number;
}
function flag(value: unknown): boolean { if (typeof value !== 'boolean') return fail(); return value; }
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) return fail();
  return value as T;
}
function list(value: unknown, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length > maximum || value.length < minimum || Object.getPrototypeOf(value) !== Array.prototype) return fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) return fail();
  for (let index = 0; index < value.length; index++) {
    const d = Object.getOwnPropertyDescriptor(value, String(index));
    if (!d || !('value' in d) || !d.enumerable || d.value === undefined) return fail();
  }
  return value;
}
function timestamp(value: unknown): string {
  const result = text(value, 24);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) return fail();
  return result;
}
function month(value: unknown): string {
  const result = text(value, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(result) || Number(result.slice(0, 4)) < 1970 || Number(result.slice(0, 4)) > 9998) return fail();
  return result;
}
function timeZone(value: unknown): string {
  const result = text(value, 100);
  if (!(result === 'UTC' || /^[A-Za-z_+-]+\/[A-Za-z0-9_+/-]+$/u.test(result))) return fail();
  try { new Intl.DateTimeFormat('en', { timeZone: result }); } catch { return fail(); }
  return result; // Preserve the original DTO. The server canonicalizes timezone aliases.
}
function canonicalZone(value: string): string { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
function inMonth(instant: string, period: ServiceMonth): boolean {
  const parts = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', { timeZone: period.timeZone, year: 'numeric', month: '2-digit' }).formatToParts(new Date(instant));
  return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}` === period.month;
}
function customer(value: unknown): ServiceCustomer {
  const v = object(value, ['organizationId', 'contactId']);
  return { organizationId: id(v.organizationId), contactId: v.contactId === null ? null : id(v.contactId) };
}
function customerPin(value: unknown): ServiceCustomerPin {
  const v = object(value, ['organizationId', 'contactId', 'organizationRevision', 'contactRevision']);
  const ref = customer({ organizationId: v.organizationId, contactId: v.contactId });
  if ((ref.contactId === null) !== (v.contactRevision === null)) return fail();
  return { ...ref, organizationRevision: integer(v.organizationRevision), contactRevision: v.contactRevision === null ? null : integer(v.contactRevision) };
}
function customerMatches(selected: ServiceCustomer, row: ServiceCustomer): boolean {
  return selected.organizationId === row.organizationId && (selected.contactId === null || selected.contactId === row.contactId);
}
export function requireServiceSourcePin(value: unknown): ReaderSourcePin {
  const v = object(value, ['documentId', 'revisionId', 'tenantId', 'collectionId', 'sha256']);
  return { documentId: text(v.documentId, 500), revisionId: text(v.revisionId, 500), tenantId: text(v.tenantId, 100), collectionId: text(v.collectionId, 500), sha256: digest(v.sha256) };
}
export function requireServiceActivityInput(value: unknown): ServiceActivityInput {
  const v = object(value, ['customer', 'kind', 'status', 'occurredAt', 'summary', 'references'], ['ordinarySource']);
  const references = list(v.references, L.sourcesPerActivity, 1).map((r) => ({ pin: requireServiceSourcePin(object(r, ['pin']).pin) }));
  if (new Set(references.map((r) => readerCanonical([r.pin.documentId, r.pin.revisionId]))).size !== references.length) return fail();
  let ordinarySource: ServiceActivityInput['ordinarySource'];
  if (v.ordinarySource !== undefined) {
    const source = object(v.ordinarySource, ['id', 'revision', 'sha256', 'recordJson']);
    ordinarySource = {id:id(source.id),revision:integer(source.revision),sha256:digest(source.sha256),recordJson:text(source.recordJson,16000)};
    let record; try {record=JSON.parse(ordinarySource.recordJson);} catch {return fail();}
    if (record.id!==ordinarySource.id || record.revision!==ordinarySource.revision || record.kind!=='service-record') return fail();
  }
  return { ...(ordinarySource ? {ordinarySource} : {}), customer: customer(v.customer), kind: choice(v.kind, SERVICE_ACTIVITY_KINDS), status: choice(v.status, SERVICE_ACTIVITY_STATUSES), occurredAt: timestamp(v.occurredAt), summary: text(v.summary, 1000), references };
}
function activity(value: unknown): ServiceActivity {
  const v = object(value, ['id', 'revision', 'versionId', 'archivedAt', 'version']);
  const a = object(v.version, ['schema', 'activityId', 'sequence', 'recordedAt', 'recordedBySubject', 'customerAtRecord', 'value', 'provenance', 'correction']);
  const rowId = id(v.id), valueInput = requireServiceActivityInput(a.value), atRecord = customerPin(a.customerAtRecord);
  const correction = a.correction === null ? null : object(a.correction, ['previousVersionId', 'reason']);
  const sequence = integer(a.sequence);
  if (a.schema !== 1 || a.activityId !== rowId || a.provenance !== 'user-recorded-local' || !same(valueInput.customer, { organizationId: atRecord.organizationId, contactId: atRecord.contactId }) || (sequence === 1) !== (correction === null)) return fail();
  return {
    id: rowId, revision: integer(v.revision), versionId: id(v.versionId), archivedAt: v.archivedAt === null ? null : timestamp(v.archivedAt),
    version: { schema: 1, activityId: rowId, sequence, recordedAt: timestamp(a.recordedAt), recordedBySubject: text(a.recordedBySubject, 100), customerAtRecord: atRecord, value: valueInput, provenance: 'user-recorded-local', correction: correction ? { previousVersionId: id(correction.previousVersionId), reason: text(correction.reason, 500) } : null },
  };
}
function period(value: unknown): ServiceMonth {
  const v = object(value, ['month', 'timeZone', 'membership', 'utcMarkers', 'tzdbVersion']);
  const markers = object(v.utcMarkers, ['firstInstantOfMonth', 'firstInstantOfFollowingMonth']);
  const first = timestamp(markers.firstInstantOfMonth), following = timestamp(markers.firstInstantOfFollowingMonth);
  if (v.membership !== 'local-calendar-year-month' || Date.parse(following) <= Date.parse(first) || Date.parse(following) - Date.parse(first) > 33 * 86_400_000) return fail();
  return { month: month(v.month), timeZone: timeZone(v.timeZone), membership: 'local-calendar-year-month', utcMarkers: { firstInstantOfMonth: first, firstInstantOfFollowingMonth: following }, tzdbVersion: text(v.tzdbVersion, 100) };
}
function reportState(value: unknown): ServiceReportState {
  const v = object(value, ['schema', 'archivedAt', 'supersededByReportId']);
  if (v.schema !== 1) return fail();
  return { schema: 1, archivedAt: v.archivedAt === null ? null : timestamp(v.archivedAt), supersededByReportId: v.supersededByReportId === null ? null : id(v.supersededByReportId) };
}
async function sha256(value: unknown): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(readerCanonical(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function report(value: unknown): Promise<ServiceReport> {
  const v = object(value, ['id', 'revision', 'state', 'snapshot', 'snapshotSha256', 'currentActivitiesChanged', 'authorization']);
  const s = object(v.snapshot, ['schema', 'provenance', 'evidenceClass', 'generatedAt', 'generatedBySubject', 'customer', 'customerAtGeneration', 'period', 'activities', 'totals', 'basisSha256', 'supersedesReportId']);
  const ref = customer(s.customer), pin = customerPin(s.customerAtGeneration), p = period(s.period), activities = list(s.activities, L.activitiesPerReport).map(activity);
  if (s.schema !== 1 || s.provenance !== 'derived-user-recorded-service-summary' || s.evidenceClass !== 'derived-artifact' || !same(ref, { organizationId: pin.organizationId, contactId: pin.contactId }) || new Set(activities.map((a) => a.id)).size !== activities.length || activities.some((a) => a.archivedAt !== null || !customerMatches(ref, a.version.value.customer) || !inMonth(a.version.value.occurredAt, p))) return fail();
  const t = object(s.totals, ['metric', 'totalRecords', 'byKind', 'byStatus', 'clientReadingVerified', 'clientAttendanceVerified', 'externalDeliveryVerified']);
  const byKind = object(t.byKind, SERVICE_ACTIVITY_KINDS), byStatus = object(t.byStatus, SERVICE_ACTIVITY_STATUSES);
  if (t.metric !== 'owner-recorded-activities' || t.totalRecords !== activities.length || t.clientReadingVerified !== false || t.clientAttendanceVerified !== false || t.externalDeliveryVerified !== false) return fail();
  for (const kind of SERVICE_ACTIVITY_KINDS) if (integer(byKind[kind], 0, L.activitiesPerReport) !== activities.filter((a) => a.version.value.kind === kind).length) fail();
  for (const status of SERVICE_ACTIVITY_STATUSES) if (integer(byStatus[status], 0, L.activitiesPerReport) !== activities.filter((a) => a.version.value.status === status).length) fail();
  const snapshot: ServiceReportSnapshot = { schema: 1, provenance: 'derived-user-recorded-service-summary', evidenceClass: 'derived-artifact', generatedAt: timestamp(s.generatedAt), generatedBySubject: text(s.generatedBySubject, 100), customer: ref, customerAtGeneration: pin, period: p, activities, totals: { metric: 'owner-recorded-activities', totalRecords: activities.length, byKind: byKind as ServiceReportSnapshot['totals']['byKind'], byStatus: byStatus as ServiceReportSnapshot['totals']['byStatus'], clientReadingVerified: false, clientAttendanceVerified: false, externalDeliveryVerified: false }, basisSha256: digest(s.basisSha256), supersedesReportId: s.supersedesReportId === null ? null : id(s.supersedesReportId) };
  const authorization = object(v.authorization, ['mode', 'checkedAt']);
  if (authorization.mode !== 'current-local' || byteLength(JSON.stringify(snapshot)) > L.recordBytes || await sha256(activities.map((a) => [a.id, a.revision, a.versionId])) !== snapshot.basisSha256 || await sha256(snapshot) !== digest(v.snapshotSha256)) return fail();
  return { id: id(v.id), revision: integer(v.revision), state: reportState(v.state), snapshot, snapshotSha256: digest(v.snapshotSha256), currentActivitiesChanged: flag(v.currentActivitiesChanged), authorization: { mode: 'current-local', checkedAt: timestamp(authorization.checkedAt) } };
}

export type ServiceReportsPageInput = { after: string | null; censusSha256?: string };
export type ServiceActivitiesInput = ServiceReportsPageInput & { customer: ServiceCustomer; month: string; timeZone: string; includeArchived?: boolean };
export type ServiceReportListInput = ServiceReportsPageInput & { includeArchived?: boolean };
export type ServiceCustomerIdentity = { pin: ServiceCustomerPin; organizationName: string; contactName: string | null };
export type ServiceCustomersPage = { scope: string; items: ServiceCustomerIdentity[]; nextAfter: string | null; censusSha256: string };
export type ServiceSourceOpenInput = { pin: ReaderSourcePin; referenceIndex: number; activityId: string; expectedRevision: number; versionId: string } & ({ from: 'activity' } | { from: 'report'; reportId: string });
export type ServiceReportExportInput = { reportId: string; expectedRevision: number; format: ServiceReportFormat };
export type ServiceReportExport = { scope: string; reportId: string; revision: number; format: ServiceReportFormat; filename: string; mediaType: string; bytes: Uint8Array };
export type ServiceReportsCommand =
  | { action: 'createActivity'; input: CreateServiceActivity }
  | { action: 'correctActivity'; input: CorrectServiceActivity }
  | { action: 'archiveActivity'; input: ArchiveServiceActivity }
  | { action: 'createReport'; input: CreateServiceReport }
  | { action: 'archiveReport'; input: ArchiveServiceReport };
export type ServiceReportsReceipt = { target: 'activity' | 'report'; id: string };
export type ServiceReportsRecovery =
  | { scope: string; outcome: 'absent'; receipt: null }
  | { scope: string; outcome: 'committed'; receipt: ServiceReportsReceipt }
  | { scope: string; outcome: 'cancelled'; receipt: null; cancellation: { idempotencyKey: string; fingerprint: string } };
export type ServiceReportsCancellationResult = Exclude<ServiceReportsRecovery, { outcome: 'absent' }>;
export type ServiceReportsMutationResult =
  | { scope: string; activity: ServiceActivity }
  | { scope: string; report: ServiceReport }
  | { scope: string; id: string; revision: number; archivedAt: string | null }
  | { scope: string; id: string; revision: number; state: ServiceReportState };
type Route = 'previewServiceRecord' | 'importServiceRecord' | 'sourceChoices' | 'scope' | 'customers' | 'listActivities' | 'getActivity' | 'listReports' | 'getReport' | ServiceReportsCommand['action'] | 'recoverCommand' | 'cancelCommand' | 'inspectSource' | 'openActivitySource' | 'openReportSource' | 'exportReport';

export type ServiceSourceChoicesInput = { offset?: number; limit?: number; storeScope?: string | null };
export type ServiceSourceChoicesPage = {
  scope: string;
  capabilities: { localDocuments: boolean; syntheticFixture: true };
  storeScope: string | null;
  items: readonly { documentId: string; revisionId: string; name: string; format: 'txt' | 'md' | 'pdf'; metadataRevision: number }[];
  nextOffset: number | null;
};
const sourceUuid = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/u.test(value)) return fail();
  return value;
};
function localSourceIdentity(documentId: unknown, revisionId: unknown) {
  const document = text(documentId, 500), revision = text(revisionId, 500);
  const parts = document.split(':');
  if (parts.length !== 3 || parts[0] !== 'local-doc' || !/^content:[a-f0-9]{64}:[a-f0-9]{64}(?![\s\S])/u.test(revision)) return fail();
  return { documentId: document, revisionId: revision, storeScope: sourceUuid(parts[1]), rawDocumentId: sourceUuid(parts[2]) };
}
function sourceChoicesInput(value: unknown): Required<ServiceSourceChoicesInput> {
  const v = object(value, [], ['offset', 'limit', 'storeScope']);
  const offset = has(v, 'offset') ? integer(v.offset, 0) : 0;
  const limit = has(v, 'limit') ? integer(v.limit, 1, 25) : 10;
  const storeScope = v.storeScope === undefined || v.storeScope === null ? null : sourceUuid(v.storeScope);
  if (offset > 0 && storeScope === null) return fail();
  return { offset, limit, storeScope };
}
function sourceChoicesPage(value: unknown, request: Required<ServiceSourceChoicesInput>): ServiceSourceChoicesPage {
  const v = object(value, ['scope', 'capabilities', 'storeScope', 'items', 'nextOffset']);
  const capability = object(v.capabilities, ['localDocuments', 'syntheticFixture']);
  const localDocuments = flag(capability.localDocuments);
  if (capability.syntheticFixture !== true) return fail();
  const storeScope = v.storeScope === null ? null : sourceUuid(v.storeScope);
  if (localDocuments !== (storeScope !== null) || (request.storeScope !== null && request.storeScope !== storeScope)) return fail();
  if (!Array.isArray(v.items) || v.items.length > request.limit || (!localDocuments && v.items.length)) return fail();
  const ids = new Set<string>();
  const items = v.items.map((row: unknown) => {
    const item = object(row, ['documentId', 'revisionId', 'name', 'format', 'metadataRevision']);
    const identity = localSourceIdentity(item.documentId, item.revisionId);
    if (identity.storeScope !== storeScope || ids.has(identity.documentId)) return fail();
    ids.add(identity.documentId);
    return { documentId: identity.documentId, revisionId: identity.revisionId, name: text(item.name, 1000), format: choice(item.format, ['txt', 'md', 'pdf'] as const), metadataRevision: integer(item.metadataRevision, 0) };
  });
  const nextOffset = v.nextOffset === null ? null : integer(v.nextOffset, 1);
  if (nextOffset !== null && (!localDocuments || items.length !== request.limit || nextOffset !== request.offset + items.length)) return fail();
  return { scope: digest(v.scope), capabilities: { localDocuments, syntheticFixture: true }, storeScope, items, nextOffset };
}

export type ServiceSourceObservation = { storeScope: string; documentId: string; metadataRevision: number };
export type ServiceSourceSelection = { scope: string; pin: ReaderSourcePin } & (
  | { sourceKind: 'synthetic' }
  | { sourceKind: 'local-document'; locator: ServiceSourceObservation }
);
export type ServiceProjectionAuthority = { documentStoreScope: string | null; capabilities: { localDocuments: boolean; syntheticFixture: true }; policyVersion: 1 };
export type ServiceProjectionPreview = {
  schema: 2; scope: string; authority: ServiceProjectionAuthority;
  source: NonNullable<ServiceActivityInput['ordinarySource']>; customerPin: ServiceCustomerPin;
  projection: Pick<ServiceActivityInput, 'customer' | 'kind' | 'occurredAt' | 'summary'>;
  existing: null | { id: string; revision: number; sourceRevision: number; archivedAt: string | null };
  token: string; missingInputs: readonly ['status', 'sourcePin']; syntheticSourcePin: ReaderSourcePin; warning: string;
};
export type ServiceProjectionImport = {
  schema: 2; scope: string; sourceId: string; token: string; authority: ServiceProjectionAuthority;
  expectedProjection: null | { id: string; revision: number }; status: ServiceActivityInput['status'];
  sourcePin: ReaderSourcePin; sourceObservation: ServiceSourceObservation | null; reason: string;
};
export type ServiceProjectionResult = { schema: 2; scope: string; activity: ServiceActivity; unchanged: boolean };
function projectionId(value:unknown):string {if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,100}(?![\s\S])/u.test(value))return fail();return value;}
function projectionAuthority(raw: unknown): ServiceProjectionAuthority {
  const v=object(raw,['documentStoreScope','capabilities','policyVersion']), c=object(v.capabilities,['localDocuments','syntheticFixture']);
  const store=v.documentStoreScope===null?null:sourceUuid(v.documentStoreScope), local=flag(c.localDocuments);
  if(v.policyVersion!==1 || c.syntheticFixture!==true || local!==(store!==null))return fail();
  return {documentStoreScope:store,capabilities:{localDocuments:local,syntheticFixture:true},policyVersion:1};
}
function sourceObservation(raw: unknown, pin: ReaderSourcePin): ServiceSourceObservation {
  const v=object(raw,['storeScope','documentId','metadataRevision']), identity=localSourceIdentity(pin.documentId,pin.revisionId);
  const result={storeScope:sourceUuid(v.storeScope),documentId:sourceUuid(v.documentId),metadataRevision:integer(v.metadataRevision,0)};
  if(result.storeScope!==identity.storeScope || result.documentId!==identity.rawDocumentId)return fail();
  return result;
}
export function requireServiceProjectionImport(raw: unknown): ServiceProjectionImport {
  const v=object(raw,['schema','scope','sourceId','token','authority','expectedProjection','status','sourcePin','sourceObservation','reason']);
  if(v.schema!==2)return fail();
  const a=projectionAuthority(v.authority), pin=requireServiceSourcePin(v.sourcePin), local=pin.documentId.startsWith('local-doc:');
  const observation=local?sourceObservation(v.sourceObservation,pin):null;
  if(local?(!a.capabilities.localDocuments||observation!.storeScope!==a.documentStoreScope):(v.sourceObservation!==null||pin.documentId!=='synthetic-doc'||pin.revisionId!=='v1'))return fail();
  const head=v.expectedProjection===null?null:object(v.expectedProjection,['id','revision']);
  return {schema:2,scope:digest(v.scope),sourceId:projectionId(v.sourceId),token:digest(v.token),authority:a,expectedProjection:head?{id:projectionId(head.id),revision:integer(head.revision)}:null,status:choice(v.status,SERVICE_ACTIVITY_STATUSES),sourcePin:pin,sourceObservation:observation,reason:text(v.reason,500,true)};
}
async function projectionPreview(raw: unknown, request: Record<string,unknown>): Promise<ServiceProjectionPreview> {
  const v=object(raw,['schema','scope','authority','source','customerPin','projection','existing','token','missingInputs','syntheticSourcePin','warning']);
  if(v.schema!==2 || v.scope!==request.scope)return fail();
  const a=projectionAuthority(v.authority), src=object(v.source,['id','revision','sha256','recordJson']);
  const source={id:projectionId(src.id),revision:integer(src.revision),sha256:digest(src.sha256),recordJson:text(src.recordJson,16000)};
  const record=parseServiceReportsJson(source.recordJson,64000) as Record<string,unknown>;
  if(source.id!==request.sourceId || record.id!==source.id || record.revision!==source.revision || record.kind!=='service-record' || await sha256(record)!==source.sha256)return fail();
  const c=customerPin(v.customerPin), proj=object(v.projection,['customer','kind','occurredAt','summary']);
  const projection={customer:customer(proj.customer),kind:choice(proj.kind,SERVICE_ACTIVITY_KINDS),occurredAt:timestamp(proj.occurredAt),summary:text(proj.summary,1000)};
  const data=record.data;
  if(!data||typeof data!=='object'||Array.isArray(data))return fail();
  const d=data as Record<string,unknown>;
  if(!same(projection.customer,{organizationId:c.organizationId,contactId:c.contactId})||projection.customer.organizationId!==d.organizationId||projection.customer.contactId!==d.contactId||projection.kind!==d.activity||projection.occurredAt!==d.occurredAt||projection.summary!==d.summary)return fail();
  const existing=v.existing===null?null:object(v.existing,['id','revision','sourceRevision','archivedAt']);
  const pin=requireServiceSourcePin(v.syntheticSourcePin);
  if(pin.documentId!=='synthetic-doc'||pin.revisionId!=='v1'||!same(v.missingInputs,['status','sourcePin']))return fail();
  return {schema:2,scope:digest(v.scope),authority:a,source,customerPin:c,projection,existing:existing?{id:projectionId(existing.id),revision:integer(existing.revision),sourceRevision:integer(existing.sourceRevision),archivedAt:existing.archivedAt===null?null:timestamp(existing.archivedAt)}:null,token:digest(v.token),missingInputs:['status','sourcePin'],syntheticSourcePin:pin,warning:text(v.warning,2000)};
}

function pageInput(v: Record<string, unknown>, customerCursor = false): ServiceReportsPageInput {
  const after = v.after === null ? null : customerCursor ? text(v.after, 2048) : id(v.after);
  if (after !== null && !has(v, 'censusSha256')) return fail();
  return { after, ...(has(v, 'censusSha256') ? { censusSha256: digest(v.censusSha256) } : {}) };
}
/** Full original command, not a presentation draft or a revised/normalized replacement. */
export function requireServiceReportsCommand(value: unknown): ServiceReportsCommand {
  const v = object(value, ['action', 'input']);
  const action = choice(v.action, ['createActivity', 'correctActivity', 'archiveActivity', 'createReport', 'archiveReport'] as const);
  const fields = action === 'createActivity' ? ['activity'] : action === 'correctActivity' ? ['id', 'expectedRevision', 'activity', 'reason'] : action === 'createReport' ? ['customer', 'month', 'timeZone', 'supersedes'] : ['id', 'expectedRevision', 'archived'];
  const raw = object(v.input, ['scope', 'idempotencyKey', ...fields]);
  const base = { scope: digest(raw.scope), idempotencyKey: id(raw.idempotencyKey) };
  let result: ServiceReportsCommand;
  if (action === 'createActivity') result = { action, input: { ...base, activity: requireServiceActivityInput(raw.activity) } };
  else if (action === 'correctActivity') result = { action, input: { ...base, id: id(raw.id), expectedRevision: integer(raw.expectedRevision), activity: requireServiceActivityInput(raw.activity), reason: text(raw.reason, 500) } };
  else if (action === 'createReport') {
    const prior = raw.supersedes === null ? null : object(raw.supersedes, ['id', 'expectedRevision']);
    result = { action, input: { ...base, customer: customer(raw.customer), month: month(raw.month), timeZone: timeZone(raw.timeZone), supersedes: prior ? { id: id(prior.id), expectedRevision: integer(prior.expectedRevision) } : null } };
  } else result = { action, input: { ...base, id: id(raw.id), expectedRevision: integer(raw.expectedRevision), archived: flag(raw.archived) } };
  // Reserve the recovery envelope now; every accepted command must remain checkable through the same HTTP bound.
  if (byteLength(JSON.stringify({ command: result })) > L.requestBytes) return fail();
  return deepFreeze(result);
}
/** Match the server's domain receipt fingerprint without changing the retained original DTO. */
export async function serviceReportsCommandFingerprint(value: unknown): Promise<string> {
  const command = requireServiceReportsCommand(value);
  const normalizedActivity = (activity: ServiceActivityInput) => ({ ...activity, references: [...activity.references].sort((a, b) => {
    const left = readerCanonical(a), right = readerCanonical(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }) });
  let action: string, normalized: unknown;
  switch (command.action) {
    case 'createActivity':
      action = 'create-activity'; normalized = normalizedActivity(command.input.activity); break;
    case 'correctActivity':
      action = 'correct-activity'; normalized = { key: command.input.id, expectedRevision: command.input.expectedRevision, input: normalizedActivity(command.input.activity), reason: command.input.reason }; break;
    case 'archiveActivity':
    case 'archiveReport':
      action = command.action === 'archiveActivity' ? 'archive-activity' : 'archive-report'; normalized = { key: command.input.id, expectedRevision: command.input.expectedRevision, archived: command.input.archived }; break;
    case 'createReport':
      action = 'create-report'; normalized = { ref: command.input.customer, month: command.input.month, timeZone: canonicalZone(command.input.timeZone), supersedes: command.input.supersedes }; break;
    default: return fail();
  }
  return sha256([action, command.input.scope, normalized]);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
function input(route: Route, value: unknown): unknown {
  if (route === 'previewServiceRecord') { const v=object(value,['schema','scope','sourceId']); if(v.schema!==2)return fail(); return {schema:2,scope:digest(v.scope),sourceId:projectionId(v.sourceId)}; }
  if (route === 'importServiceRecord') return requireServiceProjectionImport(value);
  if (route === 'sourceChoices') return sourceChoicesInput(value);
  if (route === 'scope') { object(value, []); return {}; }
  if (route === 'customers') return pageInput(object(value, ['after'], ['censusSha256']), true);
  if (route === 'listActivities') {
    const v = object(value, ['customer', 'month', 'timeZone', 'after'], ['includeArchived', 'censusSha256']);
    return { customer: customer(v.customer), month: month(v.month), timeZone: timeZone(v.timeZone), ...pageInput(v), ...(has(v, 'includeArchived') ? { includeArchived: flag(v.includeArchived) } : {}) };
  }
  if (route === 'listReports') {
    const v = object(value, ['after'], ['includeArchived', 'censusSha256']);
    return { ...pageInput(v), ...(has(v, 'includeArchived') ? { includeArchived: flag(v.includeArchived) } : {}) };
  }
  if (route === 'getActivity' || route === 'getReport') return { id: id(object(value, ['id']).id) };
  if (route === 'inspectSource') { const v = object(value, ['documentId', 'revisionId']); return { documentId: text(v.documentId, 500), revisionId: text(v.revisionId, 500) }; }
  if (route === 'recoverCommand' || route === 'cancelCommand') return { command: requireServiceReportsCommand(object(value, ['command']).command) };
  if (route === 'openActivitySource' || route === 'openReportSource') {
    const v = object(value, ['from', 'pin', 'referenceIndex', 'activityId', 'expectedRevision', 'versionId', ...(route === 'openReportSource' ? ['reportId'] : [])]);
    if (v.from !== (route === 'openActivitySource' ? 'activity' : 'report')) return fail();
    return { from: v.from, pin: requireServiceSourcePin(v.pin), referenceIndex: integer(v.referenceIndex, 0, L.sourcesPerActivity - 1), activityId: id(v.activityId), expectedRevision: integer(v.expectedRevision), versionId: id(v.versionId), ...(route === 'openReportSource' ? { reportId: id(v.reportId) } : {}) };
  }
  if (route === 'exportReport') { const v = object(value, ['reportId', 'expectedRevision', 'format']); return { reportId: id(v.reportId), expectedRevision: integer(v.expectedRevision), format: choice(v.format, ['json', 'csv', 'html'] as const) }; }
  return requireServiceReportsCommand({ action: route, input: value }).input;
}

function document(value: unknown): ResearchDocument {
  const v = object(value, ['id', 'revisionId', 'tenantId', 'collectionId', 'title', 'source', 'author', 'date', 'tags', 'excerpt', 'body', 'pages', 'mock'], ['originalFile', 'sourceLocations', 'media']);
  const result: ResearchDocument = { id: text(v.id, 500), revisionId: text(v.revisionId, 500), tenantId: text(v.tenantId, 100), collectionId: text(v.collectionId, 500), title: text(v.title, 1000, true), source: choice(v.source, ['public', 'research', 'roadshow'] as const), author: text(v.author, 4000, true), date: text(v.date, 100, true), tags: list(v.tags, 1000).map((tag) => text(tag, 1000, true)), excerpt: text(v.excerpt, L.sourceBytes, true), body: text(v.body, L.sourceBytes, true), pages: integer(v.pages, 0), mock: flag(v.mock) };
  if (has(v, 'originalFile')) {
    const f = object(v.originalFile, ['id', 'name', 'sha256', 'mediaType'], ['revisionId']);
    result.originalFile = { id: text(f.id, 500), name: text(f.name, 1000), sha256: digest(f.sha256), mediaType: text(f.mediaType, 200), ...(has(f, 'revisionId') ? { revisionId: text(f.revisionId, 500) } : {}) };
  }
  if (has(v, 'sourceLocations')) result.sourceLocations = list(v.sourceLocations, 10000).map((value) => {
    const location = object(value, ['kind', 'start', 'end', 'text']), start = integer(location.start, 0), end = integer(location.end, start);
    return { kind: choice(location.kind, ['lines', 'page'] as const), start, end, text: text(location.text, L.sourceBytes, true) };
  });
  if (has(v, 'media')) {
    const m = object(v.media, ['audioId', 'sha256', 'durationMs', 'timestampKind', 'segments']);
    if (m.timestampKind !== 'model-estimated-segment' || typeof m.durationMs !== 'number' || !Number.isFinite(m.durationMs) || m.durationMs <= 0) return fail();
    const durationMs = m.durationMs;
    const segments = list(m.segments, 10000).map((value) => {
      const s = object(value, ['id', 'startMs', 'endMs', 'text']);
      if (typeof s.startMs !== 'number' || typeof s.endMs !== 'number' || !Number.isFinite(s.startMs) || !Number.isFinite(s.endMs) || s.startMs < 0 || s.endMs <= s.startMs || s.endMs > durationMs) return fail();
      return { id: text(s.id, 200), startMs: s.startMs, endMs: s.endMs, text: text(s.text, L.sourceBytes, true) };
    });
    if (new Set(segments.map((s) => s.id)).size !== segments.length) return fail();
    result.media = { audioId: text(m.audioId, 500), sha256: digest(m.sha256), durationMs, timestampKind: 'model-estimated-segment', segments };
  }
  if (byteLength(JSON.stringify(readerDocumentIdentity(result))) > L.sourceBytes) return fail();
  return result;
}
function card(value: unknown): ServiceReportCard {
  const v = object(value, ['id', 'revision', 'customer', 'period', 'generatedAt', 'state']);
  return { id: id(v.id), revision: integer(v.revision), customer: customer(v.customer), period: period(v.period), generatedAt: timestamp(v.generatedAt), state: reportState(v.state) };
}
function cursor(v: Record<string, unknown>, items: readonly { id: string }[]): { nextAfter: string | null; censusSha256: string } {
  const nextAfter = v.nextAfter === null ? null : id(v.nextAfter);
  if (new Set(items.map((a) => a.id)).size !== items.length || (nextAfter !== null && nextAfter !== items.at(-1)?.id) || items.reduce((bytes, item) => bytes + byteLength(JSON.stringify(item)), 0) > L.pageBytes) return fail();
  return { nextAfter, censusSha256: digest(v.censusSha256) };
}
function receipt(value: unknown, command: ServiceReportsCommand): ServiceReportsReceipt {
  const v = object(value, ['target', 'id']), target = command.action === 'createReport' || command.action === 'archiveReport' ? 'report' : 'activity';
  const targetId = id(v.id);
  if (v.target !== target || ('id' in command.input && command.input.id !== targetId)) return fail();
  return { target, id: targetId };
}
async function output(route: Route, raw: unknown, request: unknown): Promise<unknown> {
  if (route === 'sourceChoices') return sourceChoicesPage(raw, request as Required<ServiceSourceChoicesInput>);
  const q = request as Record<string, unknown>;
  if (route === 'previewServiceRecord') return projectionPreview(raw,q);
  if (route === 'importServiceRecord') {
    const v=object(raw,['schema','scope','activity','unchanged']), command=request as ServiceProjectionImport, a=activity(v.activity);
    if(v.schema!==2||v.scope!==command.scope||(command.expectedProjection!==null&&a.id!==command.expectedProjection.id)||a.archivedAt!==null||a.version.value.ordinarySource?.id!==command.sourceId||a.version.value.status!==command.status||!same(a.version.value.references,[{pin:command.sourcePin}]))return fail();
    return {schema:2,scope:digest(v.scope),activity:a,unchanged:flag(v.unchanged)};
  }
  if (route === 'scope') return { scope: digest(object(raw, ['scope']).scope) };
  if (route === 'customers') {
    const v = object(raw, ['scope', 'items', 'nextAfter', 'censusSha256']);
    const items = list(v.items, L.pageRows).map((value) => {
      const c = object(value, ['pin', 'organizationName', 'contactName']), pin = customerPin(c.pin);
      if ((pin.contactId === null) !== (c.contactName === null)) return fail();
      return { pin, organizationName: text(c.organizationName, 1000), contactName: c.contactName === null ? null : text(c.contactName, 1000) };
    });
    const nextAfter = v.nextAfter === null ? null : text(v.nextAfter, 2048);
    if (new Set(items.map((item) => readerCanonical([item.pin.organizationId, item.pin.contactId]))).size !== items.length || (nextAfter !== null && !items.length) || byteLength(JSON.stringify(items)) > L.pageBytes || (q.censusSha256 !== undefined && q.censusSha256 !== v.censusSha256) || (nextAfter !== null && nextAfter === q.after)) return fail();
    return { scope: digest(v.scope), items, nextAfter, censusSha256: digest(v.censusSha256) };
  }
  if (route === 'listActivities' || route === 'listReports') {
    const v = object(raw, ['scope', 'items', 'nextAfter', 'censusSha256', ...(route === 'listActivities' ? ['period'] : [])]);
    const items = route === 'listActivities' ? list(v.items, L.pageRows).map(activity) : list(v.items, L.pageRows).map(card);
    const page = { scope: digest(v.scope), items, ...cursor(v, items) };
    if ((q.censusSha256 !== undefined && q.censusSha256 !== page.censusSha256) || (page.nextAfter !== null && page.nextAfter === q.after)) return fail();
    if (route === 'listActivities') {
      const p = period(v.period);
      if (p.month !== q.month || canonicalZone(p.timeZone) !== canonicalZone(q.timeZone as string) || (items as ServiceActivity[]).some((a) => (!q.includeArchived && a.archivedAt !== null) || !customerMatches(q.customer as ServiceCustomer, a.version.value.customer) || !inMonth(a.version.value.occurredAt, p)) || new Set((items as ServiceActivity[]).flatMap((a) => a.version.value.references.map((r) => readerCanonical(r.pin)))).size > L.sourcesPerOperation) return fail();
      return { ...page, period: p };
    }
    if ((items as ServiceReportCard[]).some((r) => !q.includeArchived && r.state.archivedAt !== null)) return fail();
    return page;
  }
  if (route === 'getActivity' || route === 'createActivity' || route === 'correctActivity') {
    const v = object(raw, ['scope', 'activity']), a = activity(v.activity);
    if (route !== 'createActivity' && a.id !== q.id) return fail();
    return { scope: digest(v.scope), activity: a };
  }
  if (route === 'getReport' || route === 'createReport') {
    const v = object(raw, ['scope', 'report']), r = await report(v.report);
    if (route === 'getReport' && r.id !== q.id) return fail();
    return { scope: digest(v.scope), report: r };
  }
  if (route === 'archiveActivity' || route === 'archiveReport') {
    const v = object(raw, ['scope', 'id', 'revision', route === 'archiveActivity' ? 'archivedAt' : 'state']);
    if (v.id !== q.id) return fail();
    return { scope: digest(v.scope), id: id(v.id), revision: integer(v.revision), ...(route === 'archiveActivity' ? { archivedAt: v.archivedAt === null ? null : timestamp(v.archivedAt) } : { state: reportState(v.state) }) };
  }
  if (route === 'recoverCommand' || route === 'cancelCommand') {
    const v = object(raw, ['scope', 'outcome', 'receipt'], ['cancellation']), scope = digest(v.scope), command = q.command as ServiceReportsCommand;
    if (v.outcome === 'cancelled') {
      const cancellation = object(v.cancellation, ['idempotencyKey', 'fingerprint']);
      const idempotencyKey = id(cancellation.idempotencyKey), fingerprint = digest(cancellation.fingerprint);
      if (v.receipt !== null || idempotencyKey !== command.input.idempotencyKey || fingerprint !== await serviceReportsCommandFingerprint(command)) return fail();
      return { scope, outcome: 'cancelled', receipt: null, cancellation: { idempotencyKey, fingerprint } };
    }
    if (has(v, 'cancellation')) return fail();
    if (route === 'recoverCommand' && v.outcome === 'absent' && v.receipt === null) return { scope, outcome: 'absent', receipt: null };
    if (v.outcome !== 'committed') return fail();
    return { scope, outcome: 'committed', receipt: receipt(v.receipt, command) };
  }
  if (route === 'inspectSource') {
    const local=typeof q.documentId==='string'&&q.documentId.startsWith('local-doc:');
    const v=object(raw,local?['scope','pin','sourceKind','locator']:['scope','pin']),pin=requireServiceSourcePin(v.pin);
    if(pin.documentId!==q.documentId||pin.revisionId!==q.revisionId)return fail();
    if(local){if(v.sourceKind!=='local-document')return fail();return {scope:digest(v.scope),pin,sourceKind:'local-document',locator:sourceObservation(v.locator,pin)};}
    return {scope:digest(v.scope),pin,sourceKind:'synthetic'};
  }
  if (route === 'openActivitySource' || route === 'openReportSource') {
    const v = object(raw, ['scope', 'document', 'pin']), pin = requireServiceSourcePin(v.pin), doc = document(v.document);
    if (!same(pin, q.pin) || doc.id !== pin.documentId || doc.revisionId !== pin.revisionId || doc.tenantId !== pin.tenantId || doc.collectionId !== pin.collectionId || await sha256(readerDocumentIdentity(doc)) !== pin.sha256) return fail();
    return { scope: digest(v.scope), document: doc, pin };
  }
  return fail();
}

/** Duplicate keys, non-JSON values, deep trees and oversized token sets are rejected before DTO parsing. */
export function parseServiceReportsJson(raw: string, maximumBytes: number): unknown {
  if (typeof raw !== 'string' || raw.length > maximumBytes || byteLength(raw) > maximumBytes) return fail();
  let offset = 0, nodes = 0;
  const space = () => { while (/[\x20\t\r\n]/u.test(raw[offset] ?? '\0')) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < raw.length) {
      const c = raw[offset++];
      if (c === '"') { try { return JSON.parse(raw.slice(start, offset)) as string; } catch { return fail(); } }
      if (c === '\\') offset++;
    }
    return fail();
  };
  const value = (depth: number): void => {
    if (++nodes > 200_000 || depth > 24) fail();
    space();
    if (raw[offset] === '"') { string(); return; }
    if (raw[offset] === '{' || raw[offset] === '[') {
      const isObject = raw[offset++] === '{', close = isObject ? '}' : ']', keys = new Set<string>();
      let count = 0;
      space();
      if (raw[offset] === close) { offset++; return; }
      for (;;) {
        if (++count > 10_000) fail();
        space();
        if (isObject) {
          if (raw[offset] !== '"') fail();
          const key = string(); if (keys.has(key)) fail(); keys.add(key);
          space(); if (raw[offset++] !== ':') fail();
        }
        value(depth + 1); space();
        if (raw[offset] === close) { offset++; return; }
        if (raw[offset++] !== ',') fail();
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(raw.slice(offset));
    if (!match) fail();
    offset += match![0].length;
  };
  value(0); space(); if (offset !== raw.length) fail();
  try { return JSON.parse(raw) as unknown; } catch { return fail(); }
}
function actor(value: unknown): ServiceReportsActor | null {
  if (value === null) return null;
  const v = object(value, ['binding', 'epoch']);
  return Object.freeze({ binding: text(v.binding, 256), epoch: integer(v.epoch, 0) });
}
function discard(response: Response): void { try { void response.body?.cancel().catch(() => undefined); } catch { /* Do not wait on a hostile or disconnected stream. */ } }
// A native Response can supply Uint8Array chunks from a different realm (for example, jsdom/Node).
// The intrinsic TypedArray tag checks the internal typed-array kind without trusting a spoofed own tag.
const nativeTypedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get;
function isByteArray(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && nativeTypedArrayTag?.call(value) === 'Uint8Array';
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); reject(new ServiceReportsClientError('CANCELLED')); } };
    signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => { if (settled) { late?.(value); return; } settled = true; signal.removeEventListener('abort', abort); resolve(value); }, (error: unknown) => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
async function readBytes(response: Response, maximum: number, signal: AbortSignal, assertCurrent: () => void): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if ((length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) || !response.body) { discard(response); return fail('INVALID_RESPONSE'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0, reads = 0, complete = false;
  try {
    for (;;) {
      assertCurrent();
      if (++reads > 65_536) fail('RATE_LIMITED');
      const chunk = await abortable(reader.read(), signal);
      assertCurrent();
      if (chunk.done) break;
      if (!isByteArray(chunk.value) || (total += chunk.value.byteLength) > maximum) fail('INVALID_RESPONSE');
      chunks.push(new Uint8Array(chunk.value));
    }
    if (length !== null && Number(length) !== total) fail('INVALID_RESPONSE');
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    complete = true; return bytes;
  } finally {
    if (!complete) { try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ } }
    try { reader.releaseLock(); } catch { /* Ignored in-flight reads may still hold this lock. */ }
  }
}

export type ServiceReportsClientOptions = { fetch: typeof globalThis.fetch; getActor: () => ServiceReportsActor | null };
const verifiedResults = new WeakMap<object, { command: ServiceReportsCommand; authority: ServiceReportsAuthority; outcome: 'committed' | 'cancelled' }>();

/** Fixed same-origin POST routes. An auth transition must advance actor.epoch, including an A→B→A transition. */
export function createServiceReportsClient(options: ServiceReportsClientOptions) {
  if (typeof options.fetch !== 'function' || typeof options.getActor !== 'function') fail();
  const fetch = options.fetch, getActor = options.getActor, requests = new Set<AbortController>(), listeners = new Set<() => void>();
  const downloads = new WeakMap<ServiceReportExport, () => void>();
  const openedSources = new WeakMap<object, () => void>();
  let currentActor: ServiceReportsActor | null = null, scope: string | null = null, epoch = 0;
  const emit = () => { for (const listener of listeners) listener(); };
  const invalidate = (clearAuthority: boolean) => {
    epoch++;
    if (clearAuthority) scope = null;
    for (const request of requests) request.abort();
    requests.clear();
    emit();
  };
  const synchronize = () => {
    let next: ServiceReportsActor | null;
    try { next = actor(getActor()); } catch { next = null; }
    if (!same(next, currentActor)) { currentActor = next; invalidate(true); }
    return next;
  };
  const authority = (): ServiceReportsAuthority | null => {
    const selected = synchronize();
    return selected && scope ? Object.freeze({ actor: selected, scope }) : null;
  };
  async function request(route: Route, raw: unknown, external?: AbortSignal): Promise<unknown> {
    const parsed = input(route, raw), body = JSON.stringify(parsed);
    if (byteLength(body) > L.requestBytes) fail();
    const selected = synchronize();
    if (!selected || (route !== 'scope' && !scope)) return fail('FORBIDDEN');
    if (route === 'scope') invalidate(true);
    const expectedScope = scope, generation = epoch;
    if (route !== 'scope') {
      const commandScope = route === 'recoverCommand' || route === 'cancelCommand' ? (parsed as { command: ServiceReportsCommand }).command.input.scope : (parsed as Record<string, unknown>).scope;
      if (commandScope !== undefined && commandScope !== expectedScope) fail('FORBIDDEN');
    }
    if (external?.aborted) fail('CANCELLED');
    const controller = new AbortController(), abort = () => controller.abort();
    const expiresAt = Date.now() + L.operationMilliseconds;
    let deadline = false;
    requests.add(controller);
    external?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { deadline = true; controller.abort(); }, L.operationMilliseconds);
    const assertCurrent = () => {
      if (!same(synchronize(), selected) || (route !== 'scope' && scope !== expectedScope)) fail('FORBIDDEN');
      if (generation !== epoch) fail('CANCELLED');
      if (Date.now() >= expiresAt) { deadline = true; controller.abort(); }
      if (controller.signal.aborted) fail(deadline ? 'PROVIDER_ERROR' : 'CANCELLED');
    };
    try {
      assertCurrent();
      const response = await abortable(Promise.resolve().then(() => { assertCurrent(); return fetch(`/api/service-reports/${route}`, { method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { Accept: route === 'exportReport' ? '*/*' : 'application/json', 'Content-Type': 'application/json' }, body, signal: controller.signal }); }), controller.signal, discard);
      try { assertCurrent(); } catch (error) { discard(response); throw error; }
      if (response.redirected || response.status !== 200) {
        discard(response);
        if (response.status === 401 || response.status === 403) { invalidate(true); fail('FORBIDDEN'); }
        if (response.status === 404) fail('NOT_FOUND');
        if (response.status === 409) fail('CONFLICT');
        if (response.status === 429) fail('RATE_LIMITED');
        if (response.status === 400) fail('INVALID_REQUEST');
        fail('PROVIDER_ERROR');
      }
      if (route === 'exportReport') {
        const q = parsed as ServiceReportExportInput, mime = { json: 'application/json', csv: 'text/csv', html: 'text/html' }[q.format];
        const mediaType = response.headers.get('content-type') ?? '', disposition = response.headers.get('content-disposition') ?? '';
        const match = /^attachment;\s*filename="([A-Za-z0-9_-]+\.(?:json|csv|html))"$/u.exec(disposition);
        if (!(mediaType === mime || mediaType.toLowerCase() === `${mime}; charset=utf-8`) || !match || byteLength(match[1]) > 180 || !match[1].endsWith(`.${q.format}`) || !/(?:^|,)\s*no-store\s*(?:,|$)/iu.test(response.headers.get('cache-control') ?? '') || response.headers.get('x-content-type-options') !== 'nosniff' || response.headers.get('x-service-report-scope') !== expectedScope || response.headers.get('x-service-report-id') !== q.reportId || response.headers.get('x-service-report-revision') !== String(q.expectedRevision)) { discard(response); fail('INVALID_RESPONSE'); }
        const bytes = await readBytes(response, L.exportBytes, controller.signal, assertCurrent);
        assertCurrent();
        const result = Object.freeze({ scope: expectedScope!, reportId: q.reportId, revision: q.expectedRevision, format: q.format, filename: match![1], mediaType, bytes }) satisfies ServiceReportExport;
        downloads.set(result, assertCurrent);
        return result;
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/iu.test(response.headers.get('content-type') ?? '')) { discard(response); fail('INVALID_RESPONSE'); }
      const maximum = route === 'openActivitySource' || route === 'openReportSource' ? L.sourceBytes + 16_384 : route === 'listActivities' || route === 'listReports' || route === 'customers' ? L.pageBytes + 16_384 : L.recordBytes + 16_384;
      const bytes = await readBytes(response, maximum, controller.signal, assertCurrent);
      let result: unknown;
      try { result = await abortable(output(route, parseServiceReportsJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), maximum), parsed), controller.signal); } catch (error) { if (error instanceof ServiceReportsClientError && error.code === 'CANCELLED') throw error; return fail('INVALID_RESPONSE'); }
      assertCurrent();
      const resultScope = (result as { scope: string }).scope;
      if (route === 'scope') { scope = resultScope; emit(); }
      else if (resultScope !== expectedScope) { invalidate(true); fail('FORBIDDEN'); }
      if (['createActivity', 'correctActivity', 'archiveActivity', 'createReport', 'archiveReport'].includes(route)) {
        const command = requireServiceReportsCommand({ action: route, input: parsed }), value = result as ServiceReportsMutationResult;
        const targetId = 'activity' in value ? value.activity.id : 'report' in value ? value.report.id : value.id;
        receipt({ target: route === 'createReport' || route === 'archiveReport' ? 'report' : 'activity', id: targetId }, command);
        verifiedResults.set(value, { command, authority: { actor: selected, scope: resultScope }, outcome: 'committed' });
      } else if ((route === 'recoverCommand' || route === 'cancelCommand') && (result as ServiceReportsRecovery).outcome !== 'absent') {
        const recovered = result as ServiceReportsCancellationResult;
        verifiedResults.set(recovered, { command: (parsed as { command: ServiceReportsCommand }).command, authority: { actor: selected, scope: resultScope }, outcome: recovered.outcome });
      }
      if (route === 'openActivitySource' || route === 'openReportSource') openedSources.set(result as object, assertCurrent);
      return deepFreeze(result);
    } catch (error) {
      if (!same(synchronize(), selected)) return fail('FORBIDDEN');
      if (error instanceof ServiceReportsClientError && error.code === 'FORBIDDEN') throw error;
      if (deadline) return fail('PROVIDER_ERROR');
      if (generation !== epoch || controller.signal.aborted) return fail('CANCELLED');
      if (error instanceof ServiceReportsClientError) throw error;
      return fail('PROVIDER_ERROR');
    } finally { clearTimeout(timer); external?.removeEventListener('abort', abort); requests.delete(controller); }
  }
  return Object.freeze({
    authority,
    /** Call synchronously on query/route changes, before updating presentation state or starting a new read. */
    invalidateReads: () => invalidate(false),
    /** Call synchronously on sign-out, scope replacement or controller disposal. Durable commands are untouched. */
    withdraw: () => invalidate(true),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    sourceChoices: (value: ServiceSourceChoicesInput = {}, signal?: AbortSignal) => request('sourceChoices', value, signal) as Promise<ServiceSourceChoicesPage>,
    scope: (signal?: AbortSignal) => request('scope', {}, signal) as Promise<{ scope: string }>,
    customers: (value: ServiceReportsPageInput, signal?: AbortSignal) => request('customers', value, signal) as Promise<ServiceCustomersPage>,
    listActivities: (value: ServiceActivitiesInput, signal?: AbortSignal) => request('listActivities', value, signal) as Promise<ServiceActivityPage>,
    getActivity: (value: { id: string }, signal?: AbortSignal) => request('getActivity', value, signal) as Promise<{ scope: string; activity: ServiceActivity }>,
    listReports: (value: ServiceReportListInput, signal?: AbortSignal) => request('listReports', value, signal) as Promise<ServiceReportPage>,
    getReport: (value: { id: string }, signal?: AbortSignal) => request('getReport', value, signal) as Promise<{ scope: string; report: ServiceReport }>,
    mutate: (value: ServiceReportsCommand, signal?: AbortSignal) => { const command = requireServiceReportsCommand(value); return request(command.action, command.input, signal) as Promise<ServiceReportsMutationResult>; },
    recoverCommand: (value: { command: ServiceReportsCommand }, signal?: AbortSignal) => request('recoverCommand', value, signal) as Promise<ServiceReportsRecovery>,
    cancelCommand: (value: { command: ServiceReportsCommand }, signal?: AbortSignal) => request('cancelCommand', value, signal) as Promise<ServiceReportsCancellationResult>,
    inspectSource: async (value: { documentId: string; revisionId: string }, signal?: AbortSignal) => { const r=await request('inspectSource',value,signal) as ServiceSourceSelection; return Object.freeze({scope:r.scope,pin:r.pin}); },
    inspectSourceSelection: (value: {documentId:string;revisionId:string},signal?:AbortSignal)=>request('inspectSource',value,signal) as Promise<ServiceSourceSelection>,
    previewServiceRecord: (value:{schema:2;scope:string;sourceId:string},signal?:AbortSignal)=>request('previewServiceRecord',value,signal) as Promise<ServiceProjectionPreview>,
    importServiceRecord: (value:ServiceProjectionImport,signal?:AbortSignal)=>request('importServiceRecord',value,signal) as Promise<ServiceProjectionResult>,
    openSource: (value: ServiceSourceOpenInput, signal?: AbortSignal) => request(value.from === 'activity' ? 'openActivitySource' : 'openReportSource', value, signal) as Promise<{ scope: string; document: ResearchDocument; pin: ReaderSourcePin }>,
    exportReport: (value: ServiceReportExportInput, signal?: AbortSignal) => request('exportReport', value, signal) as Promise<ServiceReportExport>,
    /** One synchronous handoff only; no reusable cached URL/bytes may be published later. */
    consumeDownload: (value: ServiceReportExport, publish: (value: ServiceReportExport) => void) => {
      const current = downloads.get(value);
      downloads.delete(value);
      try {
        if (!current || typeof publish !== 'function') return fail('INVALID_RESPONSE');
        current();
        const returned: unknown = publish(value);
        if (returned !== undefined) { void Promise.resolve(returned).catch(() => undefined); fail('INVALID_REQUEST'); }
      } finally { value.bytes.fill(0); }
    },
    consumeSource: (value: { scope: string; document: ResearchDocument; pin: ReaderSourcePin }, publish: (value: { scope: string; document: ResearchDocument; pin: ReaderSourcePin }) => void) => {
      const current = openedSources.get(value);
      openedSources.delete(value);
      if (!current || typeof publish !== 'function') return fail('INVALID_RESPONSE');
      current();
      const returned: unknown = publish(value);
      if (returned !== undefined) { void Promise.resolve(returned).catch(() => undefined); fail('INVALID_REQUEST'); }
    },
  });
}
export type ServiceReportsClient = ReturnType<typeof createServiceReportsClient>;

export const SERVICE_REPORTS_JOURNAL_PREFIX = 'research-service:pending-command:v1:';
export const SERVICE_REPORTS_JOURNAL_LIMITS = Object.freeze({ slots: 32, scanKeys: 4096, recordBytes: L.requestBytes + 4096, totalBytes: 1024 * 1024 });
export type ServiceReportsPendingRecord = Readonly<{
  schema: 1;
  actorBinding: string;
  scope: string;
  command: ServiceReportsCommand;
}>;
function storageOperation<T>(operation: () => T): T {
  try { return operation(); } catch (error) { if (error instanceof ServiceReportsClientError) throw error; return fail('STORAGE'); }
}
function journalKey(scope: string, token: string): string { return `${SERVICE_REPORTS_JOURNAL_PREFIX}${digest(scope)}:${id(token)}`; }
function pendingRecord(raw: string, scope: string, token: string): ServiceReportsPendingRecord {
  try {
    const v = object(parseServiceReportsJson(raw, SERVICE_REPORTS_JOURNAL_LIMITS.recordBytes), ['schema', 'actorBinding', 'scope', 'command']);
    const command = requireServiceReportsCommand(v.command);
    if (v.schema !== 1 || v.scope !== scope || command.input.scope !== scope || command.input.idempotencyKey !== token) return fail('STORAGE');
    return deepFreeze({ schema: 1, actorBinding: text(v.actorBinding, 256), scope: digest(v.scope), command });
  } catch { return fail('STORAGE'); }
}
/** Validate the whole owned namespace before writing. Unknown/corrupt entries are retained and block new writes. */
function journalEntries(storage: Storage): Map<string, string> {
  const count = integer(storage.length, 0, SERVICE_REPORTS_JOURNAL_LIMITS.scanKeys), entries = new Map<string, string>();
  let bytes = 0;
  for (let index = 0; index < count; index++) {
    const key = storage.key(index);
    if (typeof key !== 'string') fail('STORAGE');
    if (!key!.startsWith(SERVICE_REPORTS_JOURNAL_PREFIX)) continue;
    const parts = /^([a-f0-9]{64}):([A-Za-z0-9_-]{1,100})$/u.exec(key!.slice(SERVICE_REPORTS_JOURNAL_PREFIX.length)), raw = storage.getItem(key!);
    if (!parts || entries.has(key!) || raw === null) fail('STORAGE');
    pendingRecord(raw!, parts![1], parts![2]);
    bytes += byteLength(raw!);
    entries.set(key!, raw!);
    if (entries.size > SERVICE_REPORTS_JOURNAL_LIMITS.slots || bytes > SERVICE_REPORTS_JOURNAL_LIMITS.totalBytes) fail('STORAGE');
  }
  if (storage.length !== count) fail('STORAGE');
  return entries;
}
export function readServiceReportsPending(storage: Storage, authority: ServiceReportsAuthority, token?: string): ServiceReportsPendingRecord | null {
  const prefix = `${SERVICE_REPORTS_JOURNAL_PREFIX}${digest(authority.scope)}:`, binding = text(authority.actor.binding, 256);
  if (token !== undefined) id(token);
  return storageOperation(() => {
    const records = [...journalEntries(storage).entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, raw]) => pendingRecord(raw, authority.scope, key.slice(prefix.length)));
    if (records.some((record) => record.actorBinding !== binding)) return fail('FORBIDDEN');
    return token === undefined ? records[0] ?? null : records.find((record) => record.command.input.idempotencyKey === token) ?? null;
  });
}
function preparePending(storage: Storage, authority: ServiceReportsAuthority, command: ServiceReportsCommand): ServiceReportsPendingRecord {
  const key = journalKey(authority.scope, command.input.idempotencyKey), prefix = `${SERVICE_REPORTS_JOURNAL_PREFIX}${authority.scope}:`;
  if (command.input.scope !== authority.scope) fail('FORBIDDEN');
  return storageOperation(() => {
    const entries = journalEntries(storage);
    if ([...entries.keys()].some((entry) => entry.startsWith(prefix)) || storage.getItem(key) !== null) return fail('PENDING');
    const record = deepFreeze({ schema: 1 as const, actorBinding: text(authority.actor.binding, 256), scope: authority.scope, command: requireServiceReportsCommand(command) });
    const raw = JSON.stringify(record);
    if (byteLength(raw) > SERVICE_REPORTS_JOURNAL_LIMITS.recordBytes || entries.size >= SERVICE_REPORTS_JOURNAL_LIMITS.slots || [...entries.values()].reduce((bytes, item) => bytes + byteLength(item), 0) + byteLength(raw) > SERVICE_REPORTS_JOURNAL_LIMITS.totalBytes) fail('STORAGE');
    // This is already outcome-unknown before transport: a closed tab never needs a later failure callback.
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) fail('STORAGE');
    return pendingRecord(raw, authority.scope, command.input.idempotencyKey);
  });
}
function settlePending(storage: Storage, authority: ServiceReportsAuthority, expected: ServiceReportsPendingRecord, result: object, assertCurrent: () => void): void {
  const verified = verifiedResults.get(result);
  if (!verified || !same(verified.authority, authority)) return fail('FORBIDDEN');
  if (expected.actorBinding !== authority.actor.binding || expected.scope !== authority.scope || !same(expected.command, verified.command)) return fail('PENDING');
  return storageOperation(() => {
    const key = journalKey(authority.scope, verified.command.input.idempotencyKey), raw = storage.getItem(key);
    if (raw === null) return fail('PENDING');
    const record = pendingRecord(raw, authority.scope, verified.command.input.idempotencyKey);
    if (record.actorBinding !== authority.actor.binding || !same(record.command, verified.command)) return fail('PENDING');
    if (storage.getItem(key) !== raw) return fail('PENDING');
    assertCurrent();
    // Only a current, adapter-verified commit or cancellation for this exact original command reaches removal.
    storage.removeItem(key);
    if (storage.getItem(key) !== null) fail('STORAGE');
    verifiedResults.delete(result);
  });
}

export type ServiceReportsIntent =
  | { action: 'createActivity'; input: Omit<CreateServiceActivity, 'scope' | 'idempotencyKey'> }
  | { action: 'correctActivity'; input: Omit<CorrectServiceActivity, 'scope' | 'idempotencyKey'> }
  | { action: 'archiveActivity'; input: Omit<ArchiveServiceActivity, 'scope' | 'idempotencyKey'> }
  | { action: 'createReport'; input: Omit<CreateServiceReport, 'scope' | 'idempotencyKey'> }
  | { action: 'archiveReport'; input: Omit<ArchiveServiceReport, 'scope' | 'idempotencyKey'> };
export type ServiceReportsPendingView = Readonly<{ token: string; label: string; phase: 'sending' | 'uncertain'; message: string; canRetrySame: boolean; canCheck: boolean; canCancel: boolean }>;
const labels: Record<ServiceReportsCommand['action'], string> = { createActivity: '新增服务活动', correctActivity: '更正服务活动', archiveActivity: '更改服务活动归档状态', createReport: '生成服务月报', archiveReport: '更改服务月报归档状态' };
const activeStorageLocks = new WeakMap<Storage, Set<string>>();

/** New commands are blocked while pending work is known. Concurrent tabs retain separate immutable keys. */
export function createServiceReportsCommands(client: ServiceReportsClient, options: { storage: Storage; createKey?: () => string }) {
  const storage = options.storage, createKey = options.createKey ?? (() => globalThis.crypto.randomUUID());
  const listeners = new Set<() => void>();
  let active: { scope: string; token: string } | null = null, disposed = false, error: ServiceReportsClientError | null = null;
  const emit = () => { for (const listener of listeners) listener(); };
  const unsubscribe = client.subscribe(emit);
  const storageChanged = (event: StorageEvent) => {
    if (event.storageArea === storage && (event.key === null || event.key.startsWith(SERVICE_REPORTS_JOURNAL_PREFIX))) emit();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', storageChanged);
  const current = (): ServiceReportsAuthority => { const value = client.authority(); if (disposed || !value) return fail('FORBIDDEN'); return value; };
  const view = (): { pending: ServiceReportsPendingView | null; error: string | null } => {
    try {
      const authority = current(), record = readServiceReportsPending(storage, authority, active?.scope === authority.scope ? active.token : undefined);
      if (!record) return { pending: null, error: error?.message ?? null };
      const sending = active?.scope === authority.scope && active.token === record.command.input.idempotencyKey;
      return { pending: { token: record.command.input.idempotencyKey, label: labels[record.command.action], phase: sending ? 'sending' : 'uncertain', message: sending ? '正在确认原操作；请勿关闭恢复记录' : '结果尚未确认。可检查、用原内容和原标识重试，或取消尚未提交的原操作', canRetrySame: !sending, canCheck: !sending, canCancel: !sending }, error: error?.message ?? null };
    } catch (caught) { return { pending: null, error: caught instanceof ServiceReportsClientError ? caught.message : messages.STORAGE }; }
  };
  const run = (mode: 'new' | 'retry' | 'check' | 'cancel', value: ServiceReportsIntent | string): Promise<ServiceReportsMutationResult | ServiceReportsRecovery> => {
    let authority: ServiceReportsAuthority, record: ServiceReportsPendingRecord;
    let locks = activeStorageLocks.get(storage);
    if (!locks) { locks = new Set(); activeStorageLocks.set(storage, locks); }
    try {
      authority = current();
      if (active || locks.has(authority.scope)) return Promise.reject(new ServiceReportsClientError('PENDING'));
      // Claim synchronously before key generation, storage, state notifications or a single await.
      locks.add(authority.scope);
      if (mode === 'new') {
        const intent = object(value, ['action', 'input']);
        const action = choice(intent.action, ['createActivity', 'correctActivity', 'archiveActivity', 'createReport', 'archiveReport'] as const);
        // Validate descriptors BEFORE spreading, so getters cannot run and hidden fields cannot disappear.
        const fields = action === 'createActivity' ? ['activity'] : action === 'correctActivity' ? ['id', 'expectedRevision', 'activity', 'reason'] : action === 'createReport' ? ['customer', 'month', 'timeZone', 'supersedes'] : ['id', 'expectedRevision', 'archived'];
        const draft = object(intent.input, fields);
        const command = requireServiceReportsCommand({ action, input: { ...draft, scope: authority.scope, idempotencyKey: id(createKey()) } });
        record = preparePending(storage, authority, command);
      } else {
        const token = id(value), existing = readServiceReportsPending(storage, authority, token);
        if (!existing || existing.command.input.idempotencyKey !== token) fail('PENDING');
        record = existing!;
      }
      active = { scope: authority.scope, token: record.command.input.idempotencyKey };
      error = null; emit();
    } catch (caught) {
      // Never remove a record after a prepare/read/send failure.
      if (typeof authority! !== 'undefined') locks.delete(authority!.scope);
      error = caught instanceof ServiceReportsClientError ? caught : new ServiceReportsClientError('STORAGE');
      emit(); return Promise.reject(error);
    }
    const capturedAuthority = authority, capturedRecord = record;
    return (async () => {
      try {
        if (!same(current(), capturedAuthority)) fail('FORBIDDEN');
        const result = mode === 'check' ? await client.recoverCommand({ command: capturedRecord.command }) : mode === 'cancel' ? await client.cancelCommand({ command: capturedRecord.command }) : await client.mutate(capturedRecord.command);
        if (!same(current(), capturedAuthority)) fail('FORBIDDEN');
        if ('outcome' in result && result.outcome === 'absent') {
          if (mode !== 'check') fail('INVALID_RESPONSE');
        } else settlePending(storage, capturedAuthority, capturedRecord, result, () => { if (!same(current(), capturedAuthority)) fail('FORBIDDEN'); });
        // An absent receipt is explicitly nonterminal. Keep the original exact key/body for later check/retry.
        return result;
      } catch (caught) {
        error = caught instanceof ServiceReportsClientError ? caught : new ServiceReportsClientError('PROVIDER_ERROR');
        throw error;
      } finally { locks!.delete(capturedAuthority.scope); active = null; emit(); }
    })();
  };
  return Object.freeze({
    view,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    submit: (intent: ServiceReportsIntent) => run('new', intent),
    retry: (token: string) => run('retry', token),
    check: (token: string) => run('check', token),
    cancel: (token: string) => run('cancel', token),
    dispose: () => { disposed = true; unsubscribe(); if (typeof window !== 'undefined') window.removeEventListener('storage', storageChanged); listeners.clear(); client.withdraw(); },
  });
}
export type ServiceReportsCommands = ReturnType<typeof createServiceReportsCommands>;
