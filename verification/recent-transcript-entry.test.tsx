import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {LocalRecentMaterials} from '../candidate/src/components/LocalRecentMaterials';
import {LocalResearchSearch} from '../candidate/src/components/LocalResearchSearch';
const scope='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const id=(n:number)=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
const job=(n:number,origin='file-selection')=>({id:id(n),title:`Transcript ${n}`,filename:`synthetic-${n}.wav`,status:'completed',created:'2024-02-29T23:59:59.999Z',deleted_at:null,result:null,uploadOrigin:origin,uploadOriginAssurance:origin==='unknown'?'unknown':'client-declared'});
const json=(data:unknown,status=200,identity:string|null=scope)=>new Response(JSON.stringify(data),{status,headers:identity?{'X-Transcription-Store-Id':identity}:{}});
const page=(rows:Record<string,unknown>[],offset=0)=>({total:rows.length,offset,limit:10,hasMore:offset+10<rows.length,jobs:rows.slice(offset,offset+10)});
type Call={url:URL;init:RequestInit};
function fixture(override?:(url:URL)=>Response|Promise<Response>|undefined){
 const calls:Call[]=[];
 vi.stubGlobal('fetch',vi.fn((input:string,init:RequestInit)=>{
  const url=new URL(input,'http://localhost');calls.push({url,init});const special=override?.(url);if(special!==undefined)return Promise.resolve(special);
  if(url.pathname==='/api/local-asr/identity')return Promise.resolve(json({transcriptionStoreId:scope}));
  if(url.pathname==='/api/documents/choices')return Promise.resolve(json({uploadScope:scope}));
  const offset=Number(url.searchParams.get('offset')||0);
  if(url.pathname==='/api/documents')return Promise.resolve(json({storeScope:scope,total:11,offset,limit:10,documents:Array.from({length:Math.min(10,11-offset)},(_,i)=>({id:id(i+offset+1),name:`Document ${i+offset+1}`,format:'txt',createdAt:'2024-01-01',trashedAt:null}))}));
  if(url.pathname==='/api/local-asr/jobs'){
   let rows=Array.from({length:27},(_,i)=>job(i+1,i<10?'unknown':i<25?'file-selection':'recording-draft'));
   const origin=url.searchParams.get('origin');if(origin)rows=rows.filter(row=>row.uploadOrigin===origin);
   const statuses=url.searchParams.get('statuses')?.split(',');if(statuses)rows=rows.filter(row=>statuses.includes(row.status));
   const from=url.searchParams.get('createdFrom'),through=url.searchParams.get('createdThrough');
   if(from)rows=rows.filter(row=>Date.parse(row.created)>=Date.parse(from+'T00:00:00.000Z'));
   if(through)rows=rows.filter(row=>Date.parse(row.created)<Date.parse(through+'T00:00:00.000Z')+86400000);
   return Promise.resolve(json(page(rows,offset)));
  }throw Error('Unexpected synthetic request');
 }));return calls;
}
const reads=(calls:Call[])=>calls.filter(c=>c.url.pathname==='/api/local-asr/jobs');
const last=(calls:Call[])=>reads(calls).at(-1)!.url.searchParams;
const open=()=>fireEvent.click(screen.getByRole('button',{name:'提交入口筛选'}));
const select=(value:string)=>fireEvent.change(screen.getByLabelText('提交入口（客户端声明）'),{target:{value}});
const apply=()=>fireEvent.click(screen.getByText('应用入口筛选'));
const commit=(value:string)=>{open();select(value);apply();};
const next=(name='转写记录分页')=>fireEvent.click(within(screen.getByRole('navigation',{name})).getByText('下一页'));
const status=(label:string)=>{fireEvent.click(screen.getByRole('button',{name:/转写状态筛选/}));fireEvent.click(screen.getByLabelText(label));fireEvent.click(screen.getByText('确认筛选'));};
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('commits each entry server-side before pagination, resets transcript offset and leaves documents independent',async()=>{
 const calls=fixture();render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');await screen.findByText('Document 1');next('文档入库分页');await screen.findByText('Document 11');next();await screen.findByText('Transcript 11');const docs=calls.filter(c=>c.url.pathname==='/api/documents').length;
 commit('file-selection');await screen.findByText('第 1 页 · 当前筛选共 15 条');expect(last(calls).get('offset')).toBe('0');await screen.findByText('Transcript 11');next();await screen.findByText('Transcript 21');expect(screen.getByText('第 2 页 · 当前筛选共 15 条')).toBeTruthy();
 commit('recording-draft');await screen.findByText('Transcript 26');expect(last(calls).get('origin')).toBe('recording-draft');
 commit('unknown');await screen.findByText('Transcript 1');expect(screen.getByText('第 1 页 · 当前筛选共 10 条')).toBeTruthy();
 commit('');await screen.findByText('第 1 页 · 此来源共 27 条');expect(last(calls).has('origin')).toBe(false);expect(screen.getByText('Document 11')).toBeTruthy();expect(calls.filter(c=>c.url.pathname==='/api/documents')).toHaveLength(docs);
 expect(calls.filter(c=>c.url.pathname==='/api/local-asr/identity')).toHaveLength(1);for(const c of reads(calls)){expect(c.init.method).toBe('GET');expect(c.init.headers).toEqual({'X-Transcription-Store-Id':scope});}
});
it('draft edits, reset, cancel, toggle dismissal and no-op preserve current page and make no reads',async()=>{
 const calls=fixture();render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');commit('file-selection');await screen.findByText('Transcript 11');next();await screen.findByText('Transcript 21');const count=calls.length;
 open();select('recording-draft');fireEvent.click(screen.getByText('重置暂存入口'));expect((screen.getByLabelText('提交入口（客户端声明）') as HTMLSelectElement).value).toBe('');fireEvent.click(screen.getByText('取消入口筛选'));
 open();expect((screen.getByLabelText('提交入口（客户端声明）') as HTMLSelectElement).value).toBe('file-selection');select('unknown');open();open();expect((screen.getByLabelText('提交入口（客户端声明）') as HTMLSelectElement).value).toBe('file-selection');apply();expect(calls).toHaveLength(count);expect(screen.getByText('Transcript 21')).toBeTruthy();
});
it('keeps status and date intersection across independent resets, refresh and explicit reload',async()=>{
 const calls=fixture();render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');commit('file-selection');await screen.findByText('Transcript 11');status('转写完成');await screen.findByText('Transcript 11');
 fireEvent.click(screen.getByText('创建日期筛选'));fireEvent.change(screen.getByLabelText('开始日期（UTC）'),{target:{value:'2024-02-29'}});fireEvent.click(screen.getByText('应用日期筛选'));await screen.findByText('Transcript 11');
 expect(last(calls).get('origin')).toBe('file-selection');expect(last(calls).get('statuses')).toBe('completed');expect(last(calls).get('createdFrom')).toBe('2024-02-29');
 next();await screen.findByText('Transcript 21');fireEvent.click(screen.getByText('刷新转写记录'));await screen.findByText('Transcript 21');expect(last(calls).get('offset')).toBe('10');fireEvent.click(screen.getByText('重新载入转写来源'));await screen.findByText('Transcript 11');expect(last(calls).get('offset')).toBe('0');expect(last(calls).get('origin')).toBe('file-selection');
 open();fireEvent.click(screen.getByText('重置暂存入口'));apply();await screen.findByText('Transcript 1');expect(last(calls).has('origin')).toBe(false);expect(last(calls).get('statuses')).toBe('completed');expect(last(calls).get('createdFrom')).toBe('2024-02-29');
 commit('recording-draft');await screen.findByText('Transcript 26');status('全部状态');await screen.findByText('Transcript 26');expect(last(calls).get('origin')).toBe('recording-draft');
 fireEvent.click(screen.getByText('创建日期筛选'));fireEvent.click(screen.getByText('重置暂存日期'));fireEvent.click(screen.getByText('应用日期筛选'));await screen.findByText('Transcript 26');expect(last(calls).get('origin')).toBe('recording-draft');expect(last(calls).has('createdFrom')).toBe(false);
 status('转写失败');await screen.findByText('没有匹配所选筛选条件的本地转写记录。');expect(screen.getByText('第 1 页 · 当前筛选共 0 条')).toBeTruthy();
});
it.each(['unknown','file-selection','recording-draft'])('rejects legacy missing fields for selected %s, but permits legacy unfiltered',async(origin)=>{
 const {uploadOrigin,uploadOriginAssurance,...legacy}=job(90);
 fixture(url=>url.pathname==='/api/local-asr/jobs'?json(page([legacy])):undefined);render(<LocalRecentMaterials/>);await screen.findByText('Transcript 90');commit(origin);await screen.findByText('本地转写来源返回了无法核验或不匹配所选提交入口的记录，请重试');expect(screen.queryByText('Transcript 90')).toBeNull();expect(screen.queryByRole('navigation',{name:'转写记录分页'})).toBeNull();expect(screen.getByText('Document 1')).toBeTruthy();
});
it('rejects an entire filtered page containing a mismatched row without keeping its total',async()=>{
 fixture(url=>url.pathname==='/api/local-asr/jobs'&&url.searchParams.has('origin')?json(page([job(90),job(91,'recording-draft')])):undefined);render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');commit('file-selection');await screen.findByText('本地转写来源返回了无法核验或不匹配所选提交入口的记录，请重试');expect(screen.queryByText('Transcript 90')).toBeNull();expect(screen.queryByRole('navigation',{name:'转写记录分页'})).toBeNull();
});
it.each(['changed','missing','409'])('entry commits cannot bypass %s source blocking',async(mode)=>{
 let fail=false;const calls=fixture(url=>url.pathname==='/api/local-asr/jobs'&&fail?json(page([]),mode==='409'?409:200,mode==='missing'?null:other):undefined);render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');fail=true;fireEvent.click(screen.getByText('刷新转写记录'));await screen.findByRole('alert');await waitFor(()=>expect(screen.queryByText('正在读取转写记录…')).toBeNull());expect((screen.getByText('刷新转写记录') as HTMLButtonElement).disabled).toBe(true);const count=calls.length;
 commit('file-selection');await screen.findByText('转写来源无法核验或已变化，请明确重新载入转写来源。');expect(calls).toHaveLength(count);fail=false;fireEvent.click(screen.getByText('重新载入转写来源'));await screen.findByText('Transcript 11');expect(last(calls).get('origin')).toBe('file-selection');expect(calls.filter(c=>c.url.pathname==='/api/local-asr/identity')).toHaveLength(2);
});
it.each(['response','http-error','json','json-error'])('fences stale entry %s including ignored abort',async(mode)=>{
 let settle!:()=>void;
 fixture(url=>{if(url.pathname==='/api/local-asr/jobs'&&url.searchParams.get('origin')==='unknown'){
  if(mode==='response'||mode==='http-error')return new Promise<Response>(resolve=>{settle=()=>resolve(mode==='response'?json(page([job(90,'unknown')])):json({},409,other));});
  return {ok:true,status:200,headers:new Headers({'X-Transcription-Store-Id':scope}),json:()=>new Promise((resolve,reject)=>{settle=()=>mode==='json'?resolve(page([job(90,'unknown')])):reject(Error('STALE ENTRY JSON'));})} as Response;
 }});render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');commit('unknown');await waitFor(()=>expect(settle).toBeTruthy());commit('file-selection');await screen.findByText('Transcript 11');await act(async()=>settle());expect(screen.queryByText('Transcript 90')).toBeNull();expect(screen.queryByRole('alert')).toBeNull();
});
it('entry Apply synchronously fences an old row before React flushes',async()=>{
 fixture();const navigate=vi.fn();render(<LocalRecentMaterials onNavigate={navigate}/>);const old=await screen.findByText('打开转写记录：Transcript 1');open();select('file-selection');const submit=screen.getByText('应用入口筛选');act(()=>{submit.click();old.click();});expect(navigate).not.toHaveBeenCalled();fireEvent.click(await screen.findByText('打开转写记录：Transcript 11'));expect(navigate).toHaveBeenCalledTimes(1);
});
it('page shrink recovery and retry retain committed entry',async()=>{
 let total=15,fail=false;const calls=fixture(url=>url.pathname==='/api/local-asr/jobs'&&url.searchParams.has('origin')?json(fail?{}:page(Array.from({length:total},(_,i)=>job(11+i)),Number(url.searchParams.get('offset'))),fail?503:200):undefined);render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');commit('file-selection');await screen.findByText('Transcript 11');next();await screen.findByText('Transcript 21');total=1;fireEvent.click(screen.getByText('刷新转写记录'));await screen.findByText('Transcript 11');expect(last(calls).get('offset')).toBe('0');expect(last(calls).get('origin')).toBe('file-selection');fail=true;fireEvent.click(screen.getByText('刷新转写记录'));await screen.findByText(/503/);fail=false;fireEvent.click(screen.getByText('重试转写记录'));await screen.findByText('Transcript 11');expect(last(calls).get('origin')).toBe('file-selection');
});
it.each(['legacy','valid','malformed'])('shared search consumer retains %s origin compatibility without an entry query',async(mode)=>{
 const {uploadOrigin,uploadOriginAssurance,...legacy}=job(90);
 const row=mode==='legacy'?legacy:mode==='valid'?job(90,'recording-draft'):{...job(90),uploadOriginAssurance:'unknown'};
 const calls=fixture(url=>url.pathname==='/api/local-asr/jobs'?json(page([row])):undefined);render(<LocalResearchSearch/>);fireEvent.click(screen.getByRole('button',{name:'转写',exact:true}));
 if(mode==='malformed'){await screen.findByText('本地来源响应无效，请重试');expect(screen.queryByText('Transcript 90')).toBeNull();}else await screen.findByText('Transcript 90');
 expect(last(calls).has('origin')).toBe(false);
});
it('entry-filtered paging respects offset 1000 and discloses capped results',async()=>{
 const calls=fixture(url=>url.pathname==='/api/local-asr/jobs'&&url.searchParams.has('origin')?json(page(Array.from({length:1020},(_,i)=>job(11+i)),Number(url.searchParams.get('offset')))):undefined);render(<LocalRecentMaterials/>);await screen.findByText('Transcript 1');commit('file-selection');await screen.findByText('Transcript 11');
 for(let offset=10;offset<=1000;offset+=10){next();await screen.findByText(`Transcript ${offset+11}`);}
 const button=within(screen.getByRole('navigation',{name:'转写记录分页'})).getByText('下一页') as HTMLButtonElement;expect(button.disabled).toBe(true);fireEvent.click(button);expect(Math.max(...reads(calls).map(c=>Number(c.url.searchParams.get('offset'))))).toBe(1000);expect(screen.getByText(/此页最多浏览该来源前 1010 条/)).toBeTruthy();
});
it('intersects heterogeneous entry, status and date membership before returning total and rows',async()=>{
 const calls=fixture(url=>{
  if(url.pathname!=='/api/local-asr/jobs')return undefined;
  let rows=[job(80),job(81,'unknown'),{...job(82),status:'failed'},{...job(83),created:'2024-02-28T23:59:59.999Z'}];
  const origin=url.searchParams.get('origin'),statuses=url.searchParams.get('statuses')?.split(','),from=url.searchParams.get('createdFrom');
  if(origin)rows=rows.filter(row=>row.uploadOrigin===origin);
  if(statuses)rows=rows.filter(row=>statuses.includes(row.status));
  if(from)rows=rows.filter(row=>Date.parse(row.created)>=Date.parse(from+'T00:00:00.000Z'));
  return json(page(rows,Number(url.searchParams.get('offset'))));
 });
 render(<LocalRecentMaterials/>);await screen.findByText('Transcript 81');commit('file-selection');await screen.findByText('第 1 页 · 当前筛选共 3 条');expect(screen.queryByText('Transcript 81')).toBeNull();
 status('转写完成');await screen.findByText('第 1 页 · 当前筛选共 2 条');expect(screen.queryByText('Transcript 82')).toBeNull();
 fireEvent.click(screen.getByText('创建日期筛选'));fireEvent.change(screen.getByLabelText('开始日期（UTC）'),{target:{value:'2024-02-29'}});fireEvent.click(screen.getByText('应用日期筛选'));await screen.findByText('第 1 页 · 当前筛选共 1 条');expect(screen.getByText('Transcript 80')).toBeTruthy();expect(screen.queryByText('Transcript 83')).toBeNull();expect(last(calls).get('origin')).toBe('file-selection');expect(last(calls).get('statuses')).toBe('completed');expect(last(calls).get('createdFrom')).toBe('2024-02-29');
});
