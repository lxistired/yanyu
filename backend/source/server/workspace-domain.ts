import { types as nodeTypes } from 'node:util';
import { AdapterError, type ServerContext } from '../shared/contracts';
import type { DomainRecord, DomainTransaction, JsonValue } from '../shared/workspace';
import type { DomainStore } from './workspace-store';

/** Original local workbench data. Nothing in this module executes message content or fetches quotes. */
export type WorkspaceKind =
  'workspace' | 'session-group' | 'session' | 'message' | 'watchlist' | 'watchlist-item';
export type WorkspaceData = { name: string; parentId: string | null; description: string };
export type SessionGroupData = { name: string; workspaceId: string; parentId: string | null };
export type SessionData = {
  title: string;
  workspaceId: string;
  groupId: string | null;
  pinned: boolean;
  mode: 'quick' | 'deep' | 'plan' | 'daily';
  /** A preference label only; selecting a model does not configure or invoke a provider. */
  model: string;
};
export type MessageData = {
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Owner-wide creation order, assigned only by the server. Absent on legacy records. */
  sequence?: number;
};
export type WatchlistData = { name: string; workspaceId: string; description: string };
export type WatchlistItemData = {
  watchlistId: string;
  symbol: string;
  market: string;
  name: string;
  notes: string;
};
export type WorkspaceDataByKind = {
  workspace: WorkspaceData;
  'session-group': SessionGroupData;
  session: SessionData;
  message: MessageData;
  watchlist: WatchlistData;
  'watchlist-item': WatchlistItemData;
};
export type WorkspaceInputDataByKind = Omit<WorkspaceDataByKind, 'message'> & {
  message: Omit<MessageData, 'sequence'>;
};
export type WorkspaceRecord<K extends WorkspaceKind = WorkspaceKind> = DomainRecord<WorkspaceDataByKind[K]>;
export interface GetWorkspaceRecordRequest<K extends WorkspaceKind = WorkspaceKind> {
  kind: K;
  id: string;
  includeDeleted?: boolean;
}
export interface ListWorkspaceRecordsRequest<K extends WorkspaceKind = WorkspaceKind> {
  kind: K;
  includeDeleted?: boolean;
  query?: string;
  workspaceId?: string;
  parentId?: string | null;
  groupId?: string | null;
  sessionId?: string;
  watchlistId?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'name' | 'sequence';
  direction?: 'asc' | 'desc';
}
/** Supplied only by trusted composition after protected generated-turn authorization. */
export interface TrustedSessionSearchMatches {
  sessionIds: readonly string[];
  truncated: boolean;
}
export interface WorkspaceRecordPage<K extends WorkspaceKind = WorkspaceKind> {
  generatedSearchTruncated?: boolean;
  items: WorkspaceRecord<K>[];
  total: number;
  offset: number;
  nextOffset: number | null;
}
export interface CreateWorkspaceRecordRequest<K extends WorkspaceKind = WorkspaceKind> {
  kind: K;
  data: Partial<WorkspaceInputDataByKind[K]>;
  id?: string;
  idempotencyKey: string;
}
export interface UpdateWorkspaceRecordRequest<K extends WorkspaceKind = WorkspaceKind> {
  kind: K;
  id: string;
  expectedRevision: number;
  patch: Partial<WorkspaceInputDataByKind[K]>;
  idempotencyKey: string;
}
export interface WorkspaceRecordIdentity<K extends WorkspaceKind = WorkspaceKind> {
  kind: K;
  id: string;
  expectedRevision: number;
}
export interface MutateWorkspaceRecordRequest<
  K extends WorkspaceKind = WorkspaceKind,
> extends WorkspaceRecordIdentity<K> {
  idempotencyKey: string;
}
export interface BatchDeleteWorkspaceRecordsRequest {
  items: WorkspaceRecordIdentity[];
  idempotencyKey: string;
}
export type WorkspaceMutationSummary = {
  kind: WorkspaceKind;
  id: string;
  revision: number;
  deletedAt: string | null;
};
export interface ImportWatchlistRequest {
  watchlistId: string;
  items: Array<Partial<Omit<WatchlistItemData, 'watchlistId'>> & { symbol: string }>;
  idempotencyKey: string;
}
export interface ImportWatchlistResult {
  created: WorkspaceRecord<'watchlist-item'>[];
  /** Duplicate entries in the request and entries already in the list are not overwritten. */
  skipped: Array<{ symbol: string; market: string; existingId: string }>;
}

