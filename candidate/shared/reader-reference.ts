import type { ResearchDocument } from './contracts';
export const READER_LIMITS = Object.freeze({
  requestBytes: 16 * 1024,
  maxSourceBytes: 16 * 1024 * 1024,
  maxOperationSourceBytes: 64 * 1024 * 1024,
  operationMilliseconds: 30_000,
  responseBytes: 128 * 1024,
  maxReadRows: 4000,
  maxReadBytes: 16 * 1024 * 1024,
  bookmarks: 500,
  positions: 100,
  pageSize: 50,
  labelUnits: 160,
  labelBytes: 640,
  noteUnits: 1024,
  noteBytes: 4096,
  anchorUnits: 4096,
  searchMatches: 200,
  textWindowUnits: 16000,
  receiptMilliseconds: 7 * 24 * 60 * 60 * 1000,
});
export type ReaderReferenceKind = 'source-bookmark' | 'reading-position';
export type ReaderSourcePin = {
  documentId: string;
  revisionId: string;
  tenantId: string;
  collectionId: string;
  sha256: string;
};
export type ReaderAnchorInput =
  { kind: 'text'; start: number; end: number } | { kind: 'audio'; segmentId: string };
export type ReaderAnchor =
  | ({ kind: 'text'; start: number; end: number; sliceSha256: string } | { kind: 'audio'; segmentId: string })
  | null;
export type ReaderAuthorization = {
  mode: 'current-local' | 'single-remote-as-of';
  corpusId: string | null;
  checkedAt: string;
};
export type ReaderReference = {
  id: string;
  kind: ReaderReferenceKind;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  pin: ReaderSourcePin;
  anchor: ReaderAnchor;
  label: string;
  note: string;
  source:
    | { state: 'available'; title: string; authorization: ReaderAuthorization }
    | { state: 'unavailable'; reason: 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' };
};
export type ReaderListRequest = {
  kind?: ReaderReferenceKind;
  includeDeleted?: boolean;
  offset?: number;
  limit?: number;
};
export type ReaderList = {
  scope: string;
  items: ReaderReference[];
  nextOffset: number | null;
  observedAt: string;
};
export type ReaderReadRequest = { kind: ReaderReferenceKind; id: string };
export type ReaderRead = { scope: string; reference: ReaderReference };
export type ReaderInspect = {
  scope: string;
  pin: ReaderSourcePin;
  position: ReaderReference | null;
  authorization: ReaderAuthorization;
};
export type ReaderSaveSource = {
  scope: string;
  pin: ReaderSourcePin;
  anchor: ReaderAnchorInput | null;
  expectedRevision: number;
  idempotencyKey: string;
};
export type ReaderSaveBookmark = ReaderSaveSource & { label: string; note: string };
export type ReaderUpdateLabel = ReaderReadRequest & {
  scope: string;
  label: string;
  note: string;
  expectedRevision: number;
  idempotencyKey: string;
};
export type ReaderSetDeleted = ReaderReadRequest & {
  scope: string;
  deleted: boolean;
  expectedRevision: number;
  idempotencyKey: string;
};
export type ReaderOpen = ReaderRead & {
  document: ResearchDocument;
  authorization: ReaderAuthorization;
  anchor:
    | { kind: 'text'; start: number; end: number; quote: string }
    | {
        kind: 'audio';
        segmentId: string;
        startMs: number;
        endMs: number;
        timestampKind: 'model-estimated-segment';
      }
    | null;
};
/** Canonical source identity includes all protected native document fields; never stored in weak records. */
export function readerDocumentIdentity(document: ResearchDocument): unknown {
  return {
    id: document.id,
    revisionId: document.revisionId,
    tenantId: document.tenantId,
    collectionId: document.collectionId,
    title: document.title,
    source: document.source,
    author: document.author,
    date: document.date,
    tags: document.tags,
    excerpt: document.excerpt,
    body: document.body,
    pages: document.pages,
    mock: document.mock,
    originalFile: document.originalFile ?? null,
    sourceLocations: document.sourceLocations ?? null,
    media: document.media ?? null,
  };
}
export function readerCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(readerCanonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${readerCanonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
/** Offsets are UTF-16 [start,end), never inferred PDF pages or reading progress. */
export function isReaderTextRange(body: string, start: number, end: number): boolean {
  const boundary = (index: number) =>
    !(
      index > 0 &&
      index < body.length &&
      /[\uD800-\uDBFF]/.test(body[index - 1]) &&
      /[\uDC00-\uDFFF]/.test(body[index])
    );
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    end > start &&
    end <= body.length &&
    end - start <= READER_LIMITS.anchorUnits &&
    boundary(start) &&
    boundary(end)
  );
}
