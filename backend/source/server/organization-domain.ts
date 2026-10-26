import { types as nodeTypes } from 'node:util';
import { createHash } from 'node:crypto';
import { AdapterError, type ServerContext } from '../shared/contracts';
import type { DomainKind, DomainRecord, DomainTransaction, JsonValue } from '../shared/workspace';
import type { DomainWriteTransaction, DomainStore } from './workspace-store';

/** Durable, owner-scoped local records. This module never authenticates, sends, fetches, or grants access. */
export type OrganizationKind =
  | 'organization'
  | 'person'
  | 'meeting'
  | 'meeting-registration'
  | 'crm-contact'
  | 'service-record'
  | 'bookmark'
  | 'reading-record'
  | 'access-request'
  | 'share-draft';
export type LocalTargetKind =
  | 'organization'
  | 'person'
  | 'meeting'
  | 'workspace'
  | 'session'
  | 'watchlist'
  | 'ingestion-file'
  | 'ingestion-version'
  | 'research-artifact';
export type LocalTarget = { kind: LocalTargetKind; id: string; revision: number };
export type OrganizationData = {
  name: string;
  parentId: string | null;
  category: 'buy-side' | 'sell-side' | 'company' | 'other';
  description: string;
  website: string;
  tags: string[];
  verification: 'unverified';
};
export type PersonData = {
  name: string;
  organizationId: string | null;
  role: string;
  department: string;
  email: string;
  biography: string;
  followed: boolean;
  tags: string[];
};
export type MeetingData = {
  title: string;
  organizationId: string | null;
  series: string;
  category: 'roadshow' | 'strategy' | 'research' | 'forum' | 'other';
  startsAt: string;
  endsAt: string;
  timezone: string;
  location: string;
  description: string;
  attendeeIds: string[];
  state: 'scheduled' | 'cancelled' | 'completed';
  providerAvailability: 'unconfigured';
  /** Absent: legacy/unset; null: explicitly cleared; 0: at meeting start. No delivery. */
  reminderLeadSeconds?: 0 | 300 | 900 | 1800 | 3600 | 86400 | null;
};
export type MeetingRegistrationData = {
  meetingId: string;
  personId: string;
  state: 'requested' | 'approved-locally' | 'declined' | 'cancelled';
  notes: string;
  localOnly: true;
};
export type CrmContactData = {
  organizationId: string;
  personId: string | null;
  name: string;
  stage: 'prospect' | 'active' | 'inactive';
  notes: string;
  tags: string[];
};
export type ServiceActivity = 'content-read' | 'meeting' | 'call' | 'email' | 'other';
export type ServiceRecordData = {
  organizationId: string;
  contactId: string | null;
  activity: ServiceActivity;
  occurredAt: string;
  summary: string;
  notes: string;
  source: LocalTarget | null;
  provenance: 'user-recorded-local';
};
export type BookmarkData = { title: string; target: LocalTarget; notes: string; tags: string[] };
export type ReadingRecordData = {
  target: LocalTarget;
  readAt: string;
  progress: number;
  notes: string;
  provenance: 'user-recorded-local';
};
export type AccessRequestData = {
  organizationId: string;
  requesterPersonId: string | null;
  target: LocalTarget;
  purpose: string;
  state: 'pending' | 'approved-locally' | 'declined' | 'cancelled';
  decisionNote: string;
  localOnly: true;
};
export type ShareDraftData = {
  title: string;
  target: LocalTarget;
  recipientPersonIds: string[];
  recipientOrganizationIds: string[];
  state: 'draft' | 'approved-locally' | 'revoked';
  notes: string;
  localOnly: true;
};
export type OrganizationDataByKind = {
  organization: OrganizationData;
  person: PersonData;
  meeting: MeetingData;
  'meeting-registration': MeetingRegistrationData;
  'crm-contact': CrmContactData;
  'service-record': ServiceRecordData;
  bookmark: BookmarkData;
  'reading-record': ReadingRecordData;
  'access-request': AccessRequestData;
  'share-draft': ShareDraftData;
};
export type OrganizationInputDataByKind = {
  [K in OrganizationKind]: Omit<
    OrganizationDataByKind[K],
    'verification' | 'providerAvailability' | 'localOnly' | 'provenance'
  >;
};
export type OrganizationRecord<K extends OrganizationKind = OrganizationKind> = DomainRecord<
  OrganizationDataByKind[K]