const kinds: readonly WorkspaceKind[] = [
  'workspace',
  'session-group',
  'session',
  'message',
  'watchlist',
  'watchlist-item',
];
const fields: Record<WorkspaceKind, readonly string[]> = {
  workspace: ['name', 'parentId', 'description'],
  'session-group': ['name', 'workspaceId', 'parentId'],
  session: ['title', 'workspaceId', 'groupId', 'pinned', 'mode', 'model'],
  message: ['sessionId', 'role', 'content'],
  watchlist: ['name', 'workspaceId', 'description'],
  'watchlist-item': ['watchlistId', 'symbol', 'market', 'name', 'notes'],
};
const deterministicRejections = new WeakSet<object>();
const fail = (message: string): never => {
  const cause = new AdapterError('INVALID_REQUEST', message); deterministicRejections.add(cause); throw cause;
};
const conflict = (message: string): never => {
  const cause = new AdapterError('CONFLICT', message); deterministicRejections.add(cause); throw cause;
};
const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function object(value: unknown, allowed: readonly string[], label = '请求'): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    return fail(`${label}必须是普通对象`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.includes(key) || !('value' in descriptor) || descriptor.value === undefined)
      return fail(`${label}包含不支持的字段：${key}`);
  }
  return value as Record<string, unknown>;
}
function kind(value: unknown): WorkspaceKind {
  if (typeof value !== 'string' || !kinds.includes(value as WorkspaceKind))
    return fail('不支持的工作区记录类型');
  return value as WorkspaceKind;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) return fail('无效的本地资料 ID');
  return value;
}
function nullableId(value: unknown): string | null {
  return value === null ? null : identifier(value);
}
function text(value: unknown, maximum: number, label: string, empty = false, trim = true): string {
  if (typeof value !== 'string') return fail(`${label}必须是文本`);
  const result = trim ? value.trim() : value;
  if ((!empty && !result.trim()) || Buffer.byteLength(result, 'utf8') > maximum || result.includes('\0'))
    return fail(`${label}为空、过长或包含空字符`);
  return result;
}
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') return fail('开关必须是布尔值');
  return value;
}
function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    return fail(`${label}超出范围`);
  return value;
}
function choice<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) return fail(`${label}无效`);
  return value as T;
}
function commandKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value))
    return fail('需要 1–100 字符的幂等键');
  return value;
}
/** Routing/key validation is deliberately outside the receipt engine and is never proof. */
function commandEnvelope(request: unknown, operation: string): string {
  try {
    if (!request || typeof request !== 'object' || Array.isArray(request) || nodeTypes.isProxy(request)) throw 0;
    const keyDescriptor = Object.getOwnPropertyDescriptor(request, 'idempotencyKey');
    if (!keyDescriptor || !('value' in keyDescriptor)) throw 0;
    const key = commandKey(keyDescriptor.value);
    const descriptors = Object.getOwnPropertyDescriptors(request);
    const checkedKind = (value: unknown) => { if (typeof value !== 'string' || !kinds.includes(value as WorkspaceKind)) throw 0; };
    if (operation !== 'importWatchlist' && operation !== 'batchDelete') {
      if (!descriptors.kind || !('value' in descriptors.kind)) throw 0;
      checkedKind(descriptors.kind.value);
    }
    if (operation === 'batchDelete' && descriptors.items && 'value' in descriptors.items && Array.isArray(descriptors.items.value)) {
      const items = descriptors.items.value;
      if (nodeTypes.isProxy(items)) throw 0;
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(items))) {
        if (name === 'length') continue;
        if (!('value' in descriptor)) throw 0;
        const item = descriptor.value;
        if (!item || typeof item !== 'object' || nodeTypes.isProxy(item)) throw 0;
        const kd = Object.getOwnPropertyDescriptor(item, 'kind');
        if (!kd || !('value' in kd)) throw 0;
        checkedKind(kd.value);
      }
    }
    return key;
  } catch { throw new AdapterError('INVALID_REQUEST', 'Invalid workspace command envelope'); }
}
function normalizeField(field: string, value: unknown, recordKind: WorkspaceKind): JsonValue {
  switch (field) {
    case 'workspaceId':
    case 'sessionId':
    case 'watchlistId':
      return identifier(value);
    case 'parentId':
    case 'groupId':
      return nullableId(value);
    case 'pinned':
      return flag(value);
    case 'mode':
      return choice(value, ['quick', 'deep', 'plan', 'daily'], '研究模式');
    case 'role':
      return choice(value, ['user', 'assistant', 'system'], '消息角色');
    case 'name':
      return text(value, 480, '名称', recordKind === 'watchlist-item');
    case 'title':
      return text(value, 720, '标题');
    case 'description':
      return text(value, 12_000, '说明', true);
    case 'content':
      return text(value, 65_536, '消息正文', false, false);
    case 'model':
      return text(value, 240, '模型偏好', true);
    case 'notes':
      return text(value, 16_000, '备注', true, false);
    case 'symbol': {
      const symbol = text(value, 40, '证券代码').toUpperCase();
      if (!/^[A-Z0-9^][A-Z0-9.^:_/-]{0,39}$/.test(symbol) || symbol.includes('://') || symbol.includes('//'))
        return fail('证券代码格式无效');
      return symbol;
    }
    case 'market': {
      const market = text(value, 32, '市场').toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(market)) return fail('市场格式无效');
      return market;
    }
    default:
      return fail('不支持的记录字段');
  }
}
function patchData(recordKind: WorkspaceKind, raw: unknown): Record<string, JsonValue> {
  const input = object(raw, fields[recordKind], '记录');
  const output: Record<string, JsonValue> = {};
  for (const field of fields[recordKind])
    if (has(input, field)) output[field] = normalizeField(field, input[field], recordKind);
  return output;
}
function createData<K extends WorkspaceKind>(recordKind: K, raw: unknown): WorkspaceDataByKind[K] {
  const defaults: Record<WorkspaceKind, Record<string, JsonValue>> = {
    workspace: { parentId: null, description: '' },
    'session-group': { parentId: null },
    session: { groupId: null, pinned: false, mode: 'quick', model: '' },
    message: { role: 'user' },
    watchlist: { description: '' },
    'watchlist-item': { market: 'UNSPECIFIED', name: '', notes: '' },
  };
  const merged = { ...defaults[recordKind], ...patchData(recordKind, raw) };
  for (const field of fields[recordKind]) if (!has(merged, field)) fail(`记录缺少字段：${field}`);
  return merged as WorkspaceDataByKind[K];
}
function checkRevision(record: DomainRecord, expectedRevision: number): void {
  if (record.revision !== expectedRevision) conflict('本地记录已更改，请刷新后重试');
}
function identity(raw: unknown): WorkspaceRecordIdentity {
  const input = object(raw, ['kind', 'id', 'expectedRevision']);
  return {
    kind: kind(input.kind),
    id: identifier(input.id),
    expectedRevision: integer(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER, '版本'),
  };
}
const recordKey = (record: { kind: string; id: string }) => `${record.kind}:${record.id}`;
const summary = (record: DomainRecord): WorkspaceMutationSummary => ({
  kind: kind(record.kind),
  id: record.id,
  revision: record.revision,
  deletedAt: record.deletedAt,
});

