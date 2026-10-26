// Continuity only: a store UUID is not authentication or physical-file provenance.
export const STORE_HEADER = 'X-Transcription-Store-Id';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const validStoreId = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && uuid.test(value);
export class StoreContinuityError extends Error {
  constructor() {super('转写来源无法核验或已变化；已停止此页请求。未保存内容仍保留，请先复制保存，再明确重新选择来源。');}
}
export type StoreResponse = Pick<Response, 'ok' | 'status' | 'headers' | 'json' | 'blob'>;
export type StoreFetch = (url: string, init?: RequestInit) => Promise<StoreResponse>;
export function readStoreLink(url: URL) {
  const values = url.searchParams.getAll('transcriptStoreId');
  if (values.length > 1 || (values.length === 1 && !validStoreId(values[0]))) throw new StoreContinuityError();
  for (const key of ['transcriptJob', 'workspaceId', 'sessionId']) if (url.searchParams.getAll(key).length > 1) throw new StoreContinuityError();
  return values[0] ?? null;
}
export class TranscriptionStoreSession {
  private store: string | null;
  private stopped = false;
  private discovering = false;
  private listeners = new Set<() => void>();
  constructor(scope: string | null, private transport: typeof fetch = globalThis.fetch) {
    if (scope !== null && !validStoreId(scope)) throw new StoreContinuityError();
    this.store = scope;
    this.discovering = false;
  }
  get scope() {return this.store;}
  get blocked() {return this.stopped;}
  subscribe = (listener: () => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};
  snapshot = () => this.stopped;
  private stop(): never {this.stopped = true; for (const listener of this.listeners) listener(); throw new StoreContinuityError();}
  assertActive = () => {if (this.stopped || !this.store) throw new StoreContinuityError();};
  key = (id: string) => `${this.store ?? 'unbound'}:${id}`;
  // Only an explicit user source-choice may invoke discovery. Never retry unbound.
  async discover() {
    if (this.stopped || this.store || this.discovering) throw new StoreContinuityError();
    this.discovering = true;
    try {
      const response = await this.transport('/api/local-asr/identity', {method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'error'});
      if (this.stopped) throw new StoreContinuityError();
      const scope = response.headers.get(STORE_HEADER);
      if (!response.ok || !validStoreId(scope)) this.stop();
      // Consume only dedicated identity metadata, never job content while unbound.
      const data: unknown = await response.json().catch(() => this.stop());
      if (this.stopped) throw new StoreContinuityError();
      if (!data || typeof data !== 'object' || (data as Record<string, unknown>).transcriptionStoreId !== scope) this.stop();
      this.store = scope;
    } finally {this.discovering = false;}
  }
  fetch: StoreFetch = async (url, init = {}) => {
    this.assertActive();
    if (!/^\/api\/local-asr\/(?:jobs(?:[/?]|$)|relationships(?:[?]|$)|transcribe(?:[?]|$))/.test(url)) throw new Error('Unsupported transcription route');
    const expected = this.store!;
    const headers = new Headers(init.headers); headers.set(STORE_HEADER, expected);
    const response = await this.transport(url, {...init, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error'});
    this.assertActive();
    if (response.headers.get(STORE_HEADER) !== expected) this.stop();
    const consume = async <T,>(read: () => Promise<T>) => {
      this.assertActive();
      const value = await read();
      this.assertActive();
      return value;
    };
    return {ok: response.ok, status: response.status, headers: response.headers,
      json: () => consume(() => response.json()), blob: () => consume(() => response.blob())};
  };
}
