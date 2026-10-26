import React from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {LocalResearchSearch} from '../candidate/src/components/LocalResearchSearch';
import {ManualPlanManager} from '../candidate/src/components/ManualPlanManager';
import {ManualPlanHostView} from '../candidate/src/components/ManualPlanHostView';
import {ManualPlanHost} from '../candidate/src/components/manual-plan-host';
import {ManualPlanClient} from '../candidate/src/components/manual-plan-client';
import {ManualPlanSession} from '../candidate/src/components/manual-plan-session';
import {pdfOpenSelectionFromDocument} from '../candidate/src/components/pdf-open-selection';
import type {ManualPlanRecord} from '../candidate/shared/manual-plans';

// Focused frontend workflows with mocked transport DTOs, not actual-service,
// browser/device, PDF-renderer, ASR, AI, or end-to-end integration evidence.
const sourceA = '10000000-0000-4000-8000-000000000001';
const sourceB = '10000000-0000-4000-8000-000000000002';
const documentId = '20000000-0000-4000-8000-000000000001';
const otherId = '20000000-0000-4000-8000-000000000002';
const planScope = '1'.repeat(64);
const shortcut = {kind: 'document' as const, documentStoreId: sourceA, documentId};
const transcriptLink = {kind: 'transcript' as const, transcriptStoreId: sourceA, jobId: otherId};
const sessionLink = {scope: planScope, workspaceId: 'workspace-1', sessionId: 'session-1', workspaceRevision: 3, sessionRevision: 5};
const sourceText = '<script>not executable</script>\n# Plain extracted text';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json', 'X-Transcription-Store-Id': sourceA}});
function document(id = documentId, name = '当前文档甲.pdf') {
  return {id, name, format: 'pdf', createdAt: '2026-10-23T00:00:00Z', trashedAt: null, stale: false, bytes: 100, sha256: 'a'.repeat(64), textSha256: 'b'.repeat(64), pages: 2, revision: 0, workspaceId: null, folderId: null, workspaceName: null, folderName: null};
}
function listing(rows = [document()], offset = 0, total = rows.length, storeScope = sourceA) {
  return {storeScope, documents: rows, total, offset, limit: 10};
}
function sources() {
  let liveSource = sourceA, rows = [document()], currentDocument: Record<string, unknown> = document(), currentText = sourceText;
  let detailSource = sourceA, detailStatus = 200, padding = '', nextListDelay = false, nextDetailDelay = false;
  const delayedLists: Array<(response: Response) => void> = [], delayedDetails: Array<(response: Response) => void> = [];
  const calls: Array<{url: string; init?: RequestInit}> = [];
  const detail = () => json({storeScope: detailSource, document: currentDocument, text: currentText, ...(padding ? {padding} : {})}, detailStatus);
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({url, init});
    if (url === '/api/documents/choices') return json({uploadScope: liveSource, folders: [], workspaces: []});
    if (url.startsWith('/api/documents?')) {
      if (nextListDelay) {nextListDelay = false; return new Promise<Response>(resolve => delayedLists.push(resolve));}
      const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
      return json(listing(rows.slice(offset, offset + 10), offset, rows.length, liveSource));
    }
    if (url.startsWith('/api/documents/')) {
      if (nextDetailDelay) {nextDetailDelay = false; return new Promise<Response>(resolve => delayedDetails.push(resolve));}
      return detail();
    }
    if (url === '/api/local-asr/identity') return json({transcriptionStoreId: sourceA});
    if (url.startsWith('/api/local-asr/jobs?')) return json({jobs: [{id: otherId, title: '独立转写', filename: 'local.wav', status: 'failed', created: '2026-10-23T00:00:00Z', deleted_at: null, result: null}], total: 1, offset: 0, limit: 10, hasMore: false});
    throw Error('Unexpected mocked source route ' + url);
  });
  vi.stubGlobal('fetch', fetcher);
  return {calls, fetcher,
    setSource(value: string) {liveSource = value;}, setRows(value: ReturnType<typeof document>[]) {rows = value;},
    setDocument(value: Record<string, unknown>, text = sourceText) {currentDocument = value; currentText = text;},
    setDetailSource(value: string) {detailSource = value;}, setStatus(value: number) {detailStatus = value;}, oversize() {padding = 'x'.repeat(2 * 1024 * 1024);},
    delayList() {nextListDelay = true;}, delayDetail() {nextDetailDelay = true;},
    get delayedListCount() {return delayedLists.length;}, get delayedDetailCount() {return delayedDetails.length;},
    resolveList(value = listing()) {delayedLists.shift()!(json(value));}, resolveDetail(value?: unknown) {delayedDetails.shift()!(value === undefined ? detail() : json(value));},
    detailCalls() {return calls.filter(x => x.url.startsWith('/api/documents/') && x.url !== '/api/documents/choices');}
  };
}
function record(id = 'plan-a', documentLink: typeof shortcut | null = null): ManualPlanRecord {
  return {id, kind: 'manual-research-plan', storeScope: planScope, revision: 1, createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z', deletedAt: null, data: {schemaVersion: 1, provenance: 'user-authored-local', state: 'draft', title: id, objective: 'Private plan objective', notes: 'Private plan notes', targetDate: null, sessionLink: {...sessionLink}, materialLink: {...transcriptLink}, documentLink}};
}
function plans(initial = record()) {
  let current = initial, serial = 0, delayWrite = false, dropWrite = false;
  let release: (() => void) | null = null;
  const calls: Array<{operation: string; input: any}> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const operation = String(input).split('/').at(-1)!, payload = JSON.parse(String(init?.body ?? '{}')); calls.push({operation, input: payload});
    if (operation === 'list') return json({items: [current, record('plan-b')], total: 2, offset: 0, nextOffset: null});
    if (operation === 'get') return json(payload.id === current.id ? current : record('plan-b'));
    if (operation === 'setDocumentLink') {
      current = {...current, revision: current.revision + 1, data: {...current.data, documentLink: payload.documentLink}};
      if (dropWrite) {dropWrite = false; throw Error('Mocked lost write response');}
      if (delayWrite) {delayWrite = false; return new Promise<Response>(resolve => {release = () => resolve(json(current));});}
      return json(current);
    }
    throw Error('Unexpected mocked plan operation ' + operation);
  });
  const session = new ManualPlanSession(new ManualPlanClient(fetcher), () => `40000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`);
  return {session, calls, fetcher, get current() {return current;}, delayWrite() {delayWrite = true;}, dropWrite() {dropWrite = true;}, releaseWrite() {release!();}, writes() {return calls.filter(x => x.operation === 'setDocumentLink');}};
}
const hosts: ManualPlanHost[] = [];
afterEach(() => {cleanup(); for (const host of hosts.splice(0)) host.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
async function manager(f: ReturnType<typeof plans>, confirm: (message: string) => boolean = vi.fn(() => true), open = vi.fn()) {
  const view = render(<ManualPlanManager session={f.session} onClose={() => {}} confirmLeave={confirm} onOpenPdf={open}/>);
  fireEvent.click(await screen.findByRole('button', {name: 'plan-a'}));
  fireEvent.click(await screen.findByRole('button', {name: '管理单份文档快捷入口'}));
  await screen.findByRole('region', {name: '计划文档快捷入口'});
  return {view, confirm, open};
}
async function expandSearch() {
  fireEvent.click(screen.getByRole('button', {name: '为此计划查找本地资料'}));
  return screen.findByRole('button', {name: '保存此文档快捷入口：当前文档甲.pdf'});
}
// Capture the real React callback as well as exercising connected DOM clicks.
function handler(button: HTMLElement): () => void {
  const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!;
  return (button as unknown as Record<string, {onClick: () => void}>)[key].onClick;
}
const savedOpen = () => screen.getByRole('button', {name: '打开已保存的当前 PDF'});
function expectNoEnabledPdfOpen() {
  const button = screen.queryByRole('button', {name: '打开已保存的当前 PDF'});
  if (button) {expect(button).toHaveProperty('disabled', true); fireEvent.click(button);}
}
const retry = () => screen.getByRole('button', {name: '重新核验文档快捷入口'});
async function ready() {if(!screen.queryByRole('region',{name:'计划文档快捷入口'}))fireEvent.click(await screen.findByRole('button',{name:'管理单份文档快捷入口'}));return screen.findByText(sourceText, {exact: true, normalizer: text => text});}

describe('mocked DTOs: explicit accepted document-result saves', () => {
  it('generic search has no save control; an opted-in row emits only its source and ID on click', async () => {
    const src = sources(); render(<LocalResearchSearch/>);
    await screen.findByRole('button', {name: '当前文档甲.pdf'});
    expect(screen.queryByRole('button', {name: /保存此文档快捷入口/})).toBeNull();
    cleanup(); const save = vi.fn(); render(<LocalResearchSearch onSaveDocumentShortcut={save}/>);
    const button = await screen.findByRole('button', {name: '保存此文档快捷入口：当前文档甲.pdf'});
    expect(save).not.toHaveBeenCalled(); fireEvent.click(button); expect(save.mock.calls).toEqual([[shortcut]]);
    expect(src.calls.every(({init}) => !init?.method || init.method === 'GET')).toBe(true);
  });
  it.each(['转写', '重新载入文档来源', '搜索文档'])('withdraws a connected row synchronously on %s before a stale save', async action => {
    sources(); const save = vi.fn(); render(<LocalResearchSearch onSaveDocumentShortcut={save}/>);
    const button = await screen.findByRole('button', {name: '保存此文档快捷入口：当前文档甲.pdf'});
    act(() => {screen.getByRole('button', {name: action}).click(); expect(button.isConnected).toBe(true); button.click();});
    expect(save).not.toHaveBeenCalled();
  });
  it('pagination revokes the prior row callback and only accepts the current page', async () => {
    const src = sources(); src.setRows(Array.from({length: 11}, (_,i) => document(`30000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `文档 ${i}`)));
    const save = vi.fn(); render(<LocalResearchSearch onSaveDocumentShortcut={save}/>);
    const old = handler(await screen.findByRole('button', {name: '保存此文档快捷入口：文档 0'}));
    act(() => {screen.getByRole('button', {name: '下一页'}).click(); old();}); expect(save).not.toHaveBeenCalled();
    const fresh = await screen.findByRole('button', {name: '保存此文档快捷入口：文档 10'});
    act(() => old()); expect(save).not.toHaveBeenCalled(); fireEvent.click(fresh);
    expect(save.mock.calls).toEqual([[{...shortcut, documentId: '30000000-0000-4000-8000-000000000010'}]]);
  });
  it('a late superseded result cannot replace the current row or become a save candidate', async () => {
    const src = sources(); src.delayList(); const save = vi.fn(); render(<LocalResearchSearch onSaveDocumentShortcut={save}/>);
    await waitFor(() => expect(src.delayedListCount).toBe(1));
    src.setRows([document(otherId, '最新文档乙.pdf')]); fireEvent.click(screen.getByRole('button', {name: '搜索文档'}));
    const fresh = await screen.findByRole('button', {name: '保存此文档快捷入口：最新文档乙.pdf'});
    await act(async () => src.resolveList()); expect(screen.queryByRole('button', {name: '保存此文档快捷入口：当前文档甲.pdf'})).toBeNull();
    fireEvent.click(fresh); expect(save.mock.calls).toEqual([[{...shortcut, documentId: otherId}]]);
  });
  it('changed source blocks old rows until explicit reload, without reusing the old callback', async () => {
    const src = sources(), save = vi.fn(); render(<LocalResearchSearch onSaveDocumentShortcut={save}/>);
    const old = handler(await screen.findByRole('button', {name: '保存此文档快捷入口：当前文档甲.pdf'}));
    src.setSource(sourceB); fireEvent.click(screen.getByRole('button', {name: '搜索文档'})); await screen.findByText(/文档来源已变化/);
    act(() => old()); expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: '重新载入文档来源'}));
    fireEvent.click(await screen.findByRole('button', {name: '保存此文档快捷入口：当前文档甲.pdf'}));
    expect(save.mock.calls).toEqual([[{...shortcut, documentStoreId: sourceB}]]);
  });
});

describe('mocked DTOs: plan-owned independent document writes', () => {
  it('saves once with scope and revision, rereads, and preserves transcript/session links', async () => {
    const src = sources(), f = plans(); await manager(f); const button = await expandSearch();
    f.delayWrite(); act(() => {button.click(); button.click();}); expect(f.writes()).toHaveLength(1);
    expect(f.session.pending?.phase).toBe('sending'); expect(screen.queryByRole('button', {name: /保存此文档快捷入口/})).toBeNull();
    await act(async () => f.releaseWrite()); await waitFor(() => expect(f.session.editor?.record?.revision).toBe(2));
    expect(f.writes()[0].input).toEqual({idempotencyKey: '40000000-0000-4000-8000-000000000001', id: 'plan-a', expectedRevision: 1, scope: planScope, documentLink: shortcut});
    expect(f.calls.some(x => x.operation === 'get' && x.input.scope === planScope)).toBe(true);
    expect(f.session.editor?.record?.data.materialLink).toEqual(transcriptLink); expect(f.session.editor?.record?.data.sessionLink).toEqual(sessionLink);
    await ready(); expect(JSON.stringify(src.calls)).not.toMatch(/Private plan objective|Private plan notes|plan-a/);
  });
  it('dirty editor and a same-batch dirty change both reject saves without losing draft text', async () => {
    sources(); const f = plans(); await manager(f); const button = await expandSearch();
    act(() => {f.session.edit('notes', 'Uncommitted draft'); expect(button.isConnected).toBe(true); button.click();});
    expect(f.writes()).toHaveLength(0); expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button); expect(f.writes()).toHaveLength(0); expect(f.session.editor?.draft.notes).toBe('Uncommitted draft');
    expect(f.session.editor?.record?.data.documentLink).toBeNull(); expect(f.session.editor?.record?.data.materialLink).toEqual(transcriptLink);
  });
  it.each(['completed', 'cancelled', 'missing-scope'] as const)('%s plans expose no enabled save', async condition => {
    sources(); const initial = record(); if (condition === 'missing-scope') delete initial.storeScope; else initial.data.state = condition;
    const f = plans(initial); await manager(f); const button = await expandSearch();
    expect(button).toHaveProperty('disabled', true); fireEvent.click(button); expect(f.writes()).toHaveLength(0);
  });
  it('switching plans rejects an old connected save handler before the next render', async () => {
    sources(); const f = plans(); await manager(f); const button = await expandSearch();
    act(() => {screen.getByRole('button', {name: 'plan-b'}).click(); expect(button.isConnected).toBe(true); button.click();});
    await waitFor(() => expect(f.session.editor?.record?.id).toBe('plan-b')); expect(f.writes()).toHaveLength(0);
  });
  it('replacement cancellation preserves the old pointer; confirmation replaces only the document slot', async () => {
    const src = sources(); src.setRows([document(otherId, '替代文档乙.pdf')]);
    const f = plans(record('plan-a', shortcut)), confirm = vi.fn((_message: string) => false); await manager(f, confirm); await ready();
    fireEvent.click(screen.getByRole('button', {name: '为此计划查找本地资料'}));
    const replace = await screen.findByRole('button', {name: '保存此文档快捷入口：替代文档乙.pdf'});
    fireEvent.click(replace); expect(confirm).toHaveBeenCalledOnce(); expect(confirm.mock.calls[0][0]).toMatch(/替换.*文档快捷入口/);
    expect(f.writes()).toHaveLength(0); expect(f.session.editor?.record?.data.documentLink).toEqual(shortcut);
    confirm.mockReturnValue(true); src.setDocument(document(otherId, '替代文档乙.pdf')); fireEvent.click(replace);
    await waitFor(() => expect(f.session.editor?.record?.data.documentLink).toEqual({...shortcut, documentId: otherId}));
    expect(f.writes()).toHaveLength(1); expect(f.session.editor?.record?.data.materialLink).toEqual(transcriptLink);
    expect(f.session.editor?.record?.data.sessionLink).toEqual(sessionLink);
  });
  it('unsaved plans expose neither saved document controls nor plan-result save actions', async () => {
    sources(); const f = plans(); await manager(f); fireEvent.click(screen.getByRole('button', {name: '新建手动计划'}));
    expect(screen.queryByRole('region', {name: '计划文档快捷入口'})).toBeNull();
    expect(screen.queryByRole('button', {name: '为此计划查找本地资料'})).toBeNull(); expect(f.writes()).toHaveLength(0);
  });
  it('an uncertain response keeps the exact document command and suppresses alternative writes', async () => {
    sources(); const f = plans(); await manager(f); const button = await expandSearch(); f.dropWrite(); fireEvent.click(button);
    await waitFor(() => expect(f.session.pending?.phase).toBe('uncertain')); expect(f.writes()).toHaveLength(1);
    expect(JSON.parse(f.session.pending!.command.body).documentLink).toEqual(shortcut);
    expect(screen.queryByRole('button', {name: /保存此文档快捷入口/})).toBeNull();
    expect(screen.getByRole('button', {name: '为此计划查找本地资料'})).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', {name: '重试原操作'})).toBeTruthy();
  });
});

describe('mocked DTOs: saved document fresh verification and lifecycle', () => {
  it('rediscovers original source, reads exact detail, previews plain text, and forwards a fresh PDF tuple only', async () => {
    const src = sources(), f = plans(record('plan-a', shortcut)), open = vi.fn(); await manager(f, vi.fn(() => true), open); await ready();
    const documentCalls = src.calls.filter(x => x.url.startsWith('/api/documents'));
    expect(documentCalls.map(x => x.url)).toEqual(['/api/documents/choices', `/api/documents/${documentId}`]);
    expect(new Headers(documentCalls[1].init?.headers).get('X-Citation-Store-Id')).toBe(sourceA);
    expect(window.document.querySelector('script')).toBeNull(); expect(open).not.toHaveBeenCalled();
    fireEvent.click(savedOpen()); expect(open.mock.calls).toEqual([[pdfOpenSelectionFromDocument(document(), sourceA)]]);
    expect(Object.isFrozen(open.mock.calls[0][0])).toBe(true); expect(f.writes()).toHaveLength(0);
    const revised = {...document(), name: '当前已重命名.pdf', revision: 7, workspaceId: 'moved-workspace', folderId: otherId};
    src.setDocument(revised, 'New current text'); fireEvent.click(retry()); await screen.findByText('New current text');
    fireEvent.click(savedOpen()); expect(open.mock.calls[1]).toEqual([pdfOpenSelectionFromDocument(revised, sourceA)]);
    expect(f.session.editor?.record?.data.documentLink).toEqual(shortcut); expect(f.writes()).toHaveLength(0);
  });
  it.each(['txt', 'md'])('%s provides only non-executable extracted text, never a fabricated PDF selection', async format => {
    const src = sources(); src.setDocument({...document(), format, pages: null}); const f = plans(record('plan-a', shortcut)), open = vi.fn();
    await manager(f, vi.fn(() => true), open); await ready(); expect(window.document.querySelector('script')).toBeNull();
    const button = screen.queryByRole('button', {name: '打开已保存的当前 PDF'}); if (button) {expect(button).toHaveProperty('disabled', true); fireEvent.click(button);}
    expect(open).not.toHaveBeenCalled(); expect(f.writes()).toHaveLength(0);
  });
  it('a changed discovery source blocks exact detail reads and remains unavailable on retry', async () => {
    const src = sources(); src.setSource(sourceB); const f = plans(record('plan-a', shortcut)), open = vi.fn(); await manager(f, vi.fn(() => true), open);
    await screen.findByText(/已保存的文档快捷入口当前不可用/); expect(src.detailCalls()).toHaveLength(0);
    expectNoEnabledPdfOpen(); expect(open).not.toHaveBeenCalled();
    fireEvent.click(retry()); await waitFor(() => expect(src.calls.filter(x => x.url === '/api/documents/choices')).toHaveLength(2));
    expect(src.detailCalls()).toHaveLength(0); expect(f.session.editor?.record?.data.documentLink).toEqual(shortcut);
  });
  it.each(['wrong-source', 'wrong-id', 'trashed', 'stale', 'invalid-revision', 'missing', 'inaccessible'] as const)('%s detail stays unavailable without rebinding or writes', async condition => {
    const src = sources();
    if (condition === 'wrong-source') src.setDetailSource(sourceB);
    else if (condition === 'missing' || condition === 'inaccessible') src.setStatus(condition === 'missing' ? 404 : 403);
    else src.setDocument({...document(), ...(condition === 'wrong-id' ? {id: otherId} : condition === 'trashed' ? {trashedAt: '2026-10-23T00:00:00Z'} : condition === 'stale' ? {stale: true} : {revision: -1})});
    const f = plans(record('plan-a', shortcut)), open = vi.fn(); await manager(f, vi.fn(() => true), open);
    await screen.findByText(/已保存的文档快捷入口当前不可用/); expectNoEnabledPdfOpen();
    expect(open).not.toHaveBeenCalled(); expect(screen.queryByText(sourceText, {normalizer: text => text})).toBeNull();
    expect(f.session.editor?.record?.data.documentLink).toEqual(shortcut); expect(f.writes()).toHaveLength(0);
  });
  it('retry revokes an old open synchronously and a timed-out response cannot publish after a newer successful retry', async () => {
    const src = sources(), f = plans(record('plan-a', shortcut)), open = vi.fn(); await manager(f, vi.fn(() => true), open); await ready();
    const oldOpen = handler(savedOpen()); src.delayDetail(); vi.useFakeTimers();
    await act(async () => {retry().click(); oldOpen();}); expect(open).not.toHaveBeenCalled(); expect(src.delayedDetailCount).toBe(1);
    await act(async () => {await vi.advanceTimersByTimeAsync(15001);}); vi.useRealTimers();
    await screen.findByText(/已保存的文档快捷入口当前不可用/); expectNoEnabledPdfOpen();
    src.setDocument({...document(), revision: 9}, 'Latest after timeout'); fireEvent.click(retry()); await screen.findByText('Latest after timeout');
    await act(async () => src.resolveDetail({storeScope: sourceA, document: document(), text: 'Late obsolete text'}));
    expect(screen.queryByText('Late obsolete text')).toBeNull(); act(() => oldOpen()); expect(open).not.toHaveBeenCalled();
    fireEvent.click(savedOpen()); expect(open.mock.calls).toEqual([[pdfOpenSelectionFromDocument({...document(), revision: 9}, sourceA)]]);
  });
  it('rejects a detail body exceeding 2 MiB without accepting its otherwise valid PDF metadata', async () => {
    const src = sources(); src.oversize(); const f = plans(record('plan-a', shortcut)), open = vi.fn(); await manager(f, vi.fn(() => true), open);
    await screen.findByText(/已保存的文档快捷入口当前不可用/); expectNoEnabledPdfOpen(); expect(open).not.toHaveBeenCalled();
    expect(f.session.editor?.record?.data.documentLink).toEqual(shortcut); expect(f.writes()).toHaveLength(0);
  });
  it('late detail cannot publish after record replacement', async () => {
    const src = sources(); src.delayDetail(); const f = plans(record('plan-a', shortcut)); await manager(f);
    await waitFor(() => expect(src.delayedDetailCount).toBe(1)); fireEvent.click(screen.getByRole('button', {name: 'plan-b'}));
    await waitFor(() => expect(f.session.editor?.record?.id).toBe('plan-b')); await act(async () => src.resolveDetail());
    expect(screen.queryByText(sourceText, {normalizer: text => text})).toBeNull(); expect(screen.queryByRole('button', {name: '打开已保存的当前 PDF'})).toBeNull();
  });
  it('plan detail refresh immediately fences the old open even when the same plan ID returns', async () => {
    const src = sources(), f = plans(record('plan-a', shortcut)), open = vi.fn(); await manager(f, vi.fn(() => true), open); await ready();
    const oldOpen = handler(savedOpen()); src.setDocument({...document(), revision: 6}, 'Fresh after plan detail refresh');
    act(() => {screen.getByRole('button', {name: '读取当前版本并保留草稿'}).click(); oldOpen();}); expect(open).not.toHaveBeenCalled();
    await waitFor(()=>expect(f.session.detailLoading).toBe(false));fireEvent.click(screen.getByRole('button',{name:'管理单份文档快捷入口'}));
    await screen.findByText('Fresh after plan detail refresh'); act(() => oldOpen()); expect(open).not.toHaveBeenCalled();
    fireEvent.click(savedOpen()); expect(open.mock.calls).toEqual([[pdfOpenSelectionFromDocument({...document(), revision: 6}, sourceA)]]);
  });
  it('pending mutation immediately withdraws the accepted open and cannot be restored by its old callback', async () => {
    sources(); const f = plans(record('plan-a', shortcut)), open = vi.fn(); await manager(f, vi.fn(() => true), open); await ready(); const oldOpen = handler(savedOpen());
    f.delayWrite(); act(() => {void f.session.mutate('setDocumentLink', undefined, {scope: planScope, documentLink: null}); oldOpen();});
    expect(open).not.toHaveBeenCalled(); expect(f.session.pending?.phase).toBe('sending');
    await act(async () => f.releaseWrite()); await waitFor(() => expect(f.session.editor?.record?.data.documentLink).toBeNull());
    act(() => oldOpen()); expect(open).not.toHaveBeenCalled();
  });
  it('close/unmount withdraws callbacks and remount rechecks rather than reusing old accepted metadata', async () => {
    const src = sources(), f = plans(record('plan-a', shortcut)), open = vi.fn(); const {view} = await manager(f, vi.fn(() => true), open); await ready();
    const oldOpen = handler(savedOpen()); src.delayDetail(); fireEvent.click(retry()); await waitFor(() => expect(src.delayedDetailCount).toBe(1)); view.unmount();
    act(() => oldOpen()); expect(open).not.toHaveBeenCalled(); await act(async () => src.resolveDetail());
    src.setDocument({...document(), revision: 4}, 'Fresh after reopening');
    render(<ManualPlanManager session={f.session} onClose={() => {}} confirmLeave={() => true} onOpenPdf={open}/>);
    fireEvent.click(await screen.findByRole('button',{name:'管理单份文档快捷入口'}));
    await screen.findByText('Fresh after reopening'); act(() => oldOpen()); expect(open).not.toHaveBeenCalled();
    fireEvent.click(savedOpen()); expect(open.mock.calls).toEqual([[pdfOpenSelectionFromDocument({...document(), revision: 4}, sourceA)]]);
  });
  it('replacing the owning session fences its delayed document lookup', async () => {
    const src = sources(); src.delayDetail(); const f = plans(record('plan-a', shortcut)), next = plans(record()), open = vi.fn(); const {view} = await manager(f, vi.fn(() => true), open);
    await waitFor(() => expect(src.delayedDetailCount).toBe(1));
    view.rerender(<ManualPlanManager session={next.session} onClose={() => {}} confirmLeave={() => true} onOpenPdf={open}/>);
    fireEvent.click(await screen.findByRole('button', {name: 'plan-a'})); await waitFor(() => expect(next.session.editor?.record?.id).toBe('plan-a'));
    await act(async () => src.resolveDetail()); expect(screen.queryByText(sourceText, {normalizer: text => text})).toBeNull(); expect(open).not.toHaveBeenCalled();
  });
  it('forced same-scope host replacement rejects a saved PDF callback before React cleanup', async () => {
    sources(); const f = plans(record('plan-a', shortcut)), open = vi.fn(), authority = 'a'.repeat(64);
    const host = new ManualPlanHost(f.fetcher); hosts.push(host); host.activate(); host.setAuthority(authority, true);
    render(<ManualPlanHostView host={host} onClose={() => {}} onOpenPdf={open}/>);
    fireEvent.click(await screen.findByRole('button', {name: 'plan-a'})); await ready();
    const originalSession = host.session, button = savedOpen(), oldOpen = handler(button);
    act(() => {host.setAuthority(authority, true); expect(host.session).not.toBe(originalSession); expect(button.isConnected).toBe(true); oldOpen();});
    expect(open).not.toHaveBeenCalled();
    act(() => oldOpen()); expect(open).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', {name: 'plan-a'})); await ready();
    fireEvent.click(savedOpen()); expect(open.mock.calls).toEqual([[pdfOpenSelectionFromDocument(document(), sourceA)]]);
  });
  it('cancelled clear is a no-op; confirmed clear only removes the document slot and uses scoped revision readback', async () => {
    const src = sources(), f = plans(record('plan-a', shortcut)), confirm = vi.fn((_message: string) => false); await manager(f, confirm); await ready();
    fireEvent.click(screen.getByRole('button', {name: '清除文档快捷入口'})); expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0]).toMatch(/文档快捷入口/); expect(confirm.mock.calls[0][0]).toMatch(/不会删除/); expect(f.writes()).toHaveLength(0);
    confirm.mockReturnValue(true); fireEvent.click(screen.getByRole('button', {name: '清除文档快捷入口'}));
    await waitFor(() => expect(f.session.editor?.record?.data.documentLink).toBeNull());
    expect(f.writes()[0].input).toEqual({idempotencyKey: '40000000-0000-4000-8000-000000000001', id: 'plan-a', expectedRevision: 1, scope: planScope, documentLink: null});
    expect(f.session.editor?.record?.data.materialLink).toEqual(transcriptLink); expect(f.session.editor?.record?.data.sessionLink).toEqual(sessionLink);
    expect(f.calls.some(x => x.operation === 'get' && x.input.scope === planScope)).toBe(true);
    expect(src.calls.every(({init}) => !init?.method || init.method === 'GET')).toBe(true);
  });
  it('a confirmation-time draft edit prevents clearing the prior clean record', async () => {
    sources(); const f = plans(record('plan-a', shortcut)), confirm = vi.fn(() => {f.session.edit('notes', 'Changed during confirmation'); return true;});
    await manager(f, confirm); await ready(); fireEvent.click(screen.getByRole('button', {name: '清除文档快捷入口'}));
    expect(confirm).toHaveBeenCalledOnce(); expect(f.writes()).toHaveLength(0); expect(f.session.editor?.record?.data.documentLink).toEqual(shortcut);
    expect(f.session.editor?.draft.notes).toBe('Changed during confirmation');
  });
});
