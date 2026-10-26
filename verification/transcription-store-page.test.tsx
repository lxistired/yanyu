import React from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {LocalTranscription} from '../candidate/src/components/LocalTranscription';
import {STORE_HEADER} from '../candidate/src/components/transcription-store-session';
import {transcriptUrl} from '../candidate/src/components/TranscriptRelationships';
vi.mock('../candidate/src/components/RecordingDrafts',()=>({RecordingDrafts:()=>null}));
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id='11111111-1111-4111-8111-111111111111';
const model={maxSeconds:7200,maxBytes:100000,chunkSeconds:30,overlapSeconds:1,deadlineSeconds:14400};
const job={id,filename:'synthetic.wav',title:'Synthetic A',library_revision:0,deleted_at:null,status:'completed',requested_language:'en',created:'2026-10-21',error:null,result:{text:'A preview',duration_seconds:1,inference_seconds:1,language:'en'}};
const reply=(data:unknown,scope=A,status=200)=>({ok:status<400,status,headers:new Headers({[STORE_HEADER]:scope}),json:vi.fn(async()=>data),blob:vi.fn(async()=>new Blob(['synthetic']))});
const listing=(jobs:unknown[]=[job],scope=A)=>reply({jobs,model,total:jobs.length,hasMore:false,activeJobCount:0},scope);
const transcript=()=>reply({raw:'A full',corrected:null,revision:0,updated:null});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();history.replaceState(null,'','/');});
it('page legacy entry performs no automatic request; explicit choice discovers once then scopes polling, editor and rename',async()=>{
 history.replaceState(null,'',`/?transcriptJob=${id}`);let title='Synthetic A';
 const f=vi.fn(async(url:string,init?:RequestInit)=>{if(url==='/api/local-asr/identity')return reply({transcriptionStoreId:A});if(url.endsWith('/transcript'))return transcript();if(url.endsWith('/rename')){title=JSON.parse(init!.body as string).title;return reply({});}return listing([{...job,title}]);});vi.stubGlobal('fetch',f);
 render(<LocalTranscription/>);expect(f).not.toHaveBeenCalled();expect(screen.queryByText('Synthetic A')).toBeNull();fireEvent.click(screen.getByText('明确选择当前转写来源'));
 await screen.findByLabelText('校对文本');fireEvent.click(screen.getByText('重命名'));fireEvent.change(screen.getByLabelText('转写标题'),{target:{value:'Renamed A'}});fireEvent.click(screen.getByText('保存标题'));await screen.findByRole('heading',{name:'Renamed A'});
 await waitFor(()=>expect(f.mock.calls.filter(([url])=>url.includes('/jobs?')).length).toBeGreaterThanOrEqual(3),{timeout:2500});
 expect(f.mock.calls[0][0]).toBe('/api/local-asr/identity');expect(new Headers(f.mock.calls[0][1]?.headers).has(STORE_HEADER)).toBe(false);
 for(const [,init] of f.mock.calls.slice(1))expect(new Headers(init?.headers).get(STORE_HEADER)).toBe(A);
 expect((screen.getByText('打开此转写的固定链接') as HTMLAnchorElement).href).toContain(`transcriptStoreId=${A}`);
});
it('poll mismatch retains correction, rename, relationship and selected upload; blocks every subsequent mutation',async()=>{
 history.replaceState(null,'',`/?transcriptStoreId=${A}`);let changed=false;
 const f=vi.fn(async(url:string)=>{if(url.endsWith('/transcript'))return transcript();if(url.endsWith('/relationships'))return reply({workspaces:[{id:'w',name:'Workspace',count:1}],sessions:[]});return listing([job],changed?B:A);});vi.stubGlobal('fetch',f);
 render(<LocalTranscription/>);fireEvent.change(await screen.findByLabelText('校对文本'),{target:{value:'Retained correction'}});fireEvent.click(screen.getByText('重命名'));fireEvent.change(screen.getByLabelText('转写标题'),{target:{value:'Retained title'}});
 fireEvent.click(screen.getByText('关联工作区 / 会话'));fireEvent.change(await screen.findByLabelText('关联工作区'),{target:{value:'w'}});
 fireEvent.change(screen.getByLabelText('选择音频文件'),{target:{files:[new File(['synthetic not audio'],'hold.wav',{type:'audio/wav'})]}});
 changed=true;await screen.findByText(/本页不会自动切换来源/,{},{timeout:2500});
 expect((screen.getByLabelText('校对文本') as HTMLTextAreaElement).value).toBe('Retained correction');expect((screen.getByLabelText('转写标题') as HTMLInputElement).value).toBe('Retained title');expect((screen.getByLabelText('关联工作区') as HTMLSelectElement).value).toBe('w');expect(screen.getByText(/待上传：hold.wav/)).toBeTruthy();
 const count=f.mock.calls.length;for(const text of ['保存校对','保存标题','保存关联','清除关联','上传并本地转写','导出原始 TXT']){const button=screen.getByText(text) as HTMLButtonElement;expect(button.disabled).toBe(true);fireEvent.click(button);}expect(f).toHaveBeenCalledTimes(count);
});
it('retry mismatch retains selected retry file and blocks retry recovery without changing parent identity',async()=>{
 history.replaceState(null,'',`/?transcriptStoreId=${A}`);let retryReads=0;
 const f=vi.fn(async(url:string,init?:RequestInit)=>{if(url.endsWith('/retry')){retryReads++;return reply({parentId:id,state:'uncommitted',reconciliationFinal:false,child:null,eligible:true},init?.method==='POST'?B:A);}return listing([{...job,status:'failed',result:null}]);});vi.stubGlobal('fetch',f);
 render(<LocalTranscription/>);fireEvent.click(await screen.findByText('核对重试资格与结果'));await screen.findByText('可重新选择原文件；最终资格由服务器提交时校验。');
 fireEvent.change(screen.getByLabelText('为此失败任务重新选择原文件'),{target:{files:[new File(['synthetic not audio'],'retry.wav',{type:'audio/wav'})]}});fireEvent.click(screen.getByText('用原文件重试此失败任务'));
 await screen.findByText(/本页不会自动切换来源/);expect(screen.getByText(/待重新上传：retry.wav/)).toBeTruthy();expect((screen.getByText('用原文件重试此失败任务') as HTMLButtonElement).disabled).toBe(true);
 expect(f.mock.calls.filter(([url])=>url.endsWith('/retry'))).toHaveLength(3);expect(f.mock.calls.filter(([url,init])=>url.endsWith('/retry')&&init?.method==='POST')).toHaveLength(1);
});
it('scoped URL round trip remains source-specific across explicit remount/back-forward selection',async()=>{
 const f=vi.fn(async(url:string,init?:RequestInit)=>url.endsWith('/transcript')?reply({raw:'body',corrected:null,revision:0,updated:null},new Headers(init?.headers).get(STORE_HEADER)!):listing([],new Headers(init?.headers).get(STORE_HEADER)!));vi.stubGlobal('fetch',f);
 const urlA=transcriptUrl({transcriptStoreId:A,jobId:id});const urlB=transcriptUrl({transcriptStoreId:B,jobId:id});
 history.replaceState(null,'',urlA);const view=render(<LocalTranscription/>);await screen.findByText(/当前转写来源已固定/);await waitFor(()=>expect(f).toHaveBeenCalled());
 // The host owns guarded Back/Forward remounts; exercise that source ownership contract without a real browser.
 history.pushState(null,'',urlB);view.rerender(<LocalTranscription key="B"/>);await waitFor(()=>expect(f.mock.calls.some(([,init])=>new Headers(init?.headers).get(STORE_HEADER)===B)).toBe(true));
 history.replaceState(null,'',urlA);view.rerender(<LocalTranscription key="A-back"/>);await waitFor(()=>expect(new Headers(f.mock.calls.at(-1)?.[1]?.headers).get(STORE_HEADER)).toBe(A));
});

