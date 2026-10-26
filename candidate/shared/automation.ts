/** Browser-only automation DTOs extracted from the existing domain; no server runtime imports. */
import type { DomainRecord } from './workspace';
import type { MeetingNotificationTarget } from './meeting-reminders';
export type SkillHandler =
  'local-notification' | 'local-checkpoint' | 'local-evidence-report' | 'external-research' | 'local-document-inventory';
export type DataSourceKind =
  'local-workspace' | 'local-archive' | 'web-search' | 'private-drive' | 'vendor-feed';
export type ScheduleCadence =
  | { kind: 'once'; at: string; timezone: string }
  | { kind: 'daily'; time: string; timezone: string }
  | { kind: 'weekly'; time: string; timezone: string; weekdays: number[] };
export type AutomationAvailability = {
  status: 'available' | 'unavailable';
  code: string;
  detail: string;
  capabilities: string[];
};
export type SkillData = { name: string; description: string; enabled: boolean; handler: SkillHandler };
export type DataSourceData = {
  name: string;
  kind: DataSourceKind;
  enabled: boolean;
  collectionIds: string[];
};
export type ScheduleState = 'active' | 'paused' | 'cancelled' | 'completed';
export type ScheduleData = {
  name: string;
  skillId: string;
  sourceIds: string[];
  instructions: string;
  cadence: ScheduleCadence;
  enabled: boolean;
  state: ScheduleState;
  misfirePolicy: 'coalesce' | 'skip';
  graceSeconds: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
};
export type ScheduleRunState =
  'queued' | 'running' | 'completed' | 'cancelled' | 'unavailable' | 'skipped' | 'failed';
/** A persisted bounded intent, never a command, URL, provider request, or credential container. */
export type LocalJobIntent = {
  handler: SkillHandler;
  title: string;
  instructions: string;
  skillRevision: number;
  sources: { id: string; revision: number }[];
};
export type ScheduleRunData = {
  scheduleId: string;
  skillId: string;
  trigger: 'scheduled' | 'manual';
  scheduledAt: string;
  coalescedFrom: string | null;
  retryOf: string | null;
  state: ScheduleRunState;
  intent: LocalJobIntent | null;
  attempt: number;
  lease: { token: string; workerId: string; expiresAt: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
  code: string | null;
  detail: string | null;
  result:
    | { kind: 'local-checkpoint'; note: string }
    | { kind: 'local-notification'; notificationId: string }
    | { kind: 'local-evidence-report'; runId: string; artifactId: string }
    | null;
};
export type NotificationData = {
  title: string;
  body: string;
  delivery: 'in-app';
  target: { kind: 'schedule-run'; id: string } | MeetingNotificationTarget;
  readAt: string | null;
};
export type SkillRecord = DomainRecord<SkillData>;
export type SkillView = SkillRecord & { availability: AutomationAvailability };
export type DataSourceRecord = DomainRecord<DataSourceData>;
export type DataSourceView = DataSourceRecord & { availability: AutomationAvailability };
export type ScheduleRecord = DomainRecord<ScheduleData>;
export type ScheduleRunRecord = DomainRecord<ScheduleRunData>;
export type NotificationRecord = DomainRecord<NotificationData>;
export type Command = { idempotencyKey: string };
export type EntityMutation = Command & { id: string; expectedRevision: number };
export type CreateSkill = Command & {
  name: string;
  description?: string;
  enabled?: boolean;
  handler: SkillHandler;
};
export type UpdateSkill = EntityMutation & { patch: Partial<SkillData> };
export type CreateDataSource = Command & {
  name: string;
  kind: DataSourceKind;
  enabled?: boolean;
  collectionIds?: string[];
};
export type UpdateDataSource = EntityMutation & {
  patch: Partial<Pick<DataSourceData, 'name' | 'enabled' | 'collectionIds'>>;
};
export type CreateSchedule = Command & {
  name: string;
  skillId: string;
  sourceIds?: string[];
  instructions?: string;
  cadence: ScheduleCadence;
  enabled?: boolean;
  misfirePolicy?: 'coalesce' | 'skip';
  graceSeconds?: number;
};
export type UpdateSchedule = EntityMutation & {
  patch: Partial<
    Pick<
      ScheduleData,
      | 'name'
      | 'skillId'
      | 'sourceIds'
      | 'instructions'
      | 'cadence'
      | 'enabled'
      | 'misfirePolicy'
      | 'graceSeconds'
    >
  >;
};
export type SetScheduleState = EntityMutation & { state: 'active' | 'paused' | 'cancelled' };
export type DispatchDue = Command & { limit?: number };
export type DispatchResult = { evaluatedAt: string; runs: ScheduleRunRecord[]; hasMore: boolean };
export type ClaimLocalRun = EntityMutation & { workerId: string; leaseSeconds?: number };
export type CompleteLocalRun = EntityMutation & { leaseToken: string };
export type FailLocalRun = CompleteLocalRun & { code: 'local_execution_failed' | 'local_worker_interrupted' };

export interface AutomationWrites {
  createSkill: { input: CreateSkill; result: SkillView };
  updateSkill: { input: UpdateSkill; result: SkillView };
  deleteSkill: { input: EntityMutation; result: SkillRecord };
  restoreSkill: { input: EntityMutation; result: SkillView };
  createDataSource: { input: CreateDataSource; result: DataSourceView };
  updateDataSource: { input: UpdateDataSource; result: DataSourceView };
  deleteDataSource: { input: EntityMutation; result: DataSourceRecord };
  restoreDataSource: { input: EntityMutation; result: DataSourceView };
  createSchedule: { input: CreateSchedule; result: ScheduleRecord };
  updateSchedule: { input: UpdateSchedule; result: ScheduleRecord };
  setScheduleState: { input: SetScheduleState; result: ScheduleRecord };
  deleteSchedule: { input: EntityMutation; result: ScheduleRecord };
  restoreSchedule: { input: EntityMutation; result: ScheduleRecord };
  dispatchDue: { input: DispatchDue; result: DispatchResult };
  runNow: { input: EntityMutation; result: ScheduleRunRecord };
  retryRun: { input: EntityMutation; result: ScheduleRunRecord };
  cancelRun: { input: EntityMutation; result: ScheduleRunRecord };
  executeLocalRun: { input: EntityMutation; result: ScheduleRunRecord };
  markNotificationRead: { input: EntityMutation; result: NotificationRecord };
}

/** Separate manual family: legacy ScheduleRunData and definition receipts remain unchanged. */
export type { ManualInventoryRunData, ManualInventoryResultReference } from './manual-inventory-protocol';
export type ManualInventoryRunRecord = DomainRecord<import('./manual-inventory-protocol').ManualInventoryRunData>;
