import type { ResearchDocument, ServerContext, SourceKind } from './contracts';
import type { DomainRecord } from './workspace';
import type { MaterialEntityIdentity } from './entity-material';

/** Owner-entered metadata only; independent of provider company IDs and source bylines. */
export type CatalogEntitySelector = { mode: 'entity'; entity: MaterialEntityIdentity } | { mode: 'followed' };

/** Trusted server port. Never implement enumeration by repeatedly calling relevance/top-N search. */
export interface CatalogCorpus {
  readonly id: string;
  readonly label: string;
  /** Explicitly weaker single-remote observation contract. At most one selected remote authority. */
  readonly authorityMode?: 'remote-as-of';
  /** Missing enumeration explicitly makes complete search unavailable for this corpus. */
  enumerate?: (
    context: ServerContext,
    input: { cursor?: string; limit: number; snapshotId?: string },
  ) => Promise<CatalogEnumeration>;
  getSnapshotIdentity(context: ServerContext): Promise<string>;
  /** Synchronous, side-effect-free authoritative publication fence; a cached remote generation is insufficient.
   * Missing this guard makes complete snapshot search unavailable. Async/thenable guards are rejected. */
  guardSnapshot?(context: ServerContext, snapshotId: string): void;
  getDocumentVersion(
    context: ServerContext,
    documentId: string,
    revisionId: string,
  ): Promise<ResearchDocument>;
  availability?(context: ServerContext): Promise<{ available: boolean; detail: string }>;
}
export type CatalogIdentity = {
  documentId: string;
  revisionId: string;
  /** Structured associations supplied by the authoritative provider, never ticker/text matching. */
  companyIds?: string[];
  /** Original source date only; null when unknown. Ingestion/revision-save time is not a source date. */
  sourceDate: string | null;
  sourceDateKind: 'publication' | 'recording' | 'source-as-of' | 'unknown';
};
export type CatalogEnumeration = { snapshotId: string; items: CatalogIdentity[]; nextCursor?: string | null };
export type CatalogQuery = {
  query: string;
  sources: SourceKind[];
  /** Empty selectors mean all configured corpora / all authorized collections / no company restriction. */
  corpusIds: string[];
  collectionIds: string[];
  companyIds: string[];
  /** Missing legacy selectors mean unfiltered; new server responses normalize to null. */
  entitySelector?: CatalogEntitySelector | null;
  /** Exact case-folded, Unicode-NFKC-normalized source byline. No person/speaker inference. */
  author: string;
  dateFrom: string | null;
  dateTo: string | null;
  unknownDates: 'include' | 'exclude' | 'only';
  sort: 'relevance' | 'date-desc' | 'date-asc' | 'title-asc';
  pageSize: number;
};
export type CatalogQueryInput = Partial<CatalogQuery> & Pick<CatalogQuery, 'query' | 'sources'>;
export type CatalogSearchRequest = {
  query: CatalogQueryInput;
  idempotencyKey: string;
  saveHistory?: boolean;
};
export type CatalogSearchHit = {
  corpusId: string;
  document: Pick<
    ResearchDocument,
    'id' | 'revisionId' | 'title' | 'source' | 'author' | 'date' | 'tags' | 'excerpt' | 'pages' | 'mock'
  >;
  companyIds: string[];
  sourceDate: string | null;
  sourceDateKind: CatalogIdentity['sourceDateKind'];
};
export type CatalogSearchPage = {
  snapshotId: string;
  cursor: string;
  nextCursor: string | null;
  previousCursor: string | null;
  query: CatalogQuery;
  offset: number;
  total: number;
  items: CatalogSearchHit[];
  expiresAt: string;
  historyStatus: 'saved' | 'not-requested' | 'full';
  requestId: string;
  authorization: {
    mode: 'current-local' | 'single-remote-as-of';
    corpusId: string | null;
    checkedAt: string;
  };
};
export type CatalogCapability = { id: string; label: string; available: boolean; detail: string };
export type CatalogCapabilities = {
  corpora: CatalogCapability[];
  completeSearchAvailable: boolean;
  limits: typeof CATALOG_SEARCH_LIMITS;
  /** Missing on older servers means unavailable, never an ignored active selector. */
  entityOverlay?: { available: boolean; detail: string };
};
export type SearchHistoryData = { query: CatalogQuery; submittedAt: string };
export type SearchHistoryRecord = DomainRecord<SearchHistoryData>;
export type SearchHistoryList = {
  items: SearchHistoryRecord[];
  total: number;
  capacity: number;
  full: boolean;
};
export type SearchHistoryMutation = { id: string; expectedRevision: number; idempotencyKey: string };
export type SearchHistoryClear = {
  items: { id: string; expectedRevision: number }[];
  confirmed: true;
  idempotencyKey: string;
};
export const CATALOG_SEARCH_LIMITS = {
  pageSize: 50,
  corpora: 16,
  enumerationPageSize: 100,
  enumerationPages: 256,
  documents: 4000,
  scannedBytes: 128 * 1024 * 1024,
  documentBytes: 32 * 1024 * 1024,
  snapshotBytes: 2 * 1024 * 1024,
  snapshotPartBytes: 128 * 1024,
  snapshotParts: 16,
  snapshotSlots: 24,
  snapshotLifetimeMs: 15 * 60 * 1000,
  workMs: 30 * 1000,
  responseBytes: 512 * 1024,
  history: 100,
} as const;
