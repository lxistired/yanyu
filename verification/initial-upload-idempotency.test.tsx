// Focused service regression, not browser or real-ASR acceptance. Actual current
// server callback, real localTranscription + SQLite, prepared workspace, actual UI.
// No HTTP listener/network, microphone, playback, decoder, model or new runtime.
import React from 'react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {Blob as NodeBlob, File as NodeFile} from 'node:buffer';
import {webcrypto, createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Readable} from 'node:stream';
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync, realpathSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {localTranscription} from '../backend/local-transcription.mjs';
import {DomainStore} from '../prepared-runtime/server/workspace-store.mjs';
import {WorkspaceDomain} from '../prepared-runtime/server/workspace-domain.mjs';
import {LocalTranscription} from '../candidate/src/components/LocalTranscription';

const evidence = resolve('initial-upload-evidence');
mkdirSync(evidence, {recursive: true});
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const save = (name: string, value: unknown) => writeFileSync(join(evidence, name + '.json'), JSON.stringify(value, null, 2) + '\n');
const snapshot = (name: string) => writeFileSync(join(evidence, name + '.html'), document.body.innerHTML);
const click = (name: string) => fireEvent.click(screen.getByRole('button', {name, exact: true}));
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const transcript = '[SIMULATED PROVIDER OUTPUT; NOT ASR] Synthetic initial-upload idempotency regression only.';
const bytes = Buffer.alloc(32044);
bytes.write('RIFF', 0); bytes.writeUInt32LE(32036, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(32000, 40);
for (let i = 0; i < 16000; i++) bytes.writeInt16LE((i % 13) - 6, 44 + i * 2);
const filename = 'synthetic-initial-ack.wav';
const file = () => new NodeFile([bytes], filename, {type: 'audio/wav'});
const audioHeaders = (scope: string, operationId?: string) => ({
  'x-transcription-store-id': scope, 'content-type': 'audio/wav',
  'x-audio-filename': encodeURIComponent(filename), 'x-audio-language': 'zh', 'x-audio-origin': 'file-selection',
  ...(operationId === undefined ? {} : {'x-upload-operation-id': operationId}),
});
const serverSource = readFileSync(resolve('backend/server.mjs'), 'utf8');
const routeDeclaration = serverSource.slice(serverSource.indexOf('const routes='), serverSource.indexOf('\nconst dist='));
const callback = serverSource.slice(serverSource.indexOf('const server=createServer(') + 'const server=createServer('.length, serverSource.indexOf('\nserver.requestTimeout=') - 2);
if (!callback.startsWith('async(req,res)=>{') || !callback.endsWith('}')) throw Error('Exact current server callback extraction failed');
const inputs = ['backend/server.mjs', 'backend/local-transcription.mjs', 'backend/failed-transcription-retry.mjs', 'backend/transcription-store-dispatch.mjs', 'backend/transcription-store-identity.mjs', 'backend/transcription-library.mjs', 'backend/transcription-origin.mjs', 'backend/transcript-management.mjs', 'backend/worker-fence.mjs', 'backend/upload-receipts.mjs', 'candidate/src/components/LocalTranscription.tsx', 'candidate/src/components/RecordingDrafts.tsx', 'candidate/src/components/FailedTranscriptionRetry.tsx', 'candidate/src/components/TranscriptEditor.tsx', 'candidate/src/components/TranscriptionStoreBoundary.tsx', 'candidate/src/components/transcription-store-session.ts', 'candidate/src/recording/recording-draft-store.ts', 'candidate/src/recording/checkpoint-session.ts', 'candidate/src/recording/pcm-wav.ts', 'prepared-runtime/server/workspace-store.mjs', 'prepared-runtime/server/workspace-domain.mjs'];
const bindings = {
  candidate: resolve('.'), inputs: inputs.map(path => ({path, realpath: realpathSync(path), sha256: sha(readFileSync(path))})),
  callbackSha256: sha(callback), routeDeclarationSha256: sha(routeDeclaration), applicationModulesMocked: [],
  transport: 'Exact current backend callback over in-process Readable streams; no HTTP listener. Unrelated route owners return false and are not claimed as exercised.',
};
const expectedReceipt = {
  version: 1, sha256: sha(bytes), byteLength: bytes.length, declaredMime: 'audio/wav', acceptedFormat: 'wav', language: 'zh',
  settings: {profile: 'local-asr-upload-v1', maxSeconds: 2, maxBytes: 100000, deadlineSeconds: 20,
    requestedRecognizer: {model: 'faster-whisper-small', device: 'cpu', computeType: 'int8', beamSize: 5, temperature: 0, vadFilter: false, conditionOnPreviousText: false, wordTimestamps: true, cpuThreads: 4, numWorkers: 1, windowSeconds: 30, strideSeconds: 29, seedPolicy: 'ctranslate2-sha256-source-chunk-v1'}},
};
function committed(payload: any, operationId: string, replayed: boolean, deleted = false) {
  expect(payload.id).toMatch(canonicalUuid);
  expect(['processing', 'completed', 'failed', 'interrupted', 'cancelled']).toContain(payload.status);
  expect(payload).toEqual({operationId, state: 'committed', reconciliationFinal: true, id: payload.id, status: payload.status, filename, uploadOrigin: 'file-selection', receipt: expectedReceipt, deleted, replayed});
}
function deferred() {let resolve!: () => void; const promise = new Promise<void>(yes => {resolve = yes;}); return {promise, resolve};}
type Request = {path?: string; method?: string; body?: Buffer; headers?: Record<string, string>; duplicateOperation?: boolean; stream?: AsyncIterable<Buffer>};
function createHarness(name: string, dropFirstAck = false) {
  const storage = mkdtempSync(join(evidence, `synthetic-${name}-`));
  const providerRoot = join(storage, 'simulated-provider'); mkdirSync(providerRoot);
  const worker = join(providerRoot, 'inert-worker.sh'), calls = join(providerRoot, 'calls.txt'), output = join(providerRoot, 'result.json');
  writeFileSync(output, JSON.stringify({type: 'result', text: transcript, duration_seconds: 1, inference_seconds: 0, language: 'zh', language_source: 'explicit simulated fixture', boundaries: []}) + '\n');
  // recognize_long.py is only an argument. This existing seam never invokes it.
  writeFileSync(worker, `#!/bin/sh\nset -eu\ncase "$1" in */local-asr/recognize_long.py) ;; *) exit 90;; esac\n[ "$3" = wav ] && [ "$4" = 2 ] && [ "$5" = 100000 ] && [ "$6" = zh ] || exit 91\nprintf '%s\\n' "$*" >> '${calls}'\ncat '${output}'\n`, {mode: 0o700});
  Object.assign(process.env, {YANYU_PYTHON: worker, ASR_MAX_SECONDS: '2', ASR_MAX_BYTES: '100000', ASR_DEADLINE_SECONDS: '20', ASR_PENDING_TTL_SECONDS: '3600'});
  let transcription: any, store: any, workspace: any, handler: any, generation = 0, closed = true;
  const routes: any[] = [], lifecycle: any[] = [], logs: any[] = [];
  const principal = {tenantId: 'synthetic-initial-upload-idempotency', subjectId: 'synthetic-owner', collectionIds: []};
  const context = () => ({principal, requestId: 'synthetic-initial-upload-idempotency', signal: new AbortController().signal});
  const open = () => {
    store = new DomainStore(storage); workspace = new WorkspaceDomain(store);
    const sourceWorkspace = {get: (kind: string, id: string) => workspace.get(context(), {kind, id}), list: (kind: string) => {const rows: any[] = []; let offset: number | null = 0; do {const page = workspace.list(context(), {kind, offset, limit: 200}); rows.push(...page.items); offset = page.nextOffset;} while (offset !== null); return rows;}};
    transcription = localTranscription(storage, sourceWorkspace);
    const pass = {handle: async () => false};
    handler = new Function('app', 'port', 'origin', 'assets', 'inventoryRoutes', 'handlePrivateDemo', 'privateDemo', 'inventory', 'documents', 'transcription', 'publishPdfImage', 'event', 'Buffer', `${routeDeclaration}\nreturn (${callback});`)({context, workspace}, 12345, 'http://127.0.0.1:12345', new Map(), pass, async () => false, null, pass, pass, transcription, () => {throw Error('No PDF work');}, (value: unknown) => logs.push(value), Buffer);
    closed = false; lifecycle.push({action: 'opened-current-service-and-prepared-workspace', generation: ++generation});
  };
  const inspect = () => {
    const db = new DatabaseSync(join(storage, 'long-transcription.sqlite'), {readOnly: true});
    try {return Object.fromEntries(['transcription_jobs', 'transcription_retries', 'transcription_store_identity', 'transcript_corrections', 'transcript_versions'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));} finally {db.close();}
  };
  const close = async () => {if (closed) return; await transcription.close(); store.close(); closed = true; lifecycle.push({action: 'closed-and-drained-current-service-and-prepared-workspace', generation});};
  const request = async ({path = '/api/local-asr/transcribe', method = 'POST', body = Buffer.alloc(0), headers: givenHeaders = {}, duplicateOperation = false, stream}: Request = {}) => {
    if (closed) throw Error('Harness service is closed');
    const permitted = method === 'GET' && /^\/api\/local-asr\/(?:identity|jobs\?.*|jobs\/[a-f0-9-]{36}\/(?:retry|transcript)|relationships|transcribe\?operationId=[a-f0-9-]{36})$/.test(path)
      || method === 'POST' && (path === '/api/local-asr/transcribe' || /^\/api\/local-asr\/jobs\/[a-f0-9-]{36}\/(?:rename|trash)$/.test(path));
    if (!permitted) throw Error('Out-of-scope in-process transport ' + method + ' ' + path);
    let pulledBytes = 0;
    const req: any = Readable.from((async function* () {for await (const chunk of stream ?? (body.length ? [body] : [])) {pulledBytes += chunk.length; yield chunk;}})());
    req.url = path; req.method = method;
    req.headers = {host: '127.0.0.1:12345', origin: 'http://127.0.0.1:12345', ...givenHeaders, ...(body.length ? {'content-length': String(body.length)} : {})};
    req.rawHeaders = Object.entries(req.headers).flat();
    if (duplicateOperation) req.rawHeaders.push('X-Upload-Operation-Id', givenHeaders['x-upload-operation-id']);
    let status = 0, headers: Record<string, string> = {}, response: any;
    await handler(req, {setHeader(name: string, value: string) {headers[name] = value;}, writeHead(s: number, h: Record<string, string>) {status = s; headers = {...headers, ...h};}, end(value: any) {response = value;}});
    if (!status || response === undefined) throw Error('Actual current callback response unfinished');
    const payload = JSON.parse(String(response));
    const call = {generation, path, method, requestHeaders: req.headers, rawHeaders: req.rawHeaders, inputBytes: body.length, inputSha256: body.length ? sha(body) : null, pulledBytes, status, responseHeaders: headers, payload, outwardAck: 'delivered'};
    routes.push(call);
    if (dropFirstAck && method === 'POST' && path === '/api/local-asr/transcribe') {
      if (status !== 202) throw Error('Expected durable initial upload before dropping ACK: ' + JSON.stringify(call));
      dropFirstAck = false; call.outwardAck = 'deliberately dropped after actual handler committed initial job and returned 202';
      throw Error('Explicit transport fixture: lost initial-upload ACK after actual durable commit');
    }
    return {response: new Response(response, {status, headers}), status, payload, call};
  };
  const fetcher: typeof fetch = async (input, init = {}) => {
    const body = init.body instanceof NodeBlob ? Buffer.from(await init.body.arrayBuffer()) : Buffer.from(String(init.body ?? ''));
    return (await request({path: String(input), method: init.method ?? 'GET', body, headers: Object.fromEntries(new Headers(init.headers))})).response;
  };
  open();
  return {storage, routes, lifecycle, fetcher, request, inspect, close, async reopen() {await close(); open();},
    workerCalls: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [],
    async identity() {return (await request({path: '/api/local-asr/identity', method: 'GET'})).payload.transcriptionStoreId;},
    snapshot(label: string) {const value = inspect(); save(name + '-' + label, value); return value;},
    persist() {save('source-bindings', bindings); save(name + '-route-trace', {routes, lifecycle, logs, workerCalls: this.workerCalls(), provider: 'Explicit inert executable through existing YANYU_PYTHON seam; no recognition script/model executed.'});},
  };
}
let harness: ReturnType<typeof createHarness> | undefined;
const oldEnv = {...process.env};
let mediaSpy: any, playSpy: any;
beforeEach(() => {
  vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('File', NodeFile); vi.stubGlobal('crypto', webcrypto);
  mediaSpy = vi.fn(() => {throw Error('Microphone forbidden');});
  Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {getUserMedia: mediaSpy}});
  playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => {throw Error('Playback forbidden');});
  vi.stubGlobal('fetch', vi.fn(() => {throw Error('Network forbidden; use bounded in-process fixture');}));
});
afterEach(async () => {
  cleanup();
  if (harness) {await harness.close(); harness.persist(); harness = undefined;}
  expect(mediaSpy).not.toHaveBeenCalled(); expect(playSpy).not.toHaveBeenCalled();
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]; Object.assign(process.env, oldEnv);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/');
});
const complete = async (f: ReturnType<typeof createHarness>, count: number) => {await waitFor(() => expect(f.inspect().transcription_jobs.filter((row: any) => row.status === 'completed')).toHaveLength(count)); expect(f.workerCalls()).toHaveLength(count);};