/** ServerContext is always constructed by the server. Request bodies cannot select an owner. */
export class WorkspaceDomain {
  constructor(private readonly store: DomainStore) {}

  private relations<K extends WorkspaceKind>(
    tx: DomainTransaction,
    recordKind: K,
    id: string | null,
    data: WorkspaceDataByKind[K],
  ): void {
    const row = data as Record<string, JsonValue>;
    if (recordKind === 'workspace') {
      let parentId = row.parentId as string | null;
      const seen = new Set<string>(id === null ? [] : [id]);
      while (parentId !== null) {
        if (seen.has(parentId)) conflict('工作区不能移入自身或其子工作区');
        seen.add(parentId);
        const parent = tx.get<WorkspaceData>('workspace', parentId);
        parentId = parent.data.parentId;
      }
    }
    if (recordKind === 'session-group' || recordKind === 'session' || recordKind === 'watchlist')
      tx.get('workspace', row.workspaceId as string);
    if (recordKind === 'session-group') {
      let parentId = row.parentId as string | null;
      const seen = new Set<string>(id === null ? [] : [id]);
      while (parentId !== null) {
        if (seen.has(parentId)) conflict('会话组不能移入自身或其子组');
        seen.add(parentId);
        const parent = tx.get<SessionGroupData>('session-group', parentId);
        if (parent.data.workspaceId !== row.workspaceId) conflict('会话组必须属于同一工作区');
        parentId = parent.data.parentId;
      }
      // A group's subtree is moved explicitly, rather than silently leaving children in another workspace.
      if (
        id !== null &&
        (tx
          .list<SessionGroupData>('session-group')
          .some((child) => child.data.parentId === id && child.data.workspaceId !== row.workspaceId) ||
          tx
            .list<SessionData>('session')
            .some((child) => child.data.groupId === id && child.data.workspaceId !== row.workspaceId))
      )
        conflict('请先移动子组和会话，再跨工作区移动此组');
    }
    if (recordKind === 'session' && row.groupId !== null) {
      const group = tx.get<SessionGroupData>('session-group', row.groupId as string);
      if (group.data.workspaceId !== row.workspaceId) conflict('会话和分组必须属于同一工作区');
    }
    if (recordKind === 'message') tx.get('session', row.sessionId as string);
    if (recordKind === 'watchlist-item') {
      tx.get('watchlist', row.watchlistId as string);
      const duplicate = tx
        .list<WatchlistItemData>('watchlist-item')
        .find(
          (item) =>
            item.id !== id &&
            item.data.watchlistId === row.watchlistId &&
            item.data.market === row.market &&
            item.data.symbol === row.symbol,
        );
      if (duplicate) conflict('该证券已在此自选列表中');
    }
  }

