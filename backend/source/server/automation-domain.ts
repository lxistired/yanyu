import { types as nodeTypes } from 'node:util';
import { AdapterError, type ServerContext } from '../shared/contracts';
import type { DomainRecord, DomainTransaction, JsonValue } from '../shared/workspace';
import { DomainStore } from './workspace-store';
import type { MeetingNotificationTarget } from '../shared/meeting-reminders';
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
export interface SafeLocalRunner {
  claimLocalRun(context: ServerContext, request: ClaimLocalRun): ScheduleRunRecord;
  completeLocalRun(context: ServerContext, request: CompleteLocalRun): ScheduleRunRecord;
  executeLocalRun(context: ServerContext, request: EntityMutation): ScheduleRunRecord;
  failLocalRun(context: ServerContext, request: FailLocalRun): ScheduleRunRecord;
}
export type AutomationDomainOptions = {
  now?: () => Date;
  /** Trusted bridge registration, not a client setting. Disabled until report binding/runner routes are installed. */
  localEvidenceReportsEnabled?: boolean;
  /** Server-owned capabilities, never supplied by a browser. Local archive availability must be verified by the host. */
  localSources?: readonly { kind: 'local-workspace' | 'local-archive'; available: boolean; detail: string }[];
};
const deterministicErrors = new WeakSet<object>();
const deterministic = (code: 'INVALID_REQUEST' | 'CONFLICT', message: string) => { const cause = new AdapterError(code, message); deterministicErrors.add(cause); return cause; };
const invalid = (message: string) => deterministic('INVALID_REQUEST', message);
const conflict = (message: string) => deterministic('CONFLICT', message);
const commandEnvelopeKey = (request: unknown): string => { if (!request || typeof request !== 'object' || nodeTypes.isProxy(request)) return ''; const key = Object.getOwnPropertyDescriptor(request, 'idempotencyKey')?.value; return command({idempotencyKey:key}); };
const handlers = [
  'local-notification',
  'local-checkpoint',
  'local-evidence-report',
  'external-research',
  'local-document-inventory',
] as const;
const sourceKinds = [
  'local-workspace',
  'local-archive',
  'web-search',
  'private-drive',
  'vendor-feed',
] as const;
const terminal = new Set<ScheduleRunState>(['completed', 'cancelled', 'unavailable', 'skipped', 'failed']);
const commandFields = ['idempotencyKey'];
const mutationFields = [...commandFields, 'id', 'expectedRevision'];
const skillFields = ['name', 'description', 'enabled', 'handler'];
const sourceFields = ['name', 'kind', 'enabled', 'collectionIds'];
const scheduleFields = [
  'name',
  'skillId',
  'sourceIds',
  'instructions',
  'cadence',
  'enabled',
  'misfirePolicy',
  'graceSeconds',
];
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw invalid('Expected a plain configuration object');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.includes(key)))
    throw invalid(
      'Unsupported configuration field; credentials, endpoints and executable code are not accepted',
    );
  return result;
}
function text(value: unknown, field: string, max: number, empty = false): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && !value.trim()) ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })
  )
    throw invalid(`Invalid ${field}`);
  // Do not persist recognizable credentials in fields or replay results. Errors never echo their input.
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:sk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S+/i.test(
      value,
    )
  )
    throw invalid('Credentials are not accepted in local automation configuration');
  return value.trim();
}
function identifier(value: unknown, field = 'ID'): string {
  text(value, field, 100);
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw invalid(`Invalid ${field}`);
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw invalid('Expected a positive revision');
  return Number(value);
}
function bool(value: unknown, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') throw invalid('Expected a boolean');
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw invalid(`Unsupported ${field}`);
  return value as T;
}
function integer(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw invalid(`Invalid ${field}`);
  return Number(value);
}
function ids(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) throw invalid('Too many or invalid logical IDs');
  const result = value.map((entry) => identifier(entry));
  if (new Set(result).size !== result.length) throw invalid('Duplicate logical IDs');
  return result;
}
function command(value: Command): string {
  // Invalid keys cannot identify a durable command and must never become terminal receipts.
  try { return text(value.idempotencyKey, 'idempotency key', 100); }
  catch (cause) { if (cause instanceof AdapterError) throw new AdapterError(cause.code, cause.message); throw cause; }
}
function mutation(value: EntityMutation): void {
  command(value);
  identifier(value.id);
  revision(value.expectedRevision);
}
function fresh<T extends JsonValue>(record: DomainRecord<T>, expected: number): DomainRecord<T> {
  if (record.revision !== expected) throw conflict('Record changed; refresh before retrying');
  return record;
}
function capped(tx: DomainTransaction, kind: 'skill' | 'data-source' | 'schedule'): void {
  if (tx.list(kind, true).length >= 100) throw new AdapterError('INVALID_REQUEST', `Local ${kind} limit reached (100 including trash)`);
}
function instant(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(
      value,
    )
  )
    throw invalid('Time must be an ISO instant with an explicit UTC offset');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getUTCFullYear() < 1970 || parsed.getUTCFullYear() > 2099)
    throw invalid('Time must be between 1970 and 2099');
  // Date.parse normalizes impossible month days; reject them rather than silently rescheduling.
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) throw invalid('Invalid calendar date');
  return parsed.toISOString();
}
function timezone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value))
    throw invalid('Expected an IANA timezone');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw invalid('Unknown IANA timezone');
  }
}
export function validateScheduleCadence(value: unknown): ScheduleCadence {
  const input = object(value, ['kind', 'at', 'time', 'timezone', 'weekdays']);
  const zone = timezone(input.timezone);
  if (input.kind === 'once') {
    object(value, ['kind', 'at', 'timezone']);
    return { kind: 'once', at: instant(input.at), timezone: zone };
  }
  const kind = choice(input.kind, ['daily', 'weekly'], 'schedule cadence');
  object(value, kind === 'daily' ? ['kind', 'time', 'timezone'] : ['kind', 'time', 'timezone', 'weekdays']);
  if (typeof input.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time))
    throw invalid('Wall time must be HH:mm');
  if (kind === 'daily') return { kind, time: input.time, timezone: zone };
  if (!Array.isArray(input.weekdays) || input.weekdays.length < 1 || input.weekdays.length > 7)
    throw invalid('Weekly schedules need one to seven weekdays (Sunday = 0)');
  const weekdays = input.weekdays.map((day) => integer(day, 0, 6, 'weekday')).sort();
  if (new Set(weekdays).size !== weekdays.length) throw invalid('Duplicate weekdays');
  return { kind, time: input.time, timezone: zone, weekdays };
}
type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };
function formatter(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}
function wallAt(format: Intl.DateTimeFormat, time: number): Wall {
  const values: Record<string, number> = {};
  for (const part of format.formatToParts(time))
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  return values as Wall;
}
const wallEpoch = (wall: Wall) =>
  Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