>;
export type CreateOrganizationRecordRequest<K extends OrganizationKind = OrganizationKind> = {
  kind: K;
  data: Partial<OrganizationInputDataByKind[K]>;
  id?: string;
  idempotencyKey: string;
};
export type UpdateOrganizationRecordRequest<K extends OrganizationKind = OrganizationKind> = {
  kind: K;
  id: string;
  expectedRevision: number;
  patch: Partial<OrganizationInputDataByKind[K]>;
  idempotencyKey: string;
};
export type MutateOrganizationRecordRequest<K extends OrganizationKind = OrganizationKind> = {
  kind: K;
  id: string;
  expectedRevision: number;
  idempotencyKey: string;
};
export type GetOrganizationRecordRequest<K extends OrganizationKind = OrganizationKind> = {
  kind: K;
  id: string;
  includeDeleted?: boolean;
};
export type ListOrganizationRecordsRequest<K extends OrganizationKind = OrganizationKind> = {
  kind: K;
  includeDeleted?: boolean;
  query?: string;
  organizationId?: string | null;
  personId?: string | null;
  meetingId?: string;
  contactId?: string | null;
  parentId?: string | null;
  state?: string;
  category?: string;
  stage?: string;
  activity?: ServiceActivity;
  followed?: boolean;
  targetKind?: LocalTargetKind;
  targetId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'name' | 'date';
  direction?: 'asc' | 'desc';
};
export type OrganizationRecordPage<K extends OrganizationKind = OrganizationKind> = {
  items: OrganizationRecord<K>[];
  total: number;
  offset: number;
  nextOffset: number | null;
};
export type ServiceStatisticsRequest = {
  organizationId?: string;
  contactId?: string;
  from?: string;
  to?: string;
};
export type ServiceStatistics = {
  total: number;
  byActivity: Record<ServiceActivity, number>;
  byOrganization: { organizationId: string; total: number }[];
  events: {
    id: string;
    revision: number;
    activity: ServiceActivity;
    occurredAt: string;
    organizationId: string;
  }[];
  provenance: 'user-recorded-local';
  externalDeliveryVerified: false;
};
export type MeetingIcsExport = {
  filename: string;
  mediaType: 'text/calendar; charset=utf-8';
  content: string;
  localOnly: true;
};

const kinds: readonly OrganizationKind[] = [
  'organization',
  'person',
  'meeting',
  'meeting-registration',
  'crm-contact',
  'service-record',
  'bookmark',
  'reading-record',
  'access-request',
  'share-draft',
];
const targetKinds: readonly LocalTargetKind[] = [
  'organization',
  'person',
  'meeting',
  'workspace',
  'session',
  'watchlist',
  'ingestion-file',
  'ingestion-version',
  'research-artifact',
];
const fields: Record<OrganizationKind, readonly string[]> = {
  organization: ['name', 'parentId', 'category', 'description', 'website', 'tags'],
  person: ['name', 'organizationId', 'role', 'department', 'email', 'biography', 'followed', 'tags'],
  meeting: [
    'title',
    'organizationId',
    'series',
    'category',
    'startsAt',
    'endsAt',
    'timezone',
    'location',
    'description',
    'attendeeIds',
    'state',
    'reminderLeadSeconds',
  ],
  'meeting-registration': ['meetingId', 'personId', 'state', 'notes'],
  'crm-contact': ['organizationId', 'personId', 'name', 'stage', 'notes', 'tags'],
  'service-record': ['organizationId', 'contactId', 'activity', 'occurredAt', 'summary', 'notes', 'source'],
  bookmark: ['title', 'target', 'notes', 'tags'],
  'reading-record': ['target', 'readAt', 'progress', 'notes'],
  'access-request': ['organizationId', 'requesterPersonId', 'target', 'purpose', 'state', 'decisionNote'],
  'share-draft': ['title', 'target', 'recipientPersonIds', 'recipientOrganizationIds', 'state', 'notes'],
};
const states: Partial<Record<OrganizationKind, readonly string[]>> = {
  meeting: ['scheduled', 'cancelled', 'completed'],
  'meeting-registration': ['requested', 'approved-locally', 'declined', 'cancelled'],
  'access-request': ['pending', 'approved-locally', 'declined', 'cancelled'],
  'share-draft': ['draft', 'approved-locally', 'revoked'],
};
const activities: readonly ServiceActivity[] = ['content-read', 'meeting', 'call', 'email', 'other'];
const deterministicRejections = new WeakSet<object>();
const invalid = (message: string): never => {
  const cause = new AdapterError('INVALID_REQUEST', message); deterministicRejections.add(cause); throw cause;
};
const conflict = (message: string): never => {
  const cause = new AdapterError('CONFLICT', message); deterministicRejections.add(cause); throw cause;
};
const eligibleRejection = (cause: unknown) => cause !== null && typeof cause === 'object' && deterministicRejections.has(cause);
function rawCommandKey(value:unknown):string {
 if(value===null||typeof value!=='object'||nodeTypes.isProxy(value)||Array.isArray(value))invalid('Invalid command envelope');
 const descriptor=Object.getOwnPropertyDescriptor(value,'idempotencyKey');
 if(!descriptor||!('value' in descriptor))return invalid('Invalid command key');
 return commandKey(descriptor.value);
}

