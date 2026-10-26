import React from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {LocalResearchSearch} from '../candidate/src/components/LocalResearchSearch';
import {ManualPlanManager} from '../candidate/src/components/ManualPlanManager';
import {ManualPlanClient} from '../candidate/src/components/manual-plan-client';
import {ManualPlanSession} from '../candidate/src/components/manual-plan-session';
import {ManualPlanHost} from '../candidate/src/components/manual-plan-host';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import type {ManualPlanRecord} from '../candidate/shared/manual-plans';

// These tests exercise real frontend ownership and navigation with synthetic HTTP DTOs.
// They do not establish live backend, REA, browser/device, ASR, or AI integration.
vi.mock('../candidate/src/components/ServiceReportsEntry', () => ({ServiceReportsEntry: () => null}));
vi.mock('../candidate/src/components/PdfPageReader', () => ({PdfPageReader: () => null}));
const sourceA = '10000000-0000-4000-8000-000000000001';
const sourceB = '10000000-0000-4000-8000-000000000002';
const jobId = '20000000-0000-4000-8000-000000000001';
const otherJobId = '20000000-0000-4000-8000-000000000002';
const planScope = '1'.repeat(64);
const shortcut = {kind: 'transcript' as const, transcriptStoreId: sourceA, jobId};
const sessionLink = {scope: planScope, workspaceId: 'workspace-1', sessionId: 'session-1', workspaceRevision: 3, sessionRevision: 5};
const json = (value: unknown, scope = sourceA) => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json', 'X-Transcription-Store-Id': scope}});
const job = (id = jobId, title = '当前转写甲') => ({id, title, filename: 'local.wav', status: 'failed', created: '2026-10-23T00:00:00Z', deleted_at: null, result: null, error: 'synthetic failure', workspace_id: null, session_id: null});
function page(rows = [job()], offset = 0, total = rows.length) {
  return {jobs: rows, total, offset, limit: 10, hasMore: offset + rows.length < total, activeJobCount: 0, model: {maxSeconds: 7200, maxBytes: 268435456, chunkSeconds: 30, overlapSeconds: 1, deadlineSeconds: 14400}};
}
function sources() {
  let liveSource = sourceA, rows = [job()], nextDelay = false;
  let release: ((response: Response) => void) | null = null;
  const calls: Array<{url: string; init?: RequestInit}> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({url, init});
    if (url === '/api/local-asr/identity') return json({transcriptionStoreId: liveSource}, liveSource);
    if (url === '/api/documents/choices') return json({uploadScope: sourceA, folders: [], workspaces: []});
    if (url.startsWith('/api/documents?')) return json({storeScope: sourceA, documents: [], total: 0, offset: 0, limit: 10});
    if (url === '/api/local-asr/choices') return json({workspaces: [], sessions: []}, liveSource);
    if (url.startsWith('/api/local-asr/jobs?')) {
      if (nextDelay) { nextDelay = false; return new Promise<Response>(resolve => {release = resolve;}); }
      return json(page(rows), liveSource);
    }
    throw Error('Unexpected synthetic source route ' + url);
  });
  vi.stubGlobal('fetch', fetcher);
  return {calls, fetcher, setSource(value: string) {liveSource = value;}, setRows(value: ReturnType<typeof job>[]) {rows = value;}, delay() {nextDelay = true;}, get delayed() {return !!release;}, resolve(value = page(), scope = sourceA) {const finish = release!; release = null; finish(json(value, scope));}};
}
function record(id = 'plan-a', materialLink: typeof shortcut | null = null): ManualPlanRecord {
  return {id, kind: 'manual-research-plan', storeScope: planScope, revision: 1, createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z', deletedAt: null, data: {schemaVersion: 1, provenance: 'user-authored-local', state: 'draft', title: id, objective: 'Private plan objective', notes: 'Private plan notes', targetDate: null, sessionLink: {...sessionLink}, materialLink}};
}
function plans(initial = record()) {
  let current = initial, serial = 0, delayWrite = false, dropWrite = false;
  let release: (() => void) | null = null;
  const calls: Array<{operation: string; input: any}> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const operation = String(input).split('/').at(-1)!, payload = JSON.parse(String(init?.body ?? '{}')); calls.push({operation, input: payload});
    if (operation === 'list') return json({items: [current, record('plan-b')], total: 2, offset: 0, nextOffset: null});
    if (operation === 'get') return json(payload.id === current.id ? current : record('plan-b'));
    if (operation === 'setMaterialLink') {
      current = {...current, revision: current.revision + 1, data: {...current.data, materialLink: payload.materialLink}};
      if (dropWrite) {dropWrite = false; throw Error('Synthetic lost write response');}
      if (delayWrite) {delayWrite = false; return new Promise<Response>(resolve => {release = () => resolve(json(current));});}
      return json(current);
    }
    throw Error('Unexpected synthetic plan operation ' + operation);
  });
  const session = new ManualPlanSession(new ManualPlanClient(fetcher), () => `shortcut-${++serial}`);
  return {session, fetcher, calls, get current() {return current;}, delayWrite() {delayWrite = true;}, dropWrite() {dropWrite = true;}, releaseWrite() {release!();}, writes() {return calls.filter(x => x.operation === 'setMaterialLink');}};
}
const hosts: ManualPlanHost[] = [];
afterEach(() => {cleanup(); for (const host of hosts.splice(0)) host.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, '', '/');});
async function search(save?: (link: typeof shortcut) => void) {
  render(<LocalResearchSearch onSaveTranscriptShortcut={save}/>);
  fireEvent.click(screen.getByRole('button', {name: '转写', exact: true}));
  await screen.findByRole('heading', {name: '当前转写甲'});
}
async function manager(f: ReturnType<typeof plans>, confirm = vi.fn(() => true), navigate = vi.fn()) {
  render(<ManualPlanManager session={f.session} onClose={() => {}} confirmLeave={confirm} onNavigateMaterial={navigate}/>);
  fireEvent.click(await screen.findByRole('button', {name: 'plan-a', exact: true}));
  fireEvent.click(await screen.findByRole('button', {name: '管理单份转写快捷入口'}));
  await screen.findByRole('region', {name: '计划转写快捷入口'});
  return {confirm, navigate};
}
async function expandSearch() {
  fireEvent.click(screen.getByRole('button', {name: '为此计划查找本地资料'}));
  fireEvent.click(screen.getByRole('button', {name: '转写', exact: true}));
  return await screen.findByRole('button', {name: '保存此转写快捷入口：当前转写甲'});
}

