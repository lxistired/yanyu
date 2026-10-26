import {createHash} from 'node:crypto';
import {readerCanonical} from '../candidate/shared/reader-reference';
import {OrganizationWriteHost} from '../candidate/src/components/organization-write-host';
import {OrganizationHostView} from '../candidate/src/components/OrganizationHostView';
import {preview as v2Preview,scope as reportScope,synthetic,json} from './fixtures/projection-source-v2';
import {writeUnsavedHistory} from '../candidate/src/components/unsaved-work';
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { OrganizationManager } from '../candidate/src/components/OrganizationManager';
import { AutomationManager } from '../candidate/src/components/AutomationManager';
import { OrdinaryNavigationShell } from '../candidate/src/components/OrdinaryNavigationShell';
import { OrdinaryRequestLifetime } from '../candidate/src/components/ordinary-navigation';
import { allowLeavingUnsavedWork } from '../candidate/src/components/unsaved-work';
import { organizationApi, serviceRecordBridgeApi } from '../candidate/src/adapters/organization';
import { automationApi } from '../candidate/src/adapters/automation';
import { ApiError } from '../candidate/src/adapters/api';

vi.mock('../candidate/src/components/ServiceReportsEntry', () => ({ ServiceReportsEntry: () => null }));
const stamp = '2026-10-16T00:00:00.000Z';
const organization = (name = 'Synthetic A', id = 'org-a') => ({
  id, kind: 'organization', revision: 1, deletedAt: null, createdAt: stamp, updatedAt: stamp,
  data: { name, parentId: null, category: 'other', website: '', description: '', tags: [], verification:'unverified' },
});
const base = { revision: 1, deletedAt: null, createdAt: stamp, updatedAt: stamp };
const availability = { status: 'available', code: 'local_only', detail: 'Synthetic fixture', capabilities: [] };
const skill = { ...base, id: 'skill-a', data: { name: 'Synthetic skill', description: '', enabled: true, handler: 'local-checkpoint' }, availability };
const source = { ...base, id: 'source-a', data: { name: 'Synthetic source', kind: 'local-workspace', collectionIds: ['collection-a'], enabled: true }, availability };
const schedule = { ...base, id: 'schedule-a', data: { name: 'Synthetic schedule', skillId: skill.id, sourceIds: [], instructions: '', cadence: { kind: 'daily', time: '09:00', timezone: 'UTC' }, enabled: true, state: 'active', misfirePolicy: 'coalesce', graceSeconds: 60, nextRunAt: '2027-01-01T09:00:00.000Z', lastRunAt: null } };
const configurations = {
  organization: { tab: '', create: '新建机构', field: '机构名称 *', cancel: '取消编辑', record: 'Synthetic A', write: () => organizationApi.create },
  skills: { tab: '技能', create: '新建技能', field: '技能名称', cancel: '取消', record: 'Synthetic skill', write: () => automationApi.createSkill },
  sources: { tab: '数据源', create: '新建数据源', field: '数据源名称', cancel: '取消', record: 'Synthetic source', write: () => automationApi.createDataSource },
  schedules: { tab: '', create: '新建任务', field: '任务名称', cancel: '取消', record: 'Synthetic schedule', write: () => automationApi.createSchedule },
} as const;
type FormKind = keyof typeof configurations;
const formKinds = Object.keys(configurations) as FormKind[];
let orgs: ReturnType<typeof organization>[];
const projectionHosts:OrganizationWriteHost[]=[];
beforeEach(() => {
  orgs = [organization(), organization('Synthetic B', 'org-b')];
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  vi.spyOn(organizationApi, 'list').mockImplementation(async ({ kind }) => ({ items: kind === 'organization' ? orgs : [], nextOffset: null }) as any);
  vi.spyOn(organizationApi, 'get').mockImplementation(async () => organization('Latest server name') as any);
  vi.spyOn(organizationApi, 'create').mockImplementation(async ({ data }) => ({ ...organization(), data:{...organization().data,...data} }) as any);
  vi.spyOn(organizationApi, 'update').mockImplementation(async ({ patch }) => ({ ...organization(), data: { ...organization().data, ...patch } }) as any);
  vi.spyOn(automationApi, 'listSkills').mockResolvedValue([skill] as any);
  vi.spyOn(automationApi, 'listDataSources').mockResolvedValue([source] as any);
  vi.spyOn(automationApi, 'listSchedules').mockResolvedValue([schedule] as any);
  vi.spyOn(automationApi, 'listRuns').mockResolvedValue([]);
  vi.spyOn(automationApi, 'listNotifications').mockResolvedValue([]);
  for (const [create, update, fixture] of [
    ['createSkill', 'updateSkill', skill], ['createDataSource', 'updateDataSource', source], ['createSchedule', 'updateSchedule', schedule],
  ] as const) {
    vi.spyOn(automationApi, create).mockImplementation(async () => fixture as any);
    vi.spyOn(automationApi, update).mockImplementation(async () => fixture as any);
  }
});
afterEach(() => { cleanup(); for(const host of projectionHosts.splice(0))host.dispose();vi.unstubAllGlobals(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); });
async function mount(kind: FormKind, edit = false, shell = false) {
  const config = configurations[kind];
  const life = new OrdinaryRequestLifetime();
  const page = kind === 'organization' ? 'organization' : 'automation';
  history.replaceState(null, '', `/?page=${page}`);
  const view = render(shell ? <OrdinaryNavigationShell lifetime={life} /> : kind === 'organization' ? <OrganizationManager /> : <AutomationManager definitionsOnly />);
  if (config.tab) fireEvent.click(screen.getByRole('button', { name: config.tab, exact: true }));
  await waitFor(() => expect((screen.getByRole('button', { name: config.create }) as HTMLButtonElement).disabled).toBe(false));
  if (edit) {
    const card = screen.getByRole('article', { name: config.record });
    fireEvent.click(within(card).getByRole('button', { name: kind === 'organization' ? '编辑机构' : `编辑 ${config.record}` }));
  } else fireEvent.click(screen.getByRole('button', { name: config.create }));
  return { ...view, life, config };
}
function change(kind: FormKind, value = 'Synthetic unsaved draft') {
  fireEvent.change(screen.getByLabelText(configurations[kind].field), { target: { value } });
}
function save(kind: FormKind) {
  fireEvent.submit(screen.getByLabelText(configurations[kind].field).closest('form')!);
}
function expectClean() {
  vi.mocked(window.confirm).mockClear();
  expect(allowLeavingUnsavedWork()).toBe(true);
  expect(window.confirm).not.toHaveBeenCalled();
}

