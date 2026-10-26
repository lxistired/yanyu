import {randomUUID} from 'node:crypto';

// Continuity of logical SQLite lineage only, not authorization or clone detection.
export const transcriptionStoreHeader = 'x-transcription-store-id';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isTranscriptionStoreId(value) {
 return typeof value === 'string' && value.length === 36 && uuid.test(value);
}
function unavailable() {
 return Object.assign(new Error('Transcription store identity unavailable'), {code: 'STORE_IDENTITY_UNAVAILABLE'});
}
// Read-only, deliberately not self-healing. Never call initialization from a GET.
export function readTranscriptionStoreIdentity(db) {
 try {
  if (db.prepare("SELECT type FROM sqlite_schema WHERE name = 'transcription_store_identity'").get()?.type !== 'table') throw unavailable();
  const rows = db.prepare('SELECT singleton, store_id FROM transcription_store_identity').all();
  if (rows.length !== 1 || rows[0].singleton !== 1 || !isTranscriptionStoreId(rows[0].store_id)) throw unavailable();
  return rows[0].store_id;
 } catch { throw unavailable(); }
}
// Startup/schema migration only. An existing empty/corrupt table is NOT legacy.
export function initializeTranscriptionStoreIdentity(db) {
 db.exec('BEGIN IMMEDIATE');
 try {
  const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'transcription_store_identity'").get();
  if (!exists) {
   db.exec(`CREATE TABLE transcription_store_identity (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), store_id TEXT NOT NULL
   )`);
   db.prepare('INSERT INTO transcription_store_identity(singleton, store_id) VALUES(1, ?) ON CONFLICT(singleton) DO NOTHING').run(randomUUID());
  }
  const identity = readTranscriptionStoreIdentity(db);
  db.exec('COMMIT');
  return identity;
 } catch (error) {
  try { db.exec('ROLLBACK'); } catch {}
  throw unavailable();
 }
}
const invalid = () => ({ok: false, status: 400, code: 'INVALID_STORE_SCOPE'});
// Pure parser: no database, request body, URL, filesystem or side effects. Raw
// headers, when supplied by Node, must agree with the normalized representation.
export function parseTranscriptionStoreScope(headers, rawHeaders) {
 if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return invalid();
 const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === transcriptionStoreHeader);
 if (matches.length !== 1 || !isTranscriptionStoreId(matches[0][1])) return invalid();
 const value = matches[0][1];
 if (rawHeaders !== undefined) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 || rawHeaders.some(item => typeof item !== 'string')) return invalid();
  const raw = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
   if (rawHeaders[i].toLowerCase() === transcriptionStoreHeader) raw.push(rawHeaders[i + 1]);
  }
  if (raw.length !== 1 || raw[0] !== value) return invalid();
 }
 return {ok: true, transcriptionStoreId: value};
}
// Pure validation. Dispatch requires scope on every route except exact identity discovery.
export function validateTranscriptionStoreScope(expectedStoreId, headers, rawHeaders) {
 if (!isTranscriptionStoreId(expectedStoreId)) throw unavailable();
 const parsed = parseTranscriptionStoreScope(headers, rawHeaders);
 if (!parsed.ok) return parsed;
 return parsed.transcriptionStoreId === expectedStoreId ? parsed : {ok: false, status: 409, code: 'STORE_CHANGED'};
}
// A closure binds one initialized connection, never a global/current filename.
// Every use verifies persisted identity without writing or silently rebinding.
export function bindTranscriptionStoreIdentity(db) {
 const transcriptionStoreId = readTranscriptionStoreIdentity(db);
 return Object.freeze({
  get transcriptionStoreId() {
   if (readTranscriptionStoreIdentity(db) !== transcriptionStoreId) throw unavailable();
   return transcriptionStoreId;
  },
  validateRequest(headers, rawHeaders) {
   if (readTranscriptionStoreIdentity(db) !== transcriptionStoreId) throw unavailable();
   return validateTranscriptionStoreScope(transcriptionStoreId, headers, rawHeaders);
  },
 });
}
