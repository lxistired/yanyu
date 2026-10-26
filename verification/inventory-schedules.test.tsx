import React from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {InventorySchedules, inventoryCadence, inventoryTime} from '../visual-harness/InventorySchedules';
import {nextScheduleOccurrence} from '../scheduler/cadence.mjs';
import {allowLeavingUnsavedWork} from '../candidate/src/components/unsaved-work';
const recoveryScope = '33333333-3333-4333-8333-333333333333';
const savedCommand = (body: any) => {const command = JSON.parse(body); return {id: command.id, state: 'active', nextDue: base + 15000, definition: {handler: command.handler, scope: command.scope, cadence: command.cadence}};};
const base = Date.parse('2026-10-16T00:00:00.000Z');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
const choices = {workspaces: [{id: 'w1', name: '合成工作区一'}, {id: 'w2', name: '合成工作区二'}], folders: [{id: 'f1', name: '合成文件夹', workspaceId: 'w1'}]};
const initial = {id: 'daily-synthetic', state: 'active', nextDue: base + 3600000, definition: {scope: {workspaceId: null, folderId: null}, cadence: {kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai'}}};
async function setup(extra?: (path: string, init?: RequestInit) => Promise<Response> | undefined, schedules: unknown[] = []) {
  vi.spyOn(Date, 'now').mockReturnValue(base);
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    return extra?.(path, init) ?? Promise.resolve(json(path === '/api/documents/choices' ? choices : path.endsWith('/capabilities') ? {lastError: null, recoveryScope} : path.endsWith('/runs') ? [] : init?.method === 'POST' ? savedCommand(init.body) : schedules));
  });
  vi.stubGlobal('fetch', fetcher);
  const view = render(<InventorySchedules/>);
  await screen.findByRole('form', {name: '创建清单计划'});
  return {...view, fetcher};
}
const posts = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
const submit = () => fireEvent.submit(screen.getByRole('form', {name: '创建清单计划'}));
const select = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), {target: {value}});
afterEach(() => {cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();});

