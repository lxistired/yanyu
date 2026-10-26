import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {TranscriptEditor} from '../candidate/src/components/TranscriptEditor';
import {TranscriptionStoreBoundary} from '../candidate/src/components/TranscriptionStoreBoundary';
import {fixtureStoreHeaders,fixtureStoreUrl} from './transcription-store-fixture';
const updated='2026-10-21T00:00:00Z';
const saved={raw:'原始文本',corrected:'当前校对',revision:3,updated};
const metadata={revision:2,updated,kind:'correction',sourceRevision:null};
const historyResult=()=>({versions:[{revision:3,updated,kind:'correction',sourceRevision:null},{...metadata},{revision:1,updated,kind:'original',sourceRevision:null}],earliestRevision:1,legacyGap:false});
beforeEach(()=>history.replaceState(null,'',fixtureStoreUrl()));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
async function setup(options:{history?:unknown;preview?:unknown;restore?:unknown;restoreError?:boolean}={}){
 const state={restoreError:false,history:historyResult() as unknown,preview:{...metadata,text:'历史校对'} as unknown,restore:{...saved,revision:4,corrected:'历史校对'} as unknown,...options};
 const fetch=vi.fn(async(url:string,_options?:RequestInit)=>({ok:!(url.endsWith('/transcript-restore')&&state.restoreError),headers:fixtureStoreHeaders(),json:async()=>url.endsWith('/history')?state.history:url.includes('/history/')?state.preview:url.endsWith('/transcript-restore')?state.restore:saved}));vi.stubGlobal('fetch',fetch);
 const view=render(<TranscriptionStoreBoundary><TranscriptEditor id="history-test" raw="preview"/></TranscriptionStoreBoundary>);await screen.findByText('已载入最新版本');fireEvent.change(screen.getByLabelText('校对文本'),{target:{value:'保留草稿'}});return {state,fetch,...view};
}
function draft(){expect((screen.getByLabelText('校对文本') as HTMLTextAreaElement).value).toBe('保留草稿');}
async function openHistory(){fireEvent.click(screen.getByText('查看版本历史'));await screen.findByText('查看版本 2');}
async function select(){await openHistory();fireEvent.click(screen.getByText('查看版本 2'));await screen.findByLabelText('历史版本文本（只读）');}
function confirmRestore(){fireEvent.click(screen.getByText('恢复此版本为新版本'));fireEvent.click(screen.getByText('确认创建新版本'));}
it.each([
 ['null',null],['array',[]],['missing versions',{}],['nonarray versions',{versions:{},earliestRevision:null,legacyGap:false}],
 ['revision zero',{versions:[{...metadata,revision:0}],earliestRevision:0,legacyGap:false}],
 ['duplicate revisions',{versions:[metadata,metadata],earliestRevision:2,legacyGap:true}],
 ['ascending revisions',{versions:[metadata,{...metadata,revision:3}],earliestRevision:3,legacyGap:true}],
 ['bad earliest',{...historyResult(),earliestRevision:2}],['false legacy gap',{...historyResult(),legacyGap:true}],
 ['unknown kind',{versions:[{...metadata,kind:'unknown'}],earliestRevision:2,legacyGap:true}],
 ['null timestamp',{versions:[{...metadata,updated:null}],earliestRevision:2,legacyGap:true}],
 ['invalid restore source',{versions:[{...metadata,kind:'restore',sourceRevision:2}],earliestRevision:2,legacyGap:true}],
])('rejects malformed history %s without crashing or discarding draft',async(_name,history)=>{
 const {fetch}=await setup({history});fireEvent.click(screen.getByText('查看版本历史'));await screen.findByRole('alert');draft();expect(screen.queryByText('恢复此版本为新版本')).toBeNull();expect(fetch.mock.calls.some(([u])=>u.endsWith('/transcript-restore'))).toBe(false);
});
it.each([
 ['wrong requested revision',{...metadata,revision:1,text:'错误版本'}],['missing text',{...metadata}],['bad text',{...metadata,text:42}],['wrong timestamp',{...metadata,updated:'changed',text:'历史校对'}],['wrong kind',{...metadata,kind:'migration',text:'历史校对'}],['wrong source',{...metadata,sourceRevision:1,text:'历史校对'}],['null',null],
])('does not offer restore after invalid preview %s',async(_name,preview)=>{
 const {fetch}=await setup({preview});await openHistory();fireEvent.click(screen.getByText('查看版本 2'));await screen.findByRole('alert');draft();expect(screen.queryByLabelText('历史版本文本（只读）')).toBeNull();expect(screen.queryByText('恢复此版本为新版本')).toBeNull();expect(fetch.mock.calls.some(([u])=>u.endsWith('/transcript-restore'))).toBe(false);
});
it('clears a previously verified selection on failed refresh, retaining only prior list and draft',async()=>{
 const {state,fetch}=await setup();await select();state.history={versions:null};fireEvent.click(screen.getByText('刷新版本历史'));await screen.findByRole('alert');draft();expect(screen.queryByText('恢复此版本为新版本')).toBeNull();expect(screen.queryByLabelText('历史版本文本（只读）')).toBeNull();expect(screen.getByText('查看版本 2')).toBeTruthy();expect(fetch.mock.calls.some(([u])=>u.endsWith('/transcript-restore'))).toBe(false);
});
it.each([
 ['wrong revision',{...saved,revision:5,corrected:'历史校对'}],['wrong text',{...saved,revision:4,corrected:'另一个版本'}],['wrong raw',{...saved,revision:4,raw:'错误原文',corrected:'历史校对'}],['null timestamp',{...saved,revision:4,corrected:'历史校对',updated:null}],['bad snapshot',null],
])('retains draft and saved snapshot after inconsistent restore response %s',async(_name,restore)=>{
 const {fetch}=await setup({restore});await select();confirmRestore();await screen.findByRole('alert');draft();expect(screen.getByText(/已保存版本 3/)).toBeTruthy();expect(screen.queryByText(/已将历史版本/)).toBeNull();expect(fetch.mock.calls.filter(([u])=>u.endsWith('/transcript-restore'))).toHaveLength(1);
});
it('allows fresh empty history without inventing revision zero',async()=>{await setup({history:{versions:[],earliestRevision:null,legacyGap:false}});fireEvent.click(screen.getByText('查看版本历史'));await screen.findByText('最早可用版本：无');draft();expect(screen.queryByRole('alert')).toBeNull();expect(screen.queryByText('查看版本 0')).toBeNull();});
it('allows archived history newer than the loaded saved snapshot and preserves expectedRevision for conflict control',async()=>{
 const newer={revision:7,updated,kind:'migration',sourceRevision:null};const {fetch}=await setup({history:{versions:[newer],earliestRevision:7,legacyGap:true},preview:{...newer,text:'迁移文本'},restore:{error:{message:'版本已变化，请载入最新版本'}},restoreError:true});fireEvent.click(screen.getByText('查看版本历史'));fireEvent.click(await screen.findByText('查看版本 7'));await screen.findByLabelText('历史版本文本（只读）');confirmRestore();await screen.findByText('版本已变化，请载入最新版本');draft();const call=fetch.mock.calls.find(([u])=>u.endsWith('/transcript-restore')) as unknown as [string,RequestInit];expect(JSON.parse(call[1].body as string)).toEqual({expectedRevision:3,sourceRevision:7});
});
it('does not reject legacy invalid text merely while previewing it',async()=>{await setup({preview:{...metadata,text:'legacy\ud800'}});await select();expect(screen.queryByRole('alert')).toBeNull();draft();expect(screen.getByText('恢复此版本为新版本')).toBeTruthy();});
it('does not show a late preview after editor unmount',async()=>{
 let release!:(v:unknown)=>void;const pending=new Promise(resolve=>release=resolve);const {unmount,state,fetch}=await setup();state.preview=pending;
 await openHistory();fireEvent.click(screen.getByText('查看版本 2'));await waitFor(()=>expect(fetch.mock.calls.some(([u])=>u.endsWith('/history/2'))).toBe(true));unmount();await act(async()=>{release({...metadata,text:'迟到历史'});await pending;});expect(screen.queryByLabelText('历史版本文本（只读）')).toBeNull();
});
it('restores a verified empty string without substituting the raw text',async()=>{
 await setup({preview:{...metadata,text:''},restore:{...saved,revision:4,corrected:''}});await select();expect((screen.getByLabelText('历史版本文本（只读）') as HTMLTextAreaElement).value).toBe('');confirmRestore();await screen.findByText(/已将历史版本 2 恢复为新版本 4/);expect((screen.getByLabelText('校对文本') as HTMLTextAreaElement).value).toBe('');
});
it('recovers from a malformed list with explicit refresh without touching the draft',async()=>{
 const {state}=await setup({history:null});fireEvent.click(screen.getByText('查看版本历史'));await screen.findByRole('alert');draft();state.history=historyResult();fireEvent.click(screen.getByText('刷新版本历史'));await screen.findByText('查看版本 2');expect(screen.queryByRole('alert')).toBeNull();fireEvent.click(screen.getByText('查看版本 2'));await screen.findByLabelText('历史版本文本（只读）');draft();expect(screen.getByText('恢复此版本为新版本')).toBeTruthy();
});