it('lost ACK → real close/reopen → exact UI reconcile → explicit same-operation replay keeps one job/worker; deliberate new operation permits same bytes', async () => {
  const f = harness = createHarness('continuous', true); vi.stubGlobal('fetch', f.fetcher); history.replaceState(null, '', '/?page=transcription');
  save('synthetic-input', {filename, bytes: bytes.length, sha256: sha(bytes), kind: 'Constructed synthetic PCM WAV; never captured, played, decoded or recognized'});
  render(<LocalTranscription/>); expect(f.routes).toHaveLength(0); click('明确选择当前转写来源'); await screen.findByText('还没有转写记录');
  const scope = f.routes.find(call => call.path === '/api/local-asr/identity').payload.transcriptionStoreId;
  fireEvent.change(screen.getByLabelText('选择音频文件'), {target: {files: [file()]}});
  fireEvent.change(screen.getByLabelText('识别语言'), {target: {value: 'zh'}});
  click('上传并本地转写'); await screen.findByLabelText('未确认上传核对'); await complete(f, 1);
  const uploads = () => f.routes.filter(call => call.method === 'POST' && call.path === '/api/local-asr/transcribe');
  expect(uploads()).toHaveLength(1); const first = uploads()[0], operationId = first.requestHeaders['x-upload-operation-id'];
  expect(operationId).toMatch(canonicalUuid); expect(first.status).toBe(202); committed(first.payload, operationId, false);
  expect(first.outwardAck).toContain('deliberately dropped'); expect(first.inputSha256).toBe(sha(bytes));
  expect(screen.queryByRole('link', {name: '查看新提交任务'})).toBeNull();
  expect((screen.getByRole('button', {name: '上传并本地转写'}) as HTMLButtonElement).disabled).toBe(true);
  snapshot('continuous-01-uncertain'); const initial = f.snapshot('01-committed-lost-ack');
  expect(initial.transcription_jobs[0].original_upload_operation_id).toBe(operationId);
  expect(initial.transcription_retries).toHaveLength(0);
  // Same mounted client retains the original File/envelope; real owner and SQLite close.
  await act(async () => {await f.reopen();}); expect(f.inspect()).toEqual(initial); expect(f.workerCalls()).toHaveLength(1);
  f.snapshot('02-after-service-reopen');
  const start = f.routes.length; click('核对本次上传结果'); await screen.findByRole('link', {name: '查看新提交任务'});
  const exact = f.routes.slice(start).filter(call => call.path === '/api/local-asr/transcribe?operationId=' + operationId);
  expect(exact).toHaveLength(1); expect(exact[0].method).toBe('GET'); expect(exact[0].status).toBe(200); committed(exact[0].payload, operationId, false);
  expect(exact[0].payload.id).toBe(first.payload.id); expect(uploads()).toHaveLength(1); expect(f.workerCalls()).toHaveLength(1);
  expect(screen.queryByLabelText('未确认上传核对')).toBeNull();
  const href = screen.getByRole('link', {name: '查看新提交任务'}).getAttribute('href')!;
  expect(new URL(href, 'http://localhost').searchParams.get('transcriptJob')).toBe(first.payload.id);
  snapshot('continuous-03-confirmed-exact-operation');
  // Explicit service replay tests the durable contract even after UI clears pending.
  const replay = await f.request({body: bytes, headers: audioHeaders(scope, operationId)});
  expect(replay.status).toBe(200); committed(replay.payload, operationId, true); expect(replay.payload.id).toBe(first.payload.id);
  expect(replay.call.pulledBytes).toBe(bytes.length); expect(f.inspect()).toEqual(initial); expect(f.workerCalls()).toHaveLength(1);
  f.snapshot('04-explicit-replay-no-duplicate');
  // Same content is allowed as new intentional work, never content deduplication.
  fireEvent.change(screen.getByLabelText('选择音频文件'), {target: {files: [file()]}}); click('上传并本地转写');
  await waitFor(() => expect(uploads()).toHaveLength(3)); await complete(f, 2);
  const intentional = uploads()[2], newOperationId = intentional.requestHeaders['x-upload-operation-id'];
  expect(intentional.status).toBe(202); expect(newOperationId).toMatch(canonicalUuid); expect(newOperationId).not.toBe(operationId);
  committed(intentional.payload, newOperationId, false); expect(intentional.payload.id).not.toBe(first.payload.id); expect(intentional.inputSha256).toBe(first.inputSha256);
  const final = f.snapshot('05-explicit-new-operation'); expect(final.transcription_jobs).toHaveLength(2); expect(final.transcription_retries).toHaveLength(0);
  expect(final.transcription_jobs.find((row: any) => row.id === first.payload.id)).toEqual(initial.transcription_jobs[0]);
  expect(readdirSync(join(f.storage, 'long-asr-temp'))).toEqual([]); expect(document.querySelector('audio')).toBeNull();
  for (const route of f.routes.filter(call => call.path !== '/api/local-asr/identity')) expect(route.requestHeaders['x-transcription-store-id']).toBe(scope);
  save('continuous-result', {result: 'PASS_FIXED_SERVICE', lostAcknowledgments: 1, serviceGenerations: 2, exactReconciliationGets: 1, automaticResubmissions: 0, sameOperationReplayStatus: replay.status, jobsAfterReplay: initial.transcription_jobs.length, workersAfterReplay: 1, intentionalNewOperationJobs: final.transcription_jobs.length, totalWorkers: f.workerCalls().length, seededRows: 0, provider: 'SIMULATED inert executable only', browser: false, network: false, listener: false, microphone: false, playback: false, realAi: false, fullProductAcceptance: false});
});

