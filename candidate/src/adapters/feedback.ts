import {
  FEEDBACK_LIMITS,
  type CreateFeedbackRequest,
  type FeedbackCapabilities,
  type FeedbackDestination,
  type FeedbackPage,
  type FeedbackRecord,
  type ListFeedbackRequest,
  type FeedbackDetailRequest,
  type SubmitFeedbackRequest,
  type ReconcileFeedbackRequest,
  type SettleFeedbackCommandRequest,
  type FeedbackCommandSettlement,
} from '../../shared/feedback';
import { workbenchCall } from './workbench-client';

export class FeedbackProtocolError extends Error {
  constructor(message = '反馈服务返回的数据无法核验，原命令已保留') {
    super(message);
    this.name = 'FeedbackProtocolError';
  }
}
export class FeedbackOwnerError extends FeedbackProtocolError {
  constructor() {
    super('当前反馈身份已变化，请返回并重新打开反馈');
    this.name = 'FeedbackOwnerError';
  }
}
const fail = (): never => {
  throw new FeedbackProtocolError();
};
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
export const validFeedbackScope = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) return fail();
  return row;
}
function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === 'string' && (empty || value.trim().length > 0) && bytes(value) <= max;
}
export function validFeedbackText(value: string, maxCharacters: number, maxBytes: number): boolean {
  return (
    value.trim().length > 0 &&
    Array.from(value).length <= maxCharacters &&
    bytes(value) <= maxBytes &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127 || (code >= 0xd800 && code <= 0xdfff);
    })
  );
}
function bounded(value: unknown): void {
  try {
    if (bytes(JSON.stringify(value)) > FEEDBACK_LIMITS.responseBytes) fail();
  } catch {
    fail();
  }
}
function destination(value: unknown): FeedbackDestination | null {
  if (value === null) return null;
  const row = object(value, ['key', 'label', 'canReconcile']);
  if (!text(row.key, 200) || !text(row.label, 500) || typeof row.canReconcile !== 'boolean') return fail();
  return value as FeedbackDestination;
}
function scope(value: unknown, expected?: string): string {
  if (!validFeedbackScope(value)) return fail();
  if (expected !== undefined && value !== expected) throw new FeedbackOwnerError();
  return value;
}
export function requireFeedbackCapabilities(value: unknown, expected?: string): FeedbackCapabilities {
  bounded(value);
  const row = object(value, ['schemaVersion', 'scopeKey', 'localLabel', 'external', 'limits']);
  scope(row.scopeKey, expected);
  if (row.schemaVersion !== 1 || row.localLabel !== '当前工作区') return fail();
  destination(row.external);
  const limits = object(row.limits, ['textCharacters', 'textBytes', 'pageSize', 'records']);
  for (const key of ['textCharacters', 'textBytes', 'pageSize', 'records'] as const)
    if (
      !Number.isSafeInteger(limits[key]) ||
      Number(limits[key]) < 1 ||
      Number(limits[key]) > FEEDBACK_LIMITS[key]
    )
      return fail();
  return value as FeedbackCapabilities;
}
export function requireFeedbackRecord(value: unknown, expected?: string): FeedbackRecord {
  bounded(value);
  const row = object(value, [
    'schemaVersion',
    'scopeKey',
    'id',
    'reference',
    'revision',
    'category',
    'text',
    'createdAt',
    'updatedAt',
    'delivery',
  ]);
  scope(row.scopeKey, expected);
  if (
    row.schemaVersion !== 1 ||
    !text(row.id, 200) ||
    !text(row.reference, 200) ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 1 ||
    !['problem', 'suggestion'].includes(String(row.category)) ||
    typeof row.text !== 'string' ||
    !validFeedbackText(row.text, FEEDBACK_LIMITS.textCharacters, FEEDBACK_LIMITS.textBytes) ||
    !text(row.createdAt, 100) ||
    !Number.isFinite(Date.parse(String(row.createdAt))) ||
    !text(row.updatedAt, 100) ||
    !Number.isFinite(Date.parse(String(row.updatedAt)))
  )
    return fail();
  const delivery = object(row.delivery, ['state', 'destination', 'attemptedAt', 'checkedAt', 'receipt']);
  if (
    ![
      'local-recorded',
      'external-unknown',
      'external-submitted',
      'external-accepted',
      'external-delivered',
      'external-failed',
    ].includes(String(delivery.state))
  )
    return fail();
  const target = destination(delivery.destination);
  if (delivery.state === 'local-recorded' ? target !== null : target === null) return fail();
  for (const key of ['attemptedAt', 'checkedAt'])
    if (
      delivery[key] !== null &&
      (!text(delivery[key], 100) || !Number.isFinite(Date.parse(String(delivery[key]))))
    )
      return fail();
  const confirmed = ['external-submitted', 'external-accepted', 'external-delivered'].includes(
    String(delivery.state),
  );
  if (
    confirmed
      ? typeof delivery.receipt !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(delivery.receipt)
      : delivery.receipt !== null
  )
    return fail();
  if (
    delivery.state === 'local-recorded'
      ? delivery.attemptedAt !== null || delivery.checkedAt !== null
      : delivery.attemptedAt === null
  )
    return fail();
  return value as FeedbackRecord;
}
export function requireFeedbackPage(value: unknown, expected: string): FeedbackPage {
  bounded(value);
  const row = object(value, ['schemaVersion', 'scopeKey', 'records', 'nextCursor']);
  scope(row.scopeKey, expected);
  if (
    row.schemaVersion !== 1 ||
    !Array.isArray(row.records) ||
    row.records.length > FEEDBACK_LIMITS.pageSize ||
    (row.nextCursor !== null && !text(row.nextCursor, 2000))
  )
    return fail();
  const ids = new Set<string>();
  for (const item of row.records) {
    const record = requireFeedbackRecord(item, expected);
    if (ids.has(record.id)) return fail();
    ids.add(record.id);
  }
  return value as FeedbackPage;
}
function requireResult(value: unknown, input: FeedbackDetailRequest): FeedbackRecord {
  const record = requireFeedbackRecord(value, input.expectedScopeKey);
  if (record.id !== input.id) return fail();
  return record;
}
export function requireFeedbackSettlement(
  value: unknown,
  input: SettleFeedbackCommandRequest,
): FeedbackCommandSettlement {
  bounded(value);
  const row = object(value, [
    'schemaVersion',
    'scopeKey',
    'action',
    'idempotencyKey',
    'resolution',
    'record',
  ]);
  scope(row.scopeKey, input.expectedScopeKey);
  if (
    row.schemaVersion !== 1 ||
    row.action !== input.command.action ||
    row.idempotencyKey !== input.command.input.idempotencyKey ||
    !['recorded', 'closed'].includes(String(row.resolution))
  )
    return fail();
  if (row.record === null) {
    if (row.resolution !== 'closed' || input.command.action !== 'create') return fail();
  } else {
    const record = requireFeedbackRecord(row.record, input.expectedScopeKey);
    if (input.command.action === 'create') {
      if (
        row.resolution !== 'recorded' ||
        record.text !== input.command.input.text ||
        record.category !== input.command.input.category
      )
        return fail();
    } else if (
      record.id !== input.command.input.id ||
      (row.resolution === 'recorded' && record.revision < input.command.input.expectedRevision)
    )
      return fail();
  }
  return value as FeedbackCommandSettlement;
}
export interface FeedbackClient {
  settleCommand(
    input: SettleFeedbackCommandRequest,
    signal?: AbortSignal,
  ): Promise<FeedbackCommandSettlement>;
  read(signal?: AbortSignal): Promise<FeedbackCapabilities>;
  create(input: CreateFeedbackRequest, signal?: AbortSignal): Promise<FeedbackRecord>;
  list(input: ListFeedbackRequest, signal?: AbortSignal): Promise<FeedbackPage>;
  detail(input: FeedbackDetailRequest, signal?: AbortSignal): Promise<FeedbackRecord>;
  submit(input: SubmitFeedbackRequest, signal?: AbortSignal): Promise<FeedbackRecord>;
  reconcile(input: ReconcileFeedbackRequest, signal?: AbortSignal): Promise<FeedbackRecord>;
}
/** Ordinary protected POST transport. No browser-selectable URL, recipient, attachment, or credential. */
export const feedbackApi: FeedbackClient = {
  settleCommand: async (input, signal) =>
    requireFeedbackSettlement(await workbenchCall('feedback/settleCommand', input, signal), input),
  read: async (signal) => requireFeedbackCapabilities(await workbenchCall('feedback/read', {}, signal)),
  create: async (input, signal) => {
    const record = requireFeedbackRecord(
      await workbenchCall('feedback/create', input, signal),
      input.expectedScopeKey,
    );
    if (record.category !== input.category || record.text !== input.text) return fail();
    return record;
  },
  list: async (input, signal) =>
    requireFeedbackPage(await workbenchCall('feedback/list', input, signal), input.expectedScopeKey),
  detail: async (input, signal) =>
    requireResult(await workbenchCall('feedback/detail', input, signal), input),
  submit: async (input, signal) => {
    const record = requireResult(await workbenchCall('feedback/submit', input, signal), input);
    if (
      record.delivery.destination?.key !== input.expectedDestinationKey ||
      record.revision < input.expectedRevision
    )
      return fail();
    return record;
  },
  reconcile: async (input, signal) =>
    requireResult(await workbenchCall('feedback/reconcile', input, signal), input),
};
