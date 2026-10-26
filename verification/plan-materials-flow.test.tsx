import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {ManualPlanHost} from '../candidate/src/components/manual-plan-host';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
vi.mock('../candidate/src/components/ServiceReportsEntry',()=>({ServiceReportsEntry:()=>null}));
// Actual producer, host, shell and document receiver. PDF canvas excluded from this focused test.
vi.mock('../candidate/src/components/PdfPageReader',()=>({PdfPageReader:(p:any)=><div data-testid="selected-reader" data-id={p.documentId}/>}));
const scope='10000000-0000-4000-8000-000000000001',id='20000000-0000-4000-8000-000000000002';
const document={id,revision:0,trashedAt:null,name:'Fixture.pdf',format:'pdf',bytes:1,sha256:'a'.repeat(64),textSha256:'b'.repeat(64),createdAt:'2026-10-22',pages:1,workspaceId:null,folderId:null,workspaceName:null,folderName:null,stale:false};
const plan=(id='plan-a')=>({id,kind:'manual-research-plan',revision:1,createdAt:'2026-10-21T00:00:00.000Z',updatedAt:'2026-10-21T00:00:00.000Z',deletedAt:null,data:{schemaVersion:1,provenance:'user-authored-local',state:'draft',title:id,objective:'Private objective',notes:'Private notes',targetDate:null}});
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json','X-Transcription-Store-Id':scope}});
let host:ManualPlanHost;
let shellView:ReturnType<typeof render>;
let liveScope=scope;
afterEach(()=>{cleanup();host?.dispose();vi.restoreAllMocks();vi.unstubAllGlobals();history.replaceState(null,'','/');});
async function start(paged=false){
 liveScope=scope;
 const requests=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);if(url==='/api/local-asr/identity')return new Response(JSON.stringify({transcriptionStoreId:liveScope}),{headers:{'content-type':'application/json','X-Transcription-Store-Id':liveScope}});if(url.startsWith('/api/local-asr/jobs?')){const offset=Number(new URL(url,'http://localhost').searchParams.get('offset')??0);const total=paged&&!url.includes('jobId=')?11:1;return json({total,offset,limit:10,hasMore:offset+10<total,activeJobCount:0,jobs:Array.from({length:Math.min(10,total-offset)},(_,i)=>({id,title:'Selected saved transcript',filename:'fixture.wav',status:'failed',created:'2026-10-22T00:00:00Z',deleted_at:null,result:null,error:'synthetic failure',workspace_id:null,session_id:null,...(i?{id:`20000000-0000-4000-8000-${String(i+10).padStart(12,'0')}`}:{})})),model:{maxSeconds:7200,maxBytes:268435456,chunkSeconds:30,overlapSeconds:1,deadlineSeconds:14400}});}if(url==='/api/local-asr/choices')return json({workspaces:[],sessions:[]});if(url==='/api/documents/choices')return json({uploadScope:liveScope,folders:[],workspaces:[]});if(url.startsWith('/api/documents?')){const offset=Number(new URL(url,'http://localhost').searchParams.get('offset')??0),total=paged?11:1;return json({storeScope:liveScope,documents:Array.from({length:Math.min(10,total-offset)},(_,i)=>({...document,...(i?{id:`20000000-0000-4000-8000-${String(i+10).padStart(12,'0')}`,name:`Other-${i}.pdf`}:{})})),total,offset,limit:10});}if(url===`/api/documents/${id}`)return json({storeScope:scope,document,text:'Actual component synthetic text preview'});throw Error('Unexpected fixture request '+url);});
 vi.stubGlobal('fetch',requests);
 host=new ManualPlanHost(async(input,init)=>{const url=String(input);if(url.endsWith('/list'))return json({items:[plan(),plan('plan-b')],total:2,offset:0,nextOffset:null});if(url.endsWith('/get'))return json(plan(JSON.parse(String(init?.body)).id));throw Error('No writes expected');});host.activate();host.setAuthority('a'.repeat(64),true);
 history.replaceState(null,'','/?page=planner');shellView=render(<OrdinaryNavigationShell lifetime={new OrdinaryRequestLifetime()} manualPlanHost={host} identityScope={'a'.repeat(64)}/>);
 fireEvent.click(await screen.findByRole('button',{name:'plan-a',exact:true}));await screen.findByRole('button',{name:'为此计划查找本地资料'});return requests;
}
async function expand(){fireEvent.click(screen.getByRole('button',{name:'为此计划查找本地资料'}));return await screen.findByRole('button',{name:'打开 PDF：Fixture.pdf'});}
it('saved-plan opt-in uses real search, explicit query and text preview without leaking plan text or writing relations',async()=>{const requests=await start();expect(requests).not.toHaveBeenCalled();await expand();expect((screen.getByLabelText('文档查询') as HTMLInputElement).value).toBe('');fireEvent.change(screen.getByLabelText('文档查询'),{target:{value:'chosen query'}});fireEvent.click(screen.getByRole('button',{name:'搜索文档'}));await waitFor(()=>expect(requests.mock.calls.some(([u])=>String(u).includes('q=chosen+query'))).toBe(true));fireEvent.click(await screen.findByRole('button',{name:'Fixture.pdf',exact:true}));await screen.findByText('Actual component synthetic text preview');expect(location.search).toBe('?page=planner');expect(JSON.stringify(requests.mock.calls)).not.toMatch(/Private objective|Private notes|plan-a/);expect(requests.mock.calls.every(([,init])=>!init?.method||init.method==='GET')).toBe(true);});
it('explicit result opens exact PDF through real shell and document receiver',async()=>{await start();const open=await expand();fireEvent.click(open);expect((await screen.findByTestId('selected-reader')).dataset.id).toBe(id);expect(location.search).toBe('?page=documents');expect(JSON.stringify(history.state)).not.toContain(id);});
it('dirty plan Stay preserves plan and search; Leave opens PDF once and retains draft',async()=>{await start();const open=await expand();fireEvent.change(screen.getByLabelText('备注'),{target:{value:'unsaved retained'}});const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);fireEvent.click(open);expect(location.search).toBe('?page=planner');expect(screen.queryByTestId('selected-reader')).toBeNull();expect(confirm).toHaveBeenCalledTimes(1);confirm.mockReturnValue(true);fireEvent.click(open);await screen.findByTestId('selected-reader');expect(confirm).toHaveBeenCalledTimes(2);expect(host.session?.editor?.draft.notes).toBe('unsaved retained');});
it('switching saved plans closes temporary search and does not carry a query to another plan',async()=>{await start();await expand();fireEvent.change(screen.getByLabelText('文档查询'),{target:{value:'do not carry'}});fireEvent.click(screen.getByRole('button',{name:'plan-b',exact:true}));await waitFor(()=>expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('plan-b'));expect(screen.queryByLabelText('文档查询')).toBeNull();await expand();expect((screen.getByLabelText('文档查询') as HTMLInputElement).value).toBe('');expect(screen.getByText('当前已保存计划：plan-b')).toBeTruthy();});
it('new unsaved plan has no materials context, close stops search and reopening is explicit',async()=>{await start();await expand();fireEvent.click(screen.getByRole('button',{name:'收起计划资料检索'}));expect(screen.queryByLabelText('文档查询')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'新建手动计划'}));expect(screen.queryByRole('button',{name:'为此计划查找本地资料'})).toBeNull();});