it('necessary operation guards fail closed; rename/trash retains exact original identity; headerless legacy response remains unchanged', async () => {
  const f = harness = createHarness('guards'); const scope = await f.identity(); const operationId = randomUUID();
  const malformed = await f.request({body: bytes, headers: audioHeaders(scope, 'not-a-canonical-uuid')});
  const duplicate = await f.request({body: bytes, headers: audioHeaders(scope, operationId), duplicateOperation: true});
  for (const rejected of [malformed, duplicate]) {expect(rejected.status).toBe(400); expect(rejected.call.pulledBytes).toBe(0);}
  const wrongScope = await f.request({body: bytes, headers: audioHeaders(randomUUID(), operationId)});
  expect(wrongScope.status).toBe(409); expect(wrongScope.payload.error.code).toBe('STORE_CHANGED'); expect(wrongScope.call.pulledBytes).toBe(0);
  expect(f.inspect().transcription_jobs).toHaveLength(0); expect(f.workerCalls()).toHaveLength(0);
  const first = await f.request({body: bytes, headers: audioHeaders(scope, operationId)});
  expect(first.status).toBe(202); committed(first.payload, operationId, false); await complete(f, 1);
  const original = f.snapshot('01-original');
  // Synthetic DB only. Failed immutable writes and a rolled-back duplicate insert
  // prove the durable guard, rather than only testing in-memory request handling.
  const guardDb = new DatabaseSync(join(f.storage, 'long-transcription.sqlite'));
  try {
    expect(() => guardDb.prepare('UPDATE transcription_jobs SET original_upload_operation_id=? WHERE id=?').run(randomUUID(), first.payload.id)).toThrow(/immutable/);
    expect(() => guardDb.prepare('UPDATE transcription_jobs SET original_upload_operation_filename=? WHERE id=?').run('mutated.wav', first.payload.id)).toThrow(/immutable/);
    guardDb.exec('BEGIN IMMEDIATE');
    try {
      expect(() => guardDb.prepare('INSERT INTO transcription_jobs(id,filename,status,created,requested_language,original_upload_receipt,original_upload_origin,original_upload_operation_id,original_upload_operation_filename) SELECT ?,filename,status,created,requested_language,original_upload_receipt,original_upload_origin,original_upload_operation_id,original_upload_operation_filename FROM transcription_jobs WHERE id=?').run(randomUUID(), first.payload.id)).toThrow(/UNIQUE constraint failed/);
    } finally {guardDb.exec('ROLLBACK');}
  } finally {guardDb.close();}
  expect(f.inspect()).toEqual(original);
  const changedBytes = Buffer.from(bytes); changedBytes[changedBytes.length - 1] ^= 1;
  const conflict = await f.request({body: changedBytes, headers: audioHeaders(scope, operationId)});
  expect(conflict.status).toBe(409); expect(conflict.call.pulledBytes).toBe(bytes.length);
  for (const change of [{'x-audio-language': 'en'}, {'x-audio-origin': 'recording-draft'}, {'x-audio-filename': 'changed-name.wav'}]) {
    const mismatch = await f.request({body: bytes, headers: {...audioHeaders(scope, operationId), ...change}}); expect(mismatch.status).toBe(409);
  }
  const wrongScopeGet = await f.request({path: '/api/local-asr/transcribe?operationId=' + operationId, method: 'GET', headers: {'x-transcription-store-id': randomUUID()}});
  expect(wrongScopeGet.status).toBe(409); expect(wrongScopeGet.payload.error.code).toBe('STORE_CHANGED'); expect(wrongScopeGet.payload.id).toBeUndefined();
  expect(f.inspect()).toEqual(original); expect(f.workerCalls()).toHaveLength(1);
  const metaHeaders = {'x-transcription-store-id': scope, 'content-type': 'application/json'};
  const renamed = await f.request({path: `/api/local-asr/jobs/${first.payload.id}/rename`, headers: metaHeaders, body: Buffer.from(JSON.stringify({expectedRevision: 0, title: 'Synthetic renamed library title'}))}); expect(renamed.status).toBe(200);
  const trashed = await f.request({path: `/api/local-asr/jobs/${first.payload.id}/trash`, headers: metaHeaders, body: Buffer.from(JSON.stringify({expectedRevision: 1}))}); expect(trashed.status).toBe(200);
  await f.reopen();
  const found = await f.request({path: '/api/local-asr/transcribe?operationId=' + operationId, method: 'GET', headers: {'x-transcription-store-id': scope}});
  expect(found.status).toBe(200); committed(found.payload, operationId, false, true); expect(found.payload.id).toBe(first.payload.id);
  const replay = await f.request({body: bytes, headers: audioHeaders(scope, operationId)});
  expect(replay.status).toBe(200); committed(replay.payload, operationId, true, true); expect(replay.payload.id).toBe(first.payload.id);
  expect(f.inspect().transcription_jobs).toHaveLength(1); expect(f.workerCalls()).toHaveLength(1);
  const row = f.inspect().transcription_jobs[0]; expect(row.filename).toBe(filename); expect(row.title).toBe('Synthetic renamed library title'); expect(row.deleted_at).toBeTruthy(); expect(row.original_upload_operation_id).toBe(operationId); expect(JSON.parse(row.original_upload_receipt)).toEqual(expectedReceipt);
  const legacy = await f.request({body: bytes, headers: audioHeaders(scope)});
  expect(legacy.status).toBe(202); expect(legacy.payload).toEqual({id: expect.stringMatching(canonicalUuid), status: 'processing'}); await complete(f, 2);
  expect(f.inspect().transcription_jobs.find((row: any) => row.id === legacy.payload.id).original_upload_operation_id).toBeNull();
  expect(f.inspect().transcription_retries).toHaveLength(0); expect(readdirSync(join(f.storage, 'long-asr-temp'))).toEqual([]); f.snapshot('02-guards-and-legacy-final');
  save('guards-result', {result: 'PASS_FIXED_SERVICE', malformedAndDuplicateRejectedBeforeBody: true, storeMismatchRejectedBeforeBody: true, byteMismatchFullyConsumedAndRejected: true, languageOriginFilenameConflictsRejected: true, originalIdentitySurvivesRenameTrashAndReopen: true, trashedReplayCreatesNothing: true, exactLegacy202ShapePreserved: true, immutableOperationAndOriginalFilename: true, duplicateOperationUniqueConstraint: true, jobs: 2, workers: f.workerCalls().length});
});

