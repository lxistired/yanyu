/** The only user content collected by this leaf is explicit, bounded plain text. */
export type FeedbackCategory = 'problem' | 'suggestion';
export type FeedbackDeliveryState =
  | 'local-recorded'
  | 'external-unknown'
  | 'external-submitted'
  | 'external-accepted'
  | 'external-delivered'
  | 'external-failed';

export interface FeedbackDestination {
  /** Opaque server-owned configuration revision; never a URL, recipient or credential. */
  key: string;
  label: string;
  canReconcile: boolean;
}
export interface FeedbackCapabilities {
  schemaVersion: 1;
  /** Identity-change fence, not an owner selector or authority token. */
  scopeKey: string;
  localLabel: '当前工作区';
  external: FeedbackDestination | null;
  limits: { textCharacters: number; textBytes: number; pageSize: number; records: number };
}
export interface FeedbackRecord {
  schemaVersion: 1;
  scopeKey: string;
  id: string;
  /** Server-generated stable local reference; does not imply external support receipt. */
  reference: string;
  revision: number;
  category: FeedbackCategory;
  text: string;
  createdAt: string;
  updatedAt: string;
  delivery: {
    state: FeedbackDeliveryState;
    /** null means this record has never been submitted outside the workspace. */
    destination: FeedbackDestination | null;
    attemptedAt: string | null;
    checkedAt: string | null;
    /** Only an explicitly confirmed, bounded provider receipt, never raw provider output. */
    receipt: string | null;
  };
}
export interface CreateFeedbackRequest {
  expectedScopeKey: string;
  category: FeedbackCategory;
  text: string;
  /** Exact fixed destination binds the local review. External delivery is a separate command. */
  reviewedDestination: 'local-workspace';
  idempotencyKey: string;
}
export interface ListFeedbackRequest {
  expectedScopeKey: string;
  /** null starts history; opaque cursor returned by list. */
  cursor: string | null;
  limit: number;
}
export interface FeedbackPage {
  schemaVersion: 1;
  scopeKey: string;
  records: FeedbackRecord[];
  nextCursor: string | null;
}
export interface FeedbackDetailRequest {
  expectedScopeKey: string;
  id: string;
}
export interface SubmitFeedbackRequest extends FeedbackDetailRequest {
  expectedRevision: number;
  /** Copied from the currently reviewed server destination. */
  expectedDestinationKey: string;
  idempotencyKey: string;
}
export interface ReconcileFeedbackRequest extends FeedbackDetailRequest {
  expectedRevision: number;
  idempotencyKey: string;
}
export const FEEDBACK_LIMITS = Object.freeze({
  textCharacters: 2000,
  textBytes: 8000,
  commandBytes: 16 * 1024,
  responseBytes: 256 * 1024,
  idempotencyKeyBytes: 100,
  pageSize: 20,
  records: 200,
  commands: 800,
  readBytes: 3 * 1024 * 1024,
  providerTimeoutMs: 5000,
});

/** Exact retained command; never construct this from a newly edited draft. */
export type FeedbackCommand =
  | { action: 'create'; input: CreateFeedbackRequest }
  | { action: 'submit'; input: SubmitFeedbackRequest }
  | { action: 'reconcile'; input: ReconcileFeedbackRequest };
export interface SettleFeedbackCommandRequest {
  expectedScopeKey: string;
  command: FeedbackCommand;
}
export interface FeedbackCommandSettlement {
  schemaVersion: 1;
  scopeKey: string;
  action: FeedbackCommand['action'];
  idempotencyKey: string;
  /** Existing receipt wins. Otherwise a durable no-send tombstone closes the original key. */
  resolution: 'recorded' | 'closed';
  /** null only for a closed local create that never committed. */
  record: FeedbackRecord | null;
}
