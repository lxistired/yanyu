import {afterEach, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {LocalRecentMaterials} from '../candidate/src/components/LocalRecentMaterials';

// Synthetic source protocol only: no audio, application server or AI service.
const scope='11111111-1111-4111-8111-111111111111';
const otherScope='22222222-2222-4222-8222-222222222222';
const id=(n:number)=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
const job=(n:number,created=n<=10?'2024-02-28T23:59:59.999Z':'2024-02-29T23:59:59.999Z')=>({id:id(n),title:`Transcript ${n}`,filename:`source-${n}.wav`,status:'completed',created,deleted_at:null,result:null});
const json=(value:unknown,status=200,identity:string|null=scope)=>new Response(JSON.stringify(value),{status,headers:identity?{'X-Transcription-Store-Id':identity}:{}});
const page=(rows:ReturnType<typeof job>[],offset=0)=>({total:rows.length,offset,limit:10,hasMore:offset+10<rows.length,jobs:rows.slice(offset,offset+10)});
type Call={url:URL;init:RequestInit};
function fixture(override?:(url:URL,init:RequestInit)=>Response|Promise<Response>|undefined) {
 const calls:Call[]=[];
 vi.stubGlobal('fetch',vi.fn((input:string,init:RequestInit)=>{
  const url=new URL(input,'http://localhost');calls.push({url,init});
  const result=override?.(url,init);if(result!==undefined)return Promise.resolve(result);
  if(url.pathname==='/api/local-asr/identity')return Promise.resolve(json({transcriptionStoreId:scope}));
  if(url.pathname==='/api/documents/choices')return Promise.resolve(json({uploadScope:scope}));
  const offset=Number(url.searchParams.get('offset')||0);
  if(url.pathname==='/api/documents')return Promise.resolve(json({storeScope:scope,total:11,offset,limit:10,documents:Array.from({length:Math.min(10,11-offset)},(_,i)=>({id:id(i+offset+1),name:`Document ${i+offset+1}`,format:'txt',createdAt:'2024-01-01',trashedAt:null}))}));
  if(url.pathname==='/api/local-asr/jobs') {
   let rows=Array.from({length:25},(_,i)=>job(i+1));
   // Independent fixture oracle, not the production helper being tested.
   const from=url.searchParams.get('createdFrom'),through=url.searchParams.get('createdThrough');
   if(from)rows=rows.filter(row=>Date.parse(row.created)>=Date.parse(from+'T00:00:00.000Z'));
   if(through)rows=rows.filter(row=>Date.parse(row.created)<Date.parse(through+'T00:00:00.000Z')+86400000);
   const statuses=url.searchParams.get('statuses')?.split(',');if(statuses)rows=rows.filter(row=>statuses.includes(row.status));
   return Promise.resolve(json(page(rows,offset)));
  }
  throw Error('Unexpected synthetic request');
 }));return calls;
}
const reads=(calls:Call[])=>calls.filter(call=>call.url.pathname==='/api/local-asr/jobs');
const last=(calls:Call[])=>reads(calls).at(-1)!.url.searchParams;
const open=()=>fireEvent.click(screen.getByRole('button',{name:'创建日期筛选'}));
const from=(value:string)=>fireEvent.change(screen.getByLabelText('开始日期（UTC）'),{target:{value}});
const through=(value:string)=>fireEvent.change(screen.getByLabelText('结束日期（UTC，含当天）'),{target:{value}});
const apply=()=>fireEvent.click(screen.getByRole('button',{name:'应用日期筛选'}));
const next=(name='转写记录分页')=>fireEvent.click(within(screen.getByRole('navigation',{name})).getByText('下一页'));
const selectStatus=(label:string)=>{fireEvent.click(screen.getByRole('button',{name:/转写状态筛选/}));fireEvent.click(screen.getByLabelText(label));fireEvent.click(screen.getByText('确认筛选'));};
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

it('date Apply resets only transcript paging and requests server-filtered totals beyond the original ten',async()=>{
 const calls=fixture();render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');await screen.findByText('Document 1');
 next('文档入库分页');await screen.findByText('Document 11');next();await screen.findByText('Transcript 11');
 const documentReads=calls.filter(c=>c.url.pathname==='/api/documents').length;
 open();from('2024-02-29');through('2024-02-29');apply();
 await waitFor(()=>expect(last(calls).get('offset')).toBe('0'));await screen.findByText('Transcript 11');
 expect(screen.queryByText('Transcript 1')).toBeNull();expect(screen.getByText('Document 11')).toBeTruthy();
 expect(screen.getByText('第 1 页 · 当前筛选共 15 条')).toBeTruthy();expect(last(calls).get('createdThrough')).toBe('2024-02-29');
 next();await screen.findByText('Transcript 21');expect(screen.getByText('第 2 页 · 当前筛选共 15 条')).toBeTruthy();
 expect((within(screen.getByRole('navigation',{name:'转写记录分页'})).getByText('下一页') as HTMLButtonElement).disabled).toBe(true);
 const beforeNoop=calls.length;open();apply();expect(calls).toHaveLength(beforeNoop);expect(screen.getByText('Transcript 21')).toBeTruthy();
 fireEvent.click(screen.getByText('刷新转写记录'));await screen.findByText('Transcript 21');expect(last(calls).get('createdFrom')).toBe('2024-02-29');expect(last(calls).get('offset')).toBe('10');
 expect(calls.filter(c=>c.url.pathname==='/api/documents')).toHaveLength(documentReads);
 expect(calls.filter(c=>c.url.pathname==='/api/local-asr/identity')).toHaveLength(1);
 for(const call of reads(calls)){expect(call.init.method).toBe('GET');expect(call.init.headers).toEqual({'X-Transcription-Store-Id':scope});expect(call.url.searchParams.get('scope')).toBe('active');expect(call.url.searchParams.get('q')).toBe('');}
});

it('draft edits, reset, cancel, invalid Apply and no-op never fetch or reset page',async()=>{
 const calls=fixture();render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');next();await screen.findByText('Transcript 11');const count=calls.length;
 open();from('2024-02-29');fireEvent.click(screen.getByText('重置暂存日期'));expect((screen.getByLabelText('开始日期（UTC）') as HTMLInputElement).value).toBe('');
 for(const invalid of ['2023-02-29','2024-04-31','0000-01-01','10000-01-01','2024-2-29','2024-02-29 ']){from(invalid);apply();expect(screen.getByRole('alert').textContent).toContain('请输入有效');}
 from('2024-03-01');through('2024-02-29');apply();expect(calls).toHaveLength(count);
 fireEvent.click(screen.getByText('取消日期筛选'));open();expect((screen.getByLabelText('开始日期（UTC）') as HTMLInputElement).value).toBe('');apply();
 expect(calls).toHaveLength(count);expect(screen.getByText('Transcript 11')).toBeTruthy();expect(screen.queryByRole('form',{name:'创建日期筛选（UTC）'})).toBeNull();
});

it('status and date commits intersect and reset independently; reload retains both',async()=>{
 const calls=fixture();render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');open();from('2024-02-29');apply();await screen.findByText('Transcript 11');
 selectStatus('转写完成');await waitFor(()=>expect(last(calls).get('statuses')).toBe('completed'));await screen.findByText('Transcript 11');expect(last(calls).get('createdFrom')).toBe('2024-02-29');
 fireEvent.click(screen.getByText('重新载入转写来源'));await screen.findByText('Transcript 11');expect(last(calls).get('createdFrom')).toBe('2024-02-29');expect(last(calls).get('statuses')).toBe('completed');
 open();fireEvent.click(screen.getByText('重置暂存日期'));const count=calls.length;expect(last(calls).has('createdFrom')).toBe(true);fireEvent.click(screen.getByText('取消日期筛选'));expect(calls).toHaveLength(count);
 open();expect((screen.getByLabelText('开始日期（UTC）') as HTMLInputElement).value).toBe('2024-02-29');fireEvent.click(screen.getByText('重置暂存日期'));apply();await screen.findByText('Transcript 1');expect(last(calls).has('createdFrom')).toBe(false);expect(last(calls).has('createdThrough')).toBe(false);expect(last(calls).get('statuses')).toBe('completed');
 selectStatus('全部状态');await waitFor(()=>expect(last(calls).has('statuses')).toBe(false));await screen.findByText('Transcript 1');open();from('2025-01-01');apply();await screen.findByText('没有匹配所选筛选条件的本地转写记录。');expect(screen.getByText('第 1 页 · 当前筛选共 0 条')).toBeTruthy();
});

it.each([
 ['2024-02-29','2024-02-29','2024-02-29'],
 ['2024-02-29','2024-02-29','2024-02-29T00:00:00Z'],
 ['2024-02-29','2024-02-29','2024-02-29T23:59:59.999Z'],
 ['0001-01-01','','0001-01-01T00:00:00.000Z'],
 ['','9999-12-31','9999-12-31T23:59:59.999Z'],
])('accepts supported UTC legacy boundaries %s / %s / %s',async(start,end,created)=>{
 const calls=fixture(url=>url.pathname==='/api/local-asr/jobs'?json(page([job(50,created)])):undefined);
 render(<LocalRecentMaterials/>);await screen.findByText('Transcript 50');open();from(start);through(end);apply();await waitFor(()=>expect(reads(calls)).toHaveLength(2));await screen.findByText('Transcript 50');
 expect(last(calls).get('createdFrom')).toBe(start||null);expect(last(calls).get('createdThrough')).toBe(end||null);expect(screen.queryByRole('alert')).toBeNull();
});

it.each(['2024-02-28T23:59:59.999Z','2024-03-01T00:00:00.000Z','2024-02-29T12:00:00+00:00','2024-02-29T12:00:00','2024-02-29T12:00:00.1Z','2023-02-29','historical unknown'])('fails closed on filtered returned created=%s without trimming a page or trusting its total',async(created)=>{
 fixture(url=>url.pathname==='/api/local-asr/jobs'?json(page([job(50),job(51,created)])):undefined);
 render(<LocalRecentMaterials/>);await screen.findByText('Transcript 51');open();from('2024-02-29');through('2024-02-29');apply();
 await screen.findByText('本地转写来源返回了无法核验或不匹配所选创建日期的记录，请重试');expect(screen.queryByText('Transcript 50')).toBeNull();expect(screen.queryByText('Transcript 51')).toBeNull();expect(screen.queryByRole('navigation',{name:'转写记录分页'})).toBeNull();expect(screen.getByText('Document 1')).toBeTruthy();
});

it.each(['changed','missing','409'] as const)('date change cannot bypass %s source identity; explicit reload retains dates',async(mode)=>{
 let fail=false;const calls=fixture(url=>url.pathname==='/api/local-asr/jobs'&&fail?json(page([]),mode==='409'?409:200,mode==='missing'?null:otherScope):undefined);
 render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');fail=true;fireEvent.click(screen.getByText('刷新转写记录'));await screen.findByRole('alert');await waitFor(()=>expect(screen.queryByText('正在读取转写记录…')).toBeNull());expect((screen.getByText('刷新转写记录') as HTMLButtonElement).disabled).toBe(true);const count=calls.length;
 open();from('2024-02-29');apply();await screen.findByText('转写来源无法核验或已变化，请明确重新载入转写来源。');expect(calls).toHaveLength(count);expect(screen.queryByText('Transcript 1')).toBeNull();
 fail=false;fireEvent.click(screen.getByText('重新载入转写来源'));await screen.findByText('Transcript 11');expect(last(calls).get('createdFrom')).toBe('2024-02-29');expect(calls.filter(c=>c.url.pathname==='/api/local-asr/identity')).toHaveLength(2);
});

it.each(['response','http-error','json','json-error'] as const)('new date commit fences stale %s including ignored aborts',async(mode)=>{
 let settle!:(value?:unknown)=>void,started=false;
 fixture(url=>{
  if(url.pathname==='/api/local-asr/jobs'&&url.searchParams.get('createdFrom')==='2024-02-28') {
   started=true;
   if(mode==='response'||mode==='http-error')return new Promise<Response>(resolve=>{settle=()=>resolve(mode==='response'?json(page([job(90)])):json({},409,otherScope));});
   return {ok:true,status:200,headers:new Headers({'X-Transcription-Store-Id':scope}),json:()=>new Promise((resolve,reject)=>{settle=()=>mode==='json'?resolve(page([job(90)])):reject(Error('STALE DATE JSON'));})} as Response;
  }
 });
 render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');open();from('2024-02-28');apply();await waitFor(()=>expect(started&&settle).toBeTruthy());
 open();from('2024-02-29');apply();await screen.findByText('Transcript 11');await act(async()=>{settle();});
 expect(screen.queryByText('Transcript 90')).toBeNull();expect(screen.queryByText('STALE DATE JSON')).toBeNull();expect(screen.queryByRole('alert')).toBeNull();expect((screen.getByText('刷新转写记录') as HTMLButtonElement).disabled).toBe(false);
});

it('date Apply synchronously fences an old row handler before React flushes',async()=>{
 fixture();const navigate=vi.fn();render(<LocalRecentMaterials onNavigate={navigate}/>);const old=await screen.findByText('打开转写记录：Transcript 1');open();from('2024-02-29');const submit=screen.getByText('应用日期筛选');
 act(()=>{submit.click();old.click();});expect(navigate).not.toHaveBeenCalled();fireEvent.click(await screen.findByText('打开转写记录：Transcript 11'));expect(navigate).toHaveBeenCalledTimes(1);
 expect(new URL(navigate.mock.calls[0][0],location.href).searchParams.get('transcriptStoreId')).toBe(scope);
});

it('filtered page shrink recovery and retry retain date bounds',async()=>{
 let total=15,fail=false;const calls=fixture(url=>url.pathname==='/api/local-asr/jobs'&&url.searchParams.has('createdFrom')?json(fail?{}:page(Array.from({length:total},(_,i)=>job(11+i)),Number(url.searchParams.get('offset'))),fail?503:200):undefined);
 render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');open();from('2024-02-29');apply();await screen.findByText('Transcript 11');next();await screen.findByText('Transcript 21');
 total=1;fireEvent.click(screen.getByText('刷新转写记录'));await screen.findByText('Transcript 11');expect(last(calls).get('offset')).toBe('0');expect(last(calls).get('createdFrom')).toBe('2024-02-29');
 fail=true;fireEvent.click(screen.getByText('刷新转写记录'));await screen.findByText(/503/);fail=false;fireEvent.click(screen.getByText('重试转写记录'));await screen.findByText('Transcript 11');expect(last(calls).get('createdFrom')).toBe('2024-02-29');
});

it('date-filtered results remain capped at offset 1000 without changing document paging',async()=>{
 const calls=fixture(url=>url.pathname==='/api/local-asr/jobs'&&url.searchParams.has('createdFrom')?json(page(Array.from({length:1020},(_,i)=>job(11+i)),Number(url.searchParams.get('offset')))):undefined);
 render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');open();from('2024-02-29');apply();await screen.findByText('Transcript 11');
 for(let offset=10;offset<=1000;offset+=10){next();await screen.findByText(`Transcript ${offset+11}`);}
 const button=within(screen.getByRole('navigation',{name:'转写记录分页'})).getByText('下一页') as HTMLButtonElement;expect(button.disabled).toBe(true);fireEvent.click(button);
 expect(Math.max(...reads(calls).map(call=>Number(call.url.searchParams.get('offset'))))).toBe(1000);expect(screen.getByText('Document 1')).toBeTruthy();expect(screen.getByText(/此页最多浏览该来源前 1010 条/)).toBeTruthy();
});