it('selected transcript result reaches actual library with exact source and job selection',async()=>{const requests=await start();await expand();fireEvent.click(screen.getByRole('button',{name:'转写',exact:true}));const link=await screen.findByRole('link',{name:'在转写资料库打开'});fireEvent.click(link);await waitFor(()=>expect(requests.mock.calls.some(([url])=>String(url).includes('/api/local-asr/jobs?')&&new URL(String(url),'http://localhost').searchParams.get('jobId')===id)).toBe(true));expect(new URL(location.href).searchParams.get('transcriptJob')).toBe(id);expect(new URL(location.href).searchParams.get('transcriptStoreId')).toBe(scope);await screen.findByText('Selected saved transcript');expect(screen.queryByRole('heading',{name:'当前已保存计划：plan-a'})).toBeNull();});

const back=async()=>{await act(async()=>{history.back();await new Promise(resolve=>setTimeout(resolve,100));});};
const forward=async()=>{await act(async()=>{history.forward();await new Promise(resolve=>setTimeout(resolve,100));});};
it.each(['pdf','transcript'])('plan -> submitted query/page 2 -> %s -> accepted Back restores once, retaining dirty plan',async target=>{
 const requests=await start(true);await expand();const label=target==='pdf'?'文档':'转写';
 if(target==='transcript')fireEvent.click(screen.getByRole('button',{name:'转写',exact:true}));
 await screen.findByText(`${label}匹配：11 条（查询：全部）。按本地${target==='pdf'?'入库':'创建'}时间倒序，非相关性排名。`);
 fireEvent.change(screen.getByLabelText(`${label}查询`),{target:{value:'chosen query'}});fireEvent.click(screen.getByRole('button',{name:`搜索${label}`}));await screen.findByText(/查询：chosen query/);
 const active=screen.getByRole('region',{name:`本地${label}搜索`});fireEvent.click(within(active).getByRole('button',{name:'下一页'}));await within(active).findByText('第 2 页');
 fireEvent.change(screen.getByLabelText(`${label}查询`),{target:{value:'not submitted'}});
 fireEvent.change(screen.getByLabelText('备注'),{target:{value:'retained notes'}});
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 const open=()=>target==='pdf'?fireEvent.click(screen.getByRole('button',{name:'打开 PDF：Fixture.pdf'})):fireEvent.click(screen.getByRole('link',{name:'在转写资料库打开'}));
 open();expect(location.search).toBe('?page=planner');expect(screen.getByLabelText(`${label}查询`)).toHaveProperty('value','not submitted');
 confirm.mockReturnValue(true);open();
 if(target==='pdf')await screen.findByTestId('selected-reader');else await screen.findByText('Selected saved transcript');
 confirm.mockReturnValue(false);await back();expect(new URL(location.href).searchParams.get('page')).toBe(target==='pdf'?'documents':'files');
 confirm.mockReturnValue(true);await back();await screen.findByRole('button',{name:'收起计划资料检索'});await screen.findByText(/查询：chosen query/);
 expect(screen.getByLabelText('标题')).toHaveProperty('value','plan-a');expect(screen.getByLabelText('备注')).toHaveProperty('value','retained notes');expect(screen.getByLabelText(`${label}查询`)).toHaveProperty('value','chosen query');
 expect(screen.getByRole('region',{name:`本地${label}搜索`}).hidden).toBe(false);
 expect(within(screen.getByRole('region',{name:`本地${label}搜索`})).getByText('第 2 页')).toBeTruthy();
 expect(requests.mock.calls.some(([url])=>String(url).includes('q=chosen+query')&&String(url).includes('offset=10'))).toBe(true);
 expect(JSON.stringify(history.state)).not.toMatch(/chosen query|plan-a|retained notes/);
 expect(JSON.stringify(requests.mock.calls)).not.toMatch(/Private objective|Private notes|plan-a|retained notes/);expect(requests.mock.calls.every(([,init])=>!init?.method||init.method==='GET')).toBe(true);expect(screen.queryByLabelText('本次模拟问题')).toBeNull();
 await forward();await back();await screen.findByRole('button',{name:'为此计划查找本地资料'});expect(screen.queryByLabelText(`${label}查询`)).toBeNull();
});
it.each(['pdf','transcript'])('return to plan refuses changed %s source before listing results',async target=>{
 const requests=await start();await expand();
 if(target==='pdf'){fireEvent.click(screen.getByRole('button',{name:'打开 PDF：Fixture.pdf'}));await screen.findByTestId('selected-reader');await screen.findByText('本地研究文档');}
 else{fireEvent.click(screen.getByRole('button',{name:'转写',exact:true}));fireEvent.click(await screen.findByRole('link',{name:'在转写资料库打开'}));await screen.findByText('Selected saved transcript');}
 liveScope='30000000-0000-4000-8000-000000000003';const listCount=()=>requests.mock.calls.filter(([u])=>String(u).startsWith(target==='pdf'?'/api/documents?':'/api/local-asr/jobs?')).length;const before=listCount();
 await back();await screen.findByRole('button',{name:'收起计划资料检索'});await screen.findByRole('alert');expect(listCount()).toBe(before);
 expect(screen.queryByRole('button',{name:'打开 PDF：Fixture.pdf'})).toBeNull();expect(screen.queryByRole('link',{name:'在转写资料库打开'})).toBeNull();
});
it.each(['identity','record'])('a changed %s does not reopen the previous plan materials on Back',async change=>{
 await start();await expand();fireEvent.click(screen.getByRole('button',{name:'打开 PDF：Fixture.pdf'}));await screen.findByTestId('selected-reader');
 if(change==='identity')shellView.rerender(<OrdinaryNavigationShell lifetime={new OrdinaryRequestLifetime()} manualPlanHost={host} identityScope={'b'.repeat(64)}/>);
 else {const record=host.session!.editor!.record!;host.session!.editor={...host.session!.editor!,record:{...record,revision:record.revision+1}};}
 await back();await screen.findByRole('button',{name:'为此计划查找本地资料'});expect(screen.queryByLabelText('文档查询')).toBeNull();
});
