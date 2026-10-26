import React from 'react';
import {createHash} from 'node:crypto';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {DOCUMENT_UPLOAD_ATTEMPT_TIMEOUT_MS} from '../candidate/src/components/document-upload-attempt';
import {readUploadRecords, retainUploadRecord, UPLOAD_JOURNAL_PREFIX, type UploadRecord} from '../candidate/src/components/document-upload-journal';

// SOURCE-ONLY: authored DOM integration regressions, not executed acceptance.
// Real shell, RecentDocuments, LocalDocuments, journal and unsaved-history coordinator.
// Native jsdom History entries are stamped by the application, not fabricated here.
// One compensating native go(+1) is delayed to make timeout overlap restoration.
// setTimeout/clearTimeout simulation is NOT real-browser traversal or elapsed-time evidence.
// Only heavy PDF display, unrelated leaves and in-memory transport/crypto are synthetic.
vi.mock('../candidate/src/components/PdfPageReader', () => ({PdfPageReader: (props: any) =>
 <div data-testid="combined-pdf" data-id={props.documentId} data-scope={props.storeScope} data-sha={props.selectedSha256}/>}));
vi.mock('../candidate/src/components/LocalTranscription', () => ({LocalTranscription: () => null}));
vi.mock('../candidate/src/components/LocalResearchSearch', () => ({LocalResearchSearch: () => null}));
vi.mock('../candidate/src/components/PrivateCompanyData', () => ({PrivateCompanyData: () => null}));
vi.mock('../candidate/src/components/WorkspaceManager', () => ({WorkspaceManager: () => null}));
vi.mock('../candidate/src/components/WorkspaceHostView', () => ({WorkspaceHostView: () => null}));
vi.mock('../candidate/src/components/OrganizationHostView', () => ({OrganizationHostView: () => null}));
vi.mock('../candidate/src/components/AutomationDefinitionHostView', () => ({AutomationDefinitionHostView: () => null}));
vi.mock('../candidate/src/components/ManualPlanHostView', () => ({ManualPlanHostView: () => null}));
vi.mock('../candidate/src/components/OrganizationManager', () => ({OrganizationManager: () => null}));
vi.mock('../candidate/src/components/AutomationManager', () => ({AutomationManager: () => null}));
vi.mock('../candidate/src/components/ServiceReportsEntry', () => ({ServiceReportsEntry: () => null}));
vi.mock('../candidate/src/components/FeedbackSettingsEntry', () => ({FeedbackSettingsEntry: () => null}));
vi.mock('../candidate/src/components/LocalMeetingAgenda', () => ({LocalMeetingAgenda: () => null}));
vi.mock('../candidate/src/components/HelpContent', () => ({HelpContent: () => null}));
vi.mock('../candidate/src/components/IntegrationCapabilities', () => ({IntegrationCapabilities: () => null}));

const scope = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const committedDocumentId = '33333333-3333-4333-8333-333333333333';
const docId = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const originalText = 'SYNTHETIC_COMBINED_RETURN_UPLOAD';
const sha256 = createHash('sha256').update(originalText).digest('hex');
const journalKey = (record: UploadRecord) => `${UPLOAD_JOURNAL_PREFIX}${record.scope}:${record.operationId}`;
const pendingRecord = (): UploadRecord => ({version: 1, scope, operationId, name: 'original.md', format: 'md',
 bytes: Buffer.byteLength(originalText), sha256, workspaceId: null, folderId: null, createdAt: '2026-10-22T12:00:00.000Z'});
