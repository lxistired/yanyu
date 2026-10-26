/** Local application data, separate from immutable imported source archives and provider credentials. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type DomainKind =
  | 'workspace'
  | 'session-group'
  | 'session'
  | 'message'
  | 'watchlist'
  | 'watchlist-item'
  | 'skill'
  | 'data-source'
  | 'schedule'
  | 'schedule-run'
  | 'notification'
  | 'manual-research-plan'
  | 'research-plan'
  | 'research-plan-version'
  | 'research-interaction'
  | 'research-run'
  | 'research-event'
  | 'research-artifact'
  | 'research-schedule-binding'
  | 'research-schedule-occurrence'
  | 'research-scheduled-artifact'
  | 'ingestion-file'
  | 'ingestion-version'
  | 'document-folder'
  | 'document-placement'
  | 'session-attachment'
  | 'conversation-turn'
  | 'conversation-event'
  | 'asr-task-metadata'
  | 'user-preferences'
  | 'feedback-record'
  | 'feedback-control'
  | 'transcript-edition'
  | 'transcript-revision'
  | 'transcript-revision-part'
  | 'transcript-budget'
  | 'search-history'
  | 'catalog-search-snapshot'
  | 'catalog-search-snapshot-part'
  | 'organization'
  | 'person'
  | 'meeting'
  | 'meeting-registration'
  | 'meeting-reminder'
  | 'meeting-reminder-occurrence'
  | 'crm-contact'
  | 'service-record'
  | 'bookmark'
  | 'reading-record'
  | 'source-bookmark'
  | 'reading-position'
  | 'report-attachment'
  | 'source-entity-association'
  | 'entity-material-follow'
  | 'access-request'
  | 'share-draft';
export interface DomainRecord<T extends JsonValue = JsonValue> {
  id: string;
  kind: DomainKind;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  data: T;
}
/** No raw SQL or owner override is exposed to feature modules. All results are defensive copies. */
export interface DomainTransaction {
  get<T extends JsonValue = JsonValue>(
    kind: DomainKind,
    id: string,
    includeDeleted?: boolean,
  ): DomainRecord<T>;
  list<T extends JsonValue = JsonValue>(kind: DomainKind, includeDeleted?: boolean): DomainRecord<T>[];
  create<T extends JsonValue>(kind: DomainKind, data: T, id?: string): DomainRecord<T>;
  update<T extends JsonValue>(
    kind: DomainKind,
    id: string,
    expectedRevision: number,
    data: T,
  ): DomainRecord<T>;
  softDelete(kind: DomainKind, id: string, expectedRevision: number): DomainRecord;
  restore(kind: DomainKind, id: string, expectedRevision: number): DomainRecord;
}