it('creates one-time schedules with an explicit instant, selected zone and exact reset scope', async () => {
  const {fetcher} = await setup();
  await screen.findByRole('option', {name: '合成工作区一'});
  select('快照工作区', 'w1'); select('快照文件夹', 'f1'); select('快照工作区', 'w2');
  expect((screen.getByLabelText('快照文件夹') as HTMLSelectElement).value).toBe('');
  select('时区（IANA）', 'Asia/Shanghai'); select('延迟秒数', '20'); submit();
  await screen.findByText(/计划已保存：/);
  const command = JSON.parse(posts(fetcher)[0][1].body);
  expect(command.idempotencyKey).toBe(command.id);
  expect(command).toMatchObject({handler: 'document-inventory-snapshot', scope: {workspaceId: 'w2', folderId: null}, cadence: {kind: 'once', at: '2026-10-16T00:00:20.000Z', timezone: 'Asia/Shanghai'}});
});
it('creates daily wall time in the chosen IANA zone and previews its explicit offset', async () => {
  const {fetcher} = await setup(); select('运行周期', 'daily'); select('时区（IANA）', 'Asia/Shanghai'); select('运行时间', '09:30');
  expect(screen.getByText(/预计首次运行：/).textContent).toContain('GMT+8 09:30:00（Asia/Shanghai）');
  submit(); await screen.findByText(/计划已保存：/);
  expect(JSON.parse(posts(fetcher)[0][1].body).cadence).toEqual({kind: 'daily', time: '09:30', timezone: 'Asia/Shanghai'});
});
it('weekly controls submit Sunday=0 and multiple sorted unique weekdays', async () => {
  const {fetcher} = await setup(); select('运行周期', 'weekly'); select('时区（IANA）', 'UTC');
  fireEvent.click(screen.getByLabelText('周日')); fireEvent.click(screen.getByLabelText('周三')); submit();
  await screen.findByText(/计划已保存：/);
  expect(JSON.parse(posts(fetcher)[0][1].body).cadence).toEqual({kind: 'weekly', time: '09:00', timezone: 'UTC', weekdays: [0, 1, 3]});
});
it.each(['', 'Not/AZone', '+08:00', '../UTC'])('rejects invalid timezone %s before any POST', async zone => {
  const {fetcher} = await setup(); select('时区（IANA）', zone); submit();
  await screen.findByRole('alert'); expect(screen.getByRole('alert').textContent).toContain('有效的 IANA 时区'); expect(posts(fetcher)).toHaveLength(0);
});
it.each(['', '4', '86401', '5.5'])('rejects invalid once delay %s without dispatch', async delay => {
  const {fetcher} = await setup(); select('延迟秒数', delay); submit();
  await screen.findByRole('alert'); expect(screen.getByRole('alert').textContent).toContain('5–86400'); expect(posts(fetcher)).toHaveLength(0);
});
it('rejects empty weekly selection and empty time; valid edits can then be saved', async () => {
  const {fetcher} = await setup(); select('运行周期', 'weekly'); fireEvent.click(screen.getByLabelText('周一')); submit();
  await screen.findByRole('alert'); expect(screen.getByRole('alert').textContent).toContain('至少选择一天');
  fireEvent.click(screen.getByLabelText('周五')); select('运行时间', ''); submit();
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('有效的运行时间')); expect(posts(fetcher)).toHaveLength(0);
  select('运行时间', '23:59'); submit(); await screen.findByText(/计划已保存：/); expect(posts(fetcher)).toHaveLength(1);
});
it('uses the unchanged engine DST policy for skipped and repeated wall times', () => {
  const draft = {kind: 'daily' as const, delay: '15', time: '02:30', timezone: 'America/New_York', weekdays: [1]};
  expect(nextScheduleOccurrence(inventoryCadence(draft, base), '2026-03-08T00:00:00Z')).toBe('2026-03-09T06:30:00.000Z');
  expect(nextScheduleOccurrence(inventoryCadence({...draft, time: '01:30'}, base), '2026-11-01T05:30:00Z')).toBe('2026-11-02T06:30:00.000Z');
  expect(inventoryTime('2026-11-01T05:30:00Z', 'America/New_York')).toContain('GMT-4 01:30:00（America/New_York）');
  expect(inventoryTime('2026-11-02T06:30:00Z', 'America/New_York')).toContain('GMT-5 01:30:00（America/New_York）');
});
it('rejects invalid and out-of-range date calculations and never labels invalid timestamps as valid', () => {
  const draft = {kind: 'once' as const, delay: '15', time: '09:00', timezone: 'UTC', weekdays: [1]};
  for (const now of [NaN, Infinity, Date.parse('2099-12-31T23:59:59Z'), Date.parse('1969-01-01T00:00:00Z')]) expect(() => inventoryCadence(draft, now)).toThrow('运行日期');
  expect(inventoryTime('not-a-date', 'UTC')).toBe('时间或时区不可用');
  expect(inventoryTime(null, 'UTC')).toBe('无');
});
it('locks synchronously against repeated same-frame submissions and keeps fields unchanged while in flight', async () => {
  let resolve!: (value: Response) => void;
  const {fetcher} = await setup((path, init) => init?.method === 'POST' ? new Promise(r => {resolve = r;}) : undefined);
  submit(); submit(); fireEvent.click(screen.getByText('创建本地清单计划'));
  expect(posts(fetcher)).toHaveLength(1); expect(screen.getByLabelText('运行周期').matches(':disabled')).toBe(true);
  await act(async () => resolve(json(savedCommand(posts(fetcher)[0][1].body))));
  await screen.findByText(/计划已保存：/); expect(screen.getByLabelText('运行周期').matches(':disabled')).toBe(false);
});
it('lost response keeps a guarded frozen command and retries identical once instant, scope and key', async () => {
  let attempts = 0;
  const {fetcher} = await setup((path, init) => init?.method === 'POST' ? ++attempts === 1 ? Promise.reject(Error('response lost')) : Promise.resolve(json(savedCommand(posts(fetcher)[0][1].body))) : undefined);
  select('时区（IANA）', 'UTC'); submit(); await screen.findByText('response lost');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false); expect(allowLeavingUnsavedWork()).toBe(false);
  expect(screen.getByLabelText('运行周期').matches(':disabled')).toBe(true);
  expect((screen.getByText('创建本地清单计划') as HTMLButtonElement).disabled).toBe(true);
  submit(); expect(posts(fetcher)).toHaveLength(1);
  vi.mocked(Date.now).mockReturnValue(base + 60000);
  fireEvent.click(screen.getByText('重试原创建请求')); await screen.findByText(/计划已保存：/);
  expect(posts(fetcher)[1][1].body).toBe(posts(fetcher)[0][1].body);
  await waitFor(() => expect(allowLeavingUnsavedWork()).toBe(true)); confirm.mockClear(); expect(allowLeavingUnsavedWork()).toBe(true); expect(confirm).not.toHaveBeenCalled();
});
it('definite first rejection keeps editable values; corrected request gets a fresh ID', async () => {
  let attempts = 0;
  const {fetcher} = await setup((path, init) => init?.method === 'POST' ? Promise.resolve(++attempts === 1 ? json({error: {message: 'Invalid cadence'}}, 400) : json(savedCommand(init!.body))) : undefined);
  select('运行周期', 'daily'); submit(); await screen.findByText('Invalid cadence');
  expect(screen.getByLabelText('运行时间').matches(':disabled')).toBe(false); select('运行时间', '11:30'); submit(); await screen.findByText(/计划已保存：/);
  const [first, second] = posts(fetcher).map(([, init]) => JSON.parse(init.body));
  expect(second.id).not.toBe(first.id); expect(second.cadence.time).toBe('11:30');
});
it('an ambiguous earlier attempt cannot be discarded after a later 400 rejection', async () => {
  let attempts = 0;
  await setup((path, init) => init?.method === 'POST' ? ++attempts === 1 ? Promise.reject(Error('lost')) : Promise.resolve(json({error: {message: 'later rejection'}}, 400)) : undefined);
  submit(); await screen.findByText('lost'); fireEvent.click(screen.getByText('重试原创建请求')); await screen.findByText('later rejection');
  expect(screen.getByLabelText('运行周期').matches(':disabled')).toBe(true); expect(screen.getByRole('region', {name: '待确认创建请求'})).toBeTruthy();
});
it('separates committed creation from a later refresh failure without offering a duplicate retry', async () => {
  let committed = false;
  const {fetcher} = await setup((path, init) => {
    if (init?.method === 'POST') {committed = true; return Promise.resolve(json(savedCommand(posts(fetcher)[0][1].body)));}
    if (committed && path.endsWith('/schedules')) return Promise.reject(Error('refresh offline'));
  });
  submit(); await screen.findByText(/计划已保存：/); await screen.findByText(/操作已确认，但列表刷新失败/);
  expect(screen.queryByText('重试原创建请求')).toBeNull(); expect(posts(fetcher)).toHaveLength(1);
});
it('renders saved timezone and pause/resume state controls without inventing editing routes', async () => {
  let current = {...initial};
  const {fetcher} = await setup((path, init) => {
    if (path.endsWith('/schedules') && init?.method !== 'POST') return Promise.resolve(json([current]));
    if (path.endsWith('/state')) {current = {...current, state: JSON.parse(init!.body as string).state}; return Promise.resolve(json(current));}
  });
  const article = await screen.findByRole('article', {name: '计划 daily-synthetic'});
  expect(within(article).getByText(/下一次：/).textContent).toContain('GMT+8 09:00:00（Asia/Shanghai）');
  fireEvent.click(within(article).getByText('暂停')); await within(article).findByText(/已暂停；保留的应运行时间：/);
  fireEvent.click(within(article).getByText('恢复')); await within(article).findByText('暂停');
  expect(posts(fetcher).map(([path, init]) => [path, JSON.parse(init.body)])).toEqual([
    ['/api/local-scheduler/state', {id: initial.id, state: 'paused'}], ['/api/local-scheduler/state', {id: initial.id, state: 'active'}],
  ]);
  expect(screen.getByText(/已创建计划的时间和范围不可修改/)).toBeTruthy(); expect(screen.queryByRole('button', {name: '编辑计划'})).toBeNull();
});
it('terminal schedules show no next execution or state controls even if an old nextDue is retained', async () => {
  await setup(undefined, [{...initial, state: 'cancelled'}]);
  const article = await screen.findByRole('article', {name: '计划 daily-synthetic'});
  expect(within(article).getByText('下一次：无')).toBeTruthy(); expect(within(article).queryByRole('button')).toBeNull();
});
it('ignores older polling results after a newer state refresh', async () => {
  let resolve!: (value: Response) => void, lists = 0;
  const {fetcher} = await setup((path, init) => path.endsWith('/schedules') && init?.method !== 'POST' ? ++lists === 1 ? new Promise(r => {resolve = r;}) : Promise.resolve(json([initial])) : undefined);
  submit(); await screen.findByText(/计划已保存：/); await screen.findByRole('article', {name: '计划 daily-synthetic'});
  await act(async () => resolve(json([])));
  expect(screen.getByRole('article', {name: '计划 daily-synthetic'})).toBeTruthy(); expect(posts(fetcher)).toHaveLength(1);
});

