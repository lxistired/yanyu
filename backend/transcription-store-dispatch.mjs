import {bindTranscriptionStoreIdentity, transcriptionStoreHeader} from './transcription-store-identity.mjs';

// Mandatory continuity gate. Only exact GET identity discovery is unbound.
// This owns the entire local-asr namespace, including unknown routes/methods.
// Do not import the live runtime here: tests can bind a synthetic connection.
export function transcriptionStoreDispatch(db, dispatch) {
 const identity = bindTranscriptionStoreIdentity(db);
 return async function handle(req, send, fail, download, transport = {}) {
  const pathname = typeof req.url === 'string' ? req.url.split('?')[0] : '';
  if (!pathname.startsWith('/api/local-asr/')) return false;
  let current;
  try { current = identity.transcriptionStoreId; }
  catch { fail(503, 'STORE_IDENTITY_UNAVAILABLE', 'Transcription store identity unavailable'); return true; }
  transport.setHeader?.(transcriptionStoreHeader, current);
  // Only a structurally valid, genuinely absent header can discover. A raw-only
  // header, duplicates, arrays, or disagreement must go through strict parsing.
  const headers = req.headers, raw = req.rawHeaders;
  const validHeaders = headers && typeof headers === 'object' && !Array.isArray(headers);
  const validRaw = raw === undefined || (Array.isArray(raw) && raw.length % 2 === 0 && raw.every(x => typeof x === 'string'));
  const normalizedPresent = validHeaders && Object.keys(headers).some(key => key.toLowerCase() === transcriptionStoreHeader);
  const rawPresent = Array.isArray(raw) && raw.some((key, i) => i % 2 === 0 && typeof key === 'string' && key.toLowerCase() === transcriptionStoreHeader);
  const absent = validHeaders && validRaw && !normalizedPresent && !rawPresent;
  const discovery = req.method === 'GET' && req.url === '/api/local-asr/identity';
  if (absent && !discovery) {
   fail(428, 'STORE_SCOPE_REQUIRED', 'Transcription source identity required; upgrade or reload the client and explicitly select a source');
   return true;
  }
  if (!absent) {
   let result;
   try { result = identity.validateRequest(headers, raw); }
   catch { fail(503, 'STORE_IDENTITY_UNAVAILABLE', 'Transcription store identity unavailable'); return true; }
   if (!result.ok) {
    fail(result.status, result.code, result.code === 'STORE_CHANGED' ? 'Transcription store changed; explicitly reload the source' : 'Invalid or repeated transcription store identity');
    return true;
   }
  }
  if (discovery) {
   send(200, {transcriptionStoreId: current});
   return true;
  }
  // Identity-only metadata reads above; no job reads, body consumption, replay,
  // request logging, sweep or worker-adjacent effects before admission.
  transport.onAdmitted?.();
  return dispatch(req, send, fail, download);
 };
}