  private children(tx: DomainTransaction, recordKind: WorkspaceKind, id: string): WorkspaceRecord[] {
    switch (recordKind) {
      case 'workspace':
        return [
          ...tx.list<WorkspaceData>('workspace').filter((row) => row.data.parentId === id),
          ...tx.list<SessionGroupData>('session-group').filter((row) => row.data.workspaceId === id),
          ...tx.list<SessionData>('session').filter((row) => row.data.workspaceId === id),
          ...tx.list<WatchlistData>('watchlist').filter((row) => row.data.workspaceId === id),
        ];
      case 'session-group':
        return [
          ...tx.list<SessionGroupData>('session-group').filter((row) => row.data.parentId === id),
          ...tx.list<SessionData>('session').filter((row) => row.data.groupId === id),
        ];
      case 'session':
        return tx.list<MessageData>('message').filter((row) => row.data.sessionId === id);
      case 'watchlist':
        return tx.list<WatchlistItemData>('watchlist-item').filter((row) => row.data.watchlistId === id);
      default:
        return [];
    }
  }

  /** Build the owner-scoped dependency graph once for bulk operations, including both group edges. */
  private childIndex(tx: DomainTransaction): Map<string, WorkspaceRecord[]> {
    const index = new Map<string, WorkspaceRecord[]>();
    const add = (parentKind: WorkspaceKind, parentId: JsonValue | undefined, record: WorkspaceRecord) => {
      if (typeof parentId !== 'string') return;
      const key = recordKey({ kind: parentKind, id: parentId });
      const children = index.get(key) ?? [];
      children.push(record);
      index.set(key, children);
    };
    for (const recordKind of kinds) {
      for (const record of tx.list<WorkspaceDataByKind[WorkspaceKind]>(recordKind)) {
        const data = record.data as Record<string, JsonValue>;
        if (recordKind === 'workspace') add('workspace', data.parentId, record);
        if (recordKind === 'session-group' || recordKind === 'session' || recordKind === 'watchlist')
          add('workspace', data.workspaceId, record);
        if (recordKind === 'session-group') add('session-group', data.parentId, record);
        if (recordKind === 'session') add('session-group', data.groupId, record);
        if (recordKind === 'message') add('session', data.sessionId, record);
        if (recordKind === 'watchlist-item') add('watchlist', data.watchlistId, record);
      }
    }
    return index;
  }