it.each(formKinds)('%s: untouched and reverted create inputs close without a warning', async (kind) => {
  const { config } = await mount(kind);
  expectClean();
  change(kind); change(kind, '');
  fireEvent.click(screen.getByRole('button', { name: config.cancel, exact: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(window.confirm).not.toHaveBeenCalled();
});
it.each(formKinds)('%s: dirty create form stays on cancel, preserves focus, and explicitly discards', async (kind) => {
  const { config } = await mount(kind);
  const field = screen.getByLabelText(config.field); field.focus(); change(kind);
  expect(document.activeElement).toBe(field);
  fireEvent.click(screen.getByRole('button', { name: config.cancel, exact: true }));
  expect(window.confirm).toHaveBeenCalledOnce();
  expect(screen.getByDisplayValue('Synthetic unsaved draft')).toBe(field);
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: config.cancel, exact: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expectClean();
});
it.each(formKinds)('%s: existing record starts clean, dirty edits survive refresh, and revert clears the guard', async (kind) => {
  const { config } = await mount(kind, true);
  expectClean(); change(kind);
  fireEvent.click(screen.getByRole('button', { name: kind === 'organization' ? '刷新目录' : '刷新全部' }));
  await waitFor(() => expect(screen.getByDisplayValue('Synthetic unsaved draft')).toBeTruthy());
  expect(allowLeavingUnsavedWork()).toBe(false);
  change(kind, config.record); expectClean();
});
it.each(formKinds)('%s: failed create save retains inputs and guard; successful retry clears both', async (kind) => {
  await mount(kind); change(kind);
  if (kind === 'schedules') fireEvent.change(screen.getByLabelText('执行技能'), { target: { value: skill.id } });
  vi.mocked(configurations[kind].write()).mockRejectedValueOnce(new Error('Synthetic offline'));
  save(kind);
  await screen.findByText(kind==='organization'?/请求结果尚未确认。请重试原操作/:/请求结果尚未确认：Synthetic offline/);
  expect(screen.getByDisplayValue('Synthetic unsaved draft')).toBeTruthy();
  expect(allowLeavingUnsavedWork()).toBe(false);
  await act(async () => { save(kind); });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(configurations[kind].write()).toHaveBeenCalledTimes(2);
  expectClean();
});
it.each(['organization', 'skills'] as const)('%s: dirty Close, Escape and backdrop keep the same editor', async (kind) => {
  await mount(kind); change(kind);
  const field = screen.getByLabelText(configurations[kind].field); field.focus();
  fireEvent.click(screen.getByRole('button', { name: '关闭', exact: true }));
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
  expect(window.confirm).toHaveBeenCalledTimes(3);
  expect(screen.getByDisplayValue('Synthetic unsaved draft')).toBe(field);
  expect(document.activeElement).toBe(field);
});
it('organization: cancelled type, scope, search, trash and pagination changes keep UI state and input', async () => {
  orgs = Array.from({ length: 26 }, (_, index) => organization(`Synthetic ${index}`, `org-${index}`));
  await mount('organization'); change('organization');
  fireEvent.click(screen.getByRole('button', { name: '机构与人员', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: /^人员 / }));
  fireEvent.change(screen.getByLabelText('搜索本地记录'), { target: { value: 'no results' } });
  fireEvent.change(screen.getByLabelText('机构范围'), { target: { value: 'org-0' } });
  fireEvent.click(screen.getByLabelText('回收站'));
  fireEvent.click(screen.getByRole('button', { name: '下一页', exact: true }));
  expect(window.confirm).toHaveBeenCalledTimes(6);
  expect((screen.getByLabelText('搜索本地记录') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('机构范围') as HTMLSelectElement).value).toBe('');
  expect((screen.getByLabelText('回收站') as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText('第 1 / 2 页')).toBeTruthy();
  expect(screen.getByDisplayValue('Synthetic unsaved draft')).toBeTruthy();
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '下一页', exact: true }));
  expect(screen.getByText('第 2 / 2 页')).toBeTruthy(); expectClean();
});
it.each(['organization', 'skills'] as const)('%s: changing record, opening new, and delete confirmation ask before replacing input', async (kind) => {
  await mount(kind, true); change(kind);
  const record = kind === 'organization' ? 'Synthetic B' : 'Synthetic skill';
  const card = screen.getByRole('article', { name: record });
  fireEvent.click(within(card).getByRole('button', { name: kind === 'organization' ? '编辑机构' : `编辑 ${record}` }));
  fireEvent.click(screen.getByRole('button', { name: configurations[kind].create }));
  fireEvent.click(within(card).getByRole('button', { name: kind === 'organization' ? '移入回收站' : `删除 ${record}` }));
  expect(window.confirm).toHaveBeenCalledTimes(3);
  expect(screen.getByDisplayValue('Synthetic unsaved draft')).toBeTruthy();
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(within(card).getByRole('button', { name: kind === 'organization' ? '编辑机构' : `编辑 ${record}` }));
  expect(screen.getByDisplayValue(record)).toBeTruthy(); expectClean();
});
it('automation: section change is guarded while filtering and read refresh preserve the editor', async () => {
  await mount('skills'); change('skills');
  fireEvent.change(screen.getByLabelText('搜索自动化名称'), { target: { value: 'no results' } });
  fireEvent.click(screen.getByLabelText('查看已删除'));
  expect(screen.getByDisplayValue('Synthetic unsaved draft')).toBeTruthy();
  expect(window.confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '数据源', exact: true }));
  expect(screen.getByRole('dialog', { name: '新建技能' })).toBeTruthy();
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '数据源', exact: true }));
  expect(screen.queryByRole('dialog')).toBeNull(); expectClean();
});
it.each(['organization', 'skills'] as const)('%s: successful in-flight save for discarded editor cannot close a newer draft', async (kind) => {
  await mount(kind); change(kind);
  let resolve!: (record: any) => void;
  vi.mocked(configurations[kind].write()).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  save(kind);
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '关闭', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: configurations[kind].create }));
  change(kind, 'Newer draft');
  await act(async () => resolve(kind === 'organization' ? organization() : skill));
  expect(screen.getByDisplayValue('Newer draft')).toBeTruthy();
  vi.mocked(window.confirm).mockReturnValue(false);
  expect(allowLeavingUnsavedWork()).toBe(false);
});
it('organization: conflict reload asks only when the fetched replacement is ready and retains newer input on Stay', async () => {
  await mount('organization', true); change('organization');
  vi.mocked(organizationApi.update).mockRejectedValueOnce(new ApiError({ code: 'CONFLICT', message: 'Synthetic conflict', retryable: false }));
  save('organization');
  const reload = await screen.findByRole('button', { name: '重新载入最新版本（放弃未保存修改）' });
  let resolve!: (record: any) => void;
  vi.mocked(organizationApi.get).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  fireEvent.click(reload); change('organization', 'Typed while fetching');
  expect(window.confirm).not.toHaveBeenCalled();
  await act(async () => resolve(organization('Latest server name')));
  expect(window.confirm).toHaveBeenCalledOnce();
  expect(screen.getByDisplayValue('Typed while fetching')).toBeTruthy();
  vi.mocked(window.confirm).mockReturnValue(true);
  await act(async () => { fireEvent.click(reload); });
  await screen.findByDisplayValue('Latest server name');
  // This legacy mock supplies no durable command proof. Reading a replacement
  // clears the editor's dirty state but cannot clear the original unknown write.
  vi.mocked(window.confirm).mockReturnValue(false);expect(allowLeavingUnsavedWork()).toBe(false);
  expect(screen.getByRole('button',{name:'重试原操作'})).toBeTruthy();
});
it('organization: failed conflict reload preserves the dirty draft', async () => {
  await mount('organization', true); change('organization');
  vi.mocked(organizationApi.update).mockRejectedValueOnce(new ApiError({ code: 'CONFLICT', message: 'Synthetic conflict', retryable: false }));
  save('organization');
  const reload = await screen.findByRole('button', { name: '重新载入最新版本（放弃未保存修改）' });
  vi.mocked(organizationApi.get).mockRejectedValueOnce(new Error('Synthetic reload failure'));
  fireEvent.click(reload); await within(screen.getByRole('dialog')).findByText(/无法重新载入：Synthetic reload failure/);
  expect(screen.getByDisplayValue('Synthetic unsaved draft')).toBeTruthy();
  expect(allowLeavingUnsavedWork()).toBe(false);
});
it.each(['organization', 'skills'] as const)('%s: application route, route refresh and Back/Forward Stay preserve draft and epoch', async (kind) => {
  const { life } = await mount(kind, false, true); act(()=>prepareOwnedHistory('/?page=home')); change(kind);
  const page = kind === 'organization' ? 'organization' : 'automation';
  fireEvent.click(screen.getByRole('button', { name: '首页', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '替换当前路由并刷新' }));
  await historyBack(); await historyBack();
  expect(window.confirm).toHaveBeenCalledTimes(4);
  expect(location.search).toBe(`?page=${page}`);
  expect(life.epoch).toBe(0);
  expect(screen.getByDisplayValue('Synthetic unsaved draft')).toBeTruthy();
});
it.each(['organization', 'skills'] as const)('%s: accepted browser history asks once across router and manager, then clears guard', async (kind) => {
  const { life } = await mount(kind, false, true); change(kind);
  vi.mocked(window.confirm).mockReturnValue(true);
  act(() => { history.replaceState(null, '', '/?page=home'); window.dispatchEvent(new PopStateEvent('popstate')); });
  expect(window.confirm).toHaveBeenCalledOnce(); expect(life.epoch).toBe(1);
  expect(screen.queryByRole('dialog')).toBeNull(); expectClean();
});
it.each(['organization', 'skills'] as const)('%s: standalone actual history Stay restores entry and does not discard inputs', async (kind) => {
  await mount(kind); const original = location.href; act(()=>prepareOwnedHistory('#synthetic')); change(kind);
  await historyBack();
  expect(location.href).toBe(original); expect(screen.getByDisplayValue('Synthetic unsaved draft')).toBeTruthy();
  await historyBack();
  expect(location.href).toBe(original); expect(window.confirm).toHaveBeenCalledTimes(2);
  vi.mocked(window.confirm).mockReturnValue(true);
  await historyBack();
  expect(window.confirm).toHaveBeenCalledTimes(3); expect(screen.queryByRole('dialog')).toBeNull(); expectClean();
});
it('organization: tag-only input and incomplete target selections are dirty even before valid save data exists', async () => {
  await mount('organization'); fireEvent.change(screen.getByLabelText('标签'), { target: { value: 'unfinished, ' } });
  expect(allowLeavingUnsavedWork()).toBe(false);
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '取消编辑' }));
  fireEvent.click(screen.getByRole('button', { name: '收藏与阅读', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '新建收藏' }));
  expectClean();
  fireEvent.change(screen.getByLabelText('目标类型'), { target: { value: 'workspace' } });
  vi.mocked(window.confirm).mockReturnValue(false); expect(allowLeavingUnsavedWork()).toBe(false);
  fireEvent.change(screen.getByLabelText('目标类型'), { target: { value: 'organization' } }); expectClean();
});
it('organization: seeded create defaults remain clean without regenerating time defaults', async () => {
  await mount('organization'); fireEvent.click(screen.getByRole('button', { name: '取消编辑' }));
  fireEvent.click(within(screen.getByRole('article', { name: 'Synthetic A' })).getByRole('button', { name: '添加人员' }));
  expect((screen.getByLabelText('所属机构') as HTMLSelectElement).value).toBe('org-a'); expectClean();
  fireEvent.click(screen.getByRole('button', { name: '取消编辑' }));
  fireEvent.click(screen.getByRole('button', { name: '会议与参会', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '新建会议' }));
  expectClean();
  fireEvent.click(screen.getByRole('button', { name: '刷新目录' }));
  await waitFor(() => expect((screen.getByRole('button', { name: '新建会议' }) as HTMLButtonElement).disabled).toBe(false));
  expectClean();
});
it.each(formKinds)('%s: beforeunload is cancelled only while dirty and cleanup removes its marker (no browser guarantee)', async (kind) => {
  const { unmount } = await mount(kind);
  const clean = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(clean); expect(clean.defaultPrevented).toBe(false);
  change(kind); const dirty = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(dirty); expect(dirty.defaultPrevented).toBe(true);
  unmount(); const removed = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(removed); expect(removed.defaultPrevented).toBe(false); expectClean();
});


