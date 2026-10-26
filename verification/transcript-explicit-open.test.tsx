import {fixtureStoreHeaders, fixtureStoreUrl} from './transcription-store-fixture';
import {TranscriptionStoreBoundary} from '../candidate/src/components/TranscriptionStoreBoundary';
import {StrictMode} from 'react';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {TranscriptEditor} from '../candidate/src/components/TranscriptEditor';
import {hasUnsavedWork} from '../candidate/src/components/unsaved-work';
const original={raw:'Synthetic original',corrected:null,revision:0,updated:null};
const ok=(data:unknown=original)=>({headers:fixtureStoreHeaders(),ok:true,json:async()=>data});
const opened='本次已通过按钮打开正文',unopened='本次尚未通过此按钮打开正文',unavailable='当前暂不可通过按钮打开正文';
const button=()=>screen.getByRole('button',{name:'查看正文'}) as HTMLButtonElement;
const field=()=>screen.getByLabelText('校对文本') as HTMLTextAreaElement;
function deferred(){let resolve!:(value:ReturnType<typeof ok>)=>void;const promise=new Promise<ReturnType<typeof ok>>(r=>resolve=r);return {promise,resolve};}
async function setup(){const f=vi.fn().mockResolvedValue(ok());vi.stubGlobal('fetch',f);const view=render(<TranscriptionStoreBoundary><TranscriptEditor id="one" raw="preview"/></TranscriptionStoreBoundary>);await screen.findByLabelText('校对文本');return {f,view};}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('automatic load stays unmarked; explicit focus has no network or persistence effects',async()=>{
 const local=vi.spyOn(Storage.prototype,'setItem');const {f}=await setup();expect(screen.getByText(unopened)).toBeTruthy();expect(field().value).toBe(original.raw);
 const before=f.mock.calls.length;fireEvent.click(button());expect(document.activeElement).toBe(field());expect(screen.getByText(opened)).toBeTruthy();fireEvent.click(button());expect(f).toHaveBeenCalledTimes(before);expect(local).not.toHaveBeenCalled();
});
it('each button only focuses and marks its own matching editor',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>ok({...original,raw:url.includes('/one/')?'First':'Second'})));
 render(<><TranscriptionStoreBoundary><TranscriptEditor id="one" raw=""/></TranscriptionStoreBoundary><TranscriptionStoreBoundary><TranscriptEditor id="two" raw=""/></TranscriptionStoreBoundary></>);await screen.findByDisplayValue('Second');
 const sections=screen.getAllByRole('region',{name:'转写校对与导出'});fireEvent.click(within(sections[1]).getByText('查看正文'));
 expect(document.activeElement).toBe(within(sections[1]).getByLabelText('校对文本'));expect(within(sections[0]).getByText(unopened)).toBeTruthy();expect(within(sections[1]).getByText(opened)).toBeTruthy();
});
it.each(['{Enter}',' '])('native button keyboard activation %s focuses the textarea',async(key)=>{await setup();button().focus();await userEvent.setup().keyboard(key);expect(document.activeElement).toBe(field());expect(screen.getByText(opened)).toBeTruthy();});
it.each(['noop','throw','detached'])('unsuccessful %s focus does not mark',async(mode)=>{
 await setup();const target=field();if(mode==='detached')Object.defineProperty(target,'isConnected',{configurable:true,value:false});else vi.spyOn(target,'focus').mockImplementation(()=>{if(mode==='throw')throw Error('synthetic focus failure');});
 fireEvent.click(button());expect(screen.getByText(unopened)).toBeTruthy();
});
it.each([{raw:'',corrected:null,revision:0,updated:null},{raw:'source',corrected:'',revision:1,updated:null}])('empty valid loaded text is eligible',async(value)=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(ok(value)));render(<TranscriptionStoreBoundary><TranscriptEditor id="empty" raw="preview"/></TranscriptionStoreBoundary>);await screen.findByLabelText('校对文本');expect(field().value).toBe('');fireEvent.click(button());expect(screen.getByText(opened)).toBeTruthy();
});
it.each([null,{...original,raw:null},{...original,revision:-1},{...original,corrected:42},{...original,updated:undefined}])('malformed DTO never becomes ready',async(value)=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(ok(value)));render(<TranscriptionStoreBoundary><TranscriptEditor id="bad" raw="preview" rawPreview/></TranscriptionStoreBoundary>);await screen.findByText('转写内容格式无效，请重试读取');expect(button().disabled).toBe(true);expect(screen.queryByLabelText('校对文本')).toBeNull();expect(screen.getByText(unavailable)).toBeTruthy();
});
it('failed initial read and successful retry never consume a queued open intent',async()=>{
 const next=deferred();const f=vi.fn().mockRejectedValueOnce(Error('offline')).mockReturnValueOnce(next.promise);vi.stubGlobal('fetch',f);render(<TranscriptionStoreBoundary><TranscriptEditor id="one" raw="preview" rawPreview/></TranscriptionStoreBoundary>);
 await screen.findByText('offline');expect(button().disabled).toBe(true);fireEvent.click(button());fireEvent.click(screen.getByText('重试读取校对'));expect(button().disabled).toBe(true);
 await act(async()=>next.resolve(ok()));expect(screen.getByText(unopened)).toBeTruthy();expect(button().disabled).toBe(false);
});
it('focus preserves dirty draft and unsaved guard without save or reload',async()=>{
 const {f}=await setup();fireEvent.change(field(),{target:{value:'Unsaved synthetic correction'}});expect(hasUnsavedWork()).toBe(true);const count=f.mock.calls.length;fireEvent.click(button());expect(field().value).toBe('Unsaved synthetic correction');expect(hasUnsavedWork()).toBe(true);expect(f).toHaveBeenCalledTimes(count);
});
it('cancelled reload preserves indicator/draft, accepted reload clears before completion',async()=>{
 const {f}=await setup();fireEvent.click(button());fireEvent.change(field(),{target:{value:'draft'}});fireEvent.click(screen.getByText('载入最新版本'));fireEvent.click(screen.getByText('取消'));expect(screen.getByText(opened)).toBeTruthy();expect(field().value).toBe('draft');expect(f).toHaveBeenCalledTimes(1);
 const pending=deferred();f.mockReturnValueOnce(pending.promise);fireEvent.click(screen.getByText('载入最新版本'));fireEvent.click(screen.getByText('确认替换'));expect(button().disabled).toBe(true);expect(screen.getByText(unavailable)).toBeTruthy();await act(async()=>pending.resolve(ok({...original,revision:1})));expect(button().disabled).toBe(false);expect(screen.getByText(unopened)).toBeTruthy();
});
it('successful save replaces snapshot without marking; failed save preserves draft',async()=>{
 const {f}=await setup();fireEvent.click(button());fireEvent.change(field(),{target:{value:'saved'}});f.mockResolvedValueOnce(ok({...original,corrected:'saved',revision:1}));fireEvent.click(screen.getByText('保存校对'));await screen.findByText('校对文本已保存');expect(screen.getByText(unopened)).toBeTruthy();
 fireEvent.click(button());fireEvent.change(field(),{target:{value:'keep draft'}});f.mockResolvedValueOnce({headers:fixtureStoreHeaders(),ok:false,json:async()=>({error:{message:'conflict'}})});fireEvent.click(screen.getByText('保存校对'));await screen.findByText('conflict');expect(field().value).toBe('keep draft');expect(screen.getByText(opened)).toBeTruthy();
});
it('disabled host eligibility never hides existing editor or discards draft',async()=>{
 const {view,f}=await setup();fireEvent.click(button());fireEvent.change(field(),{target:{value:'keep'}});view.rerender(<TranscriptionStoreBoundary><TranscriptEditor id="one" raw="preview" explicitOpenDisabled/></TranscriptionStoreBoundary>);expect(button().disabled).toBe(true);expect(screen.getByText(unavailable)).toBeTruthy();expect(field().value).toBe('keep');expect((screen.getByText('保存校对') as HTMLButtonElement).disabled).toBe(false);expect(f).toHaveBeenCalledTimes(1);
});
it('same-instance ID reuse cannot accept delayed old response and fresh same-ID mount resets',async()=>{
 const old=deferred(),newer=deferred();vi.stubGlobal('fetch',vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise).mockResolvedValue(ok()));const view=render(<TranscriptionStoreBoundary><TranscriptEditor id="one" raw="old preview"/></TranscriptionStoreBoundary>);view.rerender(<TranscriptionStoreBoundary><TranscriptEditor id="two" raw="new preview"/></TranscriptionStoreBoundary>);
 await act(async()=>old.resolve(ok({...original,raw:'OLD'})));expect(screen.queryByLabelText('校对文本')).toBeNull();expect(button().disabled).toBe(true);await act(async()=>newer.resolve(ok({...original,raw:'NEW'})));expect(field().value).toBe('NEW');fireEvent.click(button());expect(screen.getByText(opened)).toBeTruthy();view.unmount();render(<TranscriptionStoreBoundary><TranscriptEditor id="two" raw=""/></TranscriptionStoreBoundary>);await screen.findByLabelText('校对文本');expect(screen.getByText(unopened)).toBeTruthy();
});
it('StrictMode obsolete completion cannot release current load or publish old snapshot',async()=>{
 const old=deferred(),current=deferred();const f=vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);vi.stubGlobal('fetch',f);render(<StrictMode><TranscriptionStoreBoundary><TranscriptEditor id="strict" raw="preview"/></TranscriptionStoreBoundary></StrictMode>);expect(f).toHaveBeenCalledTimes(2);
 await act(async()=>old.resolve(ok({...original,raw:'OBSOLETE'})));expect(button().disabled).toBe(true);expect(screen.queryByLabelText('校对文本')).toBeNull();await act(async()=>current.resolve(ok({...original,raw:'CURRENT'})));expect(field().value).toBe('CURRENT');expect(button().disabled).toBe(false);expect(screen.getByText(unopened)).toBeTruthy();
});
it('StrictMode late obsolete completion cannot overwrite accepted current snapshot',async()=>{
 const old=deferred(),current=deferred();vi.stubGlobal('fetch',vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise));render(<StrictMode><TranscriptionStoreBoundary><TranscriptEditor id="strict" raw="preview"/></TranscriptionStoreBoundary></StrictMode>);await act(async()=>current.resolve(ok({...original,raw:'CURRENT'})));fireEvent.click(button());await act(async()=>old.resolve(ok({...original,raw:'OBSOLETE'})));expect(field().value).toBe('CURRENT');expect(screen.getByText(opened)).toBeTruthy();
});
it('history preview is not an open action and successful restore clears prior mark',async()=>{
 const f=vi.fn(async(url:string)=>url.endsWith('/history')?ok({versions:[{revision:1,text:null,kind:'original',updated:"2026-10-21T00:00:00Z",sourceRevision:null}],earliestRevision:1,legacyGap:false}):url.endsWith('/history/1')?ok({revision:1,text:null,kind:'original',updated:"2026-10-21T00:00:00Z",sourceRevision:null}):url.endsWith('/transcript-restore')?ok({...original,revision:3,updated:"2026-10-21T00:00:00Z"}):ok({...original,corrected:'corrected',revision:2}));vi.stubGlobal('fetch',f);render(<TranscriptionStoreBoundary><TranscriptEditor id="one" raw=""/></TranscriptionStoreBoundary>);await screen.findByLabelText('校对文本');fireEvent.click(screen.getByText('查看版本历史'));fireEvent.click(await screen.findByText('查看版本 1'));await screen.findByLabelText('历史版本文本（只读）');expect(screen.getByText(unopened)).toBeTruthy();fireEvent.click(button());fireEvent.click(screen.getByText('恢复此版本为新版本'));fireEvent.click(screen.getByText('确认创建新版本'));await screen.findByText(/已将历史版本 1 恢复为新版本 3/);await waitFor(()=>expect(button().disabled).toBe(false));expect(screen.getByText(unopened)).toBeTruthy();
});

it('failed accepted reload keeps old text but cannot resurrect stale readiness',async()=>{
 const {f}=await setup();fireEvent.click(button());f.mockRejectedValueOnce(Error('reload failed'));fireEvent.click(screen.getByText('载入最新版本'));await screen.findByText('reload failed');expect(field().value).toBe(original.raw);expect(button().disabled).toBe(true);expect(screen.getByText(unavailable)).toBeTruthy();fireEvent.click(button());expect(screen.queryByText(opened)).toBeNull();fireEvent.click(screen.getByText('载入最新版本'));await waitFor(()=>expect(button().disabled).toBe(false));expect(screen.getByText(unopened)).toBeTruthy();
});

beforeEach(() => { history.replaceState(null, '', fixtureStoreUrl()); });
