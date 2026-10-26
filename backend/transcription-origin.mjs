// Original local contract: a client declaration about the FIRST submission route.
// It is not authenticated capture provenance and is independent of byte receipts.
export const uploadOrigins = ['unknown', 'file-selection', 'recording-draft'];
export function parseUploadOrigin(headers, rawHeaders) {
 if (rawHeaders && rawHeaders.filter((value, index) => index % 2 === 0 && String(value).toLowerCase() === 'x-audio-origin').length > 1) return null;
 const value = headers['x-audio-origin'];
 return value === undefined ? 'unknown' : typeof value === 'string' && ['file-selection', 'recording-draft'].includes(value) ? value : null;
}
export function initializeTranscriptionOrigin(db) {
 if (!db.prepare('PRAGMA table_info(transcription_jobs)').all().some(c => c.name === 'original_upload_origin')) db.exec("ALTER TABLE transcription_jobs ADD COLUMN original_upload_origin TEXT NOT NULL DEFAULT 'unknown' CHECK(original_upload_origin IN ('unknown','file-selection','recording-draft'))");
 db.exec(`CREATE TRIGGER IF NOT EXISTS transcription_origin_immutable BEFORE UPDATE OF original_upload_origin ON transcription_jobs
 WHEN NEW.original_upload_origin IS NOT OLD.original_upload_origin BEGIN SELECT RAISE(ABORT,'Original upload origin is immutable'); END;`);
}
export function publicUploadOrigin(value) {
 const origin = uploadOrigins.includes(value) ? value : 'unknown';
 return {uploadOrigin: origin, uploadOriginAssurance: origin === 'unknown' ? 'unknown' : 'client-declared'};
}