const serviceRecord = (revision = 1, deletedAt: string | null = null) => ({
  ...base, id: 'service-a', kind: 'service-record', revision, deletedAt,
  data: { organizationId: 'org-a', contactId: null, activity: 'call', occurredAt: stamp,
    summary: revision === 1 ? 'Synthetic service fact' : 'Updated service fact', notes: '', source: null },
});
async function mountProjection(shell = false) {
  let record = serviceRecord();
  vi.mocked(organizationApi.list).mockImplementation(async ({ kind }) => ({ items: kind === 'organization' ? orgs : kind === 'service-record' ? [record] : [], nextOffset: null }) as any);
  vi.spyOn(organizationApi, 'serviceStatistics').mockResolvedValue({ total: 0, byActivity: {}, byOrganization: [], events: [] } as any);
  const legacyPreview=vi.spyOn(serviceRecordBridgeApi,'preview');
  const legacyImport=vi.spyOn(serviceRecordBridgeApi,'import');
  const fetch=vi.fn(async(url:RequestInfo|URL)=>{
    const route=String(url).split('/').at(-1);
    if(route==='scope')return json({scope:reportScope});
    if(route==='previewServiceRecord')return json({...v2Preview,
      source:{id:record.id,revision:record.revision,recordJson:JSON.stringify(record),sha256:createHash('sha256').update(readerCanonical(record)).digest('hex')},
      customerPin:{organizationId:'org-a',contactId:null,organizationRevision:1,contactRevision:null},
      projection:{customer:{organizationId:'org-a',contactId:null},kind:'call',occurredAt:stamp,summary:record.data.summary},
    });
    if(route==='inspectSource')return json({scope:reportScope,pin:synthetic});
    throw Error(`Unexpected v2 guard route ${route}`);
  });
  vi.stubGlobal('fetch',fetch);
  const host=new OrganizationWriteHost();projectionHosts.push(host);host.activate();host.setAuthority('b'.repeat(64),true);
  const life = new OrdinaryRequestLifetime();
  history.replaceState(null, '', '/?page=organization');
  render(shell ? <OrdinaryNavigationShell lifetime={life} organizationWriteHost={host} /> : <OrganizationHostView host={host} visible routeEpoch={0}/>);
  await waitFor(() => expect((screen.getByRole('button', { name: '新建机构' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '客户与服务', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: /^服务记录 / }));
  fireEvent.click(screen.getByRole('button', { name: '预览计入月报' }));
  await screen.findByText('确认来源投影');
  fireEvent.change(screen.getByLabelText('投影活动状态'), { target: { value: 'reported-completed' } });
  fireEvent.change(screen.getByLabelText('投影文档来源'), { target: { value: 'synthetic-doc' } });
  await screen.findByText('来源版本已核验；保存时仍会重新检查可用性。');
  expect(legacyPreview).not.toHaveBeenCalled();expect(legacyImport).not.toHaveBeenCalled();
  return { life, host, replace: (next: ReturnType<typeof serviceRecord>) => { record = next; } };
}
function expectProjectionDraft() {
  expect((screen.getByLabelText('投影活动状态') as HTMLSelectElement).value).toBe('reported-completed');
  expect((screen.getByLabelText('投影文档来源') as HTMLSelectElement).value).toBe('synthetic-doc');
}
it('embedded projection: section and search Stay preserve choices; explicit section discard clears them', async () => {
  await mountProjection();
  fireEvent.click(screen.getByRole('button', { name: '机构与人员', exact: true }));
  fireEvent.change(screen.getByLabelText('搜索本地记录'), { target: { value: 'hide the row' } });
  expect(window.confirm).toHaveBeenCalledTimes(2); expectProjectionDraft();
  expect((screen.getByLabelText('搜索本地记录') as HTMLInputElement).value).toBe('');
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '机构与人员', exact: true }));
  expectClean();
  fireEvent.click(screen.getByRole('button', { name: '客户与服务', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: /^服务记录 / }));
  expect(screen.queryByText('确认来源投影')).toBeNull();
});
it('embedded projection: unchanged directory refresh retains choices without a prompt', async () => {
  await mountProjection(); fireEvent.click(screen.getByRole('button', { name: '刷新目录' }));
  await waitFor(() => expect((screen.getByRole('button', { name: '新建服务记录' }) as HTMLButtonElement).disabled).toBe(false));
  expectProjectionDraft(); expect(window.confirm).not.toHaveBeenCalled();
});
it.each(['updated', 'deleted'] as const)('embedded projection: a %s server record cannot replace the dirty panel until approved', async (change) => {
  const { replace } = await mountProjection();
  replace(serviceRecord(2, change === 'deleted' ? stamp : null));
  fireEvent.click(screen.getByRole('button', { name: '刷新目录' }));
  await screen.findByText(/目录更新会替换未保存的月报投影选择/);
  expect(window.confirm).toHaveBeenCalledOnce(); expectProjectionDraft();
  expect(screen.queryByRole('article', { name: 'Updated service fact' })).toBeNull();
  vi.mocked(window.confirm).mockReturnValue(true);
  // Flush the accepted refresh and passive guard cleanup before asserting no marker.
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新目录' })); });
  await waitFor(() => expect(screen.queryByText('确认来源投影')).toBeNull());
  if (change === 'updated') expect(screen.getByRole('article', { name: 'Updated service fact' })).toBeTruthy();
  else expect(screen.queryByRole('article', { name: 'Synthetic service fact' })).toBeNull();
  expectClean();
});
it('embedded projection: opening an editor asks first and accepted discard clears the old projection immediately', async () => {
  await mountProjection(); fireEvent.click(screen.getByRole('button', { name: '编辑服务记录', exact: true }));
  expect(screen.queryByRole('dialog')).toBeNull(); expectProjectionDraft();
  vi.mocked(window.confirm).mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: '编辑服务记录', exact: true }));
  expect(screen.getByRole('dialog', { name: '编辑服务记录' })).toBeTruthy();
  expect(screen.queryByText('确认来源投影')).toBeNull(); expectClean();
});
it('embedded projection: ordinary route Stay preserves input and accepted navigation cleans markers', async () => {
  const { life } = await mountProjection(true);
  fireEvent.click(screen.getByRole('button', { name: '首页', exact: true }));
  expectProjectionDraft(); expect(life.epoch).toBe(0);
  vi.mocked(window.confirm).mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: '首页', exact: true }));
  expect(life.epoch).toBe(1); expect(screen.queryByText('确认来源投影')).toBeNull(); expectClean();
});

it('embedded v2 projection: changed clean preview is invalidated without a discard prompt',async()=>{
 const {host,replace}=await mountProjection();
 await act(async()=>{host.projection!.discardUnsubmittedDraft();await host.projection!.preview('service-a');});
 vi.mocked(window.confirm).mockClear();replace(serviceRecord(2));fireEvent.click(screen.getByRole('button',{name:'刷新目录'}));
 await screen.findByRole('article',{name:'Updated service fact'});expect(screen.queryByText('确认来源投影')).toBeNull();expect(host.projection!.state.preview).toBeNull();expectClean();
});
it('embedded v2 projection: accepted section and editor changes retain uncertain exact submission',async()=>{
 const {host}=await mountProjection();const fetch=vi.mocked(globalThis.fetch),normal=fetch.getMockImplementation()!;
 fetch.mockImplementation(async(url,init)=>String(url).endsWith('/importServiceRecord')?json({},500):normal(url,init));
 await act(async()=>{await host.projection!.submit();});const pending=host.projection!.state.pending;expect(pending).not.toBeNull();vi.mocked(window.confirm).mockReturnValue(true);
 fireEvent.click(screen.getByRole('button',{name:'机构与人员',exact:true}));expect(host.projection!.state.pending).toBe(pending);
 fireEvent.click(screen.getByRole('button',{name:'客户与服务',exact:true}));fireEvent.click(screen.getByRole('button',{name:/^服务记录 /}));
 fireEvent.click(screen.getByRole('button',{name:'编辑服务记录',exact:true}));expect(host.projection!.state.pending).toBe(pending);
 expect(screen.getByRole('dialog',{name:'编辑服务记录'})).toBeTruthy();
});

function prepareOwnedHistory(target:string){const current=location.href;writeUnsavedHistory(target);writeUnsavedHistory(current)}
async function historyBack(){await act(async()=>{history.back();await new Promise(r=>setTimeout(r,65))})}
