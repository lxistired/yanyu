import React from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {ManualPlanManager} from '../candidate/src/components/ManualPlanManager';
import {LocalResearchSearch} from '../candidate/src/components/LocalResearchSearch';
import {ManualPlanClient} from '../candidate/src/components/manual-plan-client';
import {ManualPlanSession} from '../candidate/src/components/manual-plan-session';
import {effectiveManualPlanLinks,manualPlanSourceKey,type ManualPlanRecord,type ManualPlanSourceLink} from '../candidate/shared/manual-plans';
// Actual production callbacks/session with synthetic transport DTOs; no browser/device or live-service claim.
const source='10000000-0000-4000-8000-000000000001',otherSource='10000000-0000-4000-8000-000000000002',scope='1'.repeat(64);
const id=(n:number)=>`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const docLink=(n:number,store=source):ManualPlanSourceLink=>({kind:'document',documentStoreId:store,documentId:id(n)});
const jobLink=(n:number,store=source):ManualPlanSourceLink=>({kind:'transcript',transcriptStoreId:store,jobId:id(n)});
const json=(value:unknown,store=source,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','X-Transcription-Store-Id':store}});
function plan():ManualPlanRecord{return {id:'plan-a',kind:'manual-research-plan',storeScope:scope,revision:1,createdAt:'2026-10-23T00:00:00.000Z',updatedAt:'2026-10-23T00:00:00.000Z',deletedAt:null,data:{schemaVersion:1,provenance:'user-authored-local',state:'draft',title:'Private title',objective:'Private objective',notes:'Private notes',targetDate:null,sessionLink:{scope,workspaceId:'workspace',workspaceRevision:2,sessionId:'session',sessionRevision:3}}};}
const document=(n:number)=>({id:id(n),name:n<3?'同名.pdf':`文档 ${n}.pdf`,format:'pdf',createdAt:'2026-10-23T00:00:00Z',trashedAt:null,stale:false,bytes:100,sha256:'a'.repeat(64),textSha256:'b'.repeat(64),pages:1,revision:0,workspaceId:null,folderId:null,workspaceName:null,folderName:null});
const job=(n:number)=>({id:id(n),title:n<3?'同名转写':`转写 ${n}`,filename:'synthetic.wav',status:'failed',created:'2026-10-23T00:00:00Z',deleted_at:null,result:null});
function fixture(initial=plan()){
 let current=initial,serial=0,liveSource=source,failDetail=false,delay=false,drop=false;
 let release:(()=>void)|undefined;
 const sourceCalls:{url:string;init?:RequestInit}[]=[],writes:{operation:string;input:any;body:string}[]=[];
 const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);sourceCalls.push({url,init});
  if(url==='/api/documents/choices')return json({uploadScope:liveSource,folders:[],workspaces:[]},liveSource);
  if(url.startsWith('/api/documents?')){const p=new URL(url,'http://localhost').searchParams,offset=Number(p.get('offset'));const all=Array.from({length:12},(_,i)=>document(i+1));return json({storeScope:liveSource,documents:all.slice(offset,offset+10),total:12,offset,limit:10},liveSource);}
  if(url.startsWith('/api/documents/')){const n=Number(url.split('-').at(-1));return json({storeScope:liveSource,document:document(n),text:`current text ${n}`},liveSource,failDetail?404:200);}
  if(url==='/api/local-asr/identity')return json({transcriptionStoreId:liveSource},liveSource);
  if(url.startsWith('/api/local-asr/jobs?')){const p=new URL(url,'http://localhost').searchParams,offset=Number(p.get('offset')),target=p.get('jobId'),all=target?[job(Number(target.split('-').at(-1)))]:Array.from({length:12},(_,i)=>job(i+1));return json({jobs:all.slice(offset,offset+10),total:all.length,offset,limit:10,hasMore:offset+10<all.length},liveSource);}
  throw Error('Unexpected source '+url);
 });vi.stubGlobal('fetch',fetcher);
 const client=new ManualPlanClient(async(input,init)=>{
  const op=String(input).split('/').at(-1)!,body=String(init?.body),payload=JSON.parse(body);
  if(op==='list')return json({items:[current],total:1,offset:0,nextOffset:null});
  if(op==='get')return json(current);
  writes.push({operation:op,input:payload,body});
  if(op==='addMaterialLinks')current={...current,revision:current.revision+1,data:{...current.data,materialLinks:[...(current.data.materialLinks??[]),...payload.materialLinks]}};
  else if(op==='removeMaterialLink'){const key=manualPlanSourceKey(payload.materialLink);current={...current,revision:current.revision+1,data:{...current.data,materialLinks:(current.data.materialLinks??[]).filter(link=>manualPlanSourceKey(link)!==key),...(current.data.materialLink&&manualPlanSourceKey(current.data.materialLink)===key?{materialLink:null}:{}),...(current.data.documentLink&&manualPlanSourceKey(current.data.documentLink)===key?{documentLink:null}:{})}};}
  else if(op==='update')current={...current,revision:current.revision+1,data:{...current.data,...payload.patch}};
  else throw Error('Unexpected plan write '+op);
  if(drop){drop=false;throw Error('Synthetic lost ACK');}
  if(delay){delay=false;return new Promise<Response>(resolve=>{release=()=>resolve(json(current));});}
  return json(current);
 });
 const session=new ManualPlanSession(client,()=>`collection-${++serial}`);
 return {session,writes,sourceCalls,fetcher,get current(){return current;},setSource(value:string){liveSource=value;},failDetail(){failDetail=true;},delayWrite(){delay=true;},dropWrite(){drop=true;},releaseWrite(){release!();}};
}
const handler=(element:HTMLElement)=>{const key=Object.keys(element).find(key=>key.startsWith('__reactProps$'))!;return (element as any)[key].onClick as ()=>void;};
async function mount(f:ReturnType<typeof fixture>,confirm=vi.fn(()=>true),onOpenPdf=vi.fn(),onNavigate=vi.fn()){
 const props={session:f.session,onClose:()=>{},confirmLeave:confirm,onOpenPdf,onNavigateMaterial:onNavigate};
 const view=render(<ManualPlanManager {...props}/>);fireEvent.click(await screen.findByRole('button',{name:'Private title'}));await screen.findByRole('region',{name:'计划资料集合'});return {view,props,confirm,onOpenPdf,onNavigate};
}
async function search(){fireEvent.click(screen.getByRole('button',{name:'为此计划查找本地资料'}));await screen.findAllByRole('button',{name:'选择文档：同名.pdf'});}
const selected=()=>screen.getByRole('region',{name:'待添加资料'});
const saved=()=>screen.getByRole('region',{name:'计划资料集合'});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('plan-owned pointer-only collection UI',()=>{
 it('standalone search remains read-only and does not expose selection',async()=>{fixture();render(<LocalResearchSearch/>);await screen.findAllByRole('button',{name:'同名.pdf'});expect(screen.queryByRole('button',{name:/选择文档/})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'转写'}));await screen.findAllByRole('heading',{name:'同名转写'});expect(screen.queryByRole('button',{name:/选择转写/})).toBeNull();});
 it('keeps exact selections across same-title results, queries, pages, tabs, and close/reopen, then saves one batch',async()=>{
  const f=fixture(),{view,props}=await mount(f);await search();
  fireEvent.click(screen.getAllByRole('button',{name:'选择文档：同名.pdf'})[0]);fireEvent.click(screen.getAllByRole('button',{name:'选择文档：同名.pdf'})[0]);
  fireEvent.change(screen.getByLabelText('文档查询'),{target:{value:'chosen'}});fireEvent.click(screen.getByRole('button',{name:'搜索文档'}));await screen.findByText(/查询：chosen/);
  expect(screen.getAllByRole('button',{name:'取消选择文档：同名.pdf'})).toHaveLength(2);
  fireEvent.click(within(screen.getByRole('region',{name:'本地文档搜索'})).getByRole('button',{name:'下一页'}));await screen.findByRole('button',{name:'选择文档：文档 11.pdf'});
  fireEvent.click(screen.getByRole('button',{name:'转写'}));fireEvent.click((await screen.findAllByRole('button',{name:'选择转写：同名转写'}))[0]);
  expect(f.session.editor?.materialBasket).toEqual([docLink(1),docLink(2),jobLink(1)]);expect(f.session.hasUnsaved()).toBe(true);expect(JSON.stringify(f.session.editor?.materialBasket)).not.toMatch(/同名|title|preview|text/);
  fireEvent.click(screen.getByRole('button',{name:'收起计划资料检索'}));expect(within(selected()).getAllByRole('listitem')).toHaveLength(3);
  view.unmount();render(<ManualPlanManager {...props}/>);await screen.findByRole('button',{name:'添加所选 3 份资料'});expect(f.session.editor?.materialBasket).toHaveLength(3);
  f.delayWrite();const save=screen.getByRole('button',{name:'添加所选 3 份资料'});act(()=>{save.click();save.click();});expect(f.writes).toHaveLength(1);expect(f.writes[0].input).toMatchObject({scope,expectedRevision:1,materialLinks:[docLink(1),docLink(2),jobLink(1)]});
  await act(async()=>f.releaseWrite());await waitFor(()=>expect(f.session.editor?.materialBasket).toHaveLength(0));expect(effectiveManualPlanLinks(f.session.editor!.record!.data)).toEqual([docLink(1),docLink(2),jobLink(1)]);expect(f.current.data.sessionLink).toEqual(plan().data.sessionLink);
  expect(f.sourceCalls.filter(call=>call.url.startsWith('/api/documents/')&&call.url!=='/api/documents/choices')).toHaveLength(0);expect(JSON.stringify(f.sourceCalls)).not.toMatch(/Private title|Private objective|Private notes/);
 });
 it.each(['转写','重新载入文档来源','搜索文档','下一页'])('rejects connected old document selection synchronously after %s',async action=>{
  const f=fixture();await mount(f);await search();const old=handler(screen.getAllByRole('button',{name:'选择文档：同名.pdf'})[0]);
  act(()=>{(action==='下一页'?within(screen.getByRole('region',{name:'本地文档搜索'})):screen).getByRole('button',{name:action}).click();old();});expect(f.session.editor?.materialBasket).toHaveLength(0);
 });
 it.each(['文档','刷新转写结果','重新载入转写来源','搜索转写','下一页'])('rejects old transcript selection synchronously after %s',async action=>{
  const f=fixture();await mount(f);await search();fireEvent.click(screen.getByRole('button',{name:'转写'}));const old=handler((await screen.findAllByRole('button',{name:'选择转写：同名转写'}))[0]);
  act(()=>{(action==='下一页'?within(screen.getByRole('region',{name:'本地转写搜索'})):screen).getByRole('button',{name:action}).click();old();});expect(f.session.editor?.materialBasket).toHaveLength(0);
 });
 it('keeps a selected old source and permits a distinct same-ID replacement only after explicit source reload',async()=>{
  const f=fixture();await mount(f);await search();fireEvent.click(screen.getAllByRole('button',{name:'选择文档：同名.pdf'})[0]);const old=handler(screen.getAllByRole('button',{name:'选择文档：同名.pdf'})[0]);f.setSource(otherSource);fireEvent.click(screen.getByRole('button',{name:'搜索文档'}));await screen.findByText(/文档来源已变化/);act(()=>old());expect(f.session.editor?.materialBasket).toEqual([docLink(1)]);
  fireEvent.click(screen.getByRole('button',{name:'重新载入文档来源'}));fireEvent.click((await screen.findAllByRole('button',{name:'选择文档：同名.pdf'}))[0]);expect(f.session.editor?.materialBasket).toEqual([docLink(1),docLink(1,otherSource)]);
 });
 it('preserves basket on authored save; blocks dirty stage and alternate mutations, with explicit basket-only clear',async()=>{
  const f=fixture(),{confirm}=await mount(f);await search();fireEvent.click(screen.getAllByRole('button',{name:'选择文档：同名.pdf'})[0]);const old=handler(screen.getAllByRole('button',{name:'选择文档：同名.pdf'})[0]);
  act(()=>{f.session.edit('notes','Retained authored notes');old();});expect(f.session.editor?.materialBasket).toEqual([docLink(1)]);expect(screen.getByRole('button',{name:'添加所选 1 份资料'})).toHaveProperty('disabled',true);expect(screen.getByRole('button',{name:'标记为已计划'})).toHaveProperty('disabled',true);
  fireEvent.click(screen.getByRole('button',{name:'保存计划'}));await waitFor(()=>expect(f.session.editor?.record?.revision).toBe(2));expect(f.session.editor?.materialBasket).toEqual([docLink(1)]);expect(f.session.editor?.draft.notes).toBe('Retained authored notes');
  confirm.mockReturnValue(false);fireEvent.click(screen.getByRole('button',{name:'清空待添加资料'}));expect(f.session.editor?.materialBasket).toHaveLength(1);confirm.mockReturnValue(true);fireEvent.click(screen.getByRole('button',{name:'清空待添加资料'}));expect(f.session.editor?.materialBasket).toHaveLength(0);expect(f.session.editor?.draft.notes).toBe('Retained authored notes');
 });
 it('renders the deduplicated legacy union lazily, opens exact real-record targets, and removes only the named identity',async()=>{
  const initial=plan();initial.data.materialLink=jobLink(1) as any;initial.data.documentLink=docLink(1) as any;initial.data.materialLinks=[docLink(1),docLink(2),jobLink(2)];const f=fixture(initial),{confirm,onOpenPdf,onNavigate}=await mount(f);
  expect(f.sourceCalls).toHaveLength(0);expect(within(saved()).getAllByRole('listitem')).toHaveLength(4);expect(screen.getByText(/已保存 4 份/)).toBeTruthy();
  const row=(link:ManualPlanSourceLink)=>screen.getByRole('listitem',{name:`已保存资料 ${link.kind} ${source} ${link.kind==='document'?link.documentId:link.jobId}`});
  fireEvent.click(within(row(docLink(2))).getByRole('button',{name:`查看当前资料：${id(2)}`}));await screen.findByText('current text 2');fireEvent.click(screen.getByRole('button',{name:'打开已保存的当前 PDF'}));expect(onOpenPdf).toHaveBeenCalledOnce();expect(onOpenPdf.mock.calls[0][0]).toMatchObject({documentId:id(2),storeScope:source});expect(onOpenPdf.mock.calls[0]).toHaveLength(1);
  fireEvent.click(within(row(jobLink(1))).getByRole('button',{name:`查看当前资料：${id(1)}`}));await screen.findByText(/当前转写：同名转写/);expect(screen.queryByText('current text 2')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'打开已保存的当前转写'}));expect(onNavigate.mock.calls[0]).toHaveLength(1);
  const before=structuredClone(f.current.data);confirm.mockReturnValue(false);fireEvent.click(within(row(docLink(2))).getByRole('button',{name:`移除资料：${id(2)}`}));expect(f.writes).toHaveLength(0);confirm.mockReturnValue(true);fireEvent.click(within(row(docLink(2))).getByRole('button',{name:`移除资料：${id(2)}`}));await waitFor(()=>expect(f.session.editor?.record?.revision).toBe(2));expect(f.writes[0].input).toMatchObject({scope,expectedRevision:1,materialLink:docLink(2)});expect(f.writes[0].operation).toBe('removeMaterialLink');expect(effectiveManualPlanLinks(f.current.data)).toEqual([jobLink(1),docLink(1),jobLink(2)]);expect(f.current.data.sessionLink).toEqual(before.sessionLink);expect(f.current.data.notes).toBe(before.notes);
 });
 it('keeps unavailable saved entries and healthy siblings visible without automatic fanout or source fallback',async()=>{
  const initial=plan();initial.data.materialLinks=[docLink(1),jobLink(2)];const f=fixture(initial);await mount(f);f.failDetail();fireEvent.click(screen.getByRole('button',{name:`查看当前资料：${id(1)}`}));await screen.findByText(/已保存的文档快捷入口当前不可用/);expect(within(saved()).getAllByRole('listitem')).toHaveLength(2);fireEvent.click(screen.getByRole('button',{name:`查看当前资料：${id(2)}`}));await screen.findByText(/当前转写：同名转写/);expect(screen.queryByText(/已保存的文档快捷入口当前不可用/)).toBeNull();expect(f.writes).toHaveLength(0);
 });
 it('counts legacy slots toward 100 and disables a new selection without hiding saved items',async()=>{
  const initial=plan();initial.data.materialLink=jobLink(99) as any;initial.data.documentLink=docLink(99) as any;initial.data.materialLinks=Array.from({length:98},(_,i)=>docLink(i+100));const f=fixture(initial);await mount(f);expect(f.sourceCalls).toHaveLength(0);expect(within(saved()).getAllByRole('listitem')).toHaveLength(100);await search();expect(screen.getAllByRole('button',{name:'选择文档：同名.pdf'})[0]).toHaveProperty('disabled',true);expect(screen.getByText(/合计 100 \/ 100/)).toBeTruthy();
 });
 it('rejects a saved detail removal callback after plan owner replacement',async()=>{
  const initial=plan();initial.data.materialLinks=[docLink(1)];const f=fixture(initial);await mount(f);const old=handler(screen.getByRole('button',{name:`移除资料：${id(1)}`}));act(()=>{f.session.newPlan(()=>true);old();});expect(f.writes).toHaveLength(0);expect(screen.queryByRole('region',{name:'计划资料集合'})).toBeNull();
 });
});