describe('explicit accepted search-row action', () => {
  it('generic research has no save control, and an opted-in row emits only the selected pointer after a click', async () => {
    const src = sources(); await search();
    expect(screen.queryByRole('button', {name: /保存此转写快捷入口/})).toBeNull();
    cleanup(); const save = vi.fn(); await search(save);
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: '保存此转写快捷入口：当前转写甲'}));
    expect(save.mock.calls).toEqual([[shortcut]]);
    expect(src.calls.every(({init}) => !init?.method || init.method === 'GET')).toBe(true);
  });
  it.each(['文档', '刷新转写结果', '重新载入转写来源', '搜索转写'])('withdraws a visible row synchronously before a same-batch stale save after %s', async action => {
    sources(); const save = vi.fn(); await search(save);
    const rowButton = screen.getByRole('button', {name: '保存此转写快捷入口：当前转写甲'});
    const invalidate = screen.getByRole('button', {name: action, exact: true});
    act(() => {invalidate.click(); expect(rowButton.isConnected).toBe(true); rowButton.click();});
    expect(save).not.toHaveBeenCalled();
  });
  it('a superseded delayed result never publishes or produces a save candidate', async () => {
    const src = sources(); src.delay(); const save = vi.fn();
    render(<LocalResearchSearch onSaveTranscriptShortcut={save}/>);
    fireEvent.click(screen.getByRole('button', {name: '转写', exact: true}));
    await waitFor(() => expect(src.delayed).toBe(true));
    src.setRows([job(otherJobId, '最新转写乙')]);
    fireEvent.click(screen.getByRole('button', {name: '刷新转写结果'}));
    await screen.findByRole('button', {name: '保存此转写快捷入口：最新转写乙'});
    await act(async () => src.resolve());
    expect(screen.queryByRole('button', {name: '保存此转写快捷入口：当前转写甲'})).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: '保存此转写快捷入口：最新转写乙'}));
    expect(save.mock.calls).toEqual([[{...shortcut, jobId: otherJobId}]]);
  });
  it('source change blocks old rows, and only explicit reload admits a pointer from the replacement source', async () => {
    const src = sources(); const save = vi.fn(); await search(save);
    src.setSource(sourceB); fireEvent.click(screen.getByRole('button', {name: '刷新转写结果'}));
    await screen.findByText(/已停止此页请求/);
    expect(screen.queryByRole('button', {name: /保存此转写快捷入口/})).toBeNull();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: '重新载入转写来源'}));
    fireEvent.click(await screen.findByRole('button', {name: '保存此转写快捷入口：当前转写甲'}));
    expect(save.mock.calls).toEqual([[{...shortcut, transcriptStoreId: sourceB}]]);
  });
});

