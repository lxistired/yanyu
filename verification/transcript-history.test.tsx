import {fixtureStoreHeaders, fixtureStoreUrl} from './transcription-store-fixture';
import {TranscriptionStoreBoundary} from '../candidate/src/components/TranscriptionStoreBoundary';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {TranscriptEditor} from '../candidate/src/components/TranscriptEditor';
afterEach(()=>{cleanup();vi.unstubAllGlobals()});
function setup({legacyGap=false,conflict=false,failHistory=false}={}){
 let saved={raw:'原始文本',corrected:'第二次校对' as string|null,revision:legacyGap?8:3,updated:'2026-10-15T01:00:00Z'};
 const versions=[{revision:saved.revision,text:'第二次校对' as string|null,kind:'correction',updated:saved.updated,sourceRevision:null as number|null},{revision:legacyGap?7:2,text:'第一次校对',kind:legacyGap?'migration':'correction',updated:saved.updated,sourceRevision:null},...legacyGap?[]:[{revision:1,text:null,kind:'original',updated:saved.updated,sourceRevision:null}]];
 const f=vi.fn(async(url:string,options?:RequestInit)=>{
  if(url.endsWith('/history'))return failHistory?{headers:fixtureStoreHeaders(),ok:false,json:async()=>({error:{message:'历史读取失败'}})}:{headers:fixtureStoreHeaders(),ok:true,json:async()=>({versions:versions.map(({text,...metadata})=>metadata),earliestRevision:legacyGap?7:1,legacyGap})};
  if(url.includes('/history/'))return {headers:fixtureStoreHeaders(),ok:true,json:async()=>versions.find(v=>v.revision===Number(url.split('/').pop()))};
  if(url.endsWith('/transcript-restore')){
   const body=JSON.parse(options!.body as string);
   if(conflict)return {headers:fixtureStoreHeaders(),ok:false,json:async()=>({error:{message:'版本已变化，请载入最新版本'}})};
   expect(body.expectedRevision).toBe(saved.revision);
   const source=versions.find(v=>v.revision===body.sourceRevision)!;
   saved={...saved,corrected:source.text,revision:saved.revision+1};versions.unshift({revision:saved.revision,text:source.text,kind:'restore',sourceRevision:source.revision,updated:saved.updated});
  }
  return {headers:fixtureStoreHeaders(),ok:true,json:async()=>({...saved})};
 });vi.stubGlobal('fetch',f);render(<TranscriptionStoreBoundary><TranscriptEditor id="history-test" raw="预览"/></TranscriptionStoreBoundary>);return {f,versions};
}
async function openVersion(revision:number){await screen.findByLabelText('校对文本');fireEvent.click(screen.getByText('查看版本历史'));fireEvent.click(await screen.findByText(`查看版本 ${revision}`));await screen.findByLabelText('历史版本文本（只读）')}
it('loads history only on request and previews prior text read-only without replacing dirty draft',async()=>{
 const {f}=setup();await screen.findByDisplayValue('第二次校对');expect(f).toHaveBeenCalledTimes(1);
 fireEvent.change(screen.getByLabelText('校对文本'),{target:{value:'我的草稿'}});await openVersion(2);
 const preview=screen.getByLabelText('历史版本文本（只读）') as HTMLTextAreaElement;expect(preview.value).toBe('第一次校对');expect(preview.readOnly).toBe(true);expect((screen.getByLabelText('校对文本') as HTMLTextAreaElement).value).toBe('我的草稿');
});
it('requires explicit restore confirmation, warns about dirty draft, and appends a new revision',async()=>{
 const {f,versions}=setup();await openVersion(2);fireEvent.change(screen.getByLabelText('校对文本'),{target:{value:'我的草稿'}});
 fireEvent.click(screen.getByText('恢复此版本为新版本'));expect(screen.getByRole('alertdialog').textContent).toContain('未保存修改将被替换');fireEvent.click(screen.getByText('取消'));
 expect(f.mock.calls.filter(([url])=>url.endsWith('/transcript-restore'))).toHaveLength(0);expect((screen.getByLabelText('校对文本') as HTMLTextAreaElement).value).toBe('我的草稿');
 fireEvent.click(screen.getByText('恢复此版本为新版本'));fireEvent.click(screen.getByText('确认创建新版本'));
 await screen.findByText(/已将历史版本 2 恢复为新版本 4/);await screen.findByText('查看版本 4');expect(versions.map(v=>v.revision)).toEqual([4,3,2,1]);expect((screen.getByLabelText('校对文本') as HTMLTextAreaElement).value).toBe('第一次校对');
});
it('stale restore keeps unsaved draft and current revision intact',async()=>{
 setup({conflict:true});await openVersion(2);fireEvent.change(screen.getByLabelText('校对文本'),{target:{value:'保留草稿'}});fireEvent.click(screen.getByText('恢复此版本为新版本'));fireEvent.click(screen.getByText('确认创建新版本'));
 await screen.findByRole('alert');expect((screen.getByLabelText('校对文本') as HTMLTextAreaElement).value).toBe('保留草稿');expect(screen.getByText(/已保存版本 3/)).toBeTruthy();
});
it('renders null-text original snapshot and restores it as a new revision',async()=>{
 setup();await openVersion(1);expect((screen.getByLabelText('历史版本文本（只读）') as HTMLTextAreaElement).value).toBe('原始文本');fireEvent.click(screen.getByText('恢复此版本为新版本'));fireEvent.click(screen.getByText('确认创建新版本'));
 await screen.findByText(/已将历史版本 1 恢复为新版本 4/);expect((screen.getByLabelText('校对文本') as HTMLTextAreaElement).value).toBe('原始文本');
});
it('discloses missing migrated history rather than inventing earlier revisions',async()=>{
 setup({legacyGap:true});await openVersion(7);expect(screen.getByText(/更早的历史未被记录/)).toBeTruthy();expect(screen.queryByText('查看版本 0')).toBeNull();expect(screen.getByText('最早可用版本：7')).toBeTruthy();
});
it('history failure leaves editable current text available and exposes retry',async()=>{
 const {f}=setup({failHistory:true});await screen.findByDisplayValue('第二次校对');fireEvent.click(screen.getByText('查看版本历史'));await screen.findByText('历史读取失败');fireEvent.click(screen.getByText('刷新版本历史'));await waitFor(()=>expect(f.mock.calls.filter(([url])=>url.endsWith('/history'))).toHaveLength(2));expect((screen.getByLabelText('校对文本') as HTMLTextAreaElement).value).toBe('第二次校对');
});

beforeEach(() => { history.replaceState(null, '', fixtureStoreUrl()); });
