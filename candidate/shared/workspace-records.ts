import type { DomainRecord } from './workspace';

/** Exact ordinary local-record DTO declarations, detached from server implementation. */
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

