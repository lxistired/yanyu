import type { ReaderSourcePin } from "./reader-reference";

/** Service facts are explicitly entered by an owner. They never certify a client's behavior. */
export const SERVICE_REPORT_LIMITS = Object.freeze({
  requestBytes: 32 * 1024,
  recordBytes: 768 * 1024,
  operationRows: 6000,
  operationBytes: 24 * 1024 * 1024,
  sourceBytes: 16 * 1024 * 1024,
  operationSourceBytes: 64 * 1024 * 1024,
  operationMilliseconds: 30_000,
  activitiesPerReport: 200,
  sourcesPerActivity: 8,
  sourcesPerOperation: 64,
  pageRows: 25,
  pageBytes: 256 * 1024,
  exportBytes: 2 * 1024 * 1024,
  ownerRows: 10_000,
  ownerBytes: 64 * 1024 * 1024,
  ownerReceipts: 20_000,
});
export const SERVICE_ACTIVITY_KINDS = [
  "content-read",
  "meeting",
  "call",
  "email",
  "research-support",
  "other",
] as const;
export const SERVICE_ACTIVITY_STATUSES = [
  "planned",
  "reported-completed",
  "cancelled",
] as const;
export type ServiceActivityKind = (typeof SERVICE_ACTIVITY_KINDS)[number];
export type ServiceActivityStatus = (typeof SERVICE_ACTIVITY_STATUSES)[number];
export type ServiceCustomer = {
  organizationId: string;
  contactId: string | null;
};
export type ServiceCustomerPin = ServiceCustomer & {
  organizationRevision: number;
  contactRevision: number | null;
};
export type ServiceSourceReference = { pin: ReaderSourcePin };
export type ServiceActivityInput = {
  customer: ServiceCustomer;
  kind: ServiceActivityKind;
  status: ServiceActivityStatus;
  /** Canonical UTC instant, never an ambiguous local clock reading. */
  occurredAt: string;
  /** Owner-authored annotation, not an extracted source title, excerpt, or body. */
  summary: string;
  references: ServiceSourceReference[];
  /** Exact ordinary record snapshot, explicitly projected; never verified client behavior. */
  ordinarySource?: { id: string; revision: number; sha256: string; recordJson: string };
};
export type ServiceActivityVersion = {
  schema: 1;
  activityId: string;
  sequence: number;
  recordedAt: string;
  recordedBySubject: string;
  customerAtRecord: ServiceCustomerPin;
  value: ServiceActivityInput;
  provenance: "user-recorded-local";
  correction: { previousVersionId: string; reason: string } | null;
};
export type ServiceActivityHead = {
  schema: 1;
  versionId: string;
  archivedAt: string | null;
};
export type ServiceActivity = {
  id: string;
  revision: number;
  versionId: string;
  archivedAt: string | null;
  version: ServiceActivityVersion;
};
export type ServiceMonth = {
  month: string;
  timeZone: string;
  membership: "local-calendar-year-month";
  /** Reference instants only. Historic rollbacks can make actual membership noncontiguous. */
  utcMarkers: {
    firstInstantOfMonth: string;
    firstInstantOfFollowingMonth: string;
  };
  tzdbVersion: string;
};
export type ServiceReportTotals = {
  metric: "owner-recorded-activities";
  totalRecords: number;
  byKind: Record<ServiceActivityKind, number>;
  byStatus: Record<ServiceActivityStatus, number>;
  clientReadingVerified: false;
  clientAttendanceVerified: false;
  externalDeliveryVerified: false;
};
export type ServiceReportSnapshot = {
  schema: 1;
  provenance: "derived-user-recorded-service-summary";
  evidenceClass: "derived-artifact";
  generatedAt: string;
  generatedBySubject: string;
  customer: ServiceCustomer;
  customerAtGeneration: ServiceCustomerPin;
  period: ServiceMonth;
  activities: ServiceActivity[];
  totals: ServiceReportTotals;
  basisSha256: string;
  supersedesReportId: string | null;
};
export type ServiceReportState = {
  schema: 1;
  archivedAt: string | null;
  supersededByReportId: string | null;
};
export type ServiceReport = {
  id: string;
  revision: number;
  state: ServiceReportState;
  snapshot: ServiceReportSnapshot;
  snapshotSha256: string;
  currentActivitiesChanged: boolean;
  authorization: { mode: "current-local"; checkedAt: string };
};
export type ServiceCommand = { scope: string; idempotencyKey: string };
export type CreateServiceActivity = ServiceCommand & {
  activity: ServiceActivityInput;
};
export type CorrectServiceActivity = ServiceCommand & {
  id: string;
  expectedRevision: number;
  activity: ServiceActivityInput;
  reason: string;
};
export type ArchiveServiceActivity = ServiceCommand & {
  id: string;
  expectedRevision: number;
  archived: boolean;
};
export type CreateServiceReport = ServiceCommand & {
  customer: ServiceCustomer;
  month: string;
  timeZone: string;
  supersedes: { id: string; expectedRevision: number } | null;
};
export type ArchiveServiceReport = ServiceCommand & {
  id: string;
  expectedRevision: number;
  archived: boolean;
};
export type ServiceReportFormat = "json" | "csv" | "html";
export type ServiceReportCard = {
  id: string;
  revision: number;
  customer: ServiceCustomer;
  period: ServiceMonth;
  generatedAt: string;
  state: ServiceReportState;
};
export type ServiceReportPage = {
  scope: string;
  items: ServiceReportCard[];
  nextAfter: string | null;
  /** Cursor is valid only against exactly this current metadata census. */
  censusSha256: string;
};

export type ServiceActivityPage = {
  scope: string;
  items: ServiceActivity[];
  nextAfter: string | null;
  censusSha256: string;
  period: ServiceMonth;
};