describe('plan-owned write controls and current-record fencing', () => {
  it('saves once with exact scope/revision, rereads the plan, and preserves its independent session link', async () => {
    const src = sources(), f = plans(); await manager(f); const button = await expandSearch();
    expect(f.writes()).toHaveLength(0);
    f.delayWrite(); act(() => {button.click(); button.click();});
    expect(f.writes()).toHaveLength(1);
    expect(f.session.pending?.phase).toBe('sending');
    expect(screen.queryByRole('button', {name: /保存此转写快捷入口/})).toBeNull();
    await act(async () => f.releaseWrite());
    await waitFor(() => expect(f.session.editor?.record?.revision).toBe(2));
    expect(f.writes()[0].input).toEqual({idempotencyKey: 'shortcut-1', id: 'plan-a', expectedRevision: 1, scope: planScope, materialLink: shortcut});
    expect(f.calls.some(x => x.operation === 'get' && x.input.scope === planScope)).toBe(true);
    expect(f.session.editor?.record?.data.sessionLink).toEqual(sessionLink);
    fireEvent.click(screen.getByRole('button',{name:'管理单份转写快捷入口'}));
    await screen.findByText(/当前转写：当前转写甲 · 转写失败/);
    expect(JSON.stringify(src.calls)).not.toMatch(/Private plan objective|Private plan notes|plan-a/);
  });
  it('dirty drafts disable save without silently editing the draft or saved link', async () => {
    sources(); const f = plans(); await manager(f); const button = await expandSearch();
    fireEvent.change(screen.getByLabelText('备注'), {target: {value: 'Uncommitted draft'}});
    expect((button as HTMLButtonElement).disabled).toBe(true); fireEvent.click(button);
    expect(f.writes()).toHaveLength(0); expect(f.session.editor?.draft.notes).toBe('Uncommitted draft');
    expect(f.session.editor?.record?.data.materialLink).toBeNull();
  });
  it('an editor made dirty before React rerenders rejects an old enabled save handler', async () => {
    sources(); const f = plans(); await manager(f); const button = await expandSearch();
    act(() => {f.session.edit('notes', 'Same-batch draft'); expect(button.isConnected).toBe(true); button.click();});
    expect(f.writes()).toHaveLength(0); expect(f.session.editor?.dirty).toBe(true);
  });
  it.each(['completed', 'cancelled', 'missing-scope'] as const)('%s plans expose no enabled shortcut save', async condition => {
    sources(); const initial = record(); if (condition === 'missing-scope') delete initial.storeScope; else initial.data.state = condition;
    const f = plans(initial); await manager(f); const button = await expandSearch();
    expect((button as HTMLButtonElement).disabled).toBe(true); fireEvent.click(button); expect(f.writes()).toHaveLength(0);
  });
  it('unsaved plans have no shortcut controls or persisted material context', async () => {
    sources(); const f = plans(); await manager(f); fireEvent.click(screen.getByRole('button', {name: '新建手动计划'}));
    expect(screen.queryByRole('region', {name: '计划转写快捷入口'})).toBeNull();
    expect(screen.queryByRole('button', {name: '为此计划查找本地资料'})).toBeNull(); expect(f.writes()).toHaveLength(0);
  });
  it('switching the current plan rejects a still-connected old save before rerender', async () => {
    sources(); const f = plans(); await manager(f); const button = await expandSearch();
    const next = screen.getByRole('button', {name: 'plan-b', exact: true});
    act(() => {next.click(); expect(button.isConnected).toBe(true); button.click();});
    await waitFor(() => expect(f.session.editor?.record?.id).toBe('plan-b'));
    expect(f.writes()).toHaveLength(0); expect(screen.queryByRole('button', {name: /保存此转写快捷入口/})).toBeNull();
  });
  it('an uncertain shortcut write retains the original command and blocks alternative save controls', async () => {
    sources(); const f = plans(); await manager(f); const button = await expandSearch(); f.dropWrite(); fireEvent.click(button);
    await waitFor(() => expect(f.session.pending?.phase).toBe('uncertain'));
    expect(f.writes()).toHaveLength(1); expect(JSON.parse(f.session.pending!.command.body).materialLink).toEqual(shortcut);
    expect(screen.queryByRole('button', {name: /保存此转写快捷入口/})).toBeNull();
    expect((screen.getByRole('button', {name: '为此计划查找本地资料'}) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', {name: '重试原操作'})).toBeTruthy();
  });
});

describe('saved pointer revalidation, navigation, and clear', () => {
  it('reopens by original source and exact job, displays current metadata, and passes no fabricated search context', async () => {
    const src = sources(), f = plans(record('plan-a', shortcut)), navigate = vi.fn(); await manager(f, vi.fn(() => true), navigate);
    await screen.findByText(/当前转写：当前转写甲 · 转写失败/);
    const exact = src.calls.find(x => x.url.startsWith('/api/local-asr/jobs?'))!;
    expect(new URL(exact.url, 'http://localhost').searchParams.toString()).toBe(`jobId=${jobId}&scope=active&offset=0&limit=10`);
    expect(new Headers(exact.init?.headers).get('X-Transcription-Store-Id')).toBe(sourceA);
    expect(src.calls[0].url).toBe('/api/local-asr/identity');
    fireEvent.click(screen.getByRole('button', {name: '打开已保存的当前转写'}));
    expect(navigate.mock.calls).toHaveLength(1); expect(navigate.mock.calls[0]).toHaveLength(1);
    expect(Object.fromEntries(new URL(navigate.mock.calls[0][0], 'http://localhost').searchParams)).toEqual({page: 'files', transcriptStoreId: sourceA, transcriptJob: jobId});
    src.setRows([{...job(), title: '修改后的当前标题', status: 'completed'}]);
    fireEvent.click(screen.getByRole('button', {name: '重新核验转写快捷入口'}));
    await screen.findByText(/当前转写：修改后的当前标题 · 转写完成/);
    expect(screen.queryByText(/当前转写：当前转写甲/)).toBeNull(); expect(f.writes()).toHaveLength(0);
  });
  it('the same ID in another source fails before any job route is read and cannot be opened', async () => {
    const src = sources(); src.setSource(sourceB); const f = plans(record('plan-a', shortcut)), navigate = vi.fn(); await manager(f, vi.fn(() => true), navigate);
    await screen.findByText(/已保存的转写快捷入口当前不可用/);
    expect(src.calls.filter(x => x.url.startsWith('/api/local-asr/jobs'))).toHaveLength(0);
    expect((screen.getByRole('button', {name: '打开已保存的当前转写'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', {name: '打开已保存的当前转写'})); expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: '重新核验转写快捷入口'}));
    await waitFor(() => expect(src.calls.filter(x => x.url === '/api/local-asr/identity')).toHaveLength(2));
    expect(src.calls.filter(x => x.url.startsWith('/api/local-asr/jobs'))).toHaveLength(0);
    expect(f.session.editor?.record?.data.materialLink).toEqual(shortcut);
  });
  it.each(['missing', 'wrong-id', 'deleted'] as const)('a %s target is unavailable rather than replaced by a nearby match', async condition => {
    const src = sources(); src.setRows(condition === 'missing' ? [] : condition === 'wrong-id' ? [job(otherJobId)] : [{...job(), deleted_at: '2026-10-23T00:00:00Z'} as any]);
    const f = plans(record('plan-a', shortcut)); await manager(f);
    await screen.findByText(/已保存的转写快捷入口当前不可用/);
    expect((screen.getByRole('button', {name: '打开已保存的当前转写'}) as HTMLButtonElement).disabled).toBe(true);
    expect(f.session.editor?.record?.data.materialLink).toEqual(shortcut); expect(f.writes()).toHaveLength(0);
  });
  it('a delayed verification cannot publish after switching records', async () => {
    const src = sources(); src.delay(); const f = plans(record('plan-a', shortcut)); await manager(f);
    await waitFor(() => expect(src.delayed).toBe(true)); fireEvent.click(screen.getByRole('button', {name: 'plan-b', exact: true}));
    await waitFor(() => expect(f.session.editor?.record?.id).toBe('plan-b'));
    await act(async () => src.resolve()); expect(screen.queryByText(/当前转写：/)).toBeNull();
    expect(screen.queryByRole('button', {name: '打开已保存的当前转写'})).toBeNull(); expect(f.writes()).toHaveLength(0);
  });
  it('a refreshed verification withdraws the old open action synchronously', async () => {
    sources(); const f = plans(record('plan-a', shortcut)), navigate = vi.fn(); await manager(f, vi.fn(() => true), navigate);
    await screen.findByText(/当前转写：当前转写甲/);
    const open = screen.getByRole('button', {name: '打开已保存的当前转写'}), refresh = screen.getByRole('button', {name: '重新核验转写快捷入口'});
    act(() => {refresh.click(); expect(open.isConnected).toBe(true); open.click();}); expect(navigate).not.toHaveBeenCalled();
  });
  it('clear cancellation is a no-op; confirmed clear preserves the session link and rereads current plan', async () => {
    sources(); const f = plans(record('plan-a', shortcut)), confirm = vi.fn(() => false); await manager(f, confirm);
    await screen.findByText(/当前转写：当前转写甲/); fireEvent.click(screen.getByRole('button', {name: '清除转写快捷入口'}));
    expect(confirm).toHaveBeenCalledWith('是否清除此计划保存的转写快捷入口？不会删除转写，也不会更改文档快捷入口或会话关联。'); expect(f.writes()).toHaveLength(0);
    expect(f.session.editor?.record?.data.materialLink).toEqual(shortcut);
    confirm.mockReturnValue(true); fireEvent.click(screen.getByRole('button', {name: '清除转写快捷入口'}));
    await waitFor(() => expect(f.session.editor?.record?.data.materialLink).toBeNull());
    expect(f.writes()[0].input).toEqual({idempotencyKey: 'shortcut-1', id: 'plan-a', expectedRevision: 1, scope: planScope, materialLink: null});
    expect(f.session.editor?.record?.data.sessionLink).toEqual(sessionLink);
    expect(f.calls.some(x => x.operation === 'get' && x.input.scope === planScope)).toBe(true);
  });
  it('a confirmation-time editor change prevents clearing the former current record', async () => {
    sources(); const f = plans(record('plan-a', shortcut)); const confirm = vi.fn(() => {f.session.edit('notes', 'Changed during confirmation'); return true;});
    await manager(f, confirm); await screen.findByText(/当前转写：当前转写甲/);
    fireEvent.click(screen.getByRole('button', {name: '清除转写快捷入口'})); expect(confirm).toHaveBeenCalledOnce(); expect(f.writes()).toHaveLength(0);
    expect(f.session.editor?.record?.data.materialLink).toEqual(shortcut);
  });
  it('the actual shell guards dirty draft navigation and a saved shortcut does not fabricate a search-return restoration', async () => {
    const src = sources(), f = plans(record('plan-a', shortcut)), host = new ManualPlanHost(f.fetcher); hosts.push(host);
    host.activate(); host.setAuthority('a'.repeat(64), true); history.replaceState(null, '', '/?page=planner');
    render(<OrdinaryNavigationShell lifetime={new OrdinaryRequestLifetime()} manualPlanHost={host} identityScope={'a'.repeat(64)}/>);
    fireEvent.click(await screen.findByRole('button', {name: 'plan-a', exact: true})); fireEvent.click(await screen.findByRole('button',{name:'管理单份转写快捷入口'})); await screen.findByText(/当前转写：当前转写甲/);
    fireEvent.change(screen.getByLabelText('备注'), {target: {value: 'Retain this dirty draft'}});
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', {name: '打开已保存的当前转写'}));
    expect(location.search).toBe('?page=planner'); expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockReturnValue(true); fireEvent.click(screen.getByRole('button', {name: '打开已保存的当前转写'}));
    await waitFor(() => expect(new URL(location.href).searchParams.get('transcriptJob')).toBe(jobId));
    expect(new URL(location.href).searchParams.get('transcriptStoreId')).toBe(sourceA); expect(confirm).toHaveBeenCalledTimes(2);
    expect(host.session?.editor?.draft.notes).toBe('Retain this dirty draft');
    await screen.findByText('当前转写甲');
    expect(src.calls.filter(x => x.url.startsWith('/api/local-asr/jobs?')).some(x => new URL(x.url, 'http://localhost').searchParams.get('jobId') === jobId)).toBe(true);
    await act(async () => {history.back(); await new Promise(resolve => setTimeout(resolve, 100));});
    await screen.findByRole('button', {name: '为此计划查找本地资料'});
    expect(screen.queryByRole('heading', {name: '本地资料检索'})).toBeNull();
    expect(screen.getByLabelText('备注')).toHaveProperty('value', 'Retain this dirty draft'); expect(f.writes()).toHaveLength(0);
  });
});
