// Explicit per-upload, same-tab refresh recovery only. No audio/File, transcript,
// automatic network request, or clock-based deletion is part of this journal.
export type UploadRecoveryRecord = Readonly<{
  version: 1; scope: string; operationId: string; filename: string;
  byteLength: number; mime: string; format: string; sha256: string;
  language: string; origin: 'file-selection' | 'recording-draft';
  expiresAt: number | null; checkpoint: boolean;
}>;
export const UPLOAD_REFRESH_PREFIX = 'yanyu:audio-upload-refresh:v1:';
export const UPLOAD_REFRESH_MAX_RECORDS = 16;
export const UPLOAD_REFRESH_MAX_CHARS = 2048;
const fields = ['version','scope','operationId','filename','byteLength','mime','format','sha256','language','origin','expiresAt','checkpoint'] as const;
const uuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const scopeId = (value: unknown): value is string => uuid(value) && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const formats: Record<string, readonly [string, string]> = {wav:['audio/wav','wav'],mp3:['audio/mpeg','mp3'],m4a:['audio/mp4','mov'],ogg:['audio/ogg','ogg']};
const unavailable = (): never => {throw Error('刷新核对记录无法安全读写。不会覆盖旧记录；不能保证刷新后恢复本次操作。');};
function validate(value: unknown, scope: string): UploadRecoveryRecord {
  if (!scopeId(scope) || !value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== fields.length || !fields.every(key => Object.hasOwn(v,key)) || v.version !== 1 || v.scope !== scope || !uuid(v.operationId) ||
    typeof v.filename !== 'string' || !v.filename.length || v.filename.length > 180 || /[\x00-\x1f/\\]/.test(v.filename) ||
    !Number.isSafeInteger(v.byteLength) || (v.byteLength as number) < 44 || (v.byteLength as number) > 536870912 ||
    typeof v.sha256 !== 'string' || v.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(v.sha256) || !['auto','zh','en'].includes(v.language as string) ||
    !['file-selection','recording-draft'].includes(v.origin as string) || typeof v.checkpoint !== 'boolean' ||
    !(v.expiresAt === null || Number.isSafeInteger(v.expiresAt) && (v.expiresAt as number) >= 0) ||
    (v.origin === 'file-selection' && (v.expiresAt !== null || v.checkpoint))) return unavailable();
  const extension = v.filename.split('.').pop()?.toLowerCase() ?? '';
  if (!Object.hasOwn(formats,extension) || formats[extension][0] !== v.mime || formats[extension][1] !== v.format) return unavailable();
  // Return a bounded whitelist copy, never retain arbitrary caller properties.
  return Object.freeze(Object.fromEntries(fields.map(key => [key,v[key]]))) as UploadRecoveryRecord;
}
export function makeUploadRecoveryRecord(input: Omit<UploadRecoveryRecord,'version'|'expiresAt'> & {expiresAt?: number}): UploadRecoveryRecord {
  const values = {...input, version:1, expiresAt:input.expiresAt ?? null};
  return validate(Object.fromEntries(fields.map(key => [key,values[key]])),input.scope);
}
const key = (scope: string) => UPLOAD_REFRESH_PREFIX + scope;
export function readUploadRecoveryRecord(storage: Pick<Storage,'getItem'>, scope: string): UploadRecoveryRecord | null {
  if (!scopeId(scope)) return unavailable();
  try {
    const raw = storage.getItem(key(scope));
    if (raw === null) return null;
    if (!raw.length || raw.length > UPLOAD_REFRESH_MAX_CHARS) return unavailable();
    return validate(JSON.parse(raw),scope);
  } catch {return unavailable();}
}
export function retainUploadRecoveryRecord(storage: Storage, record: UploadRecoveryRecord): void {
  const checked = validate(record,record.scope), serialized = JSON.stringify(checked);
  if (serialized.length > UPLOAD_REFRESH_MAX_CHARS) return unavailable();
  try {
    const prior = readUploadRecoveryRecord(storage,record.scope);
    if (prior && JSON.stringify(prior) !== serialized) return unavailable();
    if (!prior) {
      let count = 0;
      for (let index = 0; index < storage.length; index++) if (storage.key(index)?.startsWith(UPLOAD_REFRESH_PREFIX)) count++;
      if (count >= UPLOAD_REFRESH_MAX_RECORDS) return unavailable();
    }
    storage.setItem(key(record.scope),serialized);
    if (storage.getItem(key(record.scope)) !== serialized) return unavailable();
  } catch {return unavailable();}
}
export function forgetUploadRecoveryRecord(storage: Storage, record: UploadRecoveryRecord): void {
  const checked = validate(record,record.scope);
  try {
    const prior = readUploadRecoveryRecord(storage,record.scope);
    if (!prior) return;
    if (JSON.stringify(prior) !== JSON.stringify(checked)) return unavailable();
    storage.removeItem(key(record.scope));
    if (storage.getItem(key(record.scope)) !== null) return unavailable();
  } catch {return unavailable();}
}
