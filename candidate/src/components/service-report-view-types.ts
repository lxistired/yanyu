// NEW source after the 2026-10-12 reset; not a recovered historical leaf.
import type { ReaderSourcePin } from '../../shared/reader-reference';
import type {
  ArchiveServiceActivity,
  ArchiveServiceReport,
  CreateServiceReport,
  ServiceActivity,
  ServiceActivityInput,
  ServiceActivityPage,
  ServiceCustomer,
  ServiceCustomerPin,
  ServiceReport,
  ServiceReportFormat,
  ServiceReportPage,
} from '../../shared/service-reports';

/** Hosts own reads and authority. A non-ready state carries no displayable value. */
export type ServiceReadState<T> =
  { state: 'ready'; value: T } | { state: 'unknown' | 'loading' | 'unavailable' | 'error'; message: string };
export type ServiceReportAuthority =
  | { state: 'available'; scope: string; message: string }
  | { state: 'unknown' | 'unavailable'; message: string };
export type ServiceCustomerIdentity = {
  pin: ServiceCustomerPin;
  organizationName: string;
  contactName: string | null;
};
export type ServiceReportSelection = {
  customer: ServiceCustomer | null;
  month: string;
  timeZone: string;
  includeArchived: boolean;
};
export type ServicePageRequest = {
  after: string | null;
  censusSha256: string | null;
};
export type ServicePageView<T> = {
  read: ServiceReadState<T>;
  resetNotice: string | null;
};
export type ServiceActivityDraft =
  | { mode: 'add'; activity: ServiceActivityInput }
  | {
      mode: 'correct';
      id: string;
      expectedRevision: number;
      previousVersionId: string;
      activity: ServiceActivityInput;
      reason: string;
    };
export type ServiceSourceOpenRequest = {
  pin: ReaderSourcePin;
  referenceIndex: number;
  activityId: string;
  expectedRevision: number;
  versionId: string;
} & ({ from: 'activity' } | { from: 'report'; reportId: string });
export type ServicePendingCommand = Readonly<{
  token: string;
  label: string;
  phase: 'sending' | 'uncertain';
  message: string;
  canRetrySame: boolean;
  canCheck: boolean;
  canCancel: boolean;
}>;
export type ServiceCreateReportRequest = Omit<CreateServiceReport, 'scope' | 'idempotencyKey'>;
export type ServiceArchiveActivityRequest = Omit<ArchiveServiceActivity, 'scope' | 'idempotencyKey'>;
export type ServiceArchiveReportRequest = Omit<ArchiveServiceReport, 'scope' | 'idempotencyKey'>;
export type ServiceExportReportRequest = {
  reportId: string;
  expectedRevision: number;
  format: ServiceReportFormat;
};

/** Every durable value is controlled; callbacks express intent, never a completed result. */
export interface MonthlyServiceReportsViewProps {
  authority: ServiceReportAuthority;
  customerChoices: ServiceReadState<readonly ServiceCustomerIdentity[]>;
  selection: ServiceReportSelection;
  activities: ServicePageView<ServiceActivityPage>;
  reportCards: ServicePageView<ServiceReportPage>;
  selectedReport: ServiceReadState<ServiceReport>;
  draft: ServiceActivityDraft | null;
  sourceChoices: ServiceReadState<readonly ReaderSourcePin[]>;
  pending: ServicePendingCommand | null;
  mutationError: string | null;
  sourceError: string | null;
  exportError: string | null;
  exporting: { reportId: string; format: ServiceReportFormat } | null;
  openingSource: boolean;
  onSelectionChange: (selection: ServiceReportSelection) => void;
  onRefreshCustomers: () => void;
  onActivitiesPage: (page: ServicePageRequest) => void;
  onReportsPage: (page: ServicePageRequest) => void;
  onChooseReport: (id: string) => void;
  onCloseReport: () => void;
  onBeginActivity: () => void;
  onCorrectActivity: (activity: ServiceActivity) => void;
  onArchiveActivity: (request: ServiceArchiveActivityRequest) => void;
  onDraftChange: (draft: ServiceActivityDraft) => void;
  onSubmitActivity: (draft: ServiceActivityDraft) => void;
  onCancelDraft: () => void;
  onRefreshSources: () => void;
  onCreateReport: (request: ServiceCreateReportRequest) => void;
  onArchiveReport: (request: ServiceArchiveReportRequest) => void;
  onExportReport: (request: ServiceExportReportRequest) => void;
  onOpenSource: (request: ServiceSourceOpenRequest, opener: HTMLButtonElement) => void;
  onRetryPending: (token: string) => void;
  onCheckPending: (token: string) => void;
  onCancelPending: (token: string) => void;
}