const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return invalid('需要普通记录对象');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (
      typeof key !== 'string' ||
      !allowed.includes(key) ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      descriptor.value === undefined
    )
      return invalid('包含不支持的字段');
  }
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum)
    return invalid('列表类型或长度无效');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (
      key !== 'length' &&
      (typeof key !== 'string' ||
        !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= value.length ||
        !('value' in descriptor))
    )
      return invalid('列表包含不支持的字段');
  }
  for (let index = 0; index < value.length; index++)
    if (!has(value, String(index))) invalid('列表不能有空项');
  return value;
}
function text(value: unknown, maximum: number, empty = false, multiline = false): string {
  if (typeof value !== 'string') return invalid('字段必须是文本');
  const result = multiline ? value : value.trim();
  const hasControl = [...result].some((character) => {
    const code = character.codePointAt(0)!;
    return code === 127 || (code < 32 && !(multiline && [9, 10, 13].includes(code)));
  });
  if ((!empty && !result.trim()) || Buffer.byteLength(result) > maximum || hasControl)
    return invalid('文本为空、过长或包含控制字符');
  return result;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) return invalid('无效的本地记录 ID');
  return value;
}
const nullableId = (value: unknown) => (value === null ? null : identifier(value));
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    return invalid('整数超出范围');
  return value;
}
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid('开关必须是布尔值');
  return value;
}
function choice<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) return invalid('不支持的选项');
  return value as T;
}
/** Unsupported kinds are outside the terminal-receipt opt-in, even with a valid raw binding. */
function commandKind(value: unknown): OrganizationKind {
  if (typeof value !== 'string' || !kinds.includes(value as OrganizationKind))
    throw new AdapterError('INVALID_REQUEST', 'Unsupported organization command kind');
  return value as OrganizationKind;
}
function commandKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value))
    return invalid('需要有界幂等键');
  return value;
}
/** Explicit offset/UTC is required. Impossible dates are rejected instead of Date's silent rollover. */
function instant(value: unknown): string {
  const raw = text(value, 40);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    raw,
  );
  if (!match) return invalid('时间需要 ISO 日期、秒和明确时区偏移');
  const [, y, mo, d, h, mi, s, , zone] = match;
  const year = Number(y),
    month = Number(mo),
    day = Number(d);
  if (
    year < 1970 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    Number(h) > 23 ||
    Number(mi) > 59 ||
    Number(s) > 59 ||
    (zone !== 'Z' &&
      (Number(zone.slice(1, 3)) > 14 ||
        Number(zone.slice(4)) > 59 ||
        (Number(zone.slice(1, 3)) === 14 && Number(zone.slice(4)) !== 0)))
  )
    return invalid('时间日期或偏移无效');
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1970 || date.getUTCFullYear() > 2100)
    return invalid('时间超出支持范围');
  return date.toISOString();
}
function timezone(value: unknown): string {
  const zone = text(value, 100);
  // Intl also accepts raw offsets on some runtimes; this contract accepts named zones only.
  if (!/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(zone)) return invalid('需要有效的命名时区');
  try {
    return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return invalid('时区无效');
  }
}
function ids(value: unknown, maximum = 200): string[] {
  const result = array(value, maximum).map(identifier);
  if (new Set(result).size !== result.length) return invalid('列表不能包含重复记录');
  return result;
}
function target(value: unknown): LocalTarget {
  const input = object(value, ['kind', 'id', 'revision']);
  return {
    kind: choice(input.kind, targetKinds),
    id: identifier(input.id),
    revision: integer(input.revision, 1, Number.MAX_SAFE_INTEGER),
  };
}
function normalizeField(recordKind: OrganizationKind, field: string, value: unknown): JsonValue {
  switch (field) {
    case 'name':
    case 'title':
    case 'summary':
      return text(value, 720);
    case 'description':
    case 'biography':
    case 'notes':
    case 'decisionNote':
      return text(value, 16_000, true, true);
    case 'purpose':
      return text(value, 8_000, false, true);
    case 'role':
    case 'department':
    case 'series':
    case 'location':
      return text(value, 720, true);
    case 'organizationId':
      return recordKind === 'person' || recordKind === 'meeting' ? nullableId(value) : identifier(value);
    case 'personId':
      return recordKind === 'crm-contact' ? nullableId(value) : identifier(value);
    case 'parentId':
    case 'contactId':
    case 'requesterPersonId':
      return nullableId(value);
    case 'meetingId':
      return identifier(value);
    case 'attendeeIds':
    case 'recipientPersonIds':
    case 'recipientOrganizationIds':
      return ids(value);
    case 'target':
      return target(value);
    case 'source':
      return value === null ? null : target(value);
    case 'startsAt':
    case 'endsAt':
    case 'occurredAt':
    case 'readAt':
      return instant(value);
    case 'timezone':
      return timezone(value);
    case 'followed':
      return flag(value);
    case 'reminderLeadSeconds': {
      // Local saved preference only. Keep the existing preview choices, not reminder runtime records.
      if (value === null) return null;
      const seconds = integer(value, 0, 7 * 86400);
      if (![0, 300, 900, 1800, 3600, 86400].includes(seconds)) invalid('提醒偏好提前量无效');
      return seconds;
    }
    case 'progress':
      return integer(value, 0, 100);
    case 'category':
      return recordKind === 'organization'
        ? choice(value, ['buy-side', 'sell-side', 'company', 'other'])
        : choice(value, ['roadshow', 'strategy', 'research', 'forum', 'other']);
    case 'stage':
      return choice(value, ['prospect', 'active', 'inactive']);
    case 'state':
      return choice(value, states[recordKind] ?? []);
    case 'activity':
      return choice(value, activities);
    case 'tags': {
      const tags = array(value, 20).map((item) => text(item, 80));
      if (new Set(tags.map((item) => item.toLowerCase())).size !== tags.length) invalid('标签不能重复');
      return tags;
    }
    case 'email': {
      const email = text(value, 254, true);
      if (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) invalid('邮箱格式无效');
      return email;
    }
    case 'website': {
      const raw = text(value, 2048, true);
      if (!raw) return '';
      try {
        const url = new URL(raw);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname)
          invalid('网站地址无效');
        return url.href;
      } catch {
        return invalid('网站仅支持无凭据的 HTTP(S) 地址');
      }
    }
    default:
      return invalid('不支持的字段');
  }
}
function patchData(recordKind: OrganizationKind, value: unknown): Record<string, JsonValue> {
  const input = object(value, fields[recordKind]);
  return Object.fromEntries(
    fields[recordKind]
      .filter((field) => has(input, field))
      .map((field) => [field, normalizeField(recordKind, field, input[field])]),
  );
}
function dataFor<K extends OrganizationKind>(recordKind: K, value: unknown): OrganizationDataByKind[K] {
  const defaults: Record<OrganizationKind, Record<string, JsonValue>> = {
    organization: {
      parentId: null,
      category: 'other',
      description: '',
      website: '',
      tags: [],
      verification: 'unverified',
    },
    person: {
      organizationId: null,
      role: '',
      department: '',
      email: '',
      biography: '',
      followed: false,
      tags: [],
    },
    meeting: {
      organizationId: null,
      series: '',
      category: 'other',
      location: '',
      description: '',
      attendeeIds: [],
      state: 'scheduled',
      providerAvailability: 'unconfigured',
    },
    'meeting-registration': { state: 'requested', notes: '', localOnly: true },
    'crm-contact': { personId: null, stage: 'prospect', notes: '', tags: [] },
    'service-record': {
      contactId: null,
      activity: 'other',
      notes: '',
      source: null,
      provenance: 'user-recorded-local',
    },
    bookmark: { notes: '', tags: [] },
    'reading-record': { progress: 0, notes: '', provenance: 'user-recorded-local' },
    'access-request': { requesterPersonId: null, state: 'pending', decisionNote: '', localOnly: true },
    'share-draft': {
      recipientPersonIds: [],
      recipientOrganizationIds: [],
      state: 'draft',
      notes: '',
      localOnly: true,
    },
  };
  const data = { ...defaults[recordKind], ...patchData(recordKind, value) };
  for (const field of fields[recordKind]) if (!(recordKind === 'meeting' && field === 'reminderLeadSeconds') && !has(data, field)) invalid(`记录缺少字段：${field}`);
  if (recordKind === 'meeting') {
    const duration = Date.parse(data.endsAt as string) - Date.parse(data.startsAt as string);
    if (duration <= 0 || duration > 31 * 86_400_000) invalid('会议结束必须晚于开始，且时长不能超过 31 天');
  }
  if (
    recordKind === 'share-draft' &&
    !(data.recipientPersonIds as string[]).length &&
    !(data.recipientOrganizationIds as string[]).length
  )
    invalid('分享草稿需要至少一个本地接收人或机构');
  return data as OrganizationDataByKind[K];
}
function revision(record: DomainRecord, expected: number): void {
  if (record.revision !== expected) conflict('本地记录已更改，请刷新后重试');
}
type Edge = { kind: DomainKind; id: string; revision?: number };
function edges(recordKind: OrganizationKind, data: OrganizationDataByKind[OrganizationKind]): Edge[] {
  const row = data as Record<string, JsonValue>;
  const result: Edge[] = [];
  const add = (kind: DomainKind, value: JsonValue | undefined) => {
    if (typeof value === 'string') result.push({ kind, id: value });
  };
  add('organization', row.organizationId);
  if (recordKind === 'organization') add('organization', row.parentId);
  add('person', row.personId);
  add('person', row.requesterPersonId);
  add('meeting', row.meetingId);
  add('crm-contact', row.contactId);
  for (const id of (row.attendeeIds ?? row.recipientPersonIds ?? []) as string[]) add('person', id);
  for (const id of (row.recipientOrganizationIds ?? []) as string[]) add('organization', id);
  for (const name of ['target', 'source']) if (row[name]) result.push(row[name] as LocalTarget);
  return result;
}
function dateField(recordKind: OrganizationKind): string | null {
  return recordKind === 'meeting'
    ? 'startsAt'
    : recordKind === 'service-record'
      ? 'occurredAt'
      : recordKind === 'reading-record'
        ? 'readAt'
        : null;
}
function dateRange(input: Record<string, unknown>): { from: string | null; to: string | null } {
  const from = has(input, 'from') ? instant(input.from) : null;
  const to = has(input, 'to') ? instant(input.to) : null;
  if (from && to && from >= to) invalid('日期范围需要起始早于结束');
  return { from, to };
}
function matchesRange(at: string, from: string | null, to: string | null) {
  return (!from || at >= from) && (!to || at < to);
}
function closingIntent(
  recordKind: OrganizationKind,
  data: OrganizationDataByKind[OrganizationKind],
): boolean {
  const state = (data as Record<string, JsonValue>).state;
  return (
    (recordKind === 'share-draft' && state === 'revoked') ||
    (recordKind === 'access-request' && (state === 'cancelled' || state === 'declined'))
  );
}

