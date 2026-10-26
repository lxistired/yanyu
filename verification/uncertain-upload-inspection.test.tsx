import './initial-upload-fixture';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {LocalTranscription} from '../candidate/src/components/LocalTranscription';
import {FIXTURE_STORE_ID, fixtureStoreHeaders, fixtureStoreUrl} from './transcription-store-fixture';

const model = {maxSeconds:7200,maxBytes:1024,chunkSeconds:30,overlapSeconds:1,deadlineSeconds:14400};
const row = {id:'one',filename:'source.wav',title:'Original',library_revision:0,status:'completed',created:'2026-10-15',error:null,result:{text:'Source',duration_seconds:1,inference_seconds:1,language:'en'}};
const ok = (data:unknown) => ({headers:fixtureStoreHeaders(),ok:true,status:200,json:async()=>data});
const active = '核对同源资料库（保留文件）', trash = '核对同源回收站（保留文件）';
const blocked = () => {const e = new Event('beforeunload',{cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented;};
beforeEach(()=>history.replaceState(null,'',fixtureStoreUrl('/?page=files&workspaceId=synthetic&sessionId=session&transcriptJob=old')));
afterEach(()=>{cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null,'','/');});

it('lost acknowledgement → blocked draft → explicit active/trash inspection retains File, clears restrictions, never reposts or claims a match', async()=>{
 const f=vi.fn(async(url:string,init?:RequestInit)=>{
  if(init?.method==='POST') throw Error('lost acknowledgement');
  if(url.endsWith('/transcript'))return ok({raw:'Source',corrected:null,revision:0,updated:null});
  return ok({jobs:[row],model,total:21,hasMore:true,activeJobCount:0});
 });vi.stubGlobal('fetch',f);
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 render(<LocalTranscription/>);await screen.findByLabelText('校对文本');
 fireEvent.click(screen.getByRole('button',{name:/状态筛选/}));
 fireEvent.click(screen.getByRole('checkbox',{name:'转写失败'}));fireEvent.click(screen.getByText('确认筛选'));
 fireEvent.click(screen.getByText('提交入口筛选'));fireEvent.change(screen.getByLabelText('提交入口（客户端声明）'),{target:{value:'unknown'}});fireEvent.click(screen.getByText('应用入口筛选'));
 fireEvent.click(screen.getByText('创建日期筛选'));fireEvent.change(screen.getByLabelText('开始日期（UTC）'),{target:{value:'2020-01-01'}});fireEvent.change(screen.getByLabelText('结束日期（UTC，含当天）'),{target:{value:'2020-01-02'}});fireEvent.click(screen.getByText('应用日期筛选'));
 fireEvent.change(screen.getByLabelText('搜索转写'),{target:{value:'hidden'}});fireEvent.click(screen.getByText('搜索'));
 fireEvent.click(screen.getByText('回收站'));await waitFor(()=>expect(screen.getByText('下一页').hasAttribute('disabled')).toBe(false));fireEvent.click(screen.getByText('下一页'));
 await waitFor(()=>expect(f.mock.calls.some(([url])=>url.includes('offset=10'))).toBe(true));
 await screen.findByLabelText('校对文本');
 fireEvent.click(screen.getByText('重命名'));fireEvent.change(screen.getByLabelText('转写标题'),{target:{value:'Unsaved title'}});
 const selected=new File([new Uint8Array(80)],'selected.wav',{type:'audio/wav'});
 fireEvent.change(screen.getByLabelText('选择音频文件'),{target:{files:[selected]}});
 fireEvent.click(screen.getByText('上传并本地转写'));await screen.findByLabelText('未确认上传核对');
 const before=location.search, reads=f.mock.calls.filter(([url])=>url.startsWith('/api/local-asr/jobs?')).length;
 fireEvent.click(screen.getByText(active));expect(screen.getByText(/请先保存或取消资料库中未保存/)).toBeTruthy();
 expect(location.search).toBe(before);expect((screen.getByLabelText('转写标题') as HTMLInputElement).value).toBe('Unsaved title');
 expect((screen.getByLabelText('搜索转写') as HTMLInputElement).value).toBe('hidden');
 expect(f.mock.calls.filter(([url])=>url.startsWith('/api/local-asr/jobs?'))).toHaveLength(reads);
 fireEvent.change(screen.getByLabelText('转写标题'),{target:{value:'Original'}});
 fireEvent.click(screen.getByText(active));
 for(const [label,scope] of [[active,'active'],[trash,'trash'],[active,'active']]){
  fireEvent.click(screen.getByText(label));
  await waitFor(()=>{
   const call=f.mock.calls.filter(([url])=>url.startsWith('/api/local-asr/jobs?')).at(-1)!;
   const params=new URL(call[0],'http://localhost').searchParams;
   expect(Object.fromEntries(params)).toEqual({q:'',scope,offset:'0',limit:'10'});
   expect(new Headers(call[1]?.headers).get('X-Transcription-Store-Id')).toBe(FIXTURE_STORE_ID);
  });
  expect((screen.getByLabelText('选择音频文件') as HTMLInputElement).files?.[0]).toBe(selected);
  expect(screen.getByText(/待上传：selected.wav/)).toBeTruthy();expect(blocked()).toBe(true);
 }
 expect(new URLSearchParams(location.search).get('transcriptStoreId')).toBe(FIXTURE_STORE_ID);
 expect(location.search).not.toMatch(/workspaceId|sessionId|transcriptJob/);
 expect(screen.getByText(/未找到也不代表没有提交成功/)).toBeTruthy();
 expect(screen.queryByText('查看新提交任务')).toBeNull();
 expect(f.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 expect(confirm).not.toHaveBeenCalled();
 // Clearing the visible picker is not abandonment of an uncertain server operation.
 fireEvent.click(screen.getByText('清除待上传文件'));expect(screen.queryByText(/待上传：selected.wav/)).toBeNull();expect(screen.getByLabelText('未确认上传核对')).toBeTruthy();expect(blocked()).toBe(true);
 expect((screen.getByLabelText('选择音频文件') as HTMLInputElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('选择音频文件'),{target:{files:[new File([new Uint8Array(80)],'new.wav')]}});fireEvent.click(screen.getByText('上传并本地转写'));expect(screen.queryByText(/待上传：new.wav/)).toBeNull();expect(f.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 fireEvent.click(screen.getByText('放弃追踪本次上传'));expect(confirm).toHaveBeenCalledTimes(1);expect(screen.getByLabelText('未确认上传核对')).toBeTruthy();expect(blocked()).toBe(true);
 confirm.mockReturnValue(true);fireEvent.click(screen.getByText('放弃追踪本次上传'));expect(screen.queryByLabelText('未确认上传核对')).toBeNull();expect(blocked()).toBe(false);
 expect(screen.getByRole('alert').textContent).toContain('未取消服务器上可能已提交的任务');expect(f.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
});

it('local validation is not an uncertain submission and never offers inspection',async()=>{
 const f=vi.fn(async()=>ok({jobs:[],model,activeJobCount:0}));vi.stubGlobal('fetch',f);
 render(<LocalTranscription/>);await waitFor(()=>expect((screen.getByLabelText('选择音频文件') as HTMLInputElement).disabled).toBe(false));
 fireEvent.change(screen.getByLabelText('选择音频文件'),{target:{files:[new File([],'empty.wav')]}});
 fireEvent.click(screen.getByText('上传并本地转写'));await screen.findByRole('alert');
 expect(screen.queryByLabelText('未确认上传核对')).toBeNull();expect(f.mock.calls.every(call=>call.length===1||!(call[1] as RequestInit)?.method)).toBe(true);
});
