import {beforeEach, afterEach, it, expect, vi} from 'vitest';
import {render, screen, fireEvent, cleanup, act, within} from '@testing-library/react';
import {LocalTranscription} from '../candidate/src/components/LocalTranscription';
import {fixtureStoreHeaders, fixtureStoreUrl} from './transcription-store-fixture';

const hint = '已达到当前翻页范围，仍有更多匹配记录。请缩小搜索或筛选范围后继续查看。';
const model = {maxSeconds:7200,maxBytes:268435456,chunkSeconds:30,overlapSeconds:1,deadlineSeconds:14400};
// Synthetic metadata only: no real database, recordings, provider or browser.
function setup(initialTotal = 1011) {
  let total = initialTotal;
  const rows = Array.from({length:1011}, (_, index) => ({
    id:`12345678-1234-1234-1234-${String(index).padStart(12,'0')}`,
    filename:`synthetic-${index}.wav`, title:`Synthetic row ${index}`, library_revision:0,
    deleted_at:null, status:'cancelled', created:'2026-10-15T00:00:00Z', error:null, result:null,
  }));
  const fetcher = vi.fn(async (url:string) => {
    const parsed = new URL(url,'http://localhost');
    if (parsed.pathname !== '/api/local-asr/jobs') throw Error(`Unexpected request: ${parsed.pathname}`);
    const offset = Number(parsed.searchParams.get('offset'));
    // Mirror the existing backend ceiling; any escaped request fails the test.
    expect(offset).toBeLessThanOrEqual(1000);
    expect(parsed.searchParams.get('limit')).toBe('10');
    const matches = rows.slice(0,total).filter(row => row.title.includes(parsed.searchParams.get('q') || ''));
    return {ok:true,status:200,headers:fixtureStoreHeaders(),json:async () => ({jobs:matches.slice(offset,offset+10),model,total:matches.length,offset,limit:10,hasMore:offset+10<matches.length,activeJobCount:0})};
  });
  vi.stubGlobal('fetch', fetcher);
  const requests = () => fetcher.mock.calls.map(([url]) => new URL(url,'http://localhost').searchParams);
  return {requests, setTotal:(value:number) => {total=value;}};
}
const button = (name:string) => screen.getByText(name,{selector:'button',exact:true}) as HTMLButtonElement;
async function click(name:string) {await act(async () => {fireEvent.click(button(name));});}
async function reach(offset:number) {
  for (let current=0;current<offset;current+=10) {
    expect(button('下一页').disabled).toBe(false);
    await click('下一页');
    expect(screen.getByText(`共 1011 条记录 · 第 ${(current+10)/10+1} 页`)).toBeTruthy();
  }
  expect(screen.getByText(`共 1011 条记录 · 第 ${offset/10+1} 页`)).toBeTruthy();
}
beforeEach(() => {vi.useFakeTimers();history.replaceState(null,'',fixtureStoreUrl());});
afterEach(() => {cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();history.replaceState(null,'','/');});

it('allows 990 to 1000, blocks 1010 without clearing rows or drafts, and keeps polling the valid page', async () => {
  const fixture = setup();
  const confirm = vi.spyOn(window,'confirm').mockReturnValue(false);
  await act(async () => {render(<LocalTranscription/>);});
  await reach(990);
  expect(screen.queryByText(hint)).toBeNull();
  await click('下一页');
  expect(fixture.requests().at(-1)?.get('offset')).toBe('1000');
  expect(button('下一页').disabled).toBe(true);
  expect(screen.getByText(hint)).toBeTruthy();
  const row = screen.getByRole('heading',{name:'Synthetic row 1000'}).closest('article')!;
  fireEvent.click(within(row).getByText('重命名'));
  fireEvent.change(within(row).getByLabelText('转写标题'),{target:{value:'Unsaved boundary title'}});
  const before = fixture.requests().length;
  await click('下一页');
  expect(fixture.requests()).toHaveLength(before);
  expect(confirm).not.toHaveBeenCalled();
  for (let poll=0;poll<3;poll++) await act(async () => {await vi.advanceTimersByTimeAsync(1000);});
  expect(fixture.requests()).toHaveLength(before+3);
  expect(fixture.requests().slice(before).map(p=>p.get('offset'))).toEqual(['1000','1000','1000']);
  expect(screen.getByRole('heading',{name:'Synthetic row 1009'})).toBeTruthy();
  expect((screen.getByLabelText('转写标题') as HTMLInputElement).value).toBe('Unsaved boundary title');
  await click('上一页');
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(fixture.requests().at(-1)?.get('offset')).toBe('1000');
  confirm.mockReturnValue(true);
  await click('上一页');
  expect(fixture.requests().at(-1)?.get('offset')).toBe('990');
  expect(button('下一页').disabled).toBe(false);
  expect(screen.queryByText(hint)).toBeNull();
}, 30000);

it('narrows from the cap to page zero and clears search without losing the bounded pagination policy', async () => {
  const fixture = setup();
  await act(async () => {render(<LocalTranscription/>);});
  await reach(1000);
  fireEvent.change(screen.getByLabelText('搜索转写'),{target:{value:'Synthetic row 1000'}});
  await click('搜索');
  expect(fixture.requests().at(-1)?.get('offset')).toBe('0');
  expect(fixture.requests().at(-1)?.get('q')).toBe('Synthetic row 1000');
  expect(screen.getByText('共 1 条记录 · 第 1 页')).toBeTruthy();
  expect(screen.queryByText(hint)).toBeNull();
  expect(button('下一页').disabled).toBe(true);
  await click('清除搜索');
  expect(fixture.requests().at(-1)?.get('q')).toBe('');
  expect(fixture.requests().at(-1)?.get('offset')).toBe('0');
  expect(button('下一页').disabled).toBe(false);
}, 30000);

it('removes the overflow hint for exactly 1010 matches and recovers a reachable page when polling sees fewer records', async () => {
  const fixture = setup();
  await act(async () => {render(<LocalTranscription/>);});
  await reach(1000);
  fixture.setTotal(1010);
  await act(async () => {await vi.advanceTimersByTimeAsync(1000);});
  expect(screen.getByText('共 1010 条记录 · 第 101 页')).toBeTruthy();
  expect(screen.queryByText(hint)).toBeNull();
  expect(button('下一页').disabled).toBe(true);
  fixture.setTotal(1011);
  await act(async () => {await vi.advanceTimersByTimeAsync(1000);});
  expect(screen.getByText(hint)).toBeTruthy();
  expect(button('下一页').disabled).toBe(true);
  fixture.setTotal(999);
  await act(async () => {await vi.advanceTimersByTimeAsync(1000);});
  expect(fixture.requests().at(-1)?.get('offset')).toBe('990');
  expect(screen.getByText('共 999 条记录 · 第 100 页')).toBeTruthy();
  expect(screen.getByRole('heading',{name:'Synthetic row 998'})).toBeTruthy();
  expect(screen.queryByText(hint)).toBeNull();
}, 30000);