it('exact GET miss stays nonterminal while the original request body is in flight, then resolves to its one committed job', async () => {
  const f = harness = createHarness('inflight'); const scope = await f.identity(), operationId = randomUUID();
  const started = deferred(), release = deferred();
  const stream = (async function* () {yield bytes.subarray(0, 32); started.resolve(); await release.promise; yield bytes.subarray(32);})();
  const upload = f.request({body: bytes, headers: audioHeaders(scope, operationId), stream});
  try {
    await started.promise; expect(f.inspect().transcription_jobs).toHaveLength(0); expect(f.workerCalls()).toHaveLength(0);
    const miss = await f.request({path: '/api/local-asr/transcribe?operationId=' + operationId, method: 'GET', headers: {'x-transcription-store-id': scope}});
    expect(miss.status).toBe(200); expect(miss.payload).toEqual({operationId, state: 'unconfirmed', reconciliationFinal: false});
    expect(f.inspect().transcription_jobs).toHaveLength(0); expect(f.workerCalls()).toHaveLength(0);
    release.resolve(); const accepted = await upload; expect(accepted.status).toBe(202); committed(accepted.payload, operationId, false); await complete(f, 1);
    const found = await f.request({path: '/api/local-asr/transcribe?operationId=' + operationId, method: 'GET', headers: {'x-transcription-store-id': scope}});
    expect(found.status).toBe(200); committed(found.payload, operationId, false); expect(found.payload.id).toBe(accepted.payload.id);
    expect(f.routes.filter(call => call.method === 'POST')).toHaveLength(1); expect(f.workerCalls()).toHaveLength(1); f.snapshot('01-final');
    save('inflight-result', {result: 'PASS_FIXED_SERVICE', beforeCommit: miss.payload, afterCommit: found.payload, uploadRequests: 1, workers: 1, manuallySeededRows: 0});
  } finally {release.resolve(); await upload;}
});