const json = (value: unknown) => new Response(JSON.stringify(value), {
 headers: {'Content-Type': 'application/json', 'X-Transcription-Store-Id': scope},
});
function committed(record: UploadRecord) {
 const {scope: ignoredScope, version: ignoredVersion, ...receipt} = record;
 return {scope: record.scope, operationId: record.operationId, outcome: 'committed',
  receipt: {...receipt, documentId: committedDocumentId},
  document: {id: committedDocumentId, sha256: record.sha256, trashedAt: null}};
}
function deferred<T>() {
 let resolve!: (value: T) => void;
 const promise = new Promise<T>(done => {resolve = done;});
 return {promise, resolve};
}
function heldResponse(phase: 'headers' | 'body') {
 const headers = deferred<Response>(), body = deferred<unknown>();
 const read = vi.fn(() => body.promise), cancel = vi.fn(async () => {});
 const response = {ok: true, status: 200, json: read, body: {cancel}} as unknown as Response;
 // Deliberately ignores AbortSignal to exercise post-await ownership checks.
 return {read, cancel, result: phase === 'headers' ? headers.promise : Promise.resolve(response),
  resolve(value: unknown) {body.resolve(value); headers.resolve(response);}};
}
type HeldResponse = ReturnType<typeof heldResponse>;
type Call = {url: URL; init: RequestInit; page: string | null};
function transport() {
 const calls: Call[] = [], queued: HeldResponse[] = [];
 let label = 'Original';
 const doc = (n: number) => ({id: docId(n), name: `${label} PDF ${n}`, format: 'pdf', revision: 0,
  trashedAt: null, stale: false, sha256: 'a'.repeat(64), textSha256: 'b'.repeat(64), bytes: 100, pages: 1,
  createdAt: '2026-10-22T00:00:00Z', workspaceId: null, folderId: null, workspaceName: null, folderName: null});
 vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
  const url = new URL(String(input), location.href), method = init.method ?? 'GET';
  calls.push({url, init, page: new URL(location.href).searchParams.get('page')});
  if (url.pathname === '/api/documents/upload' || url.pathname.startsWith('/api/documents/upload-operations/')) {
   expect(method).toBe(url.pathname === '/api/documents/upload' ? 'POST' : 'GET');
   const next = queued.shift();
   if (!next) throw Error(`Unexpected unrequested recovery operation: ${url.pathname}`);
   return next.result;
  }
  expect(method).toBe('GET');
  if (url.pathname === '/api/documents/choices') return Promise.resolve(json({uploadScope: scope, workspaces: [], folders: []}));
  if (url.pathname === '/api/documents') {
   expect(new Headers(init.headers).get('X-Document-Store-Id')).toBe(scope);
   const offset = Number(url.searchParams.get('offset'));
   return Promise.resolve(json({storeScope: scope, documents: Array.from({length: 11}, (_, i) => doc(i + 1)).slice(offset, offset + 10), total: 11, offset, limit: 10}));
  }
  if (url.pathname === `/api/documents/${docId(11)}`) {
   expect(new Headers(init.headers).get('X-Citation-Store-Id')).toBe(scope);
   return Promise.resolve(json({storeScope: scope, document: doc(11), text: 'synthetic extraction'}));
  }
  if (url.pathname === '/api/local-asr/identity') return Promise.resolve(json({transcriptionStoreId: scope}));
  if (url.pathname === '/api/local-asr/jobs') return Promise.resolve(json({jobs: [], total: 0, offset: 0, limit: 10, hasMore: false}));
  throw Error(`Unexpected synthetic combined request: ${url.pathname}`);
 }));
 const operations = () => calls.filter(c => c.url.pathname === '/api/documents/upload' || c.url.pathname.startsWith('/api/documents/upload-operations/'));
 return {calls, queue: (response: HeldResponse) => queued.push(response), operations,
  posts: () => operations().filter(c => c.init.method === 'POST'),
  checks: () => operations().filter(c => c.url.pathname.startsWith('/api/documents/upload-operations/')),
  details: () => calls.filter(c => c.url.pathname === `/api/documents/${docId(11)}`),
  recentLists: () => calls.filter(c => c.page === 'tasks' && c.url.pathname === '/api/documents'),
  setLabel: (value: string) => {label = value;}};
}
function syntheticFile(name = 'original.md', text = originalText) {
 const file = new File([text], name);
 Object.defineProperty(file, 'arrayBuffer', {value: async () => new TextEncoder().encode(text).buffer});
 return file;
}
const mainInput = () => screen.getByLabelText('选择文档') as HTMLInputElement;
const checkButton = () => screen.getByRole('button', {name: '核对上传结果'}) as HTMLButtonElement;
const retryButton = () => screen.getByRole('button', {name: '用原操作重试上传'}) as HTMLButtonElement;
const fieldset = () => mainInput().closest('fieldset')!;
function selectMain(file: File) {
 const input = mainInput(), nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
 let selected: File | null = file;
 // Model only the FileList surface this leaf reads, including native-style clearing.
 // A bare fireEvent target.files override can survive input.value = '' and mask a bug.
 // These per-node accessors do not patch the prototype or claim native picker coverage.
 Object.defineProperties(input, {
  files: {configurable: true, get: () => selected ? [selected] : []},
  value: {configurable: true,
   get: () => selected ? `C:\\fakepath\\${selected.name}` : nativeValue.get!.call(input),
   set: (value: string) => {nativeValue.set!.call(input, value); if (value === '') selected = null;}},
 });
 fireEvent.change(input);
}
async function flush() {await act(async () => {for (let i = 0; i < 12; i++) await Promise.resolve();});}
async function advance(ms: number) {await act(async () => {await vi.advanceTimersByTimeAsync(ms);});}
const expectedNativePops: (() => void)[] = [];
let serial = 1; // Unsaved-history module ownership survives each row of this matrix.
const observeNativePop = () => {expectedNativePops.shift()?.();};
const nextNativePop = () => new Promise<void>(resolve => {expectedNativePops.push(resolve);});
async function traverse(direction: 'back' | 'forward', compensates = false) {
 await act(async () => {
  const arrived = nextNativePop(), restored = compensates ? nextNativePop() : null;
  history[direction]();
  // jsdom queues native History on setImmediate, not this suite's fake setTimeout.
  // Observe its real event before advancing time, so expiry cannot overtake Back.
  await arrived;
  await vi.advanceTimersByTimeAsync(65);
  if (restored) await restored;
  // The final native compensation event can arrive after tickAsync's own task.
  // Drain its coordinator settle timer only after that event has actually arrived.
  await vi.advanceTimersByTimeAsync(1);
 });
 await flush();
}
function expectRetained(record: UploadRecord, raw: string, selection?: File) {
 expect(readUploadRecords(localStorage, scope)).toEqual([record]);
 expect(localStorage.getItem(journalKey(record))).toBe(raw);
 expect(screen.queryByText(/已核实文档已保存到本地/)).toBeNull();
 if (selection) expect(mainInput().files?.[0]).toBe(selection);
}
beforeEach(() => {
 localStorage.clear();
 expectedNativePops.length = 0;
 // Register before the shell's coordinator, which stops a rejected popstate.
 // Observation only: no synthetic events, ownership stamping or propagation edits.
 window.addEventListener('popstate', observeNativePop, true);
 // Unique deterministic UUIDs include the application's own history session IDs.
 // Sync in-process digest wrapped in a promise avoids native crypto scheduling.
 vi.stubGlobal('crypto', {randomUUID: () => `bbbbbbbb-bbbb-4bbb-8bbb-${String(serial++).padStart(12, '0')}`,
  subtle: {digest: async (_algorithm: string, bytes: ArrayBuffer) =>
   Uint8Array.from(createHash('sha256').update(new Uint8Array(bytes)).digest()).buffer}});
});
afterEach(async () => {
 cleanup();
 if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(65);
 window.removeEventListener('popstate', observeNativePop, true);
 expectedNativePops.length = 0;
 vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
 localStorage.clear(); history.replaceState(null, '', '/');
});

