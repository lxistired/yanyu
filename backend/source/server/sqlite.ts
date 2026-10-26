import { databaseOpenError as fail, reservePrivateDatabaseFile, workspaceDatabasePath } from './database-path';
export { reservePrivateDatabaseFile, workspaceDatabasePath } from './database-path';
import { catalogDate } from './catalog-search-corpora';
import type { CatalogIdentity } from '../shared/catalog-search';
import { DatabaseSync } from 'node:sqlite';
import {
  AdapterError,
  type ResearchDocument,
  type RetrievalAdapter,
  type Run,
  type ServerContext,
} from '../shared/contracts';
import type { FilePersistence, RunPersistence, StoredFile, StoredRun } from './mock';
/** Local, single-process SQLite journal. The shipped dataset and uploads remain synthetic-only. */
export class SqliteWorkspace {
  private db: DatabaseSync;
  private closed = false;
  constructor(root: string, relative = 'data/workspace.sqlite') {
    const path = workspaceDatabasePath(root, relative);
    reservePrivateDatabaseFile(path);
    this.db = new DatabaseSync(path, {
      timeout: 200,
      enableForeignKeyConstraints: true,
      allowExtension: false,
    });
    try {
      this.db.exec(
        'PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;',
      );
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
      if (version > 1 || version < 0) throw fail();
      if (version === 0)
        this.transaction(() => {
          this.db.exec(`
          CREATE TABLE runs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, tenant TEXT NOT NULL, owner TEXT NOT NULL, metadata TEXT NOT NULL) STRICT;
          CREATE TABLE events(run_id TEXT NOT NULL REFERENCES runs(id), cursor INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id,cursor)) STRICT;
          CREATE TABLE run_keys(scope TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), fingerprint TEXT NOT NULL) STRICT;
          CREATE TABLE documents(dataset TEXT NOT NULL, tenant TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(dataset,tenant,id,revision)) STRICT;
          CREATE TABLE files(id TEXT PRIMARY KEY, tenant TEXT NOT NULL, owner TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
          CREATE TABLE file_keys(scope TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id), fingerprint TEXT NOT NULL) STRICT;
          PRAGMA user_version=1;
        `);
        });
      for (const query of [
        'SELECT id,kind,tenant,owner,metadata FROM runs LIMIT 0',
        'SELECT run_id,cursor,payload FROM events LIMIT 0',
        'SELECT scope,run_id,fingerprint FROM run_keys LIMIT 0',
        'SELECT rowid,dataset,tenant,id,revision,payload FROM documents LIMIT 0',
        'SELECT id,tenant,owner,payload FROM files LIMIT 0',
        'SELECT scope,file_id,fingerprint FROM file_keys LIMIT 0',
      ])
        this.db.prepare(query).all();
    } catch {
      this.db.close();
      throw fail();
    }
  }
  private transaction<T>(action: () => T): T {
    if (this.closed) throw fail();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
  runPersistence<E>(kind: Run['kind']): RunPersistence<E> {
    return {
      load: () => ({
        records: this.db
          .prepare('SELECT metadata FROM runs WHERE kind=? ORDER BY id')
          .all(kind)
          .map((row) => {
            const record = JSON.parse(String(row.metadata)) as StoredRun<E>;
            record.events = this.db
              .prepare('SELECT payload FROM events WHERE run_id=? ORDER BY cursor')
              .all(record.run.id)
              .map((e) => JSON.parse(String(e.payload)));
            return record;
          }),
        keys: this.db
          .prepare(
            'SELECT k.scope,k.run_id,k.fingerprint FROM run_keys k JOIN runs r ON r.id=k.run_id WHERE r.kind=?',
          )
          .all(kind)
          .map((row) => [
            String(row.scope),
            { id: String(row.run_id), fingerprint: String(row.fingerprint) },
          ]),
      }),
      save: (record, key) =>
        this.transaction(() => {
          if (record.run.kind !== kind) throw fail();
          const { events, ...metadata } = record;
          this.db
            .prepare(
              'INSERT INTO runs(id,kind,tenant,owner,metadata) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata',
            )
            .run(record.run.id, kind, record.run.tenantId, record.owner, JSON.stringify(metadata));
          const last = Number(
            this.db
              .prepare('SELECT COALESCE(MAX(cursor),0) AS cursor FROM events WHERE run_id=?')
              .get(record.run.id)?.cursor,
          );
          for (const event of events.slice(last))
            this.db
              .prepare('INSERT INTO events(run_id,cursor,payload) VALUES(?,?,?)')
              .run(record.run.id, event.cursor, JSON.stringify(event));
          if (key)
            this.db
              .prepare('INSERT INTO run_keys(scope,run_id,fingerprint) VALUES(?,?,?)')
              .run(key[0], key[1].id, key[1].fingerprint);
        }),
    };
  }
  filePersistence(): FilePersistence {
    return {
      load: () => ({
        records: this.db
          .prepare('SELECT payload FROM files ORDER BY id')
          .all()
          .map((row) => JSON.parse(String(row.payload)) as StoredFile),
        keys: this.db
          .prepare('SELECT scope,file_id,fingerprint FROM file_keys')
          .all()
          .map((row) => [
            String(row.scope),
            { id: String(row.file_id), fingerprint: String(row.fingerprint) },
          ]),
      }),
      save: (record, key) =>
        this.transaction(() => {
          this.db
            .prepare(
              'INSERT INTO files(id,tenant,owner,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
            )
            .run(record.file.id, record.file.tenantId, record.owner, JSON.stringify(record));
          if (key)
            this.db
              .prepare('INSERT INTO file_keys(scope,file_id,fingerprint) VALUES(?,?,?)')
              .run(key[0], key[1].id, key[1].fingerprint);
        }),
    };
  }
  /** Current authorized fixture identities from the durable source of truth, not the initial seed array. */
  catalogIdentities(dataset: string, ctx: ServerContext): CatalogIdentity[] {
    if (ctx.signal.aborted) throw new AdapterError('CANCELLED', '操作已取消');
    return this.db
      .prepare(
        `SELECT id,revision,json_extract(payload,'$.date') AS source_date FROM documents
      WHERE rowid IN (SELECT MAX(rowid) FROM documents WHERE dataset=? AND tenant=? GROUP BY id)
      AND json_extract(payload,'$.collectionId') IN (SELECT value FROM json_each(?))
      ORDER BY id LIMIT 4001`,
      )
      .all(dataset, ctx.principal.tenantId, JSON.stringify(ctx.principal.collectionIds))
      .map((row) => ({
        documentId: String(row.id),
        revisionId: String(row.revision),
        ...catalogDate(row.source_date, 'publication'),
      }));
  }
  retrieval(dataset: string, fixtures: readonly ResearchDocument[]): RetrievalAdapter {
    this.transaction(() => {
      for (const doc of fixtures) {
        if (!doc.mock) throw new AdapterError('INVALID_REQUEST', '本地示例存储仅接受合成资料');
        this.db
          .prepare('INSERT OR IGNORE INTO documents(dataset,tenant,id,revision,payload) VALUES(?,?,?,?,?)')
          .run(dataset, doc.tenantId, doc.id, doc.revisionId, JSON.stringify(doc));
      }
    });
    const check = (ctx: ServerContext) => {
      if (ctx.signal.aborted) throw new AdapterError('CANCELLED', '操作已取消');
    };
    return {
      search: async (ctx, request) => {
        check(ctx);
        const words = request.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const items = this.db
          .prepare(
            'SELECT payload FROM documents WHERE rowid IN (SELECT MAX(rowid) FROM documents WHERE dataset=? AND tenant=? GROUP BY id) ORDER BY id',
          )
          .all(dataset, ctx.principal.tenantId)
          .map((row) => JSON.parse(String(row.payload)) as ResearchDocument)
          .filter(
            (doc) =>
              ctx.principal.collectionIds.includes(doc.collectionId) &&
              request.sources.includes(doc.source) &&
              words.every((w) => `${doc.title} ${doc.body} ${doc.tags.join(' ')}`.toLowerCase().includes(w)),
          );
        return {
          items: items.slice(0, request.limit ?? 20),
          total: items.length,
          requestId: ctx.requestId,
          mock: true,
        };
      },
      getDocument: async (ctx, id, revisionId) => {
        check(ctx);
        const rows = this.db
          .prepare('SELECT payload FROM documents WHERE dataset=? AND tenant=? AND id=? ORDER BY rowid')
          .all(dataset, ctx.principal.tenantId, id);
        if (!rows.length) throw new AdapterError('NOT_FOUND', '资料不存在');
        const docs = rows.map((row) => JSON.parse(String(row.payload)) as ResearchDocument);
        const doc = revisionId ? docs.find((d) => d.revisionId === revisionId) : docs.at(-1);
        if (!doc) throw new AdapterError('CONFLICT', '引用版本不存在');
        if (!ctx.principal.collectionIds.includes(doc.collectionId))
          throw new AdapterError('FORBIDDEN', '当前身份无权读取该资料');
        return doc;
      },
    };
  }
}
