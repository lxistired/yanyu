import {fixtureStoreHeaders, fixtureStoreUrl} from './transcription-store-fixture';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {LocalTranscription} from '../candidate/src/components/LocalTranscription';
const job={id:'one',filename:'Synthetic',status:'completed',created:'2026-10-15T00:00:00Z',error:null,result:{text:'Source',duration_seconds:1,inference_seconds:1,language:'en'}};
const original={raw:'Source',corrected:null,revision:0,updated:null};
const ok=(data:unknown)=>({headers:fixtureStoreHeaders(),ok:true,json:async()=>data});
const button=()=>screen.getByRole('button',{name:'查看正文'}) as HTMLButtonElement;
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();history.replaceState(null,'','/');});
async function setup(){
 vi.useFakeTimers();let mode='normal';const f=vi.fn(async(url:string)=>{
  if(url.endsWith('/transcript'))return ok(original);
  if(url.endsWith('/relationships'))return ok({workspaces:[],sessions:[]});
  if(mode==='error')throw Error('synthetic list outage');
  return ok({jobs:mode==='missing'?[]:[job],model:null,total:1,offset:0,limit:10,hasMore:false,activeJobCount:0});
 });vi.stubGlobal('fetch',f);await act(async()=>{render(<LocalTranscription/>);});return {f,setMode:(value:string)=>{mode=value;}};
}
it('unchanged list poll does not mark or refetch editor and preserves explicit marker',async()=>{
 const {f}=await setup();expect(screen.getByText('本次尚未通过此按钮打开正文')).toBeTruthy();await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(screen.getByText('本次尚未通过此按钮打开正文')).toBeTruthy();fireEvent.click(button());await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(screen.getByText('本次已通过按钮打开正文')).toBeTruthy();expect(f.mock.calls.filter(([url])=>url.endsWith('/transcript'))).toHaveLength(1);
});
it.each(['error','missing'])('host %s state disables only explicit action and retains dirty editor',async(mode)=>{
 const t=await setup();fireEvent.change(screen.getByLabelText('校对文本'),{target:{value:'keep unsaved'}});fireEvent.click(button());t.setMode(mode);await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(button().disabled).toBe(true);expect(screen.getByText('当前暂不可通过按钮打开正文')).toBeTruthy();expect((screen.getByLabelText('校对文本') as HTMLTextAreaElement).value).toBe('keep unsaved');expect((screen.getByText('保存校对') as HTMLButtonElement).disabled).toBe(false);
});
it('cancelled scope navigation preserves dirty content and marker; accepted scope transition remounts fresh',async()=>{
 await setup();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);fireEvent.change(screen.getByLabelText('校对文本'),{target:{value:'keep'}});fireEvent.click(button());fireEvent.click(screen.getByText('回收站'));expect(screen.getByText('本次已通过按钮打开正文')).toBeTruthy();expect((screen.getByLabelText('校对文本') as HTMLTextAreaElement).value).toBe('keep');confirm.mockReturnValue(true);await act(async()=>{fireEvent.click(screen.getByText('回收站'));});expect(screen.getByText('本次尚未通过此按钮打开正文')).toBeTruthy();expect((screen.getByLabelText('校对文本') as HTMLTextAreaElement).value).toBe('Source');
});

beforeEach(() => { history.replaceState(null, '', fixtureStoreUrl()); });
