import { createHash, randomUUID } from "node:crypto";
import {
  AdapterError,
  type ResearchDocument,
  type ServerContext,
} from "../shared/contracts";
import {
  readerCanonical,
  readerDocumentIdentity,
  type ReaderSourcePin,
} from "../shared/reader-reference";
import {
  SERVICE_ACTIVITY_KINDS,
  SERVICE_ACTIVITY_STATUSES,
  SERVICE_REPORT_LIMITS as L,
  type ServiceActivity,
  type ServiceActivityPage,
  type ServiceActivityHead,
  type ServiceActivityInput,
  type ServiceActivityVersion,
  type ServiceCustomer,
  type ServiceCustomerPin,
  type ServiceMonth,
  type ServiceReport,
  type ServiceReportCard,
  type ServiceReportFormat,
  type ServiceReportPage,
  type ServiceReportSnapshot,
  type ServiceReportState,
  type ServiceReportTotals,
} from "../shared/service-reports";
import type {
  ServiceCustomerObservation,
  ServiceLedgerRow,
  ServiceLedgerTransaction,
  ServiceOwnerObservation,
  ServiceReadBudget,
  ServiceReceipt,
  ServiceReportOwnerPort,
  ServiceReportCommandRepository,
  ServiceCommandResolution,
  ServiceReportSourcePort,
  ServiceSourceObservation,
} from "./service-report-ports";
import {
  serviceInstant,
  serviceMonth,
  serviceMonthContains,
} from "./service-report-month";
import {
  renderServiceReport,
  type ServiceReportDownload,
} from "./service-report-render";

type Operation = {
  context: ServerContext;
  scope: string;
  check(): void;
  budget: ServiceReadBudget;
  deadline: number;
  observations: ServiceOwnerObservation[];
  customers: Map<string, ServiceCustomerObservation>;
  sources: Map<string, ServiceSourceObservation>;
};
type ReportRows = {
  row: ServiceLedgerRow<ServiceReportSnapshot>;
  state: ServiceLedgerRow<ServiceReportState>;
};
const hash = (value: unknown) =>
  createHash("sha256").update(readerCanonical(value)).digest("hex");
const equal = (a: unknown, b: unknown) =>
  readerCanonical(a) === readerCanonical(b);