  get<K extends WorkspaceKind>(
    context: ServerContext,
    request: GetWorkspaceRecordRequest<K>,
  ): WorkspaceRecord<K> {
    const input = object(request, ['kind', 'id', 'includeDeleted']);
    const recordKind = kind(input.kind) as K;
    const id = identifier(input.id);
    const includeDeleted = has(input, 'includeDeleted') ? flag(input.includeDeleted) : false;
    return this.store.read(context, (tx) => tx.get<WorkspaceDataByKind[K]>(recordKind, id, includeDeleted));
  }

  list<K extends WorkspaceKind>(
    context: ServerContext,
    request: ListWorkspaceRecordsRequest<K>,
    trustedMatches?: TrustedSessionSearchMatches,
  ): WorkspaceRecordPage<K> {
    const input = object(request, [
      'kind',
      'includeDeleted',
      'query',
      'workspaceId',
      'parentId',
      'groupId',
      'sessionId',
      'watchlistId',
      'pinned',
      'limit',
      'offset',
      'sortBy',
      'direction',
    ]);
    const recordKind = kind(input.kind) as K;
    const includeDeleted = has(input, 'includeDeleted') ? flag(input.includeDeleted) : false;
    const query = has(input, 'query') ? text(input.query, 600, '查询', true).toLocaleLowerCase() : '';
    if (
      trustedMatches &&
      (recordKind !== 'session' ||
        !query ||
        !Array.isArray(trustedMatches.sessionIds) ||
        trustedMatches.sessionIds.length > 200 ||
        typeof trustedMatches.truncated !== 'boolean')
    )
      fail('受保护会话搜索结果无效');
    const trustedIds = trustedMatches?.sessionIds.map((value) => identifier(value)) ?? [];
    const limit = has(input, 'limit') ? integer(input.limit, 1, 200, '分页大小') : 50;
    const offset = has(input, 'offset') ? integer(input.offset, 0, 10_000, '分页位置') : 0;
    const sortBy = has(input, 'sortBy')
      ? choice(input.sortBy, ['createdAt', 'updatedAt', 'name', 'sequence'], '排序')
      : recordKind === 'session'
        ? 'updatedAt'
        : recordKind === 'message'
          ? 'sequence'
          : 'createdAt';
    if (sortBy === 'sequence' && recordKind !== 'message') fail('只有消息支持序列排序');
    const direction = has(input, 'direction')
      ? choice(input.direction, ['asc', 'desc'], '排序方向')
      : recordKind === 'session'
        ? 'desc'
        : 'asc';
    const filters: Record<string, JsonValue> = {};
    for (const field of ['workspaceId', 'parentId', 'groupId', 'sessionId', 'watchlistId', 'pinned']) {
      if (!has(input, field)) continue;
      if (!fields[recordKind].includes(field)) fail(`此记录类型不支持筛选：${field}`);
      filters[field] = normalizeField(field, input[field], recordKind);
    }
    return this.store.read(context, (tx) => {
      // Validate filters too: a foreign/deleted reference is not a way to inspect another owner's data.
      for (const [field, value] of Object.entries(filters)) {
        if (value === null || field === 'pinned') continue;
        const target: WorkspaceKind =
          field === 'workspaceId'
            ? 'workspace'
            : field === 'groupId'
              ? 'session-group'
              : field === 'sessionId'
                ? 'session'
                : field === 'watchlistId'
                  ? 'watchlist'
                  : recordKind;
        tx.get(target, value as string, includeDeleted);
      }
      const matchedSessions = new Set<string>(trustedIds);
      const sessionActivity = new Map<string, { at: string; sequence: number }>();
      if (recordKind === 'session') {
        for (const message of tx.list<MessageData>('message', includeDeleted)) {
          if (query && message.data.content.toLocaleLowerCase().includes(query))
            matchedSessions.add(message.data.sessionId);
          const previous = sessionActivity.get(message.data.sessionId);
          const sequence = message.data.sequence ?? 0;
          if (
            !previous ||
            message.updatedAt > previous.at ||
            (message.updatedAt === previous.at && sequence > previous.sequence)
          )
            sessionActivity.set(message.data.sessionId, { at: message.updatedAt, sequence });
        }
      }
      const matches = tx.list<WorkspaceDataByKind[K]>(recordKind, includeDeleted).filter((record) => {
        const data = record.data as Record<string, JsonValue>;
        return (
          Object.entries(filters).every(([field, value]) => data[field] === value) &&
          (!query ||
            matchedSessions.has(record.id) ||
            ['name', 'title', 'description', 'content', 'notes', 'symbol', 'market'].some(
              (field) =>
                typeof data[field] === 'string' &&
                (data[field] as string).toLocaleLowerCase().includes(query),
            ))
        );
      });
      const label = (record: WorkspaceRecord<K>) =>
        String(
          (record.data as Record<string, JsonValue>).name ??
            (record.data as Record<string, JsonValue>).title ??
            record.id,
        );
      matches.sort((a, b) => {
        if (recordKind === 'session') {
          const pinned = Number((b.data as SessionData).pinned) - Number((a.data as SessionData).pinned);
          if (pinned) return pinned;
        }
        let order = 0;
        if (sortBy === 'sequence') {
          const left = a.data as MessageData;
          const right = b.data as MessageData;
          // Legacy messages sort before sequenced messages, by their existing timestamp and ID.
          // No read rewrites old records or invents persisted sequence values.
          order =
            left.sessionId.localeCompare(right.sessionId) ||
            Number(left.sequence !== undefined) - Number(right.sequence !== undefined) ||
            (left.sequence ?? 0) - (right.sequence ?? 0) ||
            a.createdAt.localeCompare(b.createdAt);
        } else if (sortBy === 'updatedAt' && recordKind === 'session') {
          const left = sessionActivity.get(a.id);
          const right = sessionActivity.get(b.id);
          const leftAt = left && left.at > a.updatedAt ? left.at : a.updatedAt;
          const rightAt = right && right.at > b.updatedAt ? right.at : b.updatedAt;
          order = leftAt.localeCompare(rightAt) || (left?.sequence ?? 0) - (right?.sequence ?? 0);
        } else {
          const left = sortBy === 'name' ? label(a) : a[sortBy];
          const right = sortBy === 'name' ? label(b) : b[sortBy];
          order = left < right ? -1 : left > right ? 1 : 0;
        }
        return (order || a.id.localeCompare(b.id)) * (direction === 'asc' ? 1 : -1);
      });
      // DomainStore bounds serialized reads to 1 MiB. Content-heavy pages use a smaller byte window.
      const items: WorkspaceRecord<K>[] = [];
      let bytes = 0;
      for (const record of matches.slice(offset, offset + limit)) {
        const size = Buffer.byteLength(JSON.stringify(record));
        if (items.length && bytes + size > 512 * 1024) break;
        items.push(record);
        bytes += size;
      }
      const next = offset + items.length;
      return {
        items,
        total: matches.length,
        offset,
        nextOffset: next < matches.length ? next : null,
        ...(trustedMatches ? { generatedSearchTruncated: trustedMatches.truncated } : {}),
      };
    });
  }