it('pending upload cannot consume a late A result after concurrent B mismatch and retains the selected file',async()=>{
 history.replaceState(null,'',`/?transcriptStoreId=${A}`);let changed=false;let release!:(value:ReturnType<typeof reply>)=>void;const pending=new Promise<ReturnType<typeof reply>>(resolve=>{release=resolve;});
 const f=vi.fn(async(url:string)=>{if(url.endsWith('/transcribe'))return pending;if(url.endsWith('/transcript'))return transcript();return listing([job],changed?B:A);});vi.stubGlobal('fetch',f);
 render(<LocalTranscription/>);await screen.findByLabelText('校对文本');fireEvent.change(screen.getByLabelText('选择音频文件'),{target:{files:[new File(['synthetic not audio'],'pending.wav',{type:'audio/wav'})]}});fireEvent.click(screen.getByText('上传并本地转写'));await waitFor(()=>expect(f.mock.calls.some(([url])=>url.endsWith('/transcribe'))).toBe(true));changed=true;await screen.findByText(/本页不会自动切换来源/,{},{timeout:2500});
 const late=reply({id,status:'processing'},A,202);await act(async()=>{release(late);});expect(late.json).not.toHaveBeenCalled();expect(screen.getByText(/待上传：pending.wav/)).toBeTruthy();expect(screen.queryByText('查看新提交任务')).toBeNull();
});
