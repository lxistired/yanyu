import {
  FEEDBACK_LIMITS,
  type CreateFeedbackRequest,
  type FeedbackCategory,
  type FeedbackDestination,
  type FeedbackRecord,
  type ReconcileFeedbackRequest,
  type SubmitFeedbackRequest,
  type SettleFeedbackCommandRequest,
  type FeedbackCommandSettlement,
} from '../../shared/feedback';
import {
  requireFeedbackRecord,
  requireFeedbackSettlement,
  validFeedbackScope,
  validFeedbackText,
} from './feedback';

type Review = { category: FeedbackCategory; text: string; destination: FeedbackDestination | null };
export type FeedbackIntent =
  | { action: 'create'; request: CreateFeedbackRequest }
  | { action: 'submit'; request: SubmitFeedbackRequest; review: Review }
  | { action: 'reconcile'; request: ReconcileFeedbackRequest; review: Review };
export interface FeedbackJournalEntry {
  schemaVersion: 1;
  scopeKey: string;
  intent: FeedbackIntent;
}
export class FeedbackJournalError extends Error {
  constructor(message = '反馈恢复记录无法安全读取或更新，未发送新命令；已有记录保持不变') {
    super(message);
    this.name = 'FeedbackJournalError';
  }
}
const prefix = 'research-feedback-command-v1:';
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const fail = (): never => {
  throw new FeedbackJournalError();
};
function boundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof FeedbackJournalError) throw error;
    return fail();
  }
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function plainText(value: unknown, max: number = FEEDBACK_LIMITS.textBytes): value is string {
  return typeof value === 'string' && value.trim().length > 0 && byteLength(value) <= max;
}
function validReview(value: unknown): value is Review {
  if (
    !exact(value, ['category', 'text', 'destination']) ||
    !['problem', 'suggestion'].includes(String(value.category)) ||
    !plainText(value.text) ||
    !validFeedbackText(value.text, FEEDBACK_LIMITS.textCharacters, FEEDBACK_LIMITS.textBytes)
  )
    return false;
  const target = value.destination;
  return (
    target === null ||
    (exact(target, ['key', 'label', 'canReconcile']) &&
      plainText(target.key, 200) &&
      plainText(target.label, 500) &&
      typeof target.canReconcile === 'boolean')
  );
}
export function requireFeedbackIntent(value: unknown, scope: string): FeedbackIntent {
  if (!validFeedbackScope(scope) || !value || typeof value !== 'object') return fail();
  const item = value as FeedbackIntent;
  if (
    !['create', 'submit', 'reconcile'].includes(item.action) ||
    !exact(item, item.action === 'create' ? ['action', 'request'] : ['action', 'request', 'review'])
  )
    return fail();
  const request = item.request;
  const keys =
    item.action === 'create'
      ? ['expectedScopeKey', 'category', 'text', 'reviewedDestination', 'idempotencyKey']
      : item.action === 'submit'
        ? ['expectedScopeKey', 'id', 'expectedRevision', 'expectedDestinationKey', 'idempotencyKey']
        : ['expectedScopeKey', 'id', 'expectedRevision', 'idempotencyKey'];
  if (
    !exact(request, keys) ||
    request.expectedScopeKey !== scope ||
    !plainText(request.idempotencyKey, FEEDBACK_LIMITS.idempotencyKeyBytes) ||
    Array.from(request.idempotencyKey).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return fail();
  if (item.action === 'create') {
    if (
      !['problem', 'suggestion'].includes(item.request.category) ||
      !plainText(item.request.text) ||
      !validFeedbackText(item.request.text, FEEDBACK_LIMITS.textCharacters, FEEDBACK_LIMITS.textBytes) ||
      item.request.reviewedDestination !== 'local-workspace'
    )
      return fail();
  } else {
    if (
      !plainText(item.request.id, 200) ||
      !Number.isSafeInteger(item.request.expectedRevision) ||
      item.request.expectedRevision < 1 ||
      !validReview(item.review)
    )
      return fail();
    if (
      item.action === 'submit' &&
      (!plainText(item.request.expectedDestinationKey, 200) ||
        item.review.destination?.key !== item.request.expectedDestinationKey)
    )
      return fail();
  }
  return item;
}
export function feedbackJournalKey(scope: string): string {
  if (!validFeedbackScope(scope)) return fail();
  return `${prefix}${scope}:command`;
}
function decode(raw: string, scope: string): FeedbackJournalEntry {
  if (byteLength(raw) > FEEDBACK_LIMITS.commandBytes + FEEDBACK_LIMITS.textBytes) return fail();
  const value: unknown = JSON.parse(raw);
  if (
    !exact(value, ['schemaVersion', 'scopeKey', 'intent']) ||
    value.schemaVersion !== 1 ||
    value.scopeKey !== scope
  )
    return fail();
  requireFeedbackIntent(value.intent, scope);
  return value as unknown as FeedbackJournalEntry;
}
export function readFeedbackIntent(storage: Storage, scope: string): FeedbackJournalEntry | null {
  return boundary(() => {
    const raw = storage.getItem(feedbackJournalKey(scope));
    return raw === null ? null : decode(raw, scope);
  });
}
export function prepareFeedbackIntent(
  storage: Storage,
  scope: string,
  intent: FeedbackIntent,
): FeedbackJournalEntry {
  return boundary(() => {
    requireFeedbackIntent(intent, scope);
    const key = feedbackJournalKey(scope),
      prior = storage.getItem(key);
    const entry: FeedbackJournalEntry = { schemaVersion: 1, scopeKey: scope, intent };
    const raw = JSON.stringify(entry);
    if (byteLength(raw) > FEEDBACK_LIMITS.commandBytes + FEEDBACK_LIMITS.textBytes) return fail();
    if (prior !== null) {
      const existing = decode(prior, scope);
      if (JSON.stringify(existing) !== raw) return fail();
      return existing;
    }
    if (storage.getItem(key) !== null) return fail();
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) return fail();
    return decode(raw, scope);
  });
}
export function assertFeedbackIntentPresent(storage: Storage, entry: FeedbackJournalEntry): void {
  boundary(() => {
    const current = readFeedbackIntent(storage, entry.scopeKey);
    if (!current || JSON.stringify(current) !== JSON.stringify(entry)) fail();
  });
}
/** Called only for a validated direct response, or an explicit reconciliation of the same immutable record. */
export function settleFeedbackIntent(
  storage: Storage,
  entry: FeedbackJournalEntry,
  result: FeedbackRecord,
): void {
  boundary(() => {
    requireFeedbackIntent(entry.intent, entry.scopeKey);
    const record = requireFeedbackRecord(result, entry.scopeKey),
      intent = entry.intent;
    if (intent.action === 'create') {
      if (record.category !== intent.request.category || record.text !== intent.request.text) return fail();
    } else {
      if (
        record.id !== intent.request.id ||
        record.category !== intent.review.category ||
        record.text !== intent.review.text ||
        record.revision < intent.request.expectedRevision
      )
        return fail();
      if (
        intent.action === 'submit' &&
        (record.delivery.destination?.key !== intent.request.expectedDestinationKey ||
          ['local-recorded', 'external-unknown'].includes(record.delivery.state))
      )
        return fail();
      if (
        intent.action === 'reconcile' &&
        record.delivery.destination?.key !== intent.review.destination?.key
      )
        return fail();
    }
    const key = feedbackJournalKey(entry.scopeKey),
      prior = storage.getItem(key);
    if (prior === null || JSON.stringify(decode(prior, entry.scopeKey)) !== JSON.stringify(entry))
      return fail();
    // A late response never erases a replacement command, even in the same owner namespace.
    if (storage.getItem(key) !== prior) return fail();
    storage.removeItem(key);
    if (storage.getItem(key) !== null) return fail();
  });
}

