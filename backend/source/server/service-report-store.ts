import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { AdapterError, type ServerContext } from "../shared/contracts";
import { SERVICE_REPORT_LIMITS as L } from "../shared/service-reports";
import type {
  ServiceCommandResolution,
  ServiceLedgerKind,
  ServiceLedgerRow,
  ServiceLedgerTransaction,
  ServiceReadBudget,
  ServiceReceipt,
  ServiceReportCommandRepository,
} from "./service-report-ports";

const fail = (message = "服务月报存储无效或不可用"): never => {
  throw new AdapterError("PROVIDER_ERROR", message);
};
const conflict = (): never => {
  throw new AdapterError("CONFLICT", "服务记录或幂等命令已改变");
};
const boundedId = (value: string) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value))
    throw new AdapterError("INVALID_REQUEST", "无效的服务记录标识");
  return value;
};
const kinds: readonly ServiceLedgerKind[] = [
  "activity",
  "activity-version",
  "report",
  "report-state",
];
const kindOf = (kind: ServiceLedgerKind) => {
  if (!kinds.includes(kind)) return fail();
  return kind;
};
export function chargeServiceRead(
  budget: ServiceReadBudget,
  bytes: number,
  rows = 1,
) {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    !Number.isSafeInteger(rows) ||
    rows < 0
  )
    fail();
  budget.bytes += bytes;
  budget.rows += rows;
  if (
    !Number.isSafeInteger(budget.rows) ||
    !Number.isSafeInteger(budget.bytes) ||
    budget.rows > budget.maxRows ||
    budget.bytes > budget.maxBytes
  )
    throw new AdapterError(
      "RATE_LIMITED",
      "服务月报读取超过总预算；未返回部分汇总",
    );
}
function synchronous(value: unknown) {
  if (value && typeof value === "object" && "then" in value) {
    void Promise.resolve(value).catch(() => undefined);
    fail("服务月报事务和提交核对必须同步完成");
  }
}
function encode(value: unknown, max = L.recordBytes): string {
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 20) fail();
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || seen.has(item)) return fail();
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype
    )
      return fail();
    seen.add(item);
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(item),
    )) {
      if (Array.isArray(item) && key === "length") continue;
      if (
        !("value" in descriptor) ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        fail();
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  };
  visit(value, 0);
  const result = JSON.stringify(value);
  if (typeof result !== "string" || Buffer.byteLength(result) > max)
    fail("服务月报单条记录超过字节预算");
  return result;
}
function detached<T>(value: T): T {
  return JSON.parse(encode(value, L.operationBytes)) as T;
}
function owner(context: ServerContext): [string, string] {
  if (context.signal.aborted)
    throw new AdapterError("CANCELLED", "服务月报操作已停止");
  const values = [context.principal.tenantId, context.principal.subjectId];
  if (
    values.some(
      (v) =>
        typeof v !== "string" ||
        !v ||
        Buffer.byteLength(v) > 500 ||
        Array.from(v).some(
          (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
        ),
    )
  )
    throw new AdapterError("UNAUTHENTICATED", "服务月报需要稳定的当前身份");
  return values as [string, string];
}
function receipt(value: unknown): ServiceReceipt {
  if (
    !value ||
    typeof value !== "object" ||
    !("target" in value) ||
    !("id" in value) ||
    !["activity", "report"].includes(String(value.target)) ||
    Object.keys(value).length !== 2 ||
    typeof value.id !== "string"
  )
    return fail();
  return {
    target: value.target as ServiceReceipt["target"],
    id: boundedId(value.id),
  };
}
/** Dedicated durable ledger. Its path/lifecycle are trusted server configuration, never browser input. */
export class SqliteServiceReportRepository implements ServiceReportCommandRepository {
  private readonly db: DatabaseSync;
  private closed = false;
  private active = false;
  constructor(root: string, relative = "data/service-reports.sqlite") {
    if (
      !/^[A-Za-z0-9_./-]+\.sqlite$/.test(relative) ||
      relative.split("/").some((x) => !x || x === ".." || x === ".")
    )
      throw new AdapterError(
        "INVALID_REQUEST",
        "服务月报数据库必须使用安全的相对路径",
      );
    const base = realpathSync(root),
      path = resolve(base, relative);
    if (!path.startsWith(base + sep)) fail();
    let component = base;
    for (const part of relative.split("/")) {
      component = resolve(component, part);
      try {
        if (lstatSync(component).isSymbolicLink()) fail();
      } catch (cause) {
        if (!(
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "ENOENT"
        ))
          throw cause;
      }
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      closeSync(openSync(path, "wx", 0o600));
    } catch (cause) {
      if (!(
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "EEXIST"
      ))
        throw cause;
      const stat = lstatSync(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (process.platform !== "win32" && stat.mode & 0o077)
      )
        fail();
    }
    this.db = new DatabaseSync(path, {
      timeout: 200,
      enableForeignKeyConstraints: true,
      allowExtension: false,
    });
    try {
      this.db.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;",
      );
      const version = Number(
        this.db.prepare("PRAGMA user_version").get()?.user_version,
      );
      const app = Number(
        this.db.prepare("PRAGMA application_id").get()?.application_id,
      );
      if ((version !== 0 && version !== 1) || (app !== 0 && app !== 0x53525631))
        fail();
      if (version === 0) {
        if (
          this.db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .get()
        )
          fail();
        this.db.exec(`CREATE TABLE service_rows (
          tenant TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('activity','activity-version','report','report-state')),
          id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), payload TEXT NOT NULL,
          PRIMARY KEY(tenant,owner,kind,id)) STRICT;
          CREATE TABLE service_receipts (tenant TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL,
          fingerprint TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(tenant,owner,key)) STRICT;
          CREATE TRIGGER service_immutable_update BEFORE UPDATE ON service_rows WHEN OLD.kind IN ('activity-version','report')
          BEGIN SELECT RAISE(ABORT, 'immutable service snapshot'); END;
          CREATE TRIGGER service_immutable_delete BEFORE DELETE ON service_rows WHEN OLD.kind IN ('activity-version','report')
          BEGIN SELECT RAISE(ABORT, 'immutable service snapshot'); END;
          PRAGMA application_id=1397904945; PRAGMA user_version=1;`);
      } else if (app !== 0x53525631) fail();
      this.db
        .prepare(
          "SELECT tenant,owner,kind,id,revision,payload FROM service_rows LIMIT 0",
        )
        .all();
      this.db
        .prepare(
          "SELECT tenant,owner,key,fingerprint,payload FROM service_receipts LIMIT 0",
        )
        .all();
      this.db.exec("COMMIT");
    } catch (cause) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* May fail before BEGIN. */
      }
      this.db.close();
      throw cause;
    }
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
  private scope(context: ServerContext) {
    if (this.closed) fail();
    const initial = owner(context),
      encoded = JSON.stringify(initial);
    return {
      initial,
      check: () => {
        if (JSON.stringify(owner(context)) !== encoded)
          throw new AdapterError("FORBIDDEN", "服务月报身份已改变");
      },
    };
  }
  private transaction<T>(
    context: ServerContext,
    write: boolean,
    budget: ServiceReadBudget,
    action: (tx: ServiceLedgerTransaction, scope: [string, string]) => T,
    final?: () => void,
  ): T {
    if (this.active) fail("不支持嵌套服务月报事务");
    const scope = this.scope(context);
    let alive = true;
    this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    this.active = true;
    const check = () => {
      if (!alive) fail("服务月报事务已结束");
      scope.check();
    };
    const mutation = () => {
      check();
      if (!write) fail("只读服务月报事务不能写入");
    };
    const get = <T>(
      kind: ServiceLedgerKind,
      id: string,
    ): ServiceLedgerRow<T> => {
      check();
      kindOf(kind);
      boundedId(id);
      const row = this.db
        .prepare(
          `SELECT id,revision,length(CAST(payload AS BLOB)) AS bytes,
        CASE WHEN length(CAST(payload AS BLOB))<=? THEN payload ELSE NULL END AS payload
        FROM service_rows WHERE tenant=? AND owner=? AND kind=? AND id=?`,
        )
        .get(
          Math.max(0, budget.maxBytes - budget.bytes),
          ...scope.initial,
          kind,
          id,
        );
      if (!row)
        throw new AdapterError("NOT_FOUND", "服务记录不存在或不属于当前身份");
      chargeServiceRead(budget, Number(row.bytes));
      try {
        return {
          id: String(row.id),
          revision: Number(row.revision),
          data: JSON.parse(String(row.payload)) as T,
        };
      } catch {
        return fail("服务月报存储 JSON 无效");
      }
    };
    const tx: ServiceLedgerTransaction = {
      get,
      list: <T>(kind: ServiceLedgerKind): ServiceLedgerRow<T>[] => {
        check();
        kindOf(kind);
        const result: ServiceLedgerRow<T>[] = [];
        // IDs only first; each full row is fetched, charged and decoded separately.
        for (const row of this.db
          .prepare(
            "SELECT id FROM service_rows WHERE tenant=? AND owner=? AND kind=? ORDER BY id",
          )
          .iterate(...scope.initial, kind))
          result.push(get<T>(kind, String(row.id)));
        return result;
      },
      create: <T>(
        kind: ServiceLedgerKind,
        id: string,
        data: T,
      ): ServiceLedgerRow<T> => {
        mutation();
        kindOf(kind);
        boundedId(id);
        const payload = encode(data);
        const result = this.db
          .prepare("INSERT OR IGNORE INTO service_rows VALUES(?,?,?,?,1,?)")
          .run(...scope.initial, kind, id, payload);
        if (Number(result.changes) !== 1) conflict();
        return { id, revision: 1, data: JSON.parse(payload) as T };
      },
      update: <T>(
        kind: "activity" | "report-state",
        id: string,
        expectedRevision: number,
        data: T,
      ): ServiceLedgerRow<T> => {
        mutation();
        boundedId(id);
        if (
          !["activity", "report-state"].includes(kind) ||
          !Number.isSafeInteger(expectedRevision) ||
          expectedRevision < 1 ||
          expectedRevision >= Number.MAX_SAFE_INTEGER
        )
          return fail();
        const payload = encode(data);
        const result = this.db
          .prepare(
            "UPDATE service_rows SET revision=revision+1,payload=? WHERE tenant=? AND owner=? AND kind=? AND id=? AND revision=?",
          )
          .run(payload, ...scope.initial, kind, id, expectedRevision);
        if (Number(result.changes) !== 1) conflict();
        return {
          id,
          revision: expectedRevision + 1,
          data: JSON.parse(payload) as T,
        };
      },
    };
    try {
      const result = action(tx, scope.initial);
      synchronous(result);
      const copy = detached(result);
      if (write) {
        const total = this.db
          .prepare(
            "SELECT count(*) AS rows,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM service_rows WHERE tenant=? AND owner=?",
          )
          .get(...scope.initial);
        const receipts = this.db
          .prepare(
            "SELECT count(*) AS rows FROM service_receipts WHERE tenant=? AND owner=?",
          )
          .get(...scope.initial);
        if (
          Number(total?.rows) > L.ownerRows ||
          Number(total?.bytes) > L.ownerBytes ||
          Number(receipts?.rows) > L.ownerReceipts
        )
          throw new AdapterError(
            "RATE_LIMITED",
            "服务月报存储达到限额；未丢弃幂等回执",
          );
      }
      if (final) {
        const checked: unknown = final();
        synchronous(checked);
        if (checked !== undefined) fail();
      }
      check();
      this.db.exec("COMMIT");
      return copy;
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    } finally {
      alive = false;
      this.active = false;
    }
  }
  read<T>(
    context: ServerContext,
    budget: ServiceReadBudget,
    action: (tx: ServiceLedgerTransaction) => T,
  ): T {
    return this.transaction(context, false, budget, action);
  }
  private findResolution(
    scope: [string, string],
    key: string,
    fingerprint: string,
    budget: ServiceReadBudget,
  ): ServiceCommandResolution | null {
    boundedId(key);
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) fail();
    const row = this.db
      .prepare(
        `SELECT fingerprint,length(CAST(payload AS BLOB)) AS bytes,
      CASE WHEN length(CAST(payload AS BLOB))<=? THEN payload ELSE NULL END AS payload
      FROM service_receipts WHERE tenant=? AND owner=? AND key=?`,
      )
      .get(
        Math.min(512, Math.max(0, budget.maxBytes - budget.bytes)),
        ...scope,
        key,
      );
    if (!row) return null;
    chargeServiceRead(budget, Number(row.bytes));
    if (row.fingerprint !== fingerprint) conflict();
    if (Number(row.bytes) > 512) return fail();
    try {
      const value: unknown = JSON.parse(String(row.payload));
      if (value && typeof value === "object" && "outcome" in value) {
        if (
          value.outcome !== "cancelled" ||
          !("fingerprint" in value) ||
          value.fingerprint !== fingerprint ||
          Object.keys(value).length !== 2
        ) return fail();
        return { outcome: "cancelled", fingerprint };
      }
      return { outcome: "committed", receipt: receipt(value) };
    } catch {
      return fail();
    }
  }
  replay(
    context: ServerContext,
    key: string,
    fingerprint: string,
    budget: ServiceReadBudget,
  ): ServiceReceipt | null {
    const resolution = this.resolve(context, key, fingerprint, budget);
    if (resolution?.outcome === "cancelled") return conflict();
    return resolution?.receipt ?? null;
  }
  resolve(
    context: ServerContext,
    key: string,
    fingerprint: string,
    budget: ServiceReadBudget,
  ): ServiceCommandResolution | null {
    return this.transaction(context, false, budget, (_tx, scope) =>
      this.findResolution(scope, key, fingerprint, budget),
    );
  }
  cancel(
    context: ServerContext,
    command: { key: string; fingerprint: string },
    budget: ServiceReadBudget,
    beforeCommit: () => void,
  ): ServiceCommandResolution {
    // The same IMMEDIATE transaction and primary key used by write determine one winner.
    // Tombstones are retained indefinitely, count toward receipt limits, and never run a business action.
    return this.transaction(context, true, budget, (_tx, scope) => {
      const existing = this.findResolution(scope, command.key, command.fingerprint, budget);
      if (existing) return existing;
      const result = { outcome: "cancelled" as const, fingerprint: command.fingerprint };
      this.db.prepare("INSERT INTO service_receipts VALUES(?,?,?,?,?)")
        .run(...scope, command.key, command.fingerprint, encode(result, 512));
      return result;
    }, beforeCommit);
  }
  write(
    context: ServerContext,
    command: { key: string; fingerprint: string },
    budget: ServiceReadBudget,
    action: (tx: ServiceLedgerTransaction) => ServiceReceipt,
    beforeCommit: () => void,
  ): ServiceReceipt {
    return this.transaction(
      context,
      true,
      budget,
      (tx, scope) => {
        const existing = this.findResolution(
          scope,
          command.key,
          command.fingerprint,
          budget,
        );
        if (existing?.outcome === "cancelled") return conflict();
        if (existing) return existing.receipt;
        const raw = action(tx);
        synchronous(raw);
        const result = receipt(raw);
        this.db
          .prepare("INSERT INTO service_receipts VALUES(?,?,?,?,?)")
          .run(...scope, command.key, command.fingerprint, encode(result, 512));
        return result;
      },
      beforeCommit,
    );
  }
}
