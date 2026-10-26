/** Provider-neutral contracts. ServerContext is constructed by the SERVER, never by browser claims. */
export type SourceKind = 'research' | 'roadshow' | 'public';
export interface Principal {
  tenantId: string;
  subjectId: string;
  collectionIds: readonly string[];
}
export interface ServerContext {
  principal: Principal;
  signal: AbortSignal;
  requestId: string;
}
export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'CANCELLED'
  | 'CURSOR_EXPIRED';
export interface ServiceError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  requestId?: string;
}
export class AdapterError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}
export interface ResearchDocument {
  id: string;
  revisionId: string;
  tenantId: string;
  collectionId: string;
  title: string;
  source: SourceKind;
  author: string;
  date: string;
  tags: string[];
  excerpt: string;
  body: string;
  pages: number;
  mock: boolean;
  originalFile?: { id: string; name: string; sha256: string; mediaType: string; revisionId?: string };
  sourceLocations?: { kind: 'lines' | 'page'; start: number; end: number; text: string }[];
  media?: {
    audioId: string;
    sha256: string;
    durationMs: number;
    timestampKind: 'model-estimated-segment';
    segments: { id: string; startMs: number; endMs: number; text: string }[];
  };
}
export interface SearchRequest {
  query: string;
  sources: SourceKind[];
  limit?: number;
}
export interface SearchResponse {
  items: ResearchDocument[];
  total: number;
  requestId: string;
  mock: boolean;
}
export interface Citation {
  id: string;
  documentId: string;
  revisionId: string;
  title: string;
  quote: string;
  locator: string;
  textRange?: { start: number; end: number };
}
export interface CursorEvent<T> {
  cursor: number;
  runId: string;
  timestamp: string;
  data: T;
}
export type ResearchEvent =
  | { type: 'started' }
  | { type: 'delta'; text: string }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'completed' }
  | { type: 'cancelled' }
  | { type: 'error'; error: ServiceError };
export interface CreateResearch {
  question: string;
  sources: SourceKind[];
  idempotencyKey: string;
}
export type RunStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
export interface Run {
  id: string;
  kind: 'research' | 'asr';
  title: string;
  status: RunStatus;
  createdAt: string;
  tenantId: string;
  audioId?: string;
  sourceDocumentId?: string;
}
export interface RunSnapshot {
  run: Run;
  lastCursor: number;
}
export interface EventRequest {
  runId: string;
  afterCursor?: number;
}
export interface TranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
  final: boolean;
  translation?: string;
}
/** Complete transcript replacement, not cumulative text to append. IDs are local to this run. */
export interface TranscriptSnapshot {
  revision: number;
  replacesRevision: number;
  replacedSegmentIds: string[];
  segments: TranscriptSegment[];
}
export type AsrEvent =
  | { type: 'snapshot'; snapshot: TranscriptSnapshot }
  | { type: 'partial'; segment: TranscriptSegment }
  | { type: 'final'; segment: TranscriptSegment }
  | { type: 'translation'; segmentId: string; text: string }
  | { type: 'completed' }
  | { type: 'cancelled' }
  | { type: 'error'; error: ServiceError };
export interface CreateAsr {
  audioId: string;
  language: 'auto' | 'zh-CN' | 'en' | 'ja';
  translate: boolean;
  idempotencyKey: string;
}
export type IngestionStatus = 'uploaded' | 'queued' | 'processing' | 'ready' | 'failed';
export interface IngestionFile {
  id: string;
  tenantId: string;
  name: string;
  size: number;
  contentType: string;
  status: IngestionStatus;
  createdAt: string;
  error?: ServiceError;
  simulation: boolean;
  revision?: number;
  deletedAt?: string | null;
  sha256?: string;
  documentId?: string;
  revisionId?: string;
  parser?: string;
  attempts?: number;
}
export interface RetrievalAdapter {
  search(context: ServerContext, request: SearchRequest): Promise<SearchResponse>;
  getDocument(context: ServerContext, id: string, revisionId?: string): Promise<ResearchDocument>;
}
export interface ResearchAdapter {
  create(context: ServerContext, request: CreateResearch): Promise<Run>;
  inspect(context: ServerContext, id: string): Promise<RunSnapshot>;
  list(context: ServerContext): Promise<Run[]>;
  events(context: ServerContext, request: EventRequest): AsyncIterable<CursorEvent<ResearchEvent>>;
  cancel(context: ServerContext, id: string): Promise<Run>;
}
/** Server-only model boundary. Retrieval, identity and citations remain outside model authority. */
export interface ModelRequest {
  question: string;
  evidence: readonly { citationId: string; title: string; text: string }[];
  /** Server-selected completed pairs only. Never accepted from a browser or generic role notes. */
  history?: readonly { role: 'user' | 'assistant'; content: string }[];
}
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
export type ModelEvent =
  { type: 'delta'; text: string } | { type: 'completed'; finishReason: 'stop'; usage: ModelUsage | null };
export interface ModelAdapter {
  stream(signal: AbortSignal, request: ModelRequest): AsyncIterable<ModelEvent>;
}
export interface AsrAdapter {
  create(context: ServerContext, request: CreateAsr): Promise<Run>;
  inspect(context: ServerContext, id: string): Promise<RunSnapshot>;
  list(context: ServerContext): Promise<Run[]>;
  events(context: ServerContext, request: EventRequest): AsyncIterable<CursorEvent<AsrEvent>>;
  cancel(context: ServerContext, id: string): Promise<Run>;
}
export interface BlobAdapter {
  upload(
    context: ServerContext,
    input: { name: string; contentType: string; bytes: Uint8Array; idempotencyKey: string },
  ): Promise<IngestionFile>;
  list(context: ServerContext): Promise<IngestionFile[]>;
  retry(context: ServerContext, id: string): Promise<IngestionFile>;
}
