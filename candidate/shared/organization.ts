import type { DomainRecord } from './workspace';

/** Exact original public organization DTOs, separated from server runtime dependencies. */
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
/** Saved local preference only, never a scheduled reminder or notification. */
export const MEETING_REMINDER_LEADS = [[0, '会议开始时'], [300, '提前 5 分钟'], [900, '提前 15 分钟'], [1800, '提前 30 分钟'], [3600, '提前 1 小时'], [86400, '提前 1 天']] as const;
export type MeetingReminderLeadSeconds = typeof MEETING_REMINDER_LEADS[number][0];
export function isMeetingReminderLeadSeconds(value: unknown): value is MeetingReminderLeadSeconds {
  return MEETING_REMINDER_LEADS.some(([seconds]) => seconds === value);
}
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
  reminderLeadSeconds?: MeetingReminderLeadSeconds | null;
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

