import {fixtureStoreHeaders, fixtureStoreUrl} from './transcription-store-fixture';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {LocalTranscription} from '../candidate/src/components/LocalTranscription';
const model={maxSeconds:7200,maxBytes:268435456,chunkSeconds:30,overlapSeconds:1,deadlineSeconds:14400};
const job={id:'one',filename:'recording.wav',title:'Team meeting',library_revision:2,deleted_at:null as string|null,status:'completed',created:'2026-10-15T00:00:00Z',error:null,result:{text:'Preview',duration_seconds:75,inference_seconds:15,language:'en'}};
const ok=(data:unknown)=>({headers:fixtureStoreHeaders(),ok:true,status:200,json:async()=>data});
const list=(jobs:unknown[],extra={})=>ok({jobs,model,total:jobs.length,offset:0,limit:10,hasMore:false,activeJobCount:0,...extra});
const transcript=()=>ok({raw:'Full original',corrected:null,revision:0,updated:null});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers()});
it('searches Unicode text, paginates server-side and blocks uploads for a job outside the page',async()=>{
 const f=vi.fn(async(url:string)=>url.endsWith('/transcript')?transcript():list([job],{total:21,hasMore:true,activeJobCount:1}));vi.stubGlobal('fetch',f);
 render(<LocalTranscription/>);await screen.findByText('Team meeting');
 expect((screen.getByLabelText('选择音频文件') as HTMLInputElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('搜索转写'),{target:{value:'中文会议'}});fireEvent.click(screen.getByText('搜索'));
 await waitFor(()=>expect(f.mock.calls.some(([url])=>new URL(url,'http://localhost').searchParams.get('q')==='中文会议')).toBe(true));
 await waitFor(()=>expect((screen.getByText('下一页') as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByText('下一页'));
 await waitFor(()=>expect(f.mock.calls.some(([url])=>url.includes('offset=10'))).toBe(true));
 fireEvent.click(screen.getByText('回收站'));
 await waitFor(()=>expect(f.mock.calls.some(([url])=>url.includes('scope=trash')&&url.includes('offset=0'))).toBe(true));
});
it('renames with captured revision and makes a conflict an explicit retry choice',async()=>{
 vi.spyOn(window,'confirm').mockReturnValue(true);
 let latest={...job};let reject=true;
 const f=vi.fn(async(url:string,options?:RequestInit)=>{
  if(url.endsWith('/transcript'))return transcript();
  if(url.endsWith('/rename')){if(reject){latest={...job,title:'Other change',library_revision:3};reject=false;return {headers:fixtureStoreHeaders(),ok:false,status:409,json:async()=>({error:{message:'Revision conflict'}})}} latest={...latest,title:JSON.parse(options?.body as string).title,library_revision:4};return ok({job:latest});}
  return list([latest]);
 });vi.stubGlobal('fetch',f);render(<LocalTranscription/>);fireEvent.click(await screen.findByText('重命名'));
 fireEvent.change(screen.getByLabelText('转写标题'),{target:{value:'My title'}});fireEvent.click(screen.getByText('保存标题'));
 await screen.findByText('Revision conflict');expect((screen.getByText('保存标题') as HTMLButtonElement).disabled).toBe(true);
 await screen.findByRole('heading',{name:'Other change'});fireEvent.click(screen.getByText('使用最新记录'));await waitFor(()=>expect((screen.getByLabelText('转写标题') as HTMLInputElement).value).toBe('Other change'));
 fireEvent.change(screen.getByLabelText('转写标题'),{target:{value:'My title'}});fireEvent.click(screen.getByText('保存标题'));await screen.findByRole('heading',{name:'My title'});
 expect(f.mock.calls.filter(([url])=>url.endsWith('/rename')).map(([,options])=>JSON.parse(options?.body as string).expectedRevision)).toEqual([2,3]);
});
it('confirms recoverable trash and restores the same record without cancelling it',async()=>{
 let latest={...job};const f=vi.fn(async(url:string,options?:RequestInit)=>{
  if(url.endsWith('/transcript'))return transcript();
  if(url.endsWith('/trash')){expect(JSON.parse(options?.body as string).expectedRevision).toBe(2);latest={...latest,deleted_at:'2026-10-15',library_revision:3};return ok({job:latest});}
  if(url.endsWith('/restore')){expect(JSON.parse(options?.body as string).expectedRevision).toBe(3);latest={...latest,deleted_at:null,library_revision:4};return ok({job:latest});}
  const trash=new URL(url,'http://localhost').searchParams.get('scope')==='trash';return list(Boolean(latest.deleted_at)===trash?[latest]:[]);
 });vi.stubGlobal('fetch',f);render(<LocalTranscription/>);fireEvent.click(await screen.findByText('移到回收站'));
 expect(f.mock.calls.some(([url])=>url.endsWith('/trash'))).toBe(false);fireEvent.click(screen.getByText('确认移到回收站'));await screen.findByText('还没有转写记录');
 fireEvent.click(screen.getByText('回收站'));fireEvent.click(await screen.findByText('恢复转写'));await screen.findByText('回收站为空');fireEvent.click(screen.getByText('全部转写'));await screen.findByRole('heading',{name:'Team meeting'});
 expect(f.mock.calls.some(([url])=>url.endsWith('/cancel'))).toBe(false);
});
it('does not permit trash of a processing job',async()=>{
 const f=vi.fn(async()=>list([{...job,status:'processing',result:null}],{activeJobCount:1}));vi.stubGlobal('fetch',f);render(<LocalTranscription/>);
 expect((await screen.findByText('移到回收站') as HTMLButtonElement).disabled).toBe(true);expect(screen.getByText('取消转写')).toBeTruthy();
});
it('preserves unsaved correction and rename drafts through polling and loads the full raw transcript',async()=>{
 const f=vi.fn(async(url:string)=>url.endsWith('/transcript')?transcript():list([job]));vi.stubGlobal('fetch',f);render(<LocalTranscription/>);
 const editor=await screen.findByLabelText('校对文本');fireEvent.change(editor,{target:{value:'Unsaved correction'}});fireEvent.click(screen.getByText('重命名'));fireEvent.change(screen.getByLabelText('转写标题'),{target:{value:'Unsaved title'}});
 await waitFor(()=>expect(f.mock.calls.filter(([url])=>url.includes('/jobs?')).length).toBeGreaterThan(1),{timeout:2500});
 expect((screen.getByLabelText('校对文本') as HTMLTextAreaElement).value).toBe('Unsaved correction');expect((screen.getByLabelText('转写标题') as HTMLInputElement).value).toBe('Unsaved title');expect(screen.getByText('Full original')).toBeTruthy();expect(screen.queryByText('Preview')).toBeNull();
 expect(f.mock.calls.filter(([url])=>url.endsWith('/transcript'))).toHaveLength(1);
});
it('rejects over-budget UTF-8 search before fetching it',async()=>{
 const f=vi.fn(async()=>list([]));vi.stubGlobal('fetch',f);render(<LocalTranscription/>);await screen.findByText('还没有转写记录');
 fireEvent.change(screen.getByLabelText('搜索转写'),{target:{value:'中'.repeat(171)}});fireEvent.click(screen.getByText('搜索'));await screen.findByText('搜索内容不能超过 512 UTF-8 字节');expect(f).toHaveBeenCalledTimes(1);
});

beforeEach(() => { history.replaceState(null, '', fixtureStoreUrl()); });