it('recovers incomplete form values, weekdays and scope after remount without creating a plan', async () => {
  const first = await setup();
  select('运行周期', 'weekly'); select('运行时间', ''); select('时区（IANA）', 'Not/Finished');
  fireEvent.click(screen.getByLabelText('周日'));
  await screen.findByRole('option', {name: '合成工作区一'}); select('快照工作区', 'w1');
  await screen.findByRole('option', {name: '合成文件夹'}); select('快照文件夹', 'f1');
  first.unmount(); const second = await setup();
  expect((screen.getByLabelText('运行周期') as HTMLSelectElement).value).toBe('weekly');
  expect((screen.getByLabelText('运行时间') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('时区（IANA）') as HTMLInputElement).value).toBe('Not/Finished');
  expect((screen.getByLabelText('周日') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('快照工作区') as HTMLSelectElement).value).toBe('w1');
  expect((screen.getByLabelText('快照文件夹') as HTMLSelectElement).value).toBe('f1');
  expect(posts(second.fetcher)).toHaveLength(0); expect(screen.getByText(/已恢复本页清单草稿/)).toBeTruthy();
});
it('restores a lost-response pending command and retries the exact original payload after time advances', async () => {
  const first = await setup((path, init) => init?.method === 'POST' ? Promise.reject(Error('synthetic lost response')) : undefined);
  select('时区（IANA）', 'UTC'); select('延迟秒数', '30'); submit(); await screen.findByText('synthetic lost response');
  const body = posts(first.fetcher)[0][1].body; first.unmount();
  const second = await setup(); vi.mocked(Date.now).mockReturnValue(base + 3600000);
  expect(posts(second.fetcher)).toHaveLength(0); expect(screen.getByLabelText('运行周期').matches(':disabled')).toBe(true);
  fireEvent.click(screen.getByText('重试原创建请求')); await screen.findByText(/计划已保存：/);
  expect(posts(second.fetcher)[0][1].body).toBe(body);
  expect(posts(second.fetcher)[0][1].headers['X-Yanyu-Recovery-Scope']).toBe(recoveryScope);
});
it('recovers a submitted request after unmount before its response and confirms it with a read only', async () => {
  let resolve!: (value: Response) => void;
  const first = await setup((path, init) => init?.method === 'POST' ? new Promise(r => {resolve = r;}) : undefined);
  submit(); const committed = savedCommand(posts(first.fetcher)[0][1].body); first.unmount();
  await act(async () => resolve(json(committed)));
  const second = await setup(undefined, [committed]); expect(posts(second.fetcher)).toHaveLength(0);
  fireEvent.click(screen.getByText('核对原创建结果')); await screen.findByText(/已核对原计划：/);
  expect(posts(second.fetcher)).toHaveLength(0); expect(screen.queryByText('重试原创建请求')).toBeNull();
  second.unmount(); await setup(); expect(screen.queryByText('重试原创建请求')).toBeNull();
});
it('absence from a read-only check never clears or recreates an uncertain request', async () => {
  await setup((path, init) => init?.method === 'POST' ? Promise.reject(Error('lost')) : undefined);
  submit(); await screen.findByText('lost'); fireEvent.click(screen.getByText('核对原创建结果'));
  await screen.findByText(/这不证明创建失败/); expect(screen.getByText('重试原创建请求')).toBeTruthy();
});
it('mismatched success payload is not presented as a saved plan and keeps the request', async () => {
  await setup((path, init) => init?.method === 'POST' ? Promise.resolve(json(initial)) : undefined);
  submit(); await screen.findByText(/保存结果与原请求不一致/);
  expect(screen.queryByText(/计划已保存：/)).toBeNull(); expect(screen.getByText('重试原创建请求')).toBeTruthy();
});
it('failed session storage write preserves edited fields and prevents a new POST', async () => {
  const {fetcher} = await setup(); vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {throw Error('synthetic quota');});
  select('延迟秒数', '72'); expect((screen.getByLabelText('延迟秒数') as HTMLInputElement).value).toBe('72');
  expect(screen.getByText(/本页草稿恢复保存失败/)).toBeTruthy(); submit(); await screen.findByText('synthetic quota');
  expect(posts(fetcher)).toHaveLength(0);
});
it('corrupt recovery data blocks creation without silently deleting the record', async () => {
  const first = await setup(); first.unmount(); const key = 'yanyu:inventory-recovery:v1:' + recoveryScope;
  sessionStorage.setItem(key, '{broken'); render(<InventorySchedules/>);
  await screen.findByText(/清单恢复记录无法读取/); expect(screen.queryByRole('form')).toBeNull();
  expect(sessionStorage.getItem(key)).toBe('{broken'); expect(posts(first.fetcher)).toHaveLength(0);
});
it('changing database scope never restores another database draft', async () => {
  const first = await setup(); select('延迟秒数', '83'); first.unmount();
  const second = await setup(path => path.endsWith('/capabilities') ? Promise.resolve(json({lastError: null, recoveryScope: '44444444-4444-4444-8444-444444444444'})) : undefined);
  expect((screen.getByLabelText('延迟秒数') as HTMLInputElement).value).toBe('15'); expect(posts(second.fetcher)).toHaveLength(0);
});
it('scope change observed while mounted hides old drafts and offers an explicit reopen', async () => {
  let scope = recoveryScope;
  await setup(path => path.endsWith('/capabilities') ? Promise.resolve(json({lastError: null, recoveryScope: scope})) : undefined);
  select('延迟秒数', '93'); scope = '44444444-4444-4444-8444-444444444444';
  await screen.findByText(/本地清单数据库已变化/, {}, {timeout: 3500});
  expect(screen.queryByRole('form')).toBeNull(); fireEvent.click(screen.getByText('重新打开当前清单'));
  await screen.findByRole('form', {name: '创建清单计划'}); expect((screen.getByLabelText('延迟秒数') as HTMLInputElement).value).toBe('15');
});
it('explicit draft clearing supports cancel and then removes only the current unsubmitted draft', async () => {
  await setup(); select('延迟秒数', '63'); const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.click(screen.getByText('清除未提交草稿')); expect((screen.getByLabelText('延迟秒数') as HTMLInputElement).value).toBe('63');
  confirm.mockReturnValue(true); fireEvent.click(screen.getByText('清除未提交草稿')); await screen.findByText('本页清单草稿已清除');
  expect((screen.getByLabelText('延迟秒数') as HTMLInputElement).value).toBe('15'); expect(sessionStorage.getItem('yanyu:inventory-recovery:v1:' + recoveryScope)).toBeNull();
});
it('a removed recovered workspace remains visibly selected and cannot silently widen to all workspaces', async () => {
  const first = await setup(); await screen.findByRole('option', {name: '合成工作区一'}); select('快照工作区', 'w1'); first.unmount();
  const second = await setup(path => path === '/api/documents/choices' ? Promise.resolve(json({workspaces: [], folders: []})) : undefined);
  expect((screen.getByLabelText('快照工作区') as HTMLSelectElement).value).toBe('w1'); expect(screen.getByText(/已恢复工作区编号/)).toBeTruthy();
  submit(); await screen.findByText('恢复的工作区已不在当前列表，请重新选择范围'); expect(posts(second.fetcher)).toHaveLength(0);
});
it('binds schedule/run/result reads to the original database scope', async () => {
 const run = {id: 'synthetic-run', schedule_id: initial.id, state: 'completed', due: base, attempt: 1, error: null};
 const {fetcher} = await setup(path => path.endsWith('/runs') ? Promise.resolve(json([run])) : path.includes('/result?') ? Promise.resolve(json({count: 0})) : undefined, [initial]);
 fireEvent.click(await screen.findByText('查看快照结果')); await screen.findByRole('region', {name: '快照结果'});
 for (const [path, init] of fetcher.mock.calls) if (/\/(schedules|runs)$|\/result\?/.test(String(path))) expect(init?.headers?.['X-Yanyu-Recovery-Scope']).toBe(recoveryScope);
});
it.each(['success', 'error'] as const)('replaces result A with dismissible loading for B and ignores its late %s after Close', async outcome => {
  const runA = {id: 'synthetic-run-a', schedule_id: initial.id, state: 'completed', due: base, attempt: 1, error: null};
  const runB = {...runA, id: 'synthetic-run-b'};
  let resolve!: (response: Response) => void, reject!: (cause: Error) => void;
  const delayed = new Promise<Response>((yes, no) => {resolve = yes; reject = no;});
  const {fetcher} = await setup(path => path.endsWith('/runs') ? Promise.resolve(json([runB, runA]))
    : path.endsWith('/result?id=' + runA.id) ? Promise.resolve(json({marker: 'result A'}))
    : path.endsWith('/result?id=' + runB.id) ? delayed : undefined, [initial]);
  const buttons = await screen.findAllByRole('button', {name: '查看快照结果'});
  fireEvent.click(buttons[0]);
  await screen.findByText(/"marker": "result A"/);
  await waitFor(() => expect((buttons[1] as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(buttons[1]);
  const loading = screen.getByRole('region', {name: '快照结果'});
  expect(within(loading).queryByText(/"marker": "result A"/)).toBeNull();
  expect(within(loading).getByText('运行：' + runB.id)).toBeTruthy();
  expect(within(loading).getByRole('status').textContent).toBe('正在读取快照结果…');
  const close = within(loading).getByRole('button', {name: '关闭结果'}) as HTMLButtonElement;
  expect(close.disabled).toBe(false);
  expect(screen.getByLabelText('运行周期').matches(':disabled')).toBe(true);
  fireEvent.click(close);
  expect(screen.queryByRole('region', {name: '快照结果'})).toBeNull();
  expect(screen.getByLabelText('运行周期').matches(':disabled')).toBe(true);
  await act(async () => {if (outcome === 'success') resolve(json({marker: 'late result B'})); else reject(Error('late result B failure'));});
  await waitFor(() => expect((buttons[1] as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByRole('region', {name: '快照结果'})).toBeNull();
  expect(screen.queryByText(/late result B/)).toBeNull();
  expect(posts(fetcher)).toHaveLength(0);
});
it.each(['success', 'error'] as const)('shows a dismissible first result read and ignores its late %s after unmount', async outcome => {
  const run = {id: 'synthetic-run-unmounted', schedule_id: initial.id, state: 'completed', due: base, attempt: 1, error: null};
  let resolve!: (response: Response) => void, reject!: (cause: Error) => void;
  const delayed = new Promise<Response>((yes, no) => {resolve = yes; reject = no;});
  const {fetcher, unmount} = await setup(path => path.endsWith('/runs') ? Promise.resolve(json([run])) : path.includes('/result?') ? delayed : undefined, [initial]);
  fireEvent.click(await screen.findByRole('button', {name: '查看快照结果'}));
  const loading = screen.getByRole('region', {name: '快照结果'});
  expect(within(loading).getByRole('status').textContent).toBe('正在读取快照结果…');
  expect((within(loading).getByRole('button', {name: '关闭结果'}) as HTMLButtonElement).disabled).toBe(false);
  unmount();
  const callsAtUnmount = fetcher.mock.calls.length;
  await act(async () => {if (outcome === 'success') resolve(json({marker: 'unmounted result'})); else reject(Error('unmounted result failure'));});
  expect(screen.queryByRole('region', {name: '快照结果'})).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(fetcher.mock.calls).toHaveLength(callsAtUnmount);
  expect(posts(fetcher)).toHaveLength(0);
});
it('a read scope conflict hides stale content even if capabilities were read before the restart', async () => {
 let conflict = false;
 const {fetcher} = await setup(path => path.endsWith('/runs') && conflict ? Promise.resolve(json({error: {code: 'RECOVERY_SCOPE_CONFLICT', message: 'database changed'}}, 409)) : undefined);
 conflict = true; await screen.findByText(/本地清单数据库已变化/, {}, {timeout: 3500}); expect(screen.queryByRole('form')).toBeNull(); expect(posts(fetcher)).toHaveLength(0);
});

it('deferred scope choices are awaited before selecting and the selected incomplete draft survives remount', async () => {
  let release!: (response: Response) => void;
  const delayed = new Promise<Response>(resolve => {release = resolve;});
  const first = await setup(path => path === '/api/documents/choices' ? delayed : undefined);
  expect(screen.queryByRole('option', {name: '合成工作区一'})).toBeNull();
  expect(screen.queryByRole('option', {name: '合成文件夹'})).toBeNull();
  select('运行周期', 'weekly'); select('运行时间', ''); select('时区（IANA）', 'Not/Finished');
  fireEvent.click(screen.getByLabelText('周日'));
  await act(async () => release(json(choices)));
  await screen.findByRole('option', {name: '合成工作区一'}); select('快照工作区', 'w1');
  await screen.findByRole('option', {name: '合成文件夹'}); select('快照文件夹', 'f1');
  expect((screen.getByLabelText('快照工作区') as HTMLSelectElement).value).toBe('w1');
  expect((screen.getByLabelText('快照文件夹') as HTMLSelectElement).value).toBe('f1');
  expect(posts(first.fetcher)).toHaveLength(0);
  first.unmount(); const second = await setup();
  expect((screen.getByLabelText('运行周期') as HTMLSelectElement).value).toBe('weekly');
  expect((screen.getByLabelText('运行时间') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('时区（IANA）') as HTMLInputElement).value).toBe('Not/Finished');
  expect((screen.getByLabelText('周日') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('快照工作区') as HTMLSelectElement).value).toBe('w1');
  expect((screen.getByLabelText('快照文件夹') as HTMLSelectElement).value).toBe('f1');
  expect(posts(second.fetcher)).toHaveLength(0); expect(screen.getByText(/已恢复本页清单草稿/)).toBeTruthy();
});