export function feedbackSettlementRequest(entry: FeedbackJournalEntry): SettleFeedbackCommandRequest {
  const intent = requireFeedbackIntent(entry.intent, entry.scopeKey);
  const command =
    intent.action === 'create'
      ? { action: intent.action, input: intent.request }
      : intent.action === 'submit'
        ? { action: intent.action, input: intent.request }
        : { action: intent.action, input: intent.request };
  return { expectedScopeKey: entry.scopeKey, command };
}
/** Only the exact-command endpoint can prove an unobserved command closed without execution. */
export function clearSettledFeedbackIntent(
  storage: Storage,
  entry: FeedbackJournalEntry,
  value: FeedbackCommandSettlement,
): void {
  boundary(() => {
    const result = requireFeedbackSettlement(value, feedbackSettlementRequest(entry));
    if (
      result.record &&
      entry.intent.action !== 'create' &&
      (result.record.text !== entry.intent.review.text ||
        result.record.category !== entry.intent.review.category)
    )
      return fail();
    const key = feedbackJournalKey(entry.scopeKey),
      prior = storage.getItem(key);
    if (prior === null || JSON.stringify(decode(prior, entry.scopeKey)) !== JSON.stringify(entry))
      return fail();
    if (storage.getItem(key) !== prior) return fail();
    storage.removeItem(key);
    if (storage.getItem(key) !== null) return fail();
  });
}