it.each([
 {kind: 'upload', phase: 'body'},
 {kind: 'check', phase: 'headers'},
 {kind: 'retry', phase: 'body'},
] as const)('$kind: denied Back crosses deadline; accepted return is one-shot and old responses cannot own the Forward mount', async ({kind, phase}) => {
 if (kind !== 'upload') retainUploadRecord(localStorage, pendingRecord());
 const f = transport(), life = new OrdinaryRequestLifetime();
 history.replaceState({fixture: 'combined-return-upload'}, '', '/?page=tasks');
 render(<OrdinaryNavigationShell lifetime={life}/>);
 await screen.findByText('Original PDF 1');
 fireEvent.click(within(screen.getByRole('navigation', {name: '文档入库分页'})).getByText('下一页'));
 await screen.findByText('Original PDF 11');
 const recentEntry = JSON.stringify(history.state);
 expect(history.state.__yanyuOwnedHistory).toBeTruthy();
 fireEvent.click(screen.getByText('打开 PDF：Original PDF 11'));
 const reader = await screen.findByTestId('combined-pdf');
 await waitFor(() => expect(fieldset().disabled).toBe(false));
 await waitFor(() => expect(screen.queryByText('正在加载文档…')).toBeNull());
 expect(reader.dataset).toMatchObject({id: docId(11), scope, sha: 'a'.repeat(64)});
 expect(f.details()).toHaveLength(1);
 expect(life.epoch).toBe(1);
 const documentEntry = JSON.stringify(history.state), originalInput = mainInput();
 expect(documentEntry).not.toBe(recentEntry);
 // Initial async loading and Testing Library polling finish on real timers.
 vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});

 const selected = syntheticFile(kind === 'upload' ? 'original.md' : 'unrelated-main.md', kind === 'upload' ? originalText : 'SYNTHETIC_MAIN_DRAFT');
 selectMain(selected); // This real main-file draft supplies the dirty guard in ALL cases.
 const old = heldResponse(phase);
 f.queue(old);
 if (kind === 'upload') fireEvent.submit(mainInput().closest('form')!);
 if (kind === 'check') fireEvent.click(checkButton());
 if (kind === 'retry') {
  fireEvent.change(screen.getByLabelText('为original.md重新选择原文件'), {target: {files: [syntheticFile()]}});
  fireEvent.click(retryButton());
 }
 await flush();
 expect(f.operations()).toHaveLength(1);
 const record = readUploadRecords(localStorage, scope)[0];
 expect(record).toBeTruthy();
 const raw = localStorage.getItem(journalKey(record));
 expect(raw).not.toBeNull();
 const exactRaw = raw!;
 expectRetained(record, exactRaw, selected);
 const oldSignal = f.operations()[0].init.signal!;
 expect(oldSignal.aborted).toBe(false);
 expect(checkButton().disabled).toBe(true);
 expect(fieldset().disabled).toBe(true);
 if (kind === 'check') expect(f.operations()[0].url.pathname).toBe(`/api/documents/upload-operations/${record.operationId}`);
 else {
  const post = f.posts()[0], headers = new Headers(post.init.headers);
  expect(headers.get('X-Upload-Operation-Id')).toBe(record.operationId);
  expect(headers.get('X-Upload-Store-Id')).toBe(scope);
  expect(post.init.body).toBeInstanceOf(File);
  expect(await (post.init.body as File).arrayBuffer()).toEqual(new TextEncoder().encode(originalText).buffer);
 }

 const beforeBack = f.calls.length;
 let deniedBeforeExpiry = false;
 const confirm = vi.spyOn(window, 'confirm').mockImplementation(() => {
  deniedBeforeExpiry = !oldSignal.aborted && checkButton().disabled;
  return false;
 });
 const nativeGo = history.go.bind(history);
 let compensationDelayed = false, expiredDuringRestoration = false;
 const compensation = vi.spyOn(history, 'go').mockImplementation(delta => {
  if (delta === 1 && !compensationDelayed) {
   compensationDelayed = true;
   // A deliberately delayed compensation, still using native jsdom History.
   // Do not fabricate ownership state or dispatch a substitute popstate event.
   setTimeout(() => {
    expiredDuringRestoration = oldSignal.aborted && location.search === '?page=tasks' &&
     screen.queryByLabelText('选择文档') === originalInput && screen.queryByTestId('combined-pdf') === reader;
    nativeGo(delta);
   }, 40);
   return;
  }
  nativeGo(delta);
 });
 await advance(DOCUMENT_UPLOAD_ATTEMPT_TIMEOUT_MS - 32);
 await traverse('back', true);
 const compensationDeltas = compensation.mock.calls.map(([delta]) => delta);
 compensation.mockRestore();
 expect(deniedBeforeExpiry).toBe(true);
 expect(compensationDeltas).toEqual([1]);
 expect(compensationDelayed).toBe(true);
 expect(expiredDuringRestoration).toBe(true);
 expect(confirm).toHaveBeenCalledOnce();
 expect(location.search).toBe('?page=documents');
 expect(JSON.stringify(history.state)).toBe(documentEntry);
 expect(history.state.fixture).toBe('combined-return-upload');
 expect(life.epoch).toBe(1);
 expect(mainInput()).toBe(originalInput);
 expect(screen.getByTestId('combined-pdf')).toBe(reader);
 expect(oldSignal.aborted).toBe(true);
 expect(checkButton().disabled).toBe(false);
 expect(fieldset().disabled).toBe(false);
 expect(screen.getByText(/本次等待已超时/).textContent).toContain('不代表服务端操作已取消');
 expectRetained(record, exactRaw, selected);
 expect(f.calls).toHaveLength(beforeBack); // No automatic check, retry, list reload or PDF admission.

 // Acquire a second explicit lock after expiry, then leave while it is still pending.
 // This distinguishes unmount cancellation from the first attempt's timeout fence.
 const leaving = heldResponse('headers');
 f.queue(leaving); fireEvent.click(checkButton()); await flush();
 expect(f.operations()).toHaveLength(2);
 const leavingSignal = f.operations()[1].init.signal!;
 expect(leavingSignal.aborted).toBe(false);
 expect(checkButton().disabled).toBe(true);
 confirm.mockReturnValue(true);
 f.setLabel('Fresh');
 const beforeReturn = f.calls.length;
 await traverse('back');
 expect(confirm).toHaveBeenCalledTimes(2);
 expect(location.search).toBe('?page=tasks');
 expect(JSON.stringify(history.state)).toBe(recentEntry);
 expect(life.epoch).toBe(2);
 expect(leavingSignal.aborted).toBe(true);
 expect(screen.getByText('Fresh PDF 11')).toBeTruthy();
 expect(screen.queryByTestId('combined-pdf')).toBeNull();
 expectRetained(record, exactRaw);
 const returned = f.calls.slice(beforeReturn).filter(c => c.url.pathname.startsWith('/api/documents'));
 expect(returned.map(c => c.url.pathname)).toEqual(['/api/documents/choices', '/api/documents']);
 expect(returned[1].url.searchParams.get('offset')).toBe('10');
 expect(new Headers(returned[1].init.headers).get('X-Document-Store-Id')).toBe(scope);
 expect(f.operations()).toHaveLength(2);

 await traverse('forward');
 expect(location.search).toBe('?page=documents');
 expect(JSON.stringify(history.state)).toBe(documentEntry);
 expect(life.epoch).toBe(3);
 expect(mainInput()).not.toBe(originalInput);
 expect(mainInput().files?.length ?? 0).toBe(0);
 expect(screen.queryByTestId('combined-pdf')).toBeNull();
 expect(f.details()).toHaveLength(1);
 expect(f.operations()).toHaveLength(2);
 expect(fieldset().disabled).toBe(false);
 expect(screen.queryByText(/本次等待已超时/)).toBeNull();
 const newerSelection = syntheticFile('forward-draft.md', 'SYNTHETIC_NEW_MOUNT_DRAFT');
 selectMain(newerSelection);
 const current = heldResponse('headers');
 f.queue(current); fireEvent.click(checkButton()); await flush();
 expect(f.operations()).toHaveLength(3);
 const currentSignal = f.operations()[2].init.signal!;
 expect(currentSignal.aborted).toBe(false);
 expect(checkButton().disabled).toBe(true);

 // Successful old replies arrive only AFTER a real route unmount and Forward remount.
 // They may not settle the shared journal, clear this selection or release this lock.
 const beforeLateReplies = f.calls.length;
 await act(async () => {old.resolve(committed(record)); leaving.resolve(committed(record));});
 await flush();
 expectRetained(record, exactRaw, newerSelection);
 expect(currentSignal.aborted).toBe(false);
 expect(checkButton().disabled).toBe(true);
 expect(fieldset().disabled).toBe(true);
 expect(screen.queryByTestId('combined-pdf')).toBeNull();
 expect(screen.queryByText(/本次等待已超时/)).toBeNull();
 expect(leaving.read).not.toHaveBeenCalled();
 expect(leaving.cancel).toHaveBeenCalledOnce();
 if (phase === 'headers') {expect(old.read).not.toHaveBeenCalled(); expect(old.cancel).toHaveBeenCalledOnce();}
 else expect(old.read).toHaveBeenCalledOnce();
 fireEvent.submit(mainInput().closest('form')!); // Even a direct form event cannot steal the current lock.
 fireEvent.click(checkButton());
 await flush();
 expect(f.calls).toHaveLength(beforeLateReplies);
 expect(checkButton().disabled).toBe(true);
 expectRetained(record, exactRaw, newerSelection);
 await act(async () => {current.resolve({scope, operationId: record.operationId, outcome: 'absent'});});
 await flush();
 expect(checkButton().disabled).toBe(false);
 expect(fieldset().disabled).toBe(false);
 expectRetained(record, exactRaw, newerSelection);
 expect(screen.getByText(/不能据此认定上传失败/)).toBeTruthy();
 expect(f.posts()).toHaveLength(kind === 'check' ? 0 : 1);
 expect(f.checks()).toHaveLength(kind === 'check' ? 3 : 2);

 await traverse('back');
 expect(confirm).toHaveBeenCalledTimes(3);
 expect(life.epoch).toBe(4);
 expect(screen.getByText('Fresh PDF 1')).toBeTruthy();
 expect(screen.queryByText('Fresh PDF 11')).toBeNull();
 expect(f.recentLists().map(c => c.url.searchParams.get('offset'))).toEqual(['0', '10', '10', '0']);
 expect(f.details()).toHaveLength(1);
 expect(f.operations()).toHaveLength(3);
 expectRetained(record, exactRaw);
 // Retry-only selections have a known missing dirty guard. This suite deliberately
 // uses a real main-file draft and does NOT assert a new retry-only leave prompt.
 // In-place identity changes, changed-store remounts and pre-cleanup settlement
 // are separate boundaries, not established by these same-store post-remount cases.
});
