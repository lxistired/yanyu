import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {TranscriptionStoreBoundary} from '../candidate/src/components/TranscriptionStoreBoundary';
import {TranscriptEditor} from '../candidate/src/components/TranscriptEditor';
import {countTranscriptMatches,transcriptMatchRange,MAX_SEARCH_CODE_UNITS} from '../candidate/src/components/transcript-matches';
import {hasUnsavedWork} from '../candidate/src/components/unsaved-work';
import {fixtureStoreHeaders,fixtureStoreUrl} from './transcription-store-fixture';
const original={raw:'甲 hello 😀 hello 尾',corrected:null,revision:0,updated:null};
const ok=(data:unknown=original)=>({headers:fixtureStoreHeaders(),ok:true,json:async()=>data});
const field=()=>screen.getByLabelText('校对文本') as HTMLTextAreaElement;
const next=()=>screen.getByRole('button',{name:'下一处'}) as HTMLButtonElement;
const previous=()=>screen.getByRole('button',{name:'上一处'}) as HTMLButtonElement;
const query=(value:string)=>fireEvent.change(screen.getByLabelText('查找文字'),{target:{value}});
const selected=()=>field().value.slice(field().selectionStart,field().selectionEnd);
async function setup(data=original){const f=vi.fn().mockResolvedValue(ok(data));vi.stubGlobal('fetch',f);const view=render(<TranscriptionStoreBoundary><TranscriptEditor id="one" raw=""/></TranscriptionStoreBoundary>);await screen.findByLabelText('校对文本');return {f,view};}
beforeEach(()=>history.replaceState(null,'',fixtureStoreUrl()));
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals()});
it('literal scans count case-sensitive non-overlapping occurrences and return UTF-16 ranges',()=>{
 for(const [text,q,starts] of [['aaa','aa',[0]],['AAaa','aa',[2]],['中😀\r\n😀中','😀',[1,5]],['a.*a.*','.*',[1,4]],['abc','',[]],['abc','x',[]]] as [string,string,number[]][]){
  expect(countTranscriptMatches(text,q)).toBe(starts.length);
  starts.forEach((start,index)=>expect(transcriptMatchRange(text,q,index)).toEqual({start,end:start+q.length}));
  expect(transcriptMatchRange(text,q,starts.length)).toBeNull();
 }
 expect(transcriptMatchRange('aa','a',-1)).toBeNull();expect(transcriptMatchRange('aa','a',NaN)).toBeNull();
});
it('bounded search accepts its boundary and refuses oversize without truncating',()=>{
 const text='x'.repeat(MAX_SEARCH_CODE_UNITS);
 expect(countTranscriptMatches(text,'missing')).toBe(0);
 expect(transcriptMatchRange(text,'x',MAX_SEARCH_CODE_UNITS-1)).toEqual({start:MAX_SEARCH_CODE_UNITS-1,end:MAX_SEARCH_CODE_UNITS});
 expect(countTranscriptMatches(text+'x','x')).toBeNull();expect(transcriptMatchRange(text+'x','x',0)).toBeNull();expect(countTranscriptMatches('x',text+'x')).toBeNull();
});
it('query never steals focus; explicit cyclic actions select exact ranges without network, writes or open receipt',async()=>{
 const storage=vi.spyOn(Storage.prototype,'setItem');const {f}=await setup();const input=screen.getByLabelText('查找文字');input.focus();query('hello');expect(document.activeElement).toBe(input);expect(screen.getByText(/当前 0\/2/)).toBeTruthy();
 const count=f.mock.calls.length;
 fireEvent.click(next());expect(document.activeElement).toBe(field());expect([field().selectionStart,field().selectionEnd]).toEqual([2,7]);expect(selected()).toBe('hello');expect(screen.getByText(/当前 1\/2/)).toBeTruthy();
 fireEvent.click(next());expect(field().selectionStart).toBe(11);expect(screen.getByText(/当前 2\/2/)).toBeTruthy();
 fireEvent.click(next());expect(field().selectionStart).toBe(2);fireEvent.click(previous());expect(field().selectionStart).toBe(11);
 expect(f).toHaveBeenCalledTimes(count);expect(storage).not.toHaveBeenCalled();expect(field().value).toBe(original.raw);expect(hasUnsavedWork()).toBe(false);expect(screen.getByText('本次尚未通过此按钮打开正文')).toBeTruthy();
});
it('empty, absent and one-match states; first previous starts at last',async()=>{
 await setup();expect(next().disabled).toBe(true);expect(previous().disabled).toBe(true);query('absent');expect(next().disabled).toBe(true);expect(screen.getByText(/当前 0\/0/)).toBeTruthy();query('hello');fireEvent.click(previous());expect(field().selectionStart).toBe(11);
 query('😀');expect(screen.getByText(/当前 0\/1/)).toBeTruthy();fireEvent.click(previous());expect(selected()).toBe('😀');expect([field().selectionStart,field().selectionEnd]).toEqual([8,10]);fireEvent.click(next());expect(selected()).toBe('😀');
});
it('dirty draft, query edits and undo invalidate cursor without losing unsaved guard',async()=>{
 const {f}=await setup();query('hello');fireEvent.click(next());fireEvent.change(field(),{target:{value:'prefix '+original.raw}});expect(screen.getByText(/当前 0\/2/)).toBeTruthy();expect(hasUnsavedWork()).toBe(true);fireEvent.click(next());expect(field().selectionStart).toBe(9);expect(hasUnsavedWork()).toBe(true);expect(f).toHaveBeenCalledTimes(1);
 query('尾');fireEvent.click(next());query('hello');expect(screen.getByText(/当前 0\/2/)).toBeTruthy();fireEvent.click(previous());fireEvent.click(screen.getByText('撤销未保存修改'));expect(screen.getByText(/当前 0\/2/)).toBeTruthy();expect(hasUnsavedWork()).toBe(false);expect(field().value).toBe(original.raw);
});
it('successful save resets navigation even when text is unchanged by the response; reload failure keeps it unavailable',async()=>{
 const {f}=await setup();fireEvent.change(field(),{target:{value:'hello hello'}});query('hello');fireEvent.click(next());f.mockResolvedValueOnce(ok({...original,corrected:'hello hello',revision:1}));fireEvent.click(screen.getByText('保存校对'));await screen.findByText('校对文本已保存');expect(screen.getByText(/当前 0\/2/)).toBeTruthy();fireEvent.click(previous());
 f.mockRejectedValueOnce(Error('reload failed'));fireEvent.click(screen.getByText('载入最新版本'));await screen.findByText('reload failed');expect(next().disabled).toBe(true);expect(screen.getByText(/当前 0\/2/)).toBeTruthy();expect(field().value).toBe('hello hello');
 fireEvent.click(screen.getByText('载入最新版本'));await waitFor(()=>expect(next().disabled).toBe(false));expect(screen.getByText(/当前 0\/2/)).toBeTruthy();
});
it('confirmation blocks navigation and cancellation retains dirty cursor; accepting reload resets before resolution',async()=>{
 const {f}=await setup();fireEvent.change(field(),{target:{value:'hello hello'}});query('hello');fireEvent.click(next());fireEvent.click(screen.getByText('载入最新版本'));expect(next().disabled).toBe(true);fireEvent.click(next());expect(screen.getByText(/当前 1\/2/)).toBeTruthy();fireEvent.click(screen.getByText('取消'));expect(next().disabled).toBe(false);expect(hasUnsavedWork()).toBe(true);
 let resolve!:(value:ReturnType<typeof ok>)=>void;f.mockReturnValueOnce(new Promise(r=>resolve=r));fireEvent.click(screen.getByText('载入最新版本'));fireEvent.click(screen.getByText('确认替换'));expect(next().disabled).toBe(true);expect(screen.getByText(/当前 0\/2/)).toBeTruthy();await act(async()=>resolve(ok()));expect(next().disabled).toBe(false);
});
it('host disabling and store mismatch block selection without discarding the draft',async()=>{
 const {f,view}=await setup();query('hello');view.rerender(<TranscriptionStoreBoundary><TranscriptEditor id="one" raw="" explicitOpenDisabled/></TranscriptionStoreBoundary>);expect(next().disabled).toBe(true);view.rerender(<TranscriptionStoreBoundary><TranscriptEditor id="one" raw=""/></TranscriptionStoreBoundary>);
 fireEvent.change(field(),{target:{value:'hello keep'}});f.mockResolvedValueOnce({...ok(),headers:new Headers()});fireEvent.click(screen.getByText('保存校对'));await waitFor(()=>expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));expect(next().disabled).toBe(true);expect(field().value).toBe('hello keep');expect(hasUnsavedWork()).toBe(true);
});
it.each(['noop','throw','detached'])('failed %s focus does not announce selected match',async(mode)=>{
 await setup();query('hello');const target=field();if(mode==='detached')Object.defineProperty(target,'isConnected',{configurable:true,value:false});else vi.spyOn(target,'focus').mockImplementation(()=>{if(mode==='throw')throw Error('focus failure')});fireEvent.click(next());expect(screen.getByText(/当前 0\/2/)).toBeTruthy();
});
it('long content and normalized textarea line endings select the visible UTF-16 substring without editing source',async()=>{
 const raw='首😀\r\n'+'中'.repeat(10000)+'\r末😀';const {f}=await setup({...original,raw});query('😀');fireEvent.click(previous());expect(selected()).toBe('😀');expect(field().selectionEnd).toBe(field().value.length);fireEvent.click(next());expect(field().selectionStart).toBe(1);expect(hasUnsavedWork()).toBe(false);expect(f).toHaveBeenCalledTimes(1);
});
it('new record and unmount cannot reuse old cursor or select retained old DOM',async()=>{
 const {f,view}=await setup();query('hello');fireEvent.click(next());const old=field(),oldButton=next();const selection=vi.spyOn(old,'setSelectionRange');f.mockResolvedValueOnce(ok({...original,raw:'new hello'}));view.rerender(<TranscriptionStoreBoundary><TranscriptEditor id="two" raw=""/></TranscriptionStoreBoundary>);await screen.findByDisplayValue('new hello');expect(screen.getByLabelText('查找文字')).toHaveProperty('value','');query('hello');expect(screen.getByText(/当前 0\/1/)).toBeTruthy();fireEvent.click(oldButton);expect(selection).not.toHaveBeenCalled();view.unmount();fireEvent.click(oldButton);expect(selection).not.toHaveBeenCalled();
});
it('historical restore confirmation blocks navigation and accepted snapshot resets it',async()=>{
 const version={revision:1,text:null,kind:'original',updated:'2026-10-21T00:00:00Z',sourceRevision:null};
 const f=vi.fn(async(url:string)=>url.endsWith('/history')?ok({versions:[version],earliestRevision:1,legacyGap:false}):url.endsWith('/history/1')?ok(version):url.endsWith('/transcript-restore')?ok({...original,revision:3,updated:version.updated}):ok({...original,corrected:'hello corrected hello',revision:2}));vi.stubGlobal('fetch',f);render(<TranscriptionStoreBoundary><TranscriptEditor id="one" raw=""/></TranscriptionStoreBoundary>);await screen.findByLabelText('校对文本');query('hello');fireEvent.click(next());fireEvent.click(screen.getByText('查看版本历史'));fireEvent.click(await screen.findByText('查看版本 1'));await screen.findByLabelText('历史版本文本（只读）');fireEvent.click(screen.getByText('恢复此版本为新版本'));expect(next().disabled).toBe(true);fireEvent.click(screen.getByText('确认创建新版本'));await screen.findByText(/已将历史版本 1 恢复为新版本 3/);await waitFor(()=>expect(next().disabled).toBe(false));expect(screen.getByText(/当前 0\/2/)).toBeTruthy();expect(screen.getByText('本次尚未通过此按钮打开正文')).toBeTruthy();
});
