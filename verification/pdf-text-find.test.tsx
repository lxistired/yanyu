// Prepared component regressions. NOT RUN in the dependency-free source delta.
import React,{useState} from 'react';
import {createHash} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {PdfPageReader} from '../candidate/src/components/PdfPageReader';
import {imageResponse,installPdfCrypto} from './pdf-image-fixture';
const scope='44444444-4444-4444-8444-444444444444',id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const initial={page:1,bookmark:null,scale:100,pages:3,sha256:'a'.repeat(64)};
const props={storeScope:scope,documentId:id,documentName:'synthetic.pdf',selectedSha256:initial.sha256,selectedPages:3};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const detail=(text='needle 中文 .* needle 中文',documentId=id)=>({storeScope:scope,document:{id:documentId,name:'synthetic.pdf',format:'pdf',createdAt:'2026-10-26',trashedAt:null,stale:false,revision:0,bytes:100,sha256:initial.sha256,textSha256:createHash('sha256').update(text).digest('hex'),pages:3,workspaceId:null,folderId:null},text});
function setup(read:(path:string,init?:RequestInit)=>Promise<Response>=async()=>json(detail())){
 const fetcher=vi.fn((input:RequestInfo|URL,init?:RequestInit)=>{const path=String(input);if(path.includes('/page?'))return Promise.resolve(imageResponse(path,initial.sha256,3));if(path.endsWith('/reader'))return Promise.resolve(json({storeScope:scope,...initial,...(init?.method==='PUT'?JSON.parse(init.body as string):{})}));if(path.endsWith('/annotations'))return Promise.resolve(json({storeScope:scope,documentId:path.split('/')[3],sha256:initial.sha256,revision:0,notes:[]}));return read(path,init);});vi.stubGlobal('fetch',fetcher);return fetcher;
}
async function ready(){const image=await screen.findByRole('img');fireEvent.load(image);await screen.findByRole('button',{name:'查找 PDF 提取文字'});}
async function find(query:string){fireEvent.change(screen.getByLabelText('文内查找词'),{target:{value:query}});fireEvent.click(screen.getByRole('button',{name:'查找文字'}));}
beforeEach(()=>installPdfCrypto());
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

it('waits for verified decoded image, searches literal text and cycles without page navigation',async()=>{
 const fetcher=setup();const {container}=render(<PdfPageReader {...props}/>);await screen.findByRole('img');expect(screen.queryByText('查找 PDF 提取文字')).toBeNull();await ready();
 fireEvent.click(screen.getByText('查找 PDF 提取文字'));await screen.findByLabelText('文内查找词');await find('needle');
 expect(screen.getByText('第 1 / 2 个命中')).toBeTruthy();expect(container.querySelectorAll('mark')).toHaveLength(2);expect(container.querySelectorAll('mark.is-current')).toHaveLength(1);
 fireEvent.click(screen.getByText('下一个命中'));expect(screen.getByText('第 2 / 2 个命中')).toBeTruthy();fireEvent.click(screen.getByText('下一个命中'));expect(screen.getByText('第 1 / 2 个命中')).toBeTruthy();fireEvent.click(screen.getByText('上一个命中'));expect(screen.getByText('第 2 / 2 个命中')).toBeTruthy();
 await find('.*');expect(screen.getByText('第 1 / 1 个命中')).toBeTruthy();await find('missing');expect(screen.getByText('没有匹配的提取文字。')).toBeTruthy();await find('');expect(screen.getByText('输入查找词并点击“查找文字”。')).toBeTruthy();
 expect(screen.getByText('第 1 / 3 页 · 缩放 100%')).toBeTruthy();expect(fetcher.mock.calls.filter(([path])=>String(path).includes('/page?'))).toHaveLength(1);
});
it('shows transient read error/retry and empty-text status',async()=>{
 let fail=true;setup(async()=>fail?json({},500):json(detail('')));render(<PdfPageReader {...props}/>);await ready();fireEvent.click(screen.getByText('查找 PDF 提取文字'));await screen.findByText(/提取文字暂不可用/);fail=false;fireEvent.click(screen.getByText('重试读取查找文字'));await screen.findByText('此 PDF 没有可查找的提取文字；未进行 OCR。');
});
it('closes find synchronously and ignores a late read; document switch also fences old reads',async()=>{
 const pending:{resolve:(response:Response)=>void;signal:AbortSignal|null|undefined}[]=[];setup((_path,init)=>new Promise(resolve=>pending.push({resolve,signal:init?.signal})));const {rerender}=render(<PdfPageReader {...props}/>);await ready();fireEvent.click(screen.getByText('查找 PDF 提取文字'));fireEvent.click(screen.getByText('关闭文内查找'));expect(pending[0].signal?.aborted).toBe(true);
 await act(async()=>pending[0].resolve(json(detail())));expect(screen.queryByLabelText('文内查找词')).toBeNull();fireEvent.click(screen.getByText('查找 PDF 提取文字'));rerender(<PdfPageReader {...props} documentId={other}/>);await ready();expect(pending[1].signal?.aborted).toBe(true);await act(async()=>pending[1].resolve(json({...detail(),storeScope:'wrong'})));expect(screen.queryByText(/提取文字来源或完整性无法核实/)).toBeNull();expect(screen.queryByLabelText('文内查找词')).toBeNull();
});
it('blocks the parent for generic 409 and hides find while retaining the annotation component',async()=>{
 setup(async()=>json({error:{code:'CONFLICT'}},409));const {container}=render(<PdfPageReader {...props}/>);await ready();const annotations=container.querySelector('.pdf-annotations');await waitFor(()=>expect((screen.getByText('新增当前页批注') as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByText('新增当前页批注'));fireEvent.change(screen.getByLabelText('批注内容'),{target:{value:'retain this unsaved draft'}});fireEvent.click(screen.getByText('查找 PDF 提取文字'));await screen.findByText(/提取文字来源或完整性无法核实/);expect(screen.queryByLabelText('文内查找词')).toBeNull();expect(screen.queryByRole('img')).toBeNull();expect(container.querySelector('.pdf-annotations')).toBe(annotations);expect((screen.getByLabelText('批注内容') as HTMLTextAreaElement).value).toBe('retain this unsaved draft');expect((screen.getByText('保存批注') as HTMLButtonElement).disabled).toBe(true);
});
it('clears pending find on page change without blocking the new page for a late authority error',async()=>{
 let resolve!:(response:Response)=>void;let signal:AbortSignal|null|undefined;setup((_path,init)=>new Promise(done=>{resolve=done;signal=init?.signal;}));render(<PdfPageReader {...props}/>);await ready();fireEvent.click(screen.getByText('查找 PDF 提取文字'));fireEvent.click(screen.getByText('PDF 下一页'));expect(signal?.aborted).toBe(true);await ready();await act(async()=>resolve(json({},403)));expect(screen.getByText('第 2 / 3 页 · 缩放 100%')).toBeTruthy();expect(screen.queryByText(/提取文字来源或完整性无法核实/)).toBeNull();expect(screen.getByText('查找 PDF 提取文字')).toBeTruthy();
});
it('keeps pending find alive if parent close is cancelled, but aborts on successful unmount',async()=>{
 const pending:{resolve:(response:Response)=>void;signal:AbortSignal|null|undefined}[]=[];setup((_path,init)=>new Promise(resolve=>pending.push({resolve,signal:init?.signal})));let allow=false;
 function Host(){const [open,setOpen]=useState(true);return open?<PdfPageReader {...props} onClose={()=>{if(allow)setOpen(false);}}/>:<p>返回列表</p>;}
 render(<Host/>);await ready();fireEvent.click(screen.getByText('查找 PDF 提取文字'));fireEvent.click(screen.getByText('关闭 PDF 阅读器'));expect(pending[0].signal?.aborted).toBe(false);await act(async()=>pending[0].resolve(json(detail())));await screen.findByLabelText('文内查找词');
 fireEvent.click(screen.getByText('关闭文内查找'));fireEvent.click(screen.getByText('查找 PDF 提取文字'));allow=true;fireEvent.click(screen.getByText('关闭 PDF 阅读器'));await screen.findByText('返回列表');expect(pending[1].signal?.aborted).toBe(true);await act(async()=>pending[1].resolve(json(detail())));await waitFor(()=>expect(screen.queryByLabelText('文内查找词')).toBeNull());
});