export class OrganizationDomain {
  constructor(private readonly store: DomainStore) {}

  private relations<K extends OrganizationKind>(
    tx: DomainTransaction,
    recordKind: K,
    id: string | null,
    data: OrganizationDataByKind[K],
    closingIntent = false,
  ): void {
    for (const edge of edges(recordKind, data)) {
      // Closing an unchanged local intent must remain possible after its source changes or disappears.
      if (closingIntent && edge.revision !== undefined) continue;
      const referenced = tx.get(edge.kind, edge.id);
      if (edge.revision !== undefined) revision(referenced, edge.revision);
    }
    const row = data as Record<string, JsonValue>;
    if (recordKind === 'organization') {
      let parentId = (data as OrganizationData).parentId;
      const seen = new Set(id === null ? [] : [id]);
      while (parentId !== null) {
        if (seen.has(parentId)) conflict('机构不能位于自身或子机构之下');
        seen.add(parentId);
        parentId = tx.get<OrganizationData>('organization', parentId).data.parentId;
      }
    }
    if (recordKind === 'crm-contact' && row.personId) {
      const person = tx.get<PersonData>('person', row.personId as string);
      if (person.data.organizationId !== row.organizationId) conflict('客户联系人与机构不一致');
    }
    if (
      recordKind === 'person' &&
      id !== null &&
      tx
        .list<CrmContactData>('crm-contact')
        .some((item) => item.data.personId === id && item.data.organizationId !== row.organizationId)
    )
      conflict('请先调整关联客户，再修改人员机构');
    if (recordKind === 'service-record' && row.contactId) {
      const contact = tx.get<CrmContactData>('crm-contact', row.contactId as string);
      if (contact.data.organizationId !== row.organizationId) conflict('服务记录与客户机构不一致');
    }
    if (
      recordKind === 'crm-contact' &&
      id !== null &&
      tx
        .list<ServiceRecordData>('service-record')
        .some((item) => item.data.contactId === id && item.data.organizationId !== row.organizationId)
    )
      conflict('请先调整关联服务记录，再移动客户机构');
    if (recordKind === 'access-request' && row.requesterPersonId) {
      const person = tx.get<PersonData>('person', row.requesterPersonId as string);
      if (person.data.organizationId !== row.organizationId) conflict('来访人员与申请机构不一致');
    }
    if (
      recordKind === 'person' &&
      id !== null &&
      tx
        .list<AccessRequestData>('access-request')
        .some((item) => item.data.requesterPersonId === id && item.data.organizationId !== row.organizationId)
    )
      conflict('请先调整关联来访申请，再修改人员机构');
    if (recordKind === 'meeting-registration') {
      const meeting = tx.get<MeetingData>('meeting', row.meetingId as string);
      if (meeting.data.state !== 'scheduled' && row.state !== 'cancelled' && row.state !== 'declined')
        conflict('会议已取消或结束，不能新增或批准参会意向');
      if (
        tx
          .list<MeetingRegistrationData>('meeting-registration')
          .some(
            (item) =>
              item.id !== id && item.data.meetingId === row.meetingId && item.data.personId === row.personId,
          )
      )
        conflict('此人已有本地参会记录');
    }
    if (
      recordKind === 'crm-contact' &&
      row.personId &&
      tx
        .list<CrmContactData>('crm-contact')
        .some(
          (item) =>
            item.id !== id &&
            item.data.personId === row.personId &&
            item.data.organizationId === row.organizationId,
        )
    )
      conflict('此机构已有该客户联系人');
    if (
      recordKind === 'bookmark' &&
      tx
        .list<BookmarkData>('bookmark')
        .some(
          (item) =>
            item.id !== id &&
            item.data.target.kind === (row.target as LocalTarget).kind &&
            item.data.target.id === (row.target as LocalTarget).id,
        )
    )
      conflict('此本地资料已收藏');
    if (
      recordKind === 'reading-record' &&
      tx
        .list<ReadingRecordData>('reading-record')
        .some(
          (item) =>
            item.id !== id &&
            JSON.stringify(item.data.target) === JSON.stringify(row.target) &&
            item.data.readAt === row.readAt,
        )
    )
      conflict('该资料版本已有相同时间的阅读记录');
    if (
      recordKind === 'access-request' &&
      row.state === 'pending' &&
      tx
        .list<AccessRequestData>('access-request')
        .some(
          (item) =>
            item.id !== id &&
            item.data.state === 'pending' &&
            item.data.organizationId === row.organizationId &&
            item.data.requesterPersonId === row.requesterPersonId &&
            JSON.stringify(item.data.target) === JSON.stringify(row.target),
        )
    )
      conflict('已有同一资料版本的待处理本地申请');
  }

