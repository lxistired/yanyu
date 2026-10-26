// Actual LocalDocuments -> citation preview -> PdfPageReader / PdfAnnotations.
// In-memory HTTP-shaped fixtures only; no browser, raster decoding or backend proof.
import React,{StrictMode} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {LocalDocuments} from '../candidate/src/components/LocalDocuments';
import {imageResponse,installPdfCrypto} from './pdf-image-fixture';
const scope='10000000-0000-4000-8000-000000000001',id='20000000-0000-4000-8000-000000000002',other='30000000-0000-4000-8000-000000000003';
const record={id,revision:4,trashedAt:null,name:'Synthetic retained PDF',format:'pdf',bytes:100,sha256:'a'.repeat(64),textSha256:'b'.repeat(64),createdAt:'2026-10-23',pages:4,workspaceId:null,folderId:null,workspaceName:null,folderName:null,stale:false};
const text='Synthetic retained text. The citation stays text-level.';
const action='打开此 PDF 页面阅读器（上次阅读位置）';
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
type Options={detail?:Record<string,unknown>;list?:Record<string,unknown>;reader?:Record<string,unknown>;readerStatus?:number;total?:number};
function setup(options:Options={}){
 const detail={...record,...options.detail},list={...record,...options.list};
 const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(String(input),'http://synthetic.invalid'),path=url.pathname;
  if(path==='/api/documents/choices')return json({uploadScope:scope,workspaces:[],folders:[]});
  if(path==='/api/documents')return json({storeScope:scope,documents:[list],total:options.total??1,offset:Number(url.searchParams.get('offset')),limit:10});
  if(path===`/api/documents/${id}`){expect(new Headers(init?.headers).get('X-Citation-Store-Id')).toBe(scope);return json({storeScope:scope,document:detail,text});}
  if(path===`/api/documents/${id}/citations`)return json({citations:[]});
  if(path===`/api/documents/${id}/reader`){expect(new Headers(init?.headers).get('X-Document-Store-Id')).toBe(scope);return json({storeScope:scope,sha256:detail.sha256,pages:detail.pages,page:3,scale:100,bookmark:null,...options.reader},options.readerStatus??200);}
  if(path===`/api/documents/${id}/page`){expect(new Headers(init?.headers).get('X-Document-Store-Id')).toBe(scope);return imageResponse(String(input),String(detail.sha256),Number(detail.pages),scope);}
  if(path===`/api/documents/${id}/annotations`)return json({storeScope:scope,documentId:id,sha256:detail.sha256,revision:0,notes:[]});
  throw Error('Unexpected synthetic request '+path);
 });vi.stubGlobal('fetch',fetcher);return {...render(<StrictMode><LocalDocuments/></StrictMode>),fetcher};
}
const readerCalls=(fetcher:ReturnType<typeof setup>['fetcher'])=>fetcher.mock.calls.filter(([p])=>String(p).endsWith('/reader'));
const writes=(fetcher:ReturnType<typeof setup>['fetcher'])=>fetcher.mock.calls.filter(([,init])=>init?.method&&init.method!=='GET');
async function preview(){fireEvent.click(await screen.findByRole('button',{name:'预览纯文本',exact:true}));await screen.findByText('尚无已保存引用');await waitFor(()=>expect((screen.getByRole('button',{name:action}) as HTMLButtonElement).disabled).toBe(false));}
function capture(){const pre=screen.getByLabelText('可选择的原始提取文字'),range=document.createRange();range.setStart(pre.firstChild!,0);range.setEnd(pre.firstChild!,9);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);fireEvent.mouseUp(pre);}
function handler(button:HTMLElement):()=>void {const key=Object.keys(button).find(key=>key.startsWith('__reactProps$'));if(!key)throw Error('Missing React test handler');return (button as any)[key].onClick;}
beforeEach(()=>{history.replaceState(null,'','/?page=documents');localStorage.clear();sessionStorage.clear();installPdfCrypto();vi.spyOn(window,'confirm').mockReturnValue(true);});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear();sessionStorage.clear();history.replaceState(null,'','/');});
it('opens only on explicit action, pins retained detail rather than list, and resumes saved page without text mapping',async()=>{
 const {fetcher}=setup({list:{sha256:'c'.repeat(64),pages:2}});await preview();expect(readerCalls(fetcher)).toHaveLength(0);expect(writes(fetcher)).toHaveLength(0);
 expect(screen.getByText('打开此 PDF 上次保存的阅读位置；首次阅读从第 1 页开始。不会按所选文字或引用定位 PDF 页码。')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:action}));const image=await screen.findByRole('img');expect(image.getAttribute('data-source-url')).toBe(`/api/documents/${id}/page?page=3&scale=100&storeScope=${scope}`);
 expect(screen.getByText('第 3 / 4 页 · 缩放 100%')).toBeTruthy();expect(screen.queryByRole('region',{name:'文档纯文本预览'})).toBeNull();expect(window.confirm).not.toHaveBeenCalled();expect(writes(fetcher)).toHaveLength(0);
});
it('Stay retains exact citation selection/note without a reader request; Leave asks once and opens saved page',async()=>{
 const {fetcher}=setup();await preview();capture();fireEvent.change(screen.getByLabelText('人工备注（可选）'),{target:{value:'keep this citation draft'}});
 vi.mocked(window.confirm).mockReturnValue(false);const before=fetcher.mock.calls.length;fireEvent.click(screen.getByRole('button',{name:action}));
 expect(window.confirm).toHaveBeenCalledTimes(1);expect(screen.getByText('已选范围 [0, 9)')).toBeTruthy();expect((screen.getByLabelText('人工备注（可选）') as HTMLTextAreaElement).value).toBe('keep this citation draft');expect(fetcher.mock.calls).toHaveLength(before);expect(readerCalls(fetcher)).toHaveLength(0);
 vi.mocked(window.confirm).mockReturnValue(true);fireEvent.click(screen.getByRole('button',{name:action}));await screen.findByRole('img');expect(window.confirm).toHaveBeenCalledTimes(2);expect(screen.getByText('第 3 / 4 页 · 缩放 100%')).toBeTruthy();expect(writes(fetcher)).toHaveLength(0);
});
it('reader Close protects annotation draft, then returns to the same search and list page',async()=>{
 const {fetcher}=setup({total:11});await screen.findByText('共 11 个文档；第 1 页');fireEvent.change(screen.getByLabelText('搜索文档'),{target:{value:'Synthetic'}});fireEvent.click(screen.getByRole('button',{name:'搜索',exact:true}));await waitFor(()=>expect(fetcher.mock.calls.some(([p])=>String(p).includes('q=Synthetic'))).toBe(true));
 fireEvent.click(await screen.findByRole('button',{name:'下一页',exact:true}));await screen.findByText('共 11 个文档；第 2 页');await preview();fireEvent.click(screen.getByRole('button',{name:action}));await screen.findByRole('img');await screen.findByText('尚无批注');
 fireEvent.click(screen.getByText('新增当前页批注'));fireEvent.change(screen.getByLabelText('批注内容'),{target:{value:'keep page-three annotation'}});vi.mocked(window.confirm).mockReturnValue(false);fireEvent.click(screen.getByText('关闭 PDF 阅读器'));
 expect((screen.getByLabelText('批注内容') as HTMLTextAreaElement).value).toBe('keep page-three annotation');expect(screen.getByRole('heading',{name:'新增第 3 页页面批注'})).toBeTruthy();expect(window.confirm).toHaveBeenCalledTimes(1);
 const before=fetcher.mock.calls.length;vi.mocked(window.confirm).mockReturnValue(true);fireEvent.click(screen.getByText('关闭 PDF 阅读器'));expect(screen.queryByRole('region',{name:'PDF 页面阅读器'})).toBeNull();expect(screen.getByText('共 11 个文档；第 2 页')).toBeTruthy();expect((screen.getByLabelText('搜索文档') as HTMLInputElement).value).toBe('Synthetic');expect(fetcher.mock.calls).toHaveLength(before);expect(writes(fetcher)).toHaveLength(0);
});
it.each([{pages:null},{sha256:'invalid'},{stale:true},{trashedAt:'2026-10-23'},{revision:undefined}])('retains readable text but disables opening when retained PDF metadata cannot be admitted: %j',async detail=>{
 const {fetcher}=setup({detail});fireEvent.click(await screen.findByRole('button',{name:'预览纯文本',exact:true}));await screen.findByText('尚无已保存引用');expect(screen.getByLabelText('可选择的原始提取文字').textContent).toBe(text);expect((screen.getByRole('button',{name:action}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByRole('button',{name:action}));expect(readerCalls(fetcher)).toHaveLength(0);expect(writes(fetcher)).toHaveLength(0);
});
it.each([
 ['content',{reader:{sha256:'c'.repeat(64)}}],['store',{reader:{storeScope:other}}],['access',{readerStatus:403}],
] as const)('retained selection does not bypass live reader %s rejection',async(_label,options)=>{
 const {fetcher}=setup(options);await preview();fireEvent.click(screen.getByRole('button',{name:action}));await screen.findAllByRole('alert');expect(screen.queryByRole('img')).toBeNull();expect(fetcher.mock.calls.some(([p])=>String(p).includes('/page?')||String(p).endsWith('/annotations'))).toBe(false);expect(writes(fetcher)).toHaveLength(0);
});
it.each(['close','replacement','unmount'])('withdraws captured preview action after %s',async kind=>{
 const {fetcher,unmount}=setup();await preview();const old=handler(screen.getByRole('button',{name:action}));
 if(kind==='unmount')unmount();else{fireEvent.click(screen.getByText('关闭预览'));if(kind==='replacement')await preview();}
 const before=fetcher.mock.calls.length;act(()=>old());expect(fetcher.mock.calls).toHaveLength(before);expect(readerCalls(fetcher)).toHaveLength(0);expect(screen.queryByRole('region',{name:'PDF 页面阅读器'})).toBeNull();
 if(kind==='replacement'){fireEvent.click(screen.getByRole('button',{name:action}));await screen.findByRole('img');}
});
it('consumes a captured action synchronously so repeated activation cannot reopen the reader',async()=>{
 const {fetcher}=setup();await preview();const click=handler(screen.getByRole('button',{name:action}));act(()=>{click();click();});await screen.findByRole('img');const before=readerCalls(fetcher).length;act(()=>click());expect(readerCalls(fetcher)).toHaveLength(before);expect(writes(fetcher)).toHaveLength(0);
});