function wallInstant(
  format: Intl.DateTimeFormat,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number | null {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = naive + hours * 3_600_000;
    offsets.add(wallEpoch(wallAt(format, sample)) - sample);
  }
  const candidates = [...offsets]
    .map((offset) => naive - offset)
    .filter((candidate) => {
      const actual = wallAt(format, candidate);
      return (
        actual.year === year &&
        actual.month === month &&
        actual.day === day &&
        actual.hour === hour &&
        actual.minute === minute
      );
    });
  // Spring-forward gaps are skipped. Fall-back overlaps run only at the first occurrence.
  return candidates.length ? Math.min(...candidates) : null;
}
function occurrence(
  cadence: ScheduleCadence,
  at: string,
  direction: 1 | -1,
  inclusive: boolean,
): string | null {
  const time = new Date(at).getTime();
  const matches = (candidate: number) =>
    direction === 1
      ? inclusive
        ? candidate >= time
        : candidate > time
      : inclusive
        ? candidate <= time
        : candidate < time;
  if (cadence.kind === 'once') return matches(new Date(cadence.at).getTime()) ? cadence.at : null;
  const format = formatter(cadence.timezone);
  const wall = wallAt(format, time);
  const start = Date.UTC(wall.year, wall.month - 1, wall.day);
  const [hour, minute] = cadence.time.split(':').map(Number);
  // Includes unusual timezone date skips; bounded independently of downtime length.
  for (let days = 0; days < 370; days++) {
    const date = new Date(start + direction * days * 86_400_000);
    if (date.getUTCFullYear() < 1970 || date.getUTCFullYear() > 2099) return null;
    if (cadence.kind === 'weekly' && !cadence.weekdays.includes(date.getUTCDay())) continue;
    const candidate = wallInstant(
      format,
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      hour,
      minute,
    );
    if (candidate !== null && matches(candidate)) return new Date(candidate).toISOString();
  }
  return null;
}
export function nextScheduleOccurrence(
  cadence: ScheduleCadence,
  after: string,
  inclusive = false,
): string | null {
  return occurrence(validateScheduleCadence(cadence), instant(after), 1, inclusive);
}
export function previousScheduleOccurrence(
  cadence: ScheduleCadence,
  before: string,
  inclusive = true,
): string | null {
  return occurrence(validateScheduleCadence(cadence), instant(before), -1, inclusive);
}
export class AutomationDomain {
private readonly now: () => Date;
private readonly localEvidenceReportsEnabled: boolean;
private readonly localSources: Map<string, { available: boolean; detail: string }>;
constructor(
    private readonly store: DomainStore,
    options: AutomationDomainOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.localEvidenceReportsEnabled = bool(options.localEvidenceReportsEnabled ?? false);
    this.localSources = new Map([
      [
        'local-workspace',
        {
          available: true,
          detail: 'Local workspace metadata is available; no external source connection is implied',
        },
      ],
    ]);
    for (const entry of options.localSources ?? []) {
      choice(entry.kind, ['local-workspace', 'local-archive'], 'server local capability');
      this.localSources.set(entry.kind, {
        available: bool(entry.available),
        detail: text(entry.detail, 'capability detail', 500),
      });
    }
  }
private timestamp(): string {
    return instant(this.now().toISOString());
  }
private write<T>(
    context: ServerContext,
    key: string,
    operation: string,
    request: JsonValue,
    action: (tx: DomainTransaction) => T,
  ): T {
    return this.store.write(context, key, { operation, request }, action);
  }
private skillView(record: SkillRecord): SkillView {
    const external = record.data.handler === 'external-research';
    return {
      ...record,
      availability:
        record.data.handler === 'local-document-inventory'
          ? {status:'unavailable',code:'dedicated_manual_only',detail:'Use the separate manual inventory capability; generic execution is not enabled',capabilities:[]}
          : record.data.handler === 'local-evidence-report'
          ? {
              status: this.localEvidenceReportsEnabled ? 'available' : 'unavailable',
              code: this.localEvidenceReportsEnabled
                ? 'pinned_local_report_bridge'
                : 'local_report_bridge_unavailable',
              detail: this.localEvidenceReportsEnabled
                ? 'Requires explicit recurring consent for an exact completed local plan; a separate guarded bridge executes each occurrence'
                : 'Local evidence report bridge is not installed; enabling the skill alone does not execute reports',
              capabilities: this.localEvidenceReportsEnabled ? ['local-evidence-report'] : [],
            }
          : external
            ? {
                status: 'unavailable',
                code: 'external_adapter_unavailable',
                detail:
                  'External research execution is not configured; enabling this skill does not connect a provider',
                capabilities: [],
              }
            : {
                status: 'available',
                code: 'local_only',
                detail: 'Explicit local runner only; no network, model, email, shell or third-party actions',
                capabilities: [record.data.handler],
              },
    };
  }
private sourceView(record: DataSourceRecord): DataSourceView {
    const local = this.localSources.get(record.data.kind);
    return {
      ...record,
      availability: local
        ? {
            status: local.available ? 'available' : 'unavailable',
            code: local.available ? 'local_available' : 'local_unavailable',
            detail: local.detail,
            capabilities: local.available ? ['local-read'] : [],
          }
        : {
            status: 'unavailable',
            code: 'not_configured',
            detail:
              'Source adapter is not configured; enabled is a preference, not a connection or permission grant',
            capabilities: [],
          },
    };
  }
listSkills(context: ServerContext, includeDeleted = false): SkillView[] {
    return this.store.read(context, (tx) =>
      tx.list<SkillData>('skill', bool(includeDeleted)).map((record) => this.skillView(record)),
    );
  }
getSkill(context: ServerContext, id: string): SkillView {
    return this.store.read(context, (tx) => this.skillView(tx.get<SkillData>('skill', identifier(id))));
  }
createSkill(context: ServerContext, request: CreateSkill): SkillView {
return this.skillView(this.store.writeAutomationDefinitionCommand(context, commandEnvelopeKey(request), 'automation.createSkill', request, () => {
    object(request, [...commandFields, ...skillFields]);
    command(request);
    const data: SkillData = {
      name: text(request.name, 'name', 100),
      description: text(request.description ?? '', 'description', 2000, true),
      enabled: bool(request.enabled, false),
      handler: choice(request.handler, handlers, 'skill handler'),
    };
    
return {request: {operation: 'createSkill', request: data}, action: (tx) => {
      capped(tx, 'skill');
      return tx.create('skill', data);
    }};
}, cause => cause !== null && typeof cause === 'object' && deterministicErrors.has(cause)));
}
updateSkill(context: ServerContext, request: UpdateSkill): SkillView {
return this.skillView(this.store.writeAutomationDefinitionCommand(context, commandEnvelopeKey(request), 'automation.updateSkill', request, () => {
    object(request, [...mutationFields, 'patch']);
    mutation(request);
    object(request.patch, skillFields);
    const patch: Partial<SkillData> = {};
    if ('name' in request.patch) patch.name = text(request.patch.name, 'name', 100);
    if ('description' in request.patch)
      patch.description = text(request.patch.description, 'description', 2000, true);
    if ('enabled' in request.patch) patch.enabled = bool(request.patch.enabled);
    if ('handler' in request.patch) patch.handler = choice(request.patch.handler, handlers, 'skill handler');
    if (!Object.keys(patch).length) throw invalid('Empty skill update');
    
return {request: {operation: 'updateSkill', request: { id: request.id, expectedRevision: request.expectedRevision, patch }}, action: (tx) => {
          const current = fresh(tx.get<SkillData>('skill', request.id), request.expectedRevision);
          return tx.update('skill', current.id, current.revision, { ...current.data, ...patch });
        }};
}, cause => cause !== null && typeof cause === 'object' && deterministicErrors.has(cause)));
}
deleteSkill(context: ServerContext, request: EntityMutation): SkillRecord {
    return this.deleteConfiguration(context, request, 'skill') as SkillRecord;
  }
restoreSkill(context: ServerContext, request: EntityMutation): SkillView {
    return this.skillView(this.restoreConfiguration(context, request, 'skill') as SkillRecord);
  }
listDataSources(context: ServerContext, includeDeleted = false): DataSourceView[] {
    return this.store.read(context, (tx) =>
      tx.list<DataSourceData>('data-source', bool(includeDeleted)).map((record) => this.sourceView(record)),
    );
  }
getDataSource(context: ServerContext, id: string): DataSourceView {
    return this.store.read(context, (tx) =>
      this.sourceView(tx.get<DataSourceData>('data-source', identifier(id))),
    );
  }
createDataSource(context: ServerContext, request: CreateDataSource): DataSourceView {
return this.sourceView(this.store.writeAutomationDefinitionCommand(context, commandEnvelopeKey(request), 'automation.createDataSource', request, () => {
    object(request, [...commandFields, ...sourceFields]);
    command(request);
    const data: DataSourceData = {
      name: text(request.name, 'name', 100),
      kind: choice(request.kind, sourceKinds, 'source kind'),
      enabled: bool(request.enabled, false),
      collectionIds: ids(request.collectionIds ?? [], 50),
    };
    if (data.kind !== 'local-workspace' && data.kind !== 'local-archive' && data.collectionIds.length)
      throw invalid('External sources cannot be configured with local collection IDs');
    
return {request: {operation: 'createDataSource', request: data}, action: (tx) => {
        capped(tx, 'data-source');
        return tx.create('data-source', data);
      }};
}, cause => cause !== null && typeof cause === 'object' && deterministicErrors.has(cause)));
}
updateDataSource(context: ServerContext, request: UpdateDataSource): DataSourceView {
return this.sourceView(this.store.writeAutomationDefinitionCommand(context, commandEnvelopeKey(request), 'automation.updateDataSource', request, () => {
    object(request, [...mutationFields, 'patch']);
    mutation(request);
    object(request.patch, ['name', 'enabled', 'collectionIds']);
    const patch: Partial<DataSourceData> = {};
    if ('name' in request.patch) patch.name = text(request.patch.name, 'name', 100);
    if ('enabled' in request.patch) patch.enabled = bool(request.patch.enabled);
    if ('collectionIds' in request.patch) patch.collectionIds = ids(request.patch.collectionIds, 50);
    if (!Object.keys(patch).length) throw invalid('Empty source update');
    
return {request: {operation: 'updateDataSource', request: { id: request.id, expectedRevision: request.expectedRevision, patch }}, action: (tx) => {
          const current = fresh(tx.get<DataSourceData>('data-source', request.id), request.expectedRevision);
          const data = { ...current.data, ...patch };
          if (data.kind !== 'local-workspace' && data.kind !== 'local-archive' && data.collectionIds.length)
            throw invalid('External sources cannot be configured with local collection IDs');
          return tx.update('data-source', current.id, current.revision, data);
        }};
}, cause => cause !== null && typeof cause === 'object' && deterministicErrors.has(cause)));
}
deleteDataSource(context: ServerContext, request: EntityMutation): DataSourceRecord {
    return this.deleteConfiguration(context, request, 'data-source') as DataSourceRecord;
  }
restoreDataSource(context: ServerContext, request: EntityMutation): DataSourceView {
    return this.sourceView(this.restoreConfiguration(context, request, 'data-source') as DataSourceRecord);
  }
private deleteConfiguration(
    context: ServerContext,
    request: EntityMutation,
    kind: 'skill' | 'data-source',
  ): DomainRecord {
return this.store.writeAutomationDefinitionCommand(context, commandEnvelopeKey(request), kind==='skill'?'automation.deleteSkill':'automation.deleteDataSource', request, () => {
    object(request, mutationFields);
    mutation(request);
    
return {request: {operation: `delete-${kind}`, request: { id: request.id, expectedRevision: request.expectedRevision }}, action: (tx) => { const current = fresh(tx.get(kind, request.id), request.expectedRevision); return tx.softDelete(kind, current.id, current.revision); }};
}, cause => cause !== null && typeof cause === 'object' && deterministicErrors.has(cause));
}
private restoreConfiguration(
    context: ServerContext,
    request: EntityMutation,
    kind: 'skill' | 'data-source',
  ): DomainRecord {
return this.store.writeAutomationDefinitionCommand(context, commandEnvelopeKey(request), kind==='skill'?'automation.restoreSkill':'automation.restoreDataSource', request, () => {
    object(request, mutationFields);
    mutation(request);
    
return {request: {operation: `restore-${kind}`, request: { id: request.id, expectedRevision: request.expectedRevision }}, action: (tx) => {
        const old = fresh(
          tx.get<SkillData | DataSourceData>(kind, request.id, true),
          request.expectedRevision,
        );
        if (!old.deletedAt) throw conflict('Configuration is not deleted');
        const restored = tx.restore(kind, old.id, old.revision);
        return tx.update(kind, restored.id, restored.revision, { ...old.data, enabled: false });
      }};
}, cause => cause !== null && typeof cause === 'object' && deterministicErrors.has(cause));
}
private relationships(tx: DomainTransaction, skillId: string, sourceIds: string[]): void {
    tx.get('skill', skillId);
    for (const sourceId of sourceIds) tx.get('data-source', sourceId);
  }
createSchedule(context: ServerContext, request: CreateSchedule): ScheduleRecord {
return this.store.writeAutomationDefinitionCommand(context, commandEnvelopeKey(request), 'automation.createSchedule', request, () => {
    object(request, [...commandFields, ...scheduleFields]);
    command(request);
    const cadence = validateScheduleCadence(request.cadence);
    const data = {
      name: text(request.name, 'name', 100),
      skillId: identifier(request.skillId),
      sourceIds: ids(request.sourceIds ?? [], 20),
      instructions: text(request.instructions ?? '', 'instructions', 4000, true),
      cadence,
      enabled: bool(request.enabled, false),
      misfirePolicy: choice(request.misfirePolicy ?? 'coalesce', ['coalesce', 'skip'], 'misfire policy'),
      graceSeconds: integer(request.graceSeconds ?? 60, 0, 3600, 'grace seconds'),
    };
    
return {request: {operation: 'createSchedule', request: data}, action: (tx) => {
      capped(tx, 'schedule');
      this.relationships(tx, data.skillId, data.sourceIds);
      const nextRunAt = occurrence(cadence, this.timestamp(), 1, true);
      if (!nextRunAt) throw invalid('Schedule has no future occurrence');
      return tx.create<ScheduleData>('schedule', { ...data, state: 'active', nextRunAt, lastRunAt: null });
    }};
}, cause => cause !== null && typeof cause === 'object' && deterministicErrors.has(cause));
}
listSchedules(context: ServerContext, includeDeleted = false): ScheduleRecord[] {
    return this.store.read(context, (tx) => tx.list<ScheduleData>('schedule', bool(includeDeleted)));
  }
getSchedule(context: ServerContext, id: string): ScheduleRecord {
    return this.store.read(context, (tx) => tx.get<ScheduleData>('schedule', identifier(id)));
  }
updateSchedule(context: ServerContext, request: UpdateSchedule): ScheduleRecord {
return this.store.writeAutomationDefinitionCommand(context, commandEnvelopeKey(request), 'automation.updateSchedule', request, () => {
    object(request, [...mutationFields, 'patch']);
    mutation(request);
    object(request.patch, scheduleFields);
    const patch: UpdateSchedule['patch'] = {};
    if ('name' in request.patch) patch.name = text(request.patch.name, 'name', 100);
    if ('skillId' in request.patch) patch.skillId = identifier(request.patch.skillId);
    if ('sourceIds' in request.patch) patch.sourceIds = ids(request.patch.sourceIds, 20);
    if ('instructions' in request.patch)
      patch.instructions = text(request.patch.instructions, 'instructions', 4000, true);
    if ('cadence' in request.patch) patch.cadence = validateScheduleCadence(request.patch.cadence);
    if ('enabled' in request.patch) patch.enabled = bool(request.patch.enabled);
    if ('misfirePolicy' in request.patch)
      patch.misfirePolicy = choice(
        request.patch.misfirePolicy,
        ['coalesce', 'skip'] as const,
        'misfire policy',
      );
    if ('graceSeconds' in request.patch)
      patch.graceSeconds = integer(request.patch.graceSeconds, 0, 3600, 'grace seconds');
    if (!Object.keys(patch).length) throw invalid('Empty schedule update');
    
return {request: {operation: 'updateSchedule', request: { id: request.id, expectedRevision: request.expectedRevision, patch }}, action: (tx) => {
        const old = fresh(tx.get<ScheduleData>('schedule', request.id), request.expectedRevision);
        const data = { ...old.data, ...patch };
        this.relationships(tx, data.skillId, data.sourceIds);
        if (patch.cadence || (patch.enabled === true && !old.data.enabled)) {
          data.nextRunAt = occurrence(data.cadence, this.timestamp(), 1, true);
          if (!data.nextRunAt) throw invalid('Schedule has no future occurrence; choose a new time');
          if (data.state === 'completed') data.state = 'paused';
        }
        return tx.update('schedule', old.id, old.revision, data);
      }};
}, cause => cause !== null && typeof cause === 'object' && deterministicErrors.has(cause));
}
setScheduleState(context: ServerContext, request: SetScheduleState): ScheduleRecord {
return this.store.writeAutomationDefinitionCommand(context, commandEnvelopeKey(request), 'automation.setScheduleState', request, () => {
    object(request, [...mutationFields, 'state']);
    mutation(request);
    const state = choice(request.state, ['active', 'paused', 'cancelled'], 'schedule state');
    
return {request: {operation: 'setScheduleState', request: { id: request.id, expectedRevision: request.expectedRevision, state }}, action: (tx) => {
        const old = fresh(tx.get<ScheduleData>('schedule', request.id), request.expectedRevision);
        let nextRunAt = old.data.nextRunAt;
        if (state === 'active' && old.data.state !== 'active') {
          nextRunAt = occurrence(old.data.cadence, this.timestamp(), 1, true);
          if (!nextRunAt)
            throw invalid('Schedule has no future occurrence; choose a new time before restarting');
        }
        if (state === 'cancelled') {
          nextRunAt = null;
          this.cancelPending(tx, old.id, 'schedule_cancelled');
        }
        return tx.update('schedule', old.id, old.revision, { ...old.data, state, nextRunAt });
      }};
}, cause => cause !== null && typeof cause === 'object' && deterministicErrors.has(cause));
}
deleteSchedule(context: ServerContext, request: EntityMutation): ScheduleRecord {
return this.store.writeAutomationDefinitionCommand(context, commandEnvelopeKey(request), 'automation.deleteSchedule', request, () => {
    object(request, mutationFields);
    mutation(request);
    
return {request: {operation: 'deleteSchedule', request: { id: request.id, expectedRevision: request.expectedRevision }}, action: (tx) => {
        const old = fresh(tx.get<ScheduleData>('schedule', request.id), request.expectedRevision);
        this.cancelPending(tx, old.id, 'schedule_deleted');
        const cancelled = tx.update('schedule', old.id, old.revision, {
          ...old.data,
          state: 'cancelled' as const,
          nextRunAt: null,
        });
        return tx.softDelete('schedule', old.id, cancelled.revision) as ScheduleRecord;
      }};
}, cause => cause !== null && typeof cause === 'object' && deterministicErrors.has(cause));
}
restoreSchedule(context: ServerContext, request: EntityMutation): ScheduleRecord {
return this.store.writeAutomationDefinitionCommand(context, commandEnvelopeKey(request), 'automation.restoreSchedule', request, () => {
    object(request, mutationFields);
    mutation(request);
    
return {request: {operation: 'restoreSchedule', request: { id: request.id, expectedRevision: request.expectedRevision }}, action: (tx) => {
        const old = fresh(tx.get<ScheduleData>('schedule', request.id, true), request.expectedRevision);
        if (!old.deletedAt) throw conflict('Schedule is not deleted');
        const restored = tx.restore('schedule', old.id, old.revision);
        return tx.update('schedule', old.id, restored.revision, {
          ...old.data,
          state: 'paused' as const,
          enabled: false,
          nextRunAt: occurrence(old.data.cadence, this.timestamp(), 1, true),
        });
      }};
}, cause => cause !== null && typeof cause === 'object' && deterministicErrors.has(cause));
}
private cancelPending(tx: DomainTransaction, scheduleId: string, code: string): void {
    const now = this.timestamp();
    for (const run of tx.list<ScheduleRunData>('schedule-run')) {
      if (run.data.scheduleId === scheduleId && !terminal.has(run.data.state))
        tx.update('schedule-run', run.id, run.revision, {
          ...run.data,
          state: 'cancelled',
          lease: null,
          finishedAt: now,
          code,
          detail: 'Local job cancelled before completion',
        });
    }
  }
}