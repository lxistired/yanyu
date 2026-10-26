import {fixtureStoreHeaders, fixtureStoreUrl} from './transcription-store-fixture';
import {beforeEach,afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {LocalTranscription} from '../candidate/src/components/LocalTranscription';

// UNEXECUTED source-only regression proposal. Synthetic transport, no audio or real backend.
const seed = {id: 'one', filename: 'synthetic.wav', title: 'Synthetic', library_revision: 2,
  deleted_at: null, status: 'cancelled', created: '2026-10-21T00:00:00Z', error: null, result: null};
const ok = (data: unknown) => ({headers:fixtureStoreHeaders(),ok: true, status: 200, json: async () => data});
function setup(status: string, deletedAt: string | null = null) {
  let current = {...seed, status, deleted_at: deletedAt};
  let reject = false;
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      if (reject) return {headers:fixtureStoreHeaders(),ok: false, status: 409, json: async () => ({error: {message: 'Synthetic conflict'}})};
      return ok({});
    }
    return ok({jobs: [current], model: null, total: 1, hasMore: false,
      activeJobCount: current.status === 'processing' ? 1 : 0});
  });
  vi.stubGlobal('fetch', fetcher);
  return {fetcher, update: (next: string) => {current = {...current, status: next};},
    reject: () => {reject = true;},
    writes: () => fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')};
}
const button = (name: string) => screen.getByRole('button', {name, exact: true}) as HTMLButtonElement;
function unloadBlocked() {
  const event = new Event('beforeunload', {cancelable: true});
  window.dispatchEvent(event); return event.defaultPrevented;
}
afterEach(() => {cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, '', '/');});

it.each(['interrupted', 'processing'])('initial %s cannot open trash or trigger cancellation/resume', async status => {
  const transport = setup(status); render(<LocalTranscription/>);
  await screen.findByRole('heading', {name: 'Synthetic'});
  expect(button('移到回收站').disabled).toBe(true);
  fireEvent.click(button('移到回收站'));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  if (status === 'interrupted') {
    expect(screen.getByText(/中断任务不能移到回收站/)).toBeTruthy();
    expect(button('从已保存分段继续').disabled).toBe(false);
    expect(button('取消并删除临时音频').disabled).toBe(false);
  }
  expect(transport.writes()).toHaveLength(0);
});

it.each(['interrupted', 'processing'])('pending confirmation blocks both entries after polling becomes %s', async status => {
  const transport = setup('cancelled'); render(<LocalTranscription/>);
  fireEvent.click(await screen.findByRole('button', {name: '移到回收站', exact: true}));
  expect(button('确认移到回收站').disabled).toBe(false);
  transport.update(status);
  await waitFor(() => expect(button('确认移到回收站').disabled).toBe(true), {timeout: 2500});
  expect(button('移到回收站').disabled).toBe(true);
  fireEvent.click(button('确认移到回收站'));
  expect(transport.writes()).toHaveLength(0);
  fireEvent.click(button('保留转写'));
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it.each(['failed', 'completed'])('retained old %s row preserves its draft and blocks pending trash on interruption', async status => {
  const transport = setup(status); render(<LocalTranscription/>);
  fireEvent.click(await screen.findByRole('button', {name: '重命名'}));
  const title = screen.getByLabelText('转写标题') as HTMLInputElement;
  fireEvent.change(title, {target: {value: 'Unsaved title'}});
  fireEvent.click(button('移到回收站'));
  transport.update('interrupted');
  await screen.findByText(/暂留记录的状态可能已变化/, {}, {timeout: 2500});
  expect(button('移到回收站').disabled).toBe(true);
  expect(button('确认移到回收站').disabled).toBe(true);
  fireEvent.click(button('确认移到回收站'));
  expect(title.value).toBe('Unsaved title'); expect(unloadBlocked()).toBe(true);
  expect(button('保存标题').disabled).toBe(false); expect(button('取消重命名').disabled).toBe(false);
  expect(transport.writes()).toHaveLength(0);
  fireEvent.click(button('保留转写'));
  expect(title.value).toBe('Unsaved title'); expect(unloadBlocked()).toBe(true);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(button('取消重命名'));
  await screen.findByText(/中断任务不能移到回收站/, {}, {timeout: 2500});
  expect(screen.queryByText(/暂留记录的状态可能已变化/)).toBeNull();
  expect(transport.writes()).toHaveLength(0);
});

it.each(['completed', 'cancelled', 'failed'])('normal %s trash retains explicit confirmation and captured revision', async status => {
  const transport = setup(status); render(<LocalTranscription/>);
  await screen.findByRole('heading', {name: 'Synthetic'});
  expect(button('移到回收站').disabled).toBe(false);
  fireEvent.click(button('移到回收站'));
  expect(transport.writes()).toHaveLength(0);
  expect(button('确认移到回收站').disabled).toBe(false);
  fireEvent.click(button('确认移到回收站'));
  await waitFor(() => expect(transport.writes()).toHaveLength(1));
  const [url, options] = transport.writes()[0];
  expect(url).toBe('/api/local-asr/jobs/one/trash');
  expect(JSON.parse(options!.body as string)).toEqual({expectedRevision: 2});
});

it('existing conflict continues blocking both trash entries without clearing a dirty title', async () => {
  const transport = setup('cancelled'); transport.reject(); render(<LocalTranscription/>);
  fireEvent.click(await screen.findByRole('button', {name: '重命名'}));
  const title = screen.getByLabelText('转写标题') as HTMLInputElement;
  fireEvent.change(title, {target: {value: 'Unsaved title'}});
  fireEvent.click(button('移到回收站')); fireEvent.click(button('确认移到回收站'));
  await screen.findByText('Synthetic conflict');
  expect(button('移到回收站').disabled).toBe(true);
  expect(button('确认移到回收站').disabled).toBe(true);
  expect(button('使用最新记录').disabled).toBe(false);
  expect(title.value).toBe('Unsaved title'); expect(unloadBlocked()).toBe(true);
  expect(transport.writes()).toHaveLength(1);
});

it('only explicit cancellation followed by a terminal poll re-enables trash', async () => {
  const transport = setup('interrupted'); render(<LocalTranscription/>);
  await screen.findByRole('heading', {name: 'Synthetic'});
  expect(button('移到回收站').disabled).toBe(true);
  expect(transport.writes()).toHaveLength(0);
  fireEvent.click(button('取消并删除临时音频'));
  await waitFor(() => expect(transport.writes()).toHaveLength(1));
  expect(transport.writes()[0][0]).toBe('/api/local-asr/jobs/one/cancel');
  // A successful cancel acknowledgement alone is not a terminal status observation.
  expect(button('移到回收站').disabled).toBe(true);
  transport.update('cancelled');
  await waitFor(() => expect(button('移到回收站').disabled).toBe(false), {timeout: 2500});
  expect(transport.writes()).toHaveLength(1);
  fireEvent.click(button('移到回收站'));
  expect(button('确认移到回收站').disabled).toBe(false);
  expect(transport.writes()).toHaveLength(1);
  fireEvent.click(button('确认移到回收站'));
  await waitFor(() => expect(transport.writes()).toHaveLength(2));
  expect(transport.writes()[1][0]).toBe('/api/local-asr/jobs/one/trash');
  expect(JSON.parse(transport.writes()[1][1]!.body as string)).toEqual({expectedRevision: 2});
});

it.each(['cancelled', 'interrupted'])('restore remains unaffected by the trash-only restriction for %s', async status => {
  // Interrupted+trashed is deliberately defensive synthetic input, not a claimed reachable server state.
  history.replaceState(null, '', fixtureStoreUrl('/'));
  const transport = setup(status, '2026-10-21T00:00:00Z'); render(<LocalTranscription/>);
  await screen.findByRole('heading', {name: 'Synthetic'});
  expect(button('恢复转写').disabled).toBe(false);
  expect(screen.queryByRole('button', {name: '移到回收站', exact: true})).toBeNull();
  expect(transport.writes()).toHaveLength(0);
  fireEvent.click(button('恢复转写'));
  await waitFor(() => expect(transport.writes()).toHaveLength(1));
  expect(transport.writes()[0][0]).toBe('/api/local-asr/jobs/one/restore');
  expect(JSON.parse(transport.writes()[0][1]!.body as string)).toEqual({expectedRevision: 2});
});

beforeEach(() => { history.replaceState(null, '', fixtureStoreUrl()); });