  private transition(
    recordKind: OrganizationKind,
    previous: OrganizationDataByKind[OrganizationKind] | null,
    next: OrganizationDataByKind[OrganizationKind],
  ): void {
    const before = previous as Record<string, JsonValue> | null;
    const after = next as Record<string, JsonValue>;
    const initial: Partial<Record<OrganizationKind, string>> = {
      'meeting-registration': 'requested',
      'access-request': 'pending',
      'share-draft': 'draft',
    };
    if (before === null) {
      if (initial[recordKind] && after.state !== initial[recordKind])
        invalid('请先建立草稿或申请，再记录本地决定');
      return;
    }
    if (recordKind === 'meeting' && before.state !== 'scheduled' && after.state !== before.state)
      conflict('已取消或结束的会议不能重新激活，请创建新会议');
    const immutable: Partial<Record<OrganizationKind, string[]>> = {
      'meeting-registration': ['meetingId', 'personId'],
      'service-record': ['organizationId', 'contactId', 'activity', 'occurredAt', 'source'],
      'reading-record': ['target', 'readAt'],
    };
    for (const field of immutable[recordKind] ?? [])
      if (JSON.stringify(before[field]) !== JSON.stringify(after[field]))
        conflict('记录的事件或身份不可修改，请建立更正记录');
    // An existing local decision cannot silently approve different material or recipients.
    if (
      (recordKind === 'share-draft' || recordKind === 'access-request') &&
      before.state === 'approved-locally' &&
      after.state === 'approved-locally'
    ) {
      const protectedFields =
        recordKind === 'share-draft'
          ? ['target', 'recipientPersonIds', 'recipientOrganizationIds']
          : ['target', 'organizationId', 'requesterPersonId', 'purpose'];
      if (protectedFields.some((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field])))
        conflict('变更资料或接收范围须先回到草稿或待处理状态');
    }
    if (closingIntent(recordKind, next)) {
      const protectedFields =
        recordKind === 'share-draft'
          ? ['target', 'recipientPersonIds', 'recipientOrganizationIds']
          : ['target', 'organizationId', 'requesterPersonId', 'purpose'];
      if (protectedFields.some((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field])))
        conflict('撤销或拒绝只能关闭原有意向，不能同时变更资料或接收范围');
    }
    if (
      recordKind === 'share-draft' &&
      after.state === 'approved-locally' &&
      !['draft', 'approved-locally'].includes(before.state as string)
    )
      conflict('请先恢复草稿，再记录本地批准');
    if (
      recordKind === 'access-request' &&
      after.state === 'approved-locally' &&
      !['pending', 'approved-locally'].includes(before.state as string)
    )
      conflict('请先回到待处理状态，再记录本地批准');
    if (
      recordKind === 'meeting-registration' &&
      after.state === 'approved-locally' &&
      !['requested', 'approved-locally'].includes(before.state as string)
    )
      conflict('请先重新申请，再记录本地批准');
  }

  get<K extends OrganizationKind>(
    context: ServerContext,
    request: GetOrganizationRecordRequest<K>,
  ): OrganizationRecord<K> {
    const input = object(request, ['kind', 'id', 'includeDeleted']);
    const recordKind = choice(input.kind, kinds) as K,
      id = identifier(input.id);
    const includeDeleted = has(input, 'includeDeleted') ? flag(input.includeDeleted) : false;
    return this.store.read(context, (tx) =>
      tx.get<OrganizationDataByKind[K]>(recordKind, id, includeDeleted),
    );
  }

  list<K extends OrganizationKind>(
    context: ServerContext,
    request: ListOrganizationRecordsRequest<K>,
  ): OrganizationRecordPage<K> {
    const filterFields = [
      'organizationId',
      'personId',
      'meetingId',
      'contactId',
      'parentId',
      'state',
      'category',
      'stage',
      'activity',
      'followed',
    ];
    const input = object(request, [
      'kind',
      'includeDeleted',
      'query',
      ...filterFields,
      'targetKind',
      'targetId',
      'from',
      'to',
      'limit',
      'offset',
      'sortBy',
      'direction',
    ]);
    const recordKind = choice(input.kind, kinds) as K;
    const includeDeleted = has(input, 'includeDeleted') ? flag(input.includeDeleted) : false;
    const query = has(input, 'query') ? text(input.query, 600, true).toLowerCase() : '';
    const limit = has(input, 'limit') ? integer(input.limit, 1, 200) : 50;
    const offset = has(input, 'offset') ? integer(input.offset, 0, 10_000) : 0;
    const sortBy = has(input, 'sortBy')
      ? choice(input.sortBy, ['createdAt', 'updatedAt', 'name', 'date'])
      : 'createdAt';
    const direction = has(input, 'direction') ? choice(input.direction, ['asc', 'desc']) : 'asc';
    const timeField = dateField(recordKind);
    if ((!timeField && (has(input, 'from') || has(input, 'to'))) || (sortBy === 'date' && !timeField))
      invalid('此记录类型不支持日期筛选或排序');
    const { from, to } = dateRange(input);
    const filters: Record<string, JsonValue> = {};
    for (const field of filterFields)
      if (has(input, field)) {
        if (!fields[recordKind].includes(field)) invalid('此记录类型不支持所选筛选');
        filters[field] = normalizeField(recordKind, field, input[field]);
      }
    const targetKind = has(input, 'targetKind') ? choice(input.targetKind, targetKinds) : null;
    const targetId = has(input, 'targetId') ? identifier(input.targetId) : null;
    if ((targetKind || targetId) && !fields[recordKind].includes('target'))
      invalid('此记录类型不支持资料筛选');
    if (targetId && !targetKind) invalid('资料 ID 筛选需要资料类型');
    return this.store.read(context, (tx) => {
      for (const [field, value] of Object.entries(filters)) {
        const referenceKind =
          field === 'parentId' || field === 'organizationId'
            ? 'organization'
            : field === 'personId'
              ? 'person'
              : field === 'meetingId'
                ? 'meeting'
                : field === 'contactId'
                  ? 'crm-contact'
                  : null;
        if (referenceKind && value !== null) tx.get(referenceKind, value as string, includeDeleted);
      }
      if (targetId && targetKind) tx.get(targetKind, targetId, includeDeleted);
      const matched = tx.list<OrganizationDataByKind[K]>(recordKind, includeDeleted).filter((item) => {
        const data = item.data as Record<string, JsonValue>;
        return (
          Object.entries(filters).every(([key, value]) => data[key] === value) &&
          (!query ||
            Object.values(data).some(
              (value) =>
                (typeof value === 'string' && value.toLowerCase().includes(query)) ||
                (Array.isArray(value) &&
                  value.some((entry) => typeof entry === 'string' && entry.toLowerCase().includes(query))),
            )) &&
          (!timeField || matchesRange(data[timeField] as string, from, to)) &&
          (!targetKind || (data.target as LocalTarget).kind === targetKind) &&
          (!targetId || (data.target as LocalTarget).id === targetId)
        );
      });
      const sortValue = (item: OrganizationRecord<K>): string => {
        const row = item.data as Record<string, JsonValue>;
        return sortBy === 'name'
          ? String(row.name ?? row.title ?? row.summary ?? '')
          : sortBy === 'date'
            ? (row[timeField!] as string)
            : item[sortBy];
      };
      matched.sort(
        (a, b) =>
          (sortValue(a).localeCompare(sortValue(b)) || a.id.localeCompare(b.id)) *
          (direction === 'asc' ? 1 : -1),
      );
      const items: OrganizationRecord<K>[] = [];
      let bytes = 0;
      for (const item of matched.slice(offset, offset + limit)) {
        const size = Buffer.byteLength(JSON.stringify(item));
        if (items.length && bytes + size > 512 * 1024) break;
        items.push(item);
        bytes += size;
      }
      const next = offset + items.length;
      return { items, total: matched.length, offset, nextOffset: next < matched.length ? next : null };
    });
  }

  create<K extends OrganizationKind>(
    context: ServerContext,
    request: CreateOrganizationRecordRequest<K>,
  ): OrganizationRecord<K> {
    const key = rawCommandKey(request);
    return this.store.writeOrganizationCommand(context,key,'organization.create',request,()=>{
    const input = object(request, ['kind', 'data', 'id', 'idempotencyKey']);
    const recordKind = commandKind(input.kind) as K;
    const data = dataFor(recordKind, input.data),
      id = has(input, 'id') ? identifier(input.id) : null;
    this.transition(recordKind, null, data);
    return {request: { operation: 'organization.create', kind: recordKind, id, data },
      action: (tx:DomainWriteTransaction) => {
        this.relations(tx, recordKind, id, data);
        return id === null ? tx.create(recordKind, data) : tx.create(recordKind, data, id);
      }};
    }, eligibleRejection);
  }

  update<K extends OrganizationKind>(
    context: ServerContext,
    request: UpdateOrganizationRecordRequest<K>,
  ): OrganizationRecord<K> {
    const key = rawCommandKey(request);
    return this.store.writeOrganizationCommand(context,key,'organization.update',request,()=>{
    const input = object(request, ['kind', 'id', 'expectedRevision', 'patch', 'idempotencyKey']);
    const recordKind = commandKind(input.kind) as K,
      id = identifier(input.id);
    const expectedRevision = integer(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER),
      patch = patchData(recordKind, input.patch);
    if (!Object.keys(patch).length) invalid('修改至少需要一个字段');
    return {request: { operation: 'organization.update', kind: recordKind, id, expectedRevision, patch },
      action: (tx:DomainWriteTransaction) => {
        const previous = tx.get<OrganizationDataByKind[K]>(recordKind, id);
        revision(previous, expectedRevision);
        const editable = Object.fromEntries(
          Object.entries(previous.data).filter(([field]) => fields[recordKind].includes(field)),
        );
        const data = dataFor(recordKind, { ...editable, ...patch });
        this.transition(recordKind, previous.data, data);
        this.relations(tx, recordKind, id, data, closingIntent(recordKind, data));
        return JSON.stringify(previous.data) === JSON.stringify(data)
          ? previous
          : tx.update(recordKind, id, expectedRevision, data);
      }};
    }, eligibleRejection);
  }

  /** Deletion is distinct from cancelling a meeting, registration, or local sharing intent. */
  remove<K extends OrganizationKind>(
    context: ServerContext,
    request: MutateOrganizationRecordRequest<K>,
  ): OrganizationRecord<K> {
    return this.mutate(context, request, 'remove');
  }
  /** Live parents, current target revisions and uniqueness are revalidated before restore. */
  restore<K extends OrganizationKind>(
    context: ServerContext,
    request: MutateOrganizationRecordRequest<K>,
  ): OrganizationRecord<K> {
    return this.mutate(context, request, 'restore');
  }
  private mutate<K extends OrganizationKind>(
    context: ServerContext,
    request: MutateOrganizationRecordRequest<K>,
    operation: 'remove' | 'restore',
  ): OrganizationRecord<K> {
    const key = rawCommandKey(request);
    return this.store.writeOrganizationCommand(context,key,`organization.${operation}`,request,()=>{
    const input = object(request, ['kind', 'id', 'expectedRevision', 'idempotencyKey']);
    const recordKind = commandKind(input.kind) as K,
      id = identifier(input.id);
    const expectedRevision = integer(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER);
    return {request: { operation: `organization.${operation}`, kind: recordKind, id, expectedRevision },
      action: (tx:DomainWriteTransaction) => {
        const previous = tx.get<OrganizationDataByKind[K]>(recordKind, id, true);
        revision(previous, expectedRevision);
        if (operation === 'remove') {
          if (previous.deletedAt !== null) return previous;
          for (const candidateKind of kinds)
            if (
              tx
                .list<OrganizationDataByKind[OrganizationKind]>(candidateKind)
                .some((item) =>
                  edges(candidateKind, item.data).some((edge) => edge.kind === recordKind && edge.id === id),
                )
            )
              conflict('此记录仍被本地记录引用，请先整理关联项');
          return tx.softDelete(recordKind, id, expectedRevision) as OrganizationRecord<K>;
        }
        if (previous.deletedAt === null) return previous;
        this.relations(tx, recordKind, id, previous.data);
        return tx.restore(recordKind, id, expectedRevision) as OrganizationRecord<K>;
      }};
    }, eligibleRejection);
  }

  /** Counts local service facts, never unique audience, delivery, provider telemetry, or imported counters. */
  serviceStatistics(context: ServerContext, request: ServiceStatisticsRequest = {}): ServiceStatistics {
    const input = object(request, ['organizationId', 'contactId', 'from', 'to']);
    const organizationId = has(input, 'organizationId') ? identifier(input.organizationId) : null;
    const contactId = has(input, 'contactId') ? identifier(input.contactId) : null;
    const { from, to } = dateRange(input);
    return this.store.read(context, (tx) => {
      if (organizationId) tx.get('organization', organizationId);
      if (contactId) {
        const contact = tx.get<CrmContactData>('crm-contact', contactId);
        if (organizationId && contact.data.organizationId !== organizationId)
          conflict('客户与统计机构不一致');
      }
      const records = tx
        .list<ServiceRecordData>('service-record')
        .filter(
          (item) =>
            (!organizationId || item.data.organizationId === organizationId) &&
            (!contactId || item.data.contactId === contactId) &&
            matchesRange(item.data.occurredAt, from, to),
        );
      if (records.length > 2000) invalid('统计最多包含 2000 条事实，请缩小日期或机构范围');
      const byActivity: Record<ServiceActivity, number> = {
        'content-read': 0,
        meeting: 0,
        call: 0,
        email: 0,
        other: 0,
      };
      const groups = new Map<string, number>();
      for (const record of records) {
        byActivity[record.data.activity]++;
        groups.set(record.data.organizationId, (groups.get(record.data.organizationId) ?? 0) + 1);
      }
      return {
        total: records.length,
        byActivity,
        byOrganization: [...groups.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([organizationId, total]) => ({ organizationId, total })),
        events: records
          .sort((a, b) => a.data.occurredAt.localeCompare(b.data.occurredAt) || a.id.localeCompare(b.id))
          .map(({ id, revision, data }) => ({
            id,
            revision,
            activity: data.activity,
            occurredAt: data.occurredAt,
            organizationId: data.organizationId,
          })),
        provenance: 'user-recorded-local',
        externalDeliveryVerified: false,
      };
    });
  }

  /** Compare a stored pointer with its current local source. It never returns or authorizes source content. */
  inspectTarget(
    context: ServerContext,
    request: { target: LocalTarget },
  ): { target: LocalTarget; currentRevision: number; state: 'current' | 'changed'; localOnly: true } {
    const input = object(request, ['target']),
      reference = target(input.target);
    return this.store.read(context, (tx) => {
      const record = tx.get(reference.kind, reference.id);
      if (reference.revision > record.revision) conflict('资料版本不存在');
      return {
        target: reference,
        currentRevision: record.revision,
        state: reference.revision === record.revision ? 'current' : 'changed',
        localOnly: true,
      };
    });
  }

  /** Download-only passive VEVENT. No METHOD, invitations, attendees, alarms, URLs, or calendar integration. */
  exportMeetingIcs(
    context: ServerContext,
    request: { id: string; expectedRevision?: number },
  ): MeetingIcsExport {
    const input = object(request, ['id', 'expectedRevision']),
      id = identifier(input.id);
    const expected = has(input, 'expectedRevision')
      ? integer(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER)
      : null;
    return this.store.read(context, (tx) => {
      const meeting = tx.get<MeetingData>('meeting', id);
      if (expected !== null) revision(meeting, expected);
      const data = meeting.data;
      const uid = createHash('sha256')
        .update(JSON.stringify([context.principal.tenantId, context.principal.subjectId, id]))
        .digest('hex');
      const timestamp = (value: string) => value.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Open Research Workspace//Local Agenda//EN',
        'CALSCALE:GREGORIAN',
        'BEGIN:VEVENT',
        `UID:${uid}@local.invalid`,
        `DTSTAMP:${timestamp(meeting.updatedAt)}`,
        `SEQUENCE:${meeting.revision - 1}`,
        `DTSTART:${timestamp(data.startsAt)}`,
        `DTEND:${timestamp(data.endsAt)}`,
        `SUMMARY:${icsText(data.title)}`,
        `DESCRIPTION:${icsText(data.description)}`,
        `LOCATION:${icsText(data.location)}`,
        `X-LOCAL-TIMEZONE:${icsText(data.timezone)}`,
        'X-LOCAL-ONLY:TRUE',
        `STATUS:${data.state === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
        'END:VEVENT',
        'END:VCALENDAR',
      ];
      return {
        filename: `meeting-${id}.ics`,
        mediaType: 'text/calendar; charset=utf-8',
        content: lines.map(foldIcs).join('\r\n') + '\r\n',
        localOnly: true,
      };
    });
  }
}
function icsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}
function foldIcs(value: string): string {
  const lines: string[] = [];
  let line = '',
    bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 75) {
      lines.push(line);
      line = ' ';
      bytes = 1;
    }
    line += character;
    bytes += size;
  }
  lines.push(line);
  return lines.join('\r\n');
}