  create<K extends WorkspaceKind>(
    context: ServerContext,
    request: CreateWorkspaceRecordRequest<K>,
  ): WorkspaceRecord<K> {
    const outerKey = commandEnvelope(request, 'create');
    return this.store.writeWorkspaceCommand(context, outerKey, 'workspace.create', request, () => {
    const input = object(request, ['kind', 'data', 'id', 'idempotencyKey']);
    const recordKind = kind(input.kind) as K;
    const data = createData(recordKind, input.data);
    const id = has(input, 'id') ? identifier(input.id) : null;
    commandKey(input.idempotencyKey);
    return {request: { operation: 'workspace.create', kind: recordKind, id, data },
      action: (tx) => {
        this.relations(tx, recordKind, id, data);
        let storedData = data;
        if (recordKind === 'message') {
          const messages = tx.list<MessageData>('message', true);
          const maximum = messages.reduce(
            (value, row) => Math.max(value, row.data.sequence ?? 0),
            messages.length,
          );
          if (!Number.isSafeInteger(maximum) || maximum >= Number.MAX_SAFE_INTEGER) fail('消息序列达到上限');
          storedData = { ...data, sequence: maximum + 1 };
        }
        return id === null ? tx.create(recordKind, storedData) : tx.create(recordKind, storedData, id);
      },
    };
    }, cause => !!cause && typeof cause === 'object' && deterministicRejections.has(cause));
  }