const invalid = (message = "服务月报请求无效或超过限制"): never => {
  throw new AdapterError("INVALID_REQUEST", message);
};
const conflict = (message = "服务活动、来源或月报已改变，请刷新"): never => {
  throw new AdapterError("CONFLICT", message);
};
const corrupt = (): never => {
  throw new AdapterError("PROVIDER_ERROR", "服务月报持久记录或可信端口无效");
};
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  for (const [key, d] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  ))
    if (!keys.includes(key) || !("value" in d) || d.value === undefined)
      invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    Buffer.byteLength(value) > max * 4 ||
    Array.from(value).some(
      (c) =>
        (c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0))) ||
        c.charCodeAt(0) === 127,
    ) ||
    /[\u202a-\u202e\u2066-\u2069]/u.test(value) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    return invalid();
  return value;
}
function id(value: unknown): string {
  const out = text(value, 100);
  if (!/^[A-Za-z0-9_-]+$/.test(out)) return invalid();
  return out;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    return invalid();
  return value;
}
function integer(value: unknown, min = 1): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) >= Number.MAX_SAFE_INTEGER
  )
    return invalid();
  return Number(value);
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean") return invalid();
  return value;
}
function customer(value: unknown): ServiceCustomer {
  const v = object(value, ["organizationId", "contactId"]);
  return {
    organizationId: id(v.organizationId),
    contactId: v.contactId === null ? null : id(v.contactId),
  };
}
function customerPin(value: unknown): ServiceCustomerPin {
  const v = object(value, [
    "organizationId",
    "contactId",
    "organizationRevision",
    "contactRevision",
  ]);
  const ref = customer({
    organizationId: v.organizationId,
    contactId: v.contactId,
  });
  if ((ref.contactId === null) !== (v.contactRevision === null))
    return invalid();
  return {
    ...ref,
    organizationRevision: integer(v.organizationRevision),
    contactRevision:
      v.contactRevision === null ? null : integer(v.contactRevision),
  };
}
function pin(value: unknown): ReaderSourcePin {
  const v = object(value, [
    "documentId",
    "revisionId",
    "tenantId",
    "collectionId",
    "sha256",
  ]);
  return {
    documentId: text(v.documentId, 500),
    revisionId: text(v.revisionId, 500),
    tenantId: text(v.tenantId, 100),
    collectionId: text(v.collectionId, 500),
    sha256: digest(v.sha256),
  };
}
function activityInput(value: unknown): ServiceActivityInput {
  const v = object(value, [
    "customer",
    "kind",
    "status",
    "occurredAt",
    "summary",
    "references",
    "ordinarySource",
  ]);
  if (
    !SERVICE_ACTIVITY_KINDS.includes(v.kind as never) ||
    !SERVICE_ACTIVITY_STATUSES.includes(v.status as never) ||
    !Array.isArray(v.references) ||
    !v.references.length ||
    v.references.length > L.sourcesPerActivity
  )
    return invalid();
  const references = v.references
    .map((item) => ({ pin: pin(object(item, ["pin"]).pin) }))
    .sort((a, b) => {
      const left = readerCanonical(a),
        right = readerCanonical(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  if (
    new Set(
      references.map((item) =>
        readerCanonical([item.pin.documentId, item.pin.revisionId]),
      ),
    ).size !== references.length
  )
    return invalid("不能重复计入同一来源版本");
  let ordinarySource: ServiceActivityInput["ordinarySource"];
  if (v.ordinarySource !== undefined) {
    const source = object(v.ordinarySource, ["id", "revision", "sha256", "recordJson"]);
    ordinarySource = { id: id(source.id), revision: integer(source.revision), sha256: digest(source.sha256), recordJson: text(source.recordJson, 16000) };
    let record;
    try { record = JSON.parse(ordinarySource.recordJson); } catch { return invalid(); }
    if (record.id !== ordinarySource.id || record.revision !== ordinarySource.revision || record.kind !== "service-record" || hash(record) !== ordinarySource.sha256) return invalid();
  }
  return {
    ...(ordinarySource ? { ordinarySource } : {}),
    customer: customer(v.customer),
    kind: v.kind as ServiceActivityInput["kind"],
    status: v.status as ServiceActivityInput["status"],
    occurredAt: serviceInstant(v.occurredAt),
    summary: text(v.summary, 1000),
    references,
  };
}
function storedActivity(
  tx: ServiceLedgerTransaction,
  key: string,
): ServiceActivity {
  const row = tx.get<ServiceActivityHead>("activity", key),
    head = object(row.data, ["schema", "versionId", "archivedAt"]);
  if (head.schema !== 1 || row.id !== key) return corrupt();
  const versionId = id(head.versionId),
    versionRow = tx.get<ServiceActivityVersion>("activity-version", versionId);
  const v = object(versionRow.data, [
    "schema",
    "activityId",
    "sequence",
    "recordedAt",
    "recordedBySubject",
    "customerAtRecord",
    "value",
    "provenance",
    "correction",
  ]);
  if (
    v.schema !== 1 ||
    v.activityId !== key ||
    v.provenance !== "user-recorded-local" ||
    versionRow.revision !== 1
  )
    return corrupt();
  const value = activityInput(v.value),
    customerAtRecord = customerPin(v.customerAtRecord);
  if (
    !equal(value.customer, {
      organizationId: customerAtRecord.organizationId,
      contactId: customerAtRecord.contactId,
    })
  )
    return corrupt();
  const correction =
    v.correction === null
      ? null
      : object(v.correction, ["previousVersionId", "reason"]);
  const version: ServiceActivityVersion = {
    schema: 1,
    activityId: key,
    sequence: integer(v.sequence),
    recordedAt: serviceInstant(v.recordedAt),
    recordedBySubject: text(v.recordedBySubject, 100),
    customerAtRecord,
    value,
    provenance: "user-recorded-local",
    correction: correction
      ? {
          previousVersionId: id(correction.previousVersionId),
          reason: text(correction.reason, 500),
        }
      : null,
  };
  return {
    id: key,
    revision: integer(row.revision),
    versionId,
    archivedAt:
      head.archivedAt === null ? null : serviceInstant(head.archivedAt),
    version,
  };
}
function stateRow(
  row: ServiceLedgerRow<ServiceReportState>,
): ServiceLedgerRow<ServiceReportState> {
  const v = object(row.data, ["schema", "archivedAt", "supersededByReportId"]);
  if (v.schema !== 1) return corrupt();
  return {
    id: id(row.id),
    revision: integer(row.revision),
    data: {
      schema: 1,
      archivedAt: v.archivedAt === null ? null : serviceInstant(v.archivedAt),
      supersededByReportId:
        v.supersededByReportId === null ? null : id(v.supersededByReportId),
    },
  };
}
function totals(activities: ServiceActivity[]): ServiceReportTotals {
  const byKind = Object.fromEntries(
    SERVICE_ACTIVITY_KINDS.map((kind) => [kind, 0]),
  ) as ServiceReportTotals["byKind"];
  const byStatus = Object.fromEntries(
    SERVICE_ACTIVITY_STATUSES.map((status) => [status, 0]),
  ) as ServiceReportTotals["byStatus"];
  for (const item of activities) {
    byKind[item.version.value.kind]++;
    byStatus[item.version.value.status]++;
  }
  return {
    metric: "owner-recorded-activities",
    totalRecords: activities.length,
    byKind,
    byStatus,
    clientReadingVerified: false,
    clientAttendanceVerified: false,
    externalDeliveryVerified: false,
  };
}
const basis = (activities: ServiceActivity[]) =>
  hash(activities.map((a) => [a.id, a.revision, a.versionId]));
const sorted = (a: ServiceActivity, b: ServiceActivity) => {
  const left = `${a.version.value.occurredAt}:${a.id}`,
    right = `${b.version.value.occurredAt}:${b.id}`;
  return left < right ? -1 : left > right ? 1 : 0;
};
function selectActivities(
  tx: ServiceLedgerTransaction,
  ref: ServiceCustomer,
  period: ServiceMonth,
  includeArchived = false,
  maxActivities: number = L.activitiesPerReport,
): ServiceActivity[] {
  const result: ServiceActivity[] = [];
  for (const head of tx.list<ServiceActivityHead>("activity")) {
    const item = storedActivity(tx, head.id),
      value = item.version.value;
    if (
      (includeArchived || !item.archivedAt) &&
      value.customer.organizationId === ref.organizationId &&
      (ref.contactId === null || value.customer.contactId === ref.contactId) &&
      serviceMonthContains(period, value.occurredAt)
    ) {
      result.push(item);
      if (result.length > maxActivities)
        throw new AdapterError(
          "RATE_LIMITED",
          "本月活动超过完整月报行数限制；未截断",
        );
    }
  }
  return result.sort(sorted);
}
function storedPeriod(value: unknown): ServiceMonth {
  const p = object(value, [
    "month",
    "timeZone",
    "membership",
    "utcMarkers",
    "tzdbVersion",
  ]);
  if (p.membership !== "local-calendar-year-month") return corrupt();
  const checked = serviceMonth(p.month, p.timeZone);
  const markers = object(p.utcMarkers, [
    "firstInstantOfMonth",
    "firstInstantOfFollowingMonth",
  ]);
  const firstInstantOfMonth = serviceInstant(markers.firstInstantOfMonth);
  const firstInstantOfFollowingMonth = serviceInstant(
    markers.firstInstantOfFollowingMonth,
  );
  // These first-occurrence markers are not a claim of contiguous UTC membership.
  const separation =
    Date.parse(firstInstantOfFollowingMonth) - Date.parse(firstInstantOfMonth);
  if (separation <= 0 || separation > 33 * 24 * 3_600_000) return corrupt();
  return {
    month: checked.month,
    timeZone: text(p.timeZone, 100),
    membership: "local-calendar-year-month",
    utcMarkers: { firstInstantOfMonth, firstInstantOfFollowingMonth },
    tzdbVersion: text(p.tzdbVersion, 100),
  };
}
function reportRows(tx: ServiceLedgerTransaction, key: string): ReportRows {
  const row = tx.get<ServiceReportSnapshot>("report", key),
    state = stateRow(tx.get<ServiceReportState>("report-state", key));
  // Full immutable activity payloads are rechecked against their own retained immutable versions.
  const s = row.data;
  object(s, [
    "schema",
    "provenance",
    "evidenceClass",
    "generatedAt",
    "generatedBySubject",
    "customer",
    "customerAtGeneration",
    "period",
    "activities",
    "totals",
    "basisSha256",
    "supersedesReportId",
  ]);
  if (
    row.revision !== 1 ||
    s.schema !== 1 ||
    s.provenance !== "derived-user-recorded-service-summary" ||
    s.evidenceClass !== "derived-artifact" ||
    !Array.isArray(s.activities) ||
    s.activities.length > L.activitiesPerReport
  )
    return corrupt();
  serviceInstant(s.generatedAt);
  text(s.generatedBySubject, 100);
  customer(s.customer);
  const atGeneration = customerPin(s.customerAtGeneration);
  if (
    !equal(s.customer, {
      organizationId: atGeneration.organizationId,
      contactId: atGeneration.contactId,
    })
  )
    return corrupt();
  storedPeriod(s.period); // Retained boundaries belong to generation's tzdb, not today's runtime.
  if (s.supersedesReportId !== null) id(s.supersedesReportId);
  for (const a of s.activities) {
    object(a, ["id", "revision", "versionId", "archivedAt", "version"]);
    id(a.id);
    integer(a.revision);
    id(a.versionId);
    const stored = tx.get<ServiceActivityVersion>(
      "activity-version",
      a.versionId,
    );
    if (
      stored.revision !== 1 ||
      !equal(stored.data, a.version) ||
      a.archivedAt !== null ||
      a.version.activityId !== a.id
    )
      return corrupt();
    activityInput(a.version.value);
    if (
      a.version.value.customer.organizationId !== s.customer.organizationId ||
      (s.customer.contactId !== null &&
        a.version.value.customer.contactId !== s.customer.contactId)
    )
      return corrupt();
  }
  if (
    new Set(s.activities.map((a) => a.id)).size !== s.activities.length ||
    !equal([...s.activities].sort(sorted), s.activities) ||
    !equal(totals(s.activities), s.totals) ||
    basis(s.activities) !== digest(s.basisSha256)
  )
    return corrupt();
  return { row, state };
}
/** Durable local service ledger. No network send, tracking pixel, CRM mutation, or model invocation. */
export class ServiceReportDomain {
  constructor(
    private repository: ServiceReportCommandRepository,
    private owners: ServiceReportOwnerPort,
    private sources: ServiceReportSourcePort,
    private options: { clock?: () => Date; requestBudget?: ServiceReadBudget; requestDeadline?: number } = {},
  ) {}
  private now() {
    return serviceInstant((this.options.clock?.() ?? new Date()).toISOString());
  }
  private operation(context: ServerContext, expected?: unknown): Operation {
    const identity = () =>
      readerCanonical([
        context.principal.tenantId,
        context.principal.subjectId,
        [...context.principal.collectionIds].sort(),
      ]);
    text(context.principal.tenantId, 100);
    text(context.principal.subjectId, 100);
    if (
      !Array.isArray(context.principal.collectionIds) ||
      context.principal.collectionIds.length > 1000
    )
      invalid();
    context.principal.collectionIds.forEach((value) => text(value, 500));
    const initial = identity(),
      scope = hash(initial),
      deadline = Math.min(performance.now() + L.operationMilliseconds, this.options.requestDeadline ?? Infinity);
    if (!Number.isFinite(deadline)) invalid();
    const shared = this.options.requestBudget;
    if (shared && (![shared.rows, shared.bytes, shared.sourceBytes].every(n => Number.isSafeInteger(n) && n >= 0) ||
      ![shared.maxRows, shared.maxBytes, shared.maxSourceBytes].every(n => Number.isSafeInteger(n) && n > 0) ||
      shared.maxRows > L.operationRows || shared.maxBytes > L.operationBytes || shared.maxSourceBytes > L.operationSourceBytes)) invalid();
    if (expected !== undefined && digest(expected) !== scope)
      throw new AdapterError("FORBIDDEN", "服务月报身份范围已改变");
    const op: Operation = {
      context: {
        ...context,
        principal: Object.freeze({
          ...context.principal,
          collectionIds: Object.freeze([...context.principal.collectionIds]),
        }),
      },
      scope,
      deadline,
      budget: shared ?? {
        rows: 0,
        bytes: 0,
        sourceBytes: 0,
        maxRows: L.operationRows,
        maxBytes: L.operationBytes,
        maxSourceBytes: L.operationSourceBytes,
      },
      observations: [],
      customers: new Map(),
      sources: new Map(),
      check: () => {
        if (context.signal.aborted)
          throw new AdapterError("CANCELLED", "服务月报操作已停止");
        if (performance.now() >= deadline)
          throw new AdapterError("RATE_LIMITED", "服务月报操作超过时间预算");
        if (identity() !== initial)
          throw new AdapterError(
            "FORBIDDEN",
            "服务月报当前身份或集合权限已改变",
          );
      },
    };
    Object.defineProperties(op.budget, {
      maxRows: { value: op.budget.maxRows, writable: false, configurable: false },
      maxBytes: { value: op.budget.maxBytes, writable: false, configurable: false },
      maxSourceBytes: { value: op.budget.maxSourceBytes, writable: false, configurable: false },
    });
    op.check();
    op.observations.push(this.owners.observeOwner(op.context, op.budget));
    this.fence(op);
    return op;
  }
  private fence(op: Operation) {
    op.check();
    if (
      ![op.budget.rows, op.budget.bytes, op.budget.sourceBytes].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      op.budget.rows > op.budget.maxRows ||
      op.budget.bytes > op.budget.maxBytes ||
      op.budget.sourceBytes > op.budget.maxSourceBytes
    )
      throw new AdapterError("RATE_LIMITED", "服务月报超过累计读取预算");
    for (const observation of op.observations) {
      const result: unknown = observation.check();
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => undefined);
        return corrupt();
      }
      op.check();
    }
  }
  scope(context: ServerContext): { scope: string } {
    return { scope: this.operation(context).scope };
  }
  private request(raw: unknown, fields: string[]) {
    const value = object(raw, fields);
    // Nested structures are normalized by dedicated validators before hashing; accessors are never invoked.
    return value;
  }
  private command(
    op: Operation,
    raw: Record<string, unknown>,
    normalized: unknown,
    action: string,
  ) {
    if (digest(raw.scope) !== op.scope)
      throw new AdapterError("FORBIDDEN", "服务月报身份范围已改变");
    const key = id(raw.idempotencyKey),
      encoded = readerCanonical(normalized);
    if (Buffer.byteLength(encoded) > L.requestBytes) invalid();
    return { key, fingerprint: hash([action, op.scope, normalized]) };
  }
  /** Recovery uses only the original validated DTO and retained receipt, never executes it.
   * Keep normalization identical to each mutation below; keys are bound to action, scope and payload.
   * Receipt-only recovery deliberately does not disclose source/customer/report contents.
   */
  private recoveryCommand(context: ServerContext, raw: unknown) {
    const envelope = this.request(raw, ["command"]),
      original = object(envelope.command, ["action", "input"]);
    const action = original.action;
    if (typeof action !== "string" || !["createActivity", "correctActivity", "archiveActivity", "createReport", "archiveReport"].includes(action)) invalid();
    const fields = action === "createActivity" ? ["activity"]
      : action === "correctActivity" ? ["id", "expectedRevision", "activity", "reason"]
      : action === "createReport" ? ["customer", "month", "timeZone", "supersedes"]
      : ["id", "expectedRevision", "archived"];
    const value = this.request(original.input, ["scope", "idempotencyKey", ...fields]),
      op = this.operation(context, value.scope);
    let normalized: unknown, operation: string;
    if (action === "createActivity") {
      operation = "create-activity";
      normalized = activityInput(value.activity);
    } else if (action === "correctActivity") {
      operation = "correct-activity";
      normalized = { key: id(value.id), expectedRevision: integer(value.expectedRevision), input: activityInput(value.activity), reason: text(value.reason, 500) };
    } else if (action === "createReport") {
      operation = "create-report";
      const period = serviceMonth(value.month, value.timeZone),
        prior = value.supersedes === null ? null : object(value.supersedes, ["id", "expectedRevision"]);
      normalized = { ref: customer(value.customer), month: period.month, timeZone: period.timeZone,
        supersedes: prior ? { id: id(prior.id), expectedRevision: integer(prior.expectedRevision) } : null };
    } else {
      operation = action === "archiveActivity" ? "archive-activity" : "archive-report";
      normalized = { key: id(value.id), expectedRevision: integer(value.expectedRevision), archived: flag(value.archived) };
    }
    return { op, command: this.command(op, value, normalized, operation),
      target: action === "createReport" || action === "archiveReport" ? "report" as const : "activity" as const,
      targetId: action === "createActivity" || action === "createReport" ? null : id(value.id) };
  }
  private recoveryResult(
    request: ReturnType<ServiceReportDomain["recoveryCommand"]>,
    resolution: ServiceCommandResolution | null,
  ) {
    const { op, command, target, targetId } = request;
    this.fence(op);
    if (!resolution) return { scope: op.scope, outcome: "absent" as const, receipt: null };
    if (resolution.outcome === "cancelled") {
      if (resolution.fingerprint !== command.fingerprint) return corrupt();
      return { scope: op.scope, outcome: "cancelled" as const, receipt: null,
        cancellation: { idempotencyKey: command.key, fingerprint: command.fingerprint } };
    }
    const receiptId = this.receiptId(resolution.receipt, target);
    if (targetId !== null && receiptId !== targetId) return corrupt();
    return { scope: op.scope, outcome: "committed" as const, receipt: { target, id: receiptId } };
  }
  recoverCommand(context: ServerContext, raw: unknown) {
    const request = this.recoveryCommand(context, raw), { op, command } = request;
    const result = this.repository.resolve(op.context, command.key, command.fingerprint, op.budget);
    // Absence is nonterminal: an earlier request may still be awaiting its source checks.
    return this.recoveryResult(request, result);
  }
  cancelCommand(context: ServerContext, raw: unknown) {
    const request = this.recoveryCommand(context, raw), { op, command } = request;
    // A retained tombstone and mutation receipt share the same transaction/key. Exactly one wins.
    const result = this.repository.cancel(op.context, command, op.budget, () => this.fence(op));
    return this.recoveryResult(request, result);
  }
  private read<T>(op: Operation, action: (tx: ServiceLedgerTransaction) => T) {
    this.fence(op);
    return this.repository.read(op.context, op.budget, action);
  }
  private observeCustomer(op: Operation, ref: ServiceCustomer) {
    const key = readerCanonical(ref),
      previous = op.customers.get(key);
    if (previous) return previous;
    const observed = this.owners.observeCustomer(op.context, ref, op.budget),
      detached = customerPin(observed.customer);
    if (
      !equal(ref, {
        organizationId: detached.organizationId,
        contactId: detached.contactId,
      })
    )
      return corrupt();
    const result = { customer: detached, check: observed.check.bind(observed) };
    op.customers.set(key, result);
    op.observations.push(result);
    this.fence(op);
    return result;
  }
  private async awaitSource<T>(
    op: Operation,
    action: (context: ServerContext) => Promise<T>,
  ): Promise<T> {
    this.fence(op);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, stop!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      stop = () => {
        controller.abort();
        reject(new AdapterError("CANCELLED", "服务月报来源读取已停止"));
      };
      op.context.signal.addEventListener("abort", stop, { once: true });
      timer = setTimeout(
        () => {
          controller.abort();
          reject(
            new AdapterError("RATE_LIMITED", "服务月报来源读取超过总时间预算"),
          );
        },
        Math.max(1, op.deadline - performance.now()),
      );
    });
    try {
      const result = await Promise.race([
        action({ ...op.context, signal: controller.signal }),
        stopped,
      ]);
      this.fence(op);
      return result;
    } finally {
      clearTimeout(timer);
      op.context.signal.removeEventListener("abort", stop);
    }
  }
  private async source(
    op: Operation,
    expected: ReaderSourcePin,
  ): Promise<ServiceSourceObservation> {
    if (
      expected.tenantId !== op.context.principal.tenantId ||
      !op.context.principal.collectionIds.includes(expected.collectionId)
    )
      throw new AdapterError("FORBIDDEN", "服务月报来源不在当前集合权限中");
    const key = readerCanonical(expected),
      previous = op.sources.get(key);
    if (previous) return previous;
    if (op.sources.size >= L.sourcesPerOperation)
      throw new AdapterError(
        "RATE_LIMITED",
        "服务月报来源数量超过完整核对限制",
      );
    const observed = await this.awaitSource(op, (context) =>
      this.sources.resolve(
        context,
        expected.documentId,
        expected.revisionId,
        op.budget,
      ),
    );
    if (
      observed.evidenceClass !== "primary-source" ||
      observed.authorizationMode !== "current-local"
    )
      throw new AdapterError(
        "INVALID_REQUEST",
        "服务月报只能引用当前本地可核对的原始来源；生成的报告不作原始证据",
      );
    const encoded = JSON.stringify(observed.document),
      bytes = Buffer.byteLength(encoded);
    op.budget.sourceBytes += bytes;
    if (bytes > L.sourceBytes || op.budget.sourceBytes > L.operationSourceBytes)
      throw new AdapterError(
        "RATE_LIMITED",
        "服务月报来源内容超过完整字节预算",
      );
    const document = JSON.parse(encoded) as ResearchDocument;
    if (
      !document ||
      typeof document !== "object" ||
      !["title", "author", "date", "excerpt", "body"].every(
        (field) =>
          typeof document[field as keyof ResearchDocument] === "string",
      ) ||
      !["research", "roadshow", "public"].includes(document.source) ||
      !Array.isArray(document.tags) ||
      document.tags.length > 1000 ||
      document.tags.some((tag) => typeof tag !== "string") ||
      !Number.isSafeInteger(document.pages) ||
      document.pages < 0 ||
      typeof document.mock !== "boolean"
    )
      return corrupt();
    const actual = {
      documentId: document.id,
      revisionId: document.revisionId,
      tenantId: document.tenantId,
      collectionId: document.collectionId,
      sha256: hash(readerDocumentIdentity(document)),
    };
    if (!equal(actual, expected))
      conflict("来源内容、归属或固定版本已改变；未替换成最新版本");
    const result: ServiceSourceObservation = {
      document,
      evidenceClass: "primary-source",
      authorizationMode: "current-local",
      check: observed.check.bind(observed),
    };
    op.sources.set(key, result);
    op.observations.push(result);
    this.fence(op);
    return result;
  }
  private async authorizeActivity(op: Operation, activity: ServiceActivity) {
    this.observeCustomer(op, activity.version.value.customer);
    for (const ref of activity.version.value.references)
      await this.source(op, ref.pin);
    this.fence(op);
  }
  private async activity(op: Operation, key: string): Promise<ServiceActivity> {
    const initial = this.read(op, (tx) => storedActivity(tx, key));
    await this.authorizeActivity(op, initial);
    const current = this.read(op, (tx) => storedActivity(tx, key));
    if (!equal(current, initial)) conflict();
    this.fence(op);
    return initial;
  }
  async getActivity(
    context: ServerContext,
    raw: unknown,
  ): Promise<{ scope: string; activity: ServiceActivity }> {
    const v = this.request(raw, ["id"]),
      op = this.operation(context);
    return { scope: op.scope, activity: await this.activity(op, id(v.id)) };
  }
  async listActivities(
    context: ServerContext,
    raw: unknown,
  ): Promise<ServiceActivityPage> {
    const v = this.request(raw, [
        "customer",
        "month",
        "timeZone",
        "includeArchived",
        "after",
        "censusSha256",
      ]),
      op = this.operation(context);
    const ref = customer(v.customer),
      period = serviceMonth(v.month, v.timeZone);
    const after =
      v.after === undefined || v.after === null ? null : id(v.after);
    const includeArchived =
      v.includeArchived === undefined ? false : flag(v.includeArchived);
    if (after && v.censusSha256 === undefined) invalid();
    this.observeCustomer(op, ref);
    const selected = this.read(op, (tx) =>
      selectActivities(tx, ref, period, includeArchived, L.operationRows),
    );
    const census = (rows: ServiceActivity[]) =>
      hash([
        ref,
        period.month,
        period.timeZone,
        includeArchived,
        rows.map((a) => [a.id, a.revision, a.versionId, a.archivedAt]),
      ]);
    const censusSha256 = census(selected);
    if (v.censusSha256 !== undefined && digest(v.censusSha256) !== censusSha256)
      conflict("服务活动列表已改变，请从第一页刷新");
    const offset = after ? selected.findIndex((a) => a.id === after) + 1 : 0;
    if (after && offset === 0) conflict();
    const items: ServiceActivity[] = [],
      pins = new Set<string>();
    let bytes = 0,
      nextAfter: string | null = null;
    for (const item of selected.slice(offset)) {
      const size = Buffer.byteLength(JSON.stringify(item));
      const nextPins = new Set([
        ...pins,
        ...item.version.value.references.map((r) => readerCanonical(r.pin)),
      ]);
      if (size > L.pageBytes)
        throw new AdapterError("RATE_LIMITED", "完整服务活动超过分页字节限制");
      if (
        items.length >= L.pageRows ||
        bytes + size > L.pageBytes ||
        nextPins.size > L.sourcesPerOperation
      ) {
        nextAfter = items.at(-1)!.id;
        break;
      }
      items.push(item);
      bytes += size;
      nextPins.forEach((key) => pins.add(key));
    }
    for (const item of items) await this.authorizeActivity(op, item);
    const current = this.read(op, (tx) =>
      selectActivities(tx, ref, period, includeArchived, L.operationRows),
    );
    if (census(current) !== censusSha256) conflict();
    this.fence(op);
    return { scope: op.scope, items, nextAfter, censusSha256, period };
  }
  async createActivity(
    context: ServerContext,
    raw: unknown,
  ): Promise<{ scope: string; activity: ServiceActivity }> {
    const v = this.request(raw, ["scope", "idempotencyKey", "activity"]),
      op = this.operation(context, v.scope),
      input = activityInput(v.activity);
    const command = this.command(op, v, input, "create-activity"),
      replay = this.repository.replay(
        op.context,
        command.key,
        command.fingerprint,
        op.budget,
      );
    if (replay)
      return {
        scope: op.scope,
        activity: await this.activity(op, this.receiptId(replay, "activity")),
      };
    const observed = this.observeCustomer(op, input.customer);
    for (const ref of input.references) await this.source(op, ref.pin);
    const key = randomUUID(),
      versionId = randomUUID(),
      now = this.now();
    const result = this.repository.write(
      op.context,
      command,
      op.budget,
      (tx) => {
        this.fence(op);
        if (input.ordinarySource) {
          for (const row of tx.list<ServiceActivityVersion>("activity-version")) {
            if (row.data.value.ordinarySource?.id === input.ordinarySource.id) conflict("该机构服务记录已投影；请预览并更正原活动，不能重复计入");
          }
        }
        tx.create<ServiceActivityVersion>("activity-version", versionId, {
          schema: 1,
          activityId: key,
          sequence: 1,
          recordedAt: now,
          recordedBySubject: op.context.principal.subjectId,
          customerAtRecord: observed.customer,
          value: input,
          provenance: "user-recorded-local",
          correction: null,
        });
        tx.create<ServiceActivityHead>("activity", key, {
          schema: 1,
          versionId,
          archivedAt: null,
        });
        return { target: "activity", id: key };
      },
      () => this.fence(op),
    );
    return {
      scope: op.scope,
      activity: await this.activity(op, this.receiptId(result, "activity")),
    };
  }
  private receiptId(receipt: ServiceReceipt, target: ServiceReceipt["target"]) {
    if (receipt.target !== target) return corrupt();
    return id(receipt.id);
  }
  async correctActivity(
    context: ServerContext,
    raw: unknown,
  ): Promise<{ scope: string; activity: ServiceActivity }> {
    const v = this.request(raw, [
        "scope",
        "idempotencyKey",
        "id",
        "expectedRevision",
        "activity",
        "reason",
      ]),
      op = this.operation(context, v.scope);
    const key = id(v.id),
      expectedRevision = integer(v.expectedRevision),
      input = activityInput(v.activity),
      reason = text(v.reason, 500);
    const command = this.command(
      op,
      v,
      { key, expectedRevision, input, reason },
      "correct-activity",
    );
    const replay = this.repository.replay(
      op.context,
      command.key,
      command.fingerprint,
      op.budget,
    );
    if (replay)
      return {
        scope: op.scope,
        activity: await this.activity(op, this.receiptId(replay, "activity")),
      };
    const current = this.read(op, (tx) => storedActivity(tx, key));
    if (current.revision !== expectedRevision || current.archivedAt) conflict();
    const previousSource = current.version.value.ordinarySource;
    if (previousSource) {
      if (!input.ordinarySource) input.ordinarySource = previousSource;
      else if (input.ordinarySource.id !== previousSource.id || input.ordinarySource.revision < previousSource.revision || (input.ordinarySource.revision === previousSource.revision && !equal(input.ordinarySource, previousSource))) conflict("机构服务来源不能更换或倒退");
    } else if (input.ordinarySource) conflict("不能将普通活动重新绑定为机构来源");
    const observed = this.observeCustomer(op, input.customer);
    for (const ref of input.references) await this.source(op, ref.pin);
    const versionId = randomUUID(),
      now = this.now();
    const result = this.repository.write(
      op.context,
      command,
      op.budget,
      (tx) => {
        const fresh = storedActivity(tx, key);
        if (!equal(fresh, current)) conflict();
        this.fence(op);
        tx.create<ServiceActivityVersion>("activity-version", versionId, {
          schema: 1,
          activityId: key,
          sequence: current.version.sequence + 1,
          recordedAt: now,
          recordedBySubject: op.context.principal.subjectId,
          customerAtRecord: observed.customer,
          value: input,
          provenance: "user-recorded-local",
          correction: { previousVersionId: current.versionId, reason },
        });
        tx.update<ServiceActivityHead>("activity", key, expectedRevision, {
          schema: 1,
          versionId,
          archivedAt: null,
        });
        return { target: "activity", id: key };
      },
      () => this.fence(op),
    );
    return {
      scope: op.scope,
      activity: await this.activity(op, this.receiptId(result, "activity")),
    };
  }
  archiveActivity(context: ServerContext, raw: unknown) {
    const v = this.request(raw, [
        "scope",
        "idempotencyKey",
        "id",
        "expectedRevision",
        "archived",
      ]),
      op = this.operation(context, v.scope);
    const key = id(v.id),
      expectedRevision = integer(v.expectedRevision),
      archived = flag(v.archived);
    const command = this.command(
      op,
      v,
      { key, expectedRevision, archived },
      "archive-activity",
    );
    const result = this.repository.write(
      op.context,
      command,
      op.budget,
      (tx) => {
        const current = storedActivity(tx, key);
        if (current.revision !== expectedRevision) conflict();
        tx.update<ServiceActivityHead>("activity", key, expectedRevision, {
          schema: 1,
          versionId: current.versionId,
          archivedAt: archived ? this.now() : null,
        });
        return { target: "activity", id: key };
      },
      () => this.fence(op),
    );
    // Metadata-only acknowledgement allows withdrawal cleanup without revealing unavailable source content.
    const current = this.read(op, (tx) =>
      tx.get<ServiceActivityHead>(
        "activity",
        this.receiptId(result, "activity"),
      ),
    );
    this.fence(op);
    return {
      scope: op.scope,
      id: current.id,
      revision: current.revision,
      archivedAt: current.data.archivedAt,
    };
  }
  async createReport(
    context: ServerContext,
    raw: unknown,
  ): Promise<{ scope: string; report: ServiceReport }> {
    const v = this.request(raw, [
        "scope",
        "idempotencyKey",
        "customer",
        "month",
        "timeZone",
        "supersedes",
      ]),
      op = this.operation(context, v.scope);
    const ref = customer(v.customer),
      period = serviceMonth(v.month, v.timeZone);
    const prior =
      v.supersedes === null
        ? null
        : object(v.supersedes, ["id", "expectedRevision"]);
    const supersedes = prior
      ? { id: id(prior.id), expectedRevision: integer(prior.expectedRevision) }
      : null;
    const command = this.command(
      op,
      v,
      { ref, month: period.month, timeZone: period.timeZone, supersedes },
      "create-report",
    );
    const replay = this.repository.replay(
      op.context,
      command.key,
      command.fingerprint,
      op.budget,
    );
    if (replay)
      return {
        scope: op.scope,
        report: await this.report(op, this.receiptId(replay, "report")),
      };
    const observed = this.observeCustomer(op, ref),
      activities = this.read(op, (tx) => selectActivities(tx, ref, period));
    for (const item of activities) await this.authorizeActivity(op, item);
    const key = randomUUID(),
      snapshot: ServiceReportSnapshot = {
        schema: 1,
        provenance: "derived-user-recorded-service-summary",
        evidenceClass: "derived-artifact",
        generatedAt: this.now(),
        generatedBySubject: op.context.principal.subjectId,
        customer: ref,
        customerAtGeneration: observed.customer,
        period,
        activities,
        totals: totals(activities),
        basisSha256: basis(activities),
        supersedesReportId: supersedes?.id ?? null,
      };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > L.recordBytes)
      throw new AdapterError("RATE_LIMITED", "完整月报超过单条字节预算");
    const result = this.repository.write(
      op.context,
      command,
      op.budget,
      (tx) => {
        if (!equal(selectActivities(tx, ref, period), activities))
          conflict("本月活动在来源核对期间改变，未提交过期月报");
        if (supersedes) {
          const old = reportRows(tx, supersedes.id);
          if (
            old.state.revision !== supersedes.expectedRevision ||
            old.state.data.archivedAt ||
            old.state.data.supersededByReportId ||
            !equal(old.row.data.customer, ref) ||
            old.row.data.period.month !== period.month ||
            old.row.data.period.timeZone !== period.timeZone
          )
            conflict();
          tx.update(
            "report-state",
            supersedes.id,
            supersedes.expectedRevision,
            { ...old.state.data, supersededByReportId: key },
          );
        }
        this.fence(op);
        tx.create("report", key, snapshot);
        tx.create<ServiceReportState>("report-state", key, {
          schema: 1,
          archivedAt: null,
          supersededByReportId: null,
        });
        return { target: "report", id: key };
      },
      () => this.fence(op),
    );
    return {
      scope: op.scope,
      report: await this.report(op, this.receiptId(result, "report")),
    };
  }
  private async report(op: Operation, key: string): Promise<ServiceReport> {
    const initial = this.read(op, (tx) => reportRows(tx, key)),
      snapshot = initial.row.data;
    this.observeCustomer(op, snapshot.customer);
    for (const item of snapshot.activities)
      await this.authorizeActivity(op, item);
    const current = this.read(op, (tx) => ({
      report: reportRows(tx, key),
      activities: selectActivities(tx, snapshot.customer, snapshot.period),
    }));
    if (!equal(current.report, initial)) conflict();
    this.fence(op);
    const result: ServiceReport = {
      id: key,
      revision: initial.state.revision,
      state: initial.state.data,
      snapshot,
      snapshotSha256: hash(snapshot),
      currentActivitiesChanged:
        basis(current.activities) !== snapshot.basisSha256,
      authorization: { mode: "current-local", checkedAt: this.now() },
    };
    this.fence(op);
    return result;
  }
  async getReport(
    context: ServerContext,
    raw: unknown,
  ): Promise<{ scope: string; report: ServiceReport }> {
    const v = this.request(raw, ["id"]),
      op = this.operation(context);
    return { scope: op.scope, report: await this.report(op, id(v.id)) };
  }
  archiveReport(context: ServerContext, raw: unknown) {
    const v = this.request(raw, [
        "scope",
        "idempotencyKey",
        "id",
        "expectedRevision",
        "archived",
      ]),
      op = this.operation(context, v.scope);
    const key = id(v.id),
      expectedRevision = integer(v.expectedRevision),
      archived = flag(v.archived);
    const command = this.command(
      op,
      v,
      { key, expectedRevision, archived },
      "archive-report",
    );
    const result = this.repository.write(
      op.context,
      command,
      op.budget,
      (tx) => {
        const current = stateRow(
          tx.get<ServiceReportState>("report-state", key),
        );
        if (current.revision !== expectedRevision) conflict();
        tx.update("report-state", key, expectedRevision, {
          ...current.data,
          archivedAt: archived ? this.now() : null,
        });
        return { target: "report", id: key };
      },
      () => this.fence(op),
    );
    const current = this.read(op, (tx) =>
      stateRow(
        tx.get<ServiceReportState>(
          "report-state",
          this.receiptId(result, "report"),
        ),
      ),
    );
    this.fence(op);
    return {
      scope: op.scope,
      id: current.id,
      revision: current.revision,
      state: current.data,
    };
  }
  listReports(context: ServerContext, raw: unknown): ServiceReportPage {
    const v = this.request(raw, ["after", "censusSha256", "includeArchived"]),
      op = this.operation(context);
    const after =
        v.after === undefined || v.after === null ? null : id(v.after),
      includeArchived =
        v.includeArchived === undefined ? false : flag(v.includeArchived);
    if (after && v.censusSha256 === undefined) invalid();
    const rows = this.read(op, (tx) =>
      tx.list<ServiceReportSnapshot>("report").map((row) => ({
        row,
        state: stateRow(tx.get<ServiceReportState>("report-state", row.id)),
      })),
    );
    const censusSha256 = hash(
      rows.map(({ row, state }) => [row.id, state.revision]),
    );
    if (v.censusSha256 !== undefined && digest(v.censusSha256) !== censusSha256)
      conflict("月报列表已改变，请从第一页刷新");
    if (after && !rows.some(({ row }) => row.id === after)) conflict();
    const items: ServiceReportCard[] = [];
    let bytes = 0,
      nextAfter: string | null = null;
    const candidates = rows.filter(
      ({ row, state }) =>
        (!after || row.id > after) &&
        (includeArchived || !state.data.archivedAt),
    );
    for (const { row, state } of candidates) {
      const card: ServiceReportCard = {
        id: id(row.id),
        revision: state.revision,
        customer: customer(row.data.customer),
        period: storedPeriod(row.data.period),
        generatedAt: serviceInstant(row.data.generatedAt),
        state: state.data,
      };
      const size = Buffer.byteLength(JSON.stringify(card));
      if (size > L.pageBytes)
        throw new AdapterError(
          "RATE_LIMITED",
          "完整月报列表记录超过分页字节限制",
        );
      if (items.length >= L.pageRows || bytes + size > L.pageBytes) {
        nextAfter = items.at(-1)!.id;
        break;
      }
      bytes += size;
      items.push(card);
    }
    this.fence(op);
    return { scope: op.scope, items, nextAfter, censusSha256 };
  }
  async exportReport(
    context: ServerContext,
    raw: unknown,
  ): Promise<ServiceReportDownload & { scope: string; reportId: string; revision: number; snapshotSha256: string; currentActivitiesCensusSha256: string; checkPublication(): void }> {
    const v = this.request(raw, ["reportId", "expectedRevision", "format"]),
      op = this.operation(context),
      key = id(v.reportId),
      expectedRevision = integer(v.expectedRevision);
    if (!["json", "csv", "html"].includes(String(v.format))) invalid();
    const report = await this.report(op, key);
    if (report.revision !== expectedRevision) conflict("月报修订已改变，请重新读取");
    if (report.state.archivedAt)
      throw new AdapterError("CONFLICT", "已归档月报不能下载，请先明确恢复");
    const currentBasis = this.read(op, (tx) =>
      basis(
        selectActivities(tx, report.snapshot.customer, report.snapshot.period),
      ),
    );
    // The async report read may yield before this capture. Its serialized live-status assertion must still agree.
    if (
      (currentBasis !== report.snapshot.basisSha256) !==
      report.currentActivitiesChanged
    )
      conflict();
    const result = renderServiceReport(report, v.format as ServiceReportFormat);
    // Bind every publication to the complete live census used to render status, even if its boolean stays true.
    const checkPublication = () => {
      const latest = this.read(op, (tx) => ({
        report: reportRows(tx, key),
        currentBasis: basis(
          selectActivities(
            tx,
            report.snapshot.customer,
            report.snapshot.period,
          ),
        ),
      }));
      if (
        latest.report.state.revision !== report.revision ||
        hash(latest.report.row.data) !== report.snapshotSha256 ||
        latest.currentBasis !== currentBasis
      )
        conflict("月报状态或本月活动在下载呈现后改变，请重新生成下载内容");
      this.fence(op);
    };
    checkPublication();
    return { ...result, scope: op.scope, reportId: report.id, revision: report.revision, snapshotSha256: report.snapshotSha256, currentActivitiesCensusSha256: currentBasis, checkPublication };
  }
  /** Explicit browser DTO adapter; historical report versions never become live activity versions. */
  async openPinnedSource(context: ServerContext, raw: unknown): Promise<{ scope: string; document: ResearchDocument; pin: ReaderSourcePin; checkPublication(): void }> {
    const envelope = this.request(raw, ["from", "pin", "referenceIndex", "activityId", "expectedRevision", "versionId", "reportId"]);
    const from = envelope.from;
    if (from !== "activity" && from !== "report") invalid();
    const v = this.request(raw, ["from", "pin", "referenceIndex", "activityId", "expectedRevision", "versionId", ...(from === "report" ? ["reportId"] : [])]);
    const op = this.operation(context), requested = pin(v.pin), activityId = id(v.activityId),
      expectedRevision = integer(v.expectedRevision), versionId = id(v.versionId), referenceIndex = integer(v.referenceIndex, 0);
    if (referenceIndex >= L.sourcesPerActivity) invalid();
    let activity: ServiceActivity, checkState: () => void;
    if (from === "activity") {
      activity = await this.activity(op, activityId);
      if (activity.revision !== expectedRevision || activity.archivedAt) conflict();
      const initial = activity;
      checkState = () => { if (!equal(this.read(op, tx => storedActivity(tx, activityId)), initial)) conflict(); };
    } else {
      const reportId = id(v.reportId), report = await this.report(op, reportId);
      if (report.revision !== expectedRevision || report.state.archivedAt) conflict();
      const selected = report.snapshot.activities.find(item => item.id === activityId);
      if (!selected) throw new AdapterError("NOT_FOUND", "月报中的活动不存在");
      activity = selected;
      checkState = () => {
        const current = this.read(op, tx => reportRows(tx, reportId));
        if (current.state.revision !== report.revision || current.state.data.archivedAt || hash(current.row.data) !== report.snapshotSha256) conflict();
      };
    }
    if (activity.versionId !== versionId || !equal(activity.version.value.references[referenceIndex]?.pin, requested)) conflict();
    const source = await this.source(op, requested);
    const checkPublication = () => { checkState(); this.fence(op); };
    checkPublication();
    return {scope: op.scope, document: source.document, pin: requested, checkPublication};
  }
  async openReportSource(
    context: ServerContext,
    raw: unknown,
  ): Promise<{ scope: string; document: ResearchDocument }> {
    const v = this.request(raw, ["id", "activityId", "referenceIndex"]),
      op = this.operation(context),
      key = id(v.id),
      activityId = id(v.activityId),
      referenceIndex = integer(v.referenceIndex, 0);
    const report = await this.report(op, key);
    if (report.state.archivedAt) conflict("已归档月报的来源入口不可打开");
    const item = report.snapshot.activities.find((a) => a.id === activityId),
      ref = item?.version.value.references[referenceIndex];
    if (!ref) throw new AdapterError("NOT_FOUND", "月报中的固定来源引用不存在");
    const source = await this.source(op, ref.pin);
    const latest = this.read(op, (tx) =>
      stateRow(tx.get<ServiceReportState>("report-state", key)),
    );
    if (latest.revision !== report.revision) conflict();
    this.fence(op);
    return { scope: op.scope, document: source.document };
  }
}