  update<K extends WorkspaceKind>(
    context: ServerContext,
    request: UpdateWorkspaceRecordRequest<K>,
  ): WorkspaceRecord<K> {
    const outerKey = commandEnvelope(request, 'update');
    return this.store.writeWorkspaceCommand(context, outerKey, 'workspace.update', request, () => {
    const input = object(request, ['kind', 'id', 'expectedRevision', 'patch', 'idempotencyKey']);
    const recordKind = kind(input.kind) as K;
    const id = identifier(input.id);
    const expectedRevision = integer(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER, '版本');
    const patch = patchData(recordKind, input.patch);
    if (!Object.keys(patch).length) fail('修改至少需要一个字段');
    commandKey(input.idempotencyKey);
    return {request: { operation: 'workspace.update', kind: recordKind, id, expectedRevision, patch },
      action: (tx) => {
        const previous = tx.get<WorkspaceDataByKind[K]>(recordKind, id);
        checkRevision(previous, expectedRevision);
        const editable = Object.fromEntries(
          Object.entries(previous.data).filter(([field]) => fields[recordKind].includes(field)),
        );
        let data = createData(recordKind, { ...editable, ...patch });
        if (recordKind === 'message' && has(previous.data, 'sequence'))
          data = { ...data, sequence: (previous.data as MessageData).sequence! };
        this.relations(tx, recordKind, id, data);
        if (JSON.stringify(previous.data) === JSON.stringify(data)) return previous;
        return tx.update(recordKind, id, expectedRevision, data);
      },
    };
    }, cause => !!cause && typeof cause === 'object' && deterministicRejections.has(cause));
  }

  /** Refuses live children. Use previewDelete + batchDelete for a reviewed, atomic subtree deletion. */
  remove<K extends WorkspaceKind>(
    context: ServerContext,
    request: MutateWorkspaceRecordRequest<K>,
  ): WorkspaceRecord<K> {
    const outerKey = commandEnvelope(request, 'remove');
    return this.store.writeWorkspaceCommand(context, outerKey, 'workspace.remove', request, () => {
    const input = object(request, ['kind', 'id', 'expectedRevision', 'idempotencyKey']);
    const target = identity({ kind: input.kind, id: input.id, expectedRevision: input.expectedRevision });
    commandKey(input.idempotencyKey);
    return {request: { operation: 'workspace.remove', ...target }, action: (tx) => {
      const previous = tx.get<WorkspaceDataByKind[K]>(target.kind, target.id, true);
      checkRevision(previous, target.expectedRevision);
      if (previous.deletedAt !== null) return previous;
      if (this.children(tx, target.kind, target.id).length) conflict('此记录仍有子项，请先移走或批量删除');
      return tx.softDelete(target.kind, target.id, target.expectedRevision) as WorkspaceRecord<K>;
    }};
    }, cause => !!cause && typeof cause === 'object' && deterministicRejections.has(cause));
  }

  /** Restoring a child requires live parents; independently deleted children stay in the trash. */
  restore<K extends WorkspaceKind>(
    context: ServerContext,
    request: MutateWorkspaceRecordRequest<K>,
  ): WorkspaceRecord<K> {
    const outerKey = commandEnvelope(request, 'restore');
    return this.store.writeWorkspaceCommand(context, outerKey, 'workspace.restore', request, () => {
    const input = object(request, ['kind', 'id', 'expectedRevision', 'idempotencyKey']);
    const target = identity({ kind: input.kind, id: input.id, expectedRevision: input.expectedRevision });
    commandKey(input.idempotencyKey);
    return {request: { operation: 'workspace.restore', ...target }, action: (tx) => {
      const previous = tx.get<WorkspaceDataByKind[K]>(target.kind, target.id, true);
      checkRevision(previous, target.expectedRevision);
      if (previous.deletedAt === null) return previous;
      this.relations(tx, target.kind, target.id, previous.data);
      return tx.restore(target.kind, target.id, target.expectedRevision) as WorkspaceRecord<K>;
    }};
    }, cause => !!cause && typeof cause === 'object' && deterministicRejections.has(cause));
  }

  /** The root appears before descendants. A fresh revision manifest is returned, without message bodies. */
  previewDelete(
    context: ServerContext,
    request: { kind: WorkspaceKind; id: string },
  ): WorkspaceRecordIdentity[] {
    const input = object(request, ['kind', 'id']);
    const recordKind = kind(input.kind);
    const id = identifier(input.id);
    return this.store.read(context, (tx) => {
      const queue: WorkspaceRecord[] = [tx.get(recordKind, id) as WorkspaceRecord];
      const children = this.childIndex(tx);
      const seen = new Set<string>();
      const targets: WorkspaceRecordIdentity[] = [];
      for (let index = 0; index < queue.length; index++) {
        const record = queue[index];
        if (seen.has(recordKey(record))) continue;
        seen.add(recordKey(record));
        targets.push({ kind: kind(record.kind), id: record.id, expectedRevision: record.revision });
        if (targets.length > 1000) fail('批量删除最多 1000 项，请先分批整理');
        queue.push(...(children.get(recordKey(record)) ?? []));
      }
      return targets;
    });
  }

  batchDelete(
    context: ServerContext,
    request: BatchDeleteWorkspaceRecordsRequest,
  ): WorkspaceMutationSummary[] {
    const outerKey = commandEnvelope(request, 'batchDelete');
    return this.store.writeWorkspaceCommand(context, outerKey, 'workspace.batchDelete', request, () => {
    const input = object(request, ['items', 'idempotencyKey']);
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 1000)
      fail('批量删除需要 1–1000 项');
    const items = (input.items as unknown[]).map(identity);
    const selected = new Set(items.map(recordKey));
    if (selected.size !== items.length) fail('批量删除包含重复记录');
    commandKey(input.idempotencyKey);
    return {request: { operation: 'workspace.batchDelete', items: items.map((item) => ({ ...item })) },
      action: (tx) => {
        const records = items.map((item) => {
          const previous = tx.get(item.kind, item.id, true);
          checkRevision(previous, item.expectedRevision);
          return previous;
        });
        const children = this.childIndex(tx);
        for (const record of records)
          if ((children.get(recordKey(record)) ?? []).some((child) => !selected.has(recordKey(child))))
            conflict('删除范围缺少仍在使用的子项，请刷新后重新选择');
        return records.map((record) =>
          summary(
            record.deletedAt !== null ? record : tx.softDelete(record.kind, record.id, record.revision),
          ),
        );
      },
    };
    }, cause => !!cause && typeof cause === 'object' && deterministicRejections.has(cause));
  }

  /** Local, user-entered symbols only. No prices, identity matching or market-data entitlement is implied. */
  importWatchlist(context: ServerContext, request: ImportWatchlistRequest): ImportWatchlistResult {
    const outerKey = commandEnvelope(request, 'importWatchlist');
    return this.store.writeWorkspaceCommand(context, outerKey, 'workspace.importWatchlist', request, () => {
    const input = object(request, ['watchlistId', 'items', 'idempotencyKey']);
    const watchlistId = identifier(input.watchlistId);
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 200)
      fail('自选批量导入需要 1–200 项');
    const items = (input.items as unknown[]).map((raw) => {
      const item = object(raw, ['symbol', 'market', 'name', 'notes'], '导入项');
      return createData('watchlist-item', { ...item, watchlistId });
    });
    if (Buffer.byteLength(JSON.stringify(items)) > 512 * 1024) fail('自选批量导入超过 512 KiB');
    commandKey(input.idempotencyKey);
    return {request: { operation: 'workspace.importWatchlist', watchlistId, items },
      action: (tx) => {
        tx.get('watchlist', watchlistId);
        const existing = new Map(
          tx
            .list<WatchlistItemData>('watchlist-item')
            .filter((item) => item.data.watchlistId === watchlistId)
            .map((item) => [`${item.data.market}:${item.data.symbol}`, item.id]),
        );
        const created: WorkspaceRecord<'watchlist-item'>[] = [];
        const skipped: ImportWatchlistResult['skipped'] = [];
        for (const data of items) {
          const key = `${data.market}:${data.symbol}`;
          const existingId = existing.get(key);
          if (existingId) {
            skipped.push({ symbol: data.symbol, market: data.market, existingId });
            continue;
          }
          const record = tx.create('watchlist-item', data);
          existing.set(key, record.id);
          created.push(record);
        }
        return { created, skipped };
      },
    };
    }, cause => !!cause && typeof cause === 'object' && deterministicRejections.has(cause));
  }
}
