import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {LocalResearchSearch} from '../candidate/src/components/LocalResearchSearch';
import {LocalRecentMaterials} from '../candidate/src/components/LocalRecentMaterials';
import {documentPage,documentPreview} from '../candidate/src/components/local-research-search';
import {pdfOpenSelection,pdfOpenSelectionFromDocument,samePdfOpenSelection,PDF_OPEN_UNAVAILABLE_REASON} from '../candidate/src/components/pdf-open-selection';
const scope='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const row={id,name:'Synthetic PDF',format:'pdf',createdAt:'2026-10-22T00:00:00Z',trashedAt:null,stale:false,sha256:'a'.repeat(64),pages:2,revision:0,workspaceId:null,folderId:null};
const listing=(document:unknown=row,storeScope=scope)=>({storeScope,total:1,offset:0,limit:10,documents:[document]});
const response=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'X-Transcription-Store-Id':scope}});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('freezes an exact revision-zero pin and accepts explicit nullable and valid association IDs',()=>{
 const pin=pdfOpenSelectionFromDocument(row,scope)!;expect(pin).toEqual({storeScope:scope,documentId:id,format:'pdf',sha256:row.sha256,pages:2,revision:0,workspaceId:null,folderId:null});expect(Object.isFrozen(pin)).toBe(true);expect(pdfOpenSelection(pin)).toEqual(pin);expect(samePdfOpenSelection(pin,{...pin,revision:1})).toBe(false);
 expect(pdfOpenSelectionFromDocument({...row,folderId:id},scope)?.folderId).toBe(id);
 expect(pdfOpenSelectionFromDocument({...row,workspaceId:'legacy.workspace:1',folderId:id},scope)?.workspaceId).toBe('legacy.workspace:1');
 expect(pdfOpenSelection({...pin,extra:true})).toBeNull();
});
it('rejects missing, malformed, stale and non-PDF metadata without invented defaults',()=>{
 for(const key of ['sha256','pages','revision','workspaceId','folderId','stale']){const missing:Record<string,unknown>={...row};delete missing[key];expect(pdfOpenSelectionFromDocument(missing,scope)).toBeNull();}
 for(const patch of [{id:id+'\n'},{sha256:row.sha256+'\n'},{pages:0},{pages:41},{pages:1.5},{revision:-1},{revision:0.5},{revision:Number.MAX_SAFE_INTEGER+1},{workspaceId:'bad\n'},{folderId:id+'\n'},{stale:true},{trashedAt:'now'},{format:'txt'}])expect(pdfOpenSelectionFromDocument({...row,...patch},scope)).toBeNull();
 expect(pdfOpenSelectionFromDocument(row,scope+'\n')).toBeNull();
});
it('optional failure retains minimal PDF list and legacy exact text preview',()=>{
 const minimal={id,name:'Legacy',format:'pdf',createdAt:'today',trashedAt:null};const page=documentPage(listing(minimal),scope,0);expect(page.items[0].pdfOpen).toBeNull();expect(page.items[0].name).toBe('Legacy');expect(documentPreview({storeScope:scope,document:minimal,text:'legacy text'},scope,id).text).toBe('legacy text');
});
function fixture(document:unknown=row,override?:(url:URL)=>Response|undefined) {
 const fetcher=vi.fn((input:string)=>{const u=new URL(input,'http://localhost');const custom=override?.(u);if(custom)return Promise.resolve(custom);if(u.pathname==='/api/documents/choices')return Promise.resolve(response({uploadScope:scope}));if(u.pathname==='/api/documents')return Promise.resolve(response(listing(document)));if(u.pathname===`/api/documents/${id}`)return Promise.resolve(response({storeScope:scope,document,text:'synthetic extracted text'}));if(u.pathname==='/api/local-asr/identity')return Promise.resolve(response({transcriptionStoreId:scope}));if(u.pathname==='/api/local-asr/jobs')return Promise.resolve(response({total:0,offset:0,limit:10,hasMore:false,jobs:[]}));throw Error('Unexpected synthetic request');});vi.stubGlobal('fetch',fetcher);return fetcher;
}
// Capture the actual rendered callback to test stale callback invocation, not only detached DOM events.
function handler(button:HTMLElement):()=>void {const key=Object.keys(button).find(k=>k.startsWith('__reactProps$'))!;return (button as unknown as Record<string,{onClick:()=>void}>)[key].onClick;}
for(const kind of ['search','recent'] as const){
 it(`${kind}: only explicit PDF click forwards immutable current-list pin; preview does not open PDF`,async()=>{
  const requests=fixture(),open=vi.fn();render(kind==='search'?<LocalResearchSearch onOpenPdf={open}/>:<LocalRecentMaterials onOpenPdf={open}/>);
  const button=await screen.findByRole('button',{name:'打开 PDF：Synthetic PDF'});expect(open).not.toHaveBeenCalled();fireEvent.mouseOver(button);expect(open).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:kind==='search'?'Synthetic PDF':'查看提取文字：Synthetic PDF'}));await screen.findByText('synthetic extracted text');expect(open).not.toHaveBeenCalled();const count=requests.mock.calls.length;fireEvent.click(button);expect(open).toHaveBeenCalledExactlyOnceWith(pdfOpenSelectionFromDocument(row,scope),{documentStoreId:scope,offset:0,...(kind==='search'?{query:''}:{})});expect(Object.isFrozen(open.mock.calls[0][0])).toBe(true);expect(requests.mock.calls.length).toBe(count);
 });
 it(`${kind}: missing optional metadata disables PDF only and preserves text`,async()=>{
  fixture({...row,stale:undefined});const open=vi.fn();render(kind==='search'?<LocalResearchSearch onOpenPdf={open}/>:<LocalRecentMaterials onOpenPdf={open}/>);const button=await screen.findByRole('button',{name:'打开 PDF：Synthetic PDF'});expect((button as HTMLButtonElement).disabled).toBe(true);expect(screen.getByText(PDF_OPEN_UNAVAILABLE_REASON)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:kind==='search'?'Synthetic PDF':'查看提取文字：Synthetic PDF'}));await screen.findByText('synthetic extracted text');expect(open).not.toHaveBeenCalled();
 });
 it(`${kind}: withdrawn callbacks cannot open after reload or unmount`,async()=>{
  fixture();const open=vi.fn();const view=render(kind==='search'?<LocalResearchSearch onOpenPdf={open}/>:<LocalRecentMaterials onOpenPdf={open}/>);const old=handler(await screen.findByRole('button',{name:'打开 PDF：Synthetic PDF'}));act(()=>{fireEvent.click(screen.getByText('重新载入文档来源'));old();});expect(open).not.toHaveBeenCalled();const current=handler(await screen.findByRole('button',{name:'打开 PDF：Synthetic PDF'}));act(()=>old());expect(open).not.toHaveBeenCalled();view.unmount();act(()=>current());expect(open).not.toHaveBeenCalled();
 });
}
it('search invalidates captured callbacks synchronously on submit and tab departure',async()=>{
 fixture();const open=vi.fn();render(<LocalResearchSearch onOpenPdf={open}/>);let old=handler(await screen.findByRole('button',{name:'打开 PDF：Synthetic PDF'}));act(()=>{fireEvent.click(screen.getByText('搜索文档'));old();});expect(open).not.toHaveBeenCalled();old=handler(await screen.findByRole('button',{name:'打开 PDF：Synthetic PDF'}));act(()=>{fireEvent.click(screen.getByRole('button',{name:'转写',exact:true}));old();});expect(open).not.toHaveBeenCalled();
});

for(const kind of ['search','recent'] as const){
 it(`${kind}: old page handler is rejected synchronously during pagination and after accepted next page`,async()=>{
  fixture(row,u=>u.pathname==='/api/documents'?response({storeScope:scope,total:11,offset:Number(u.searchParams.get('offset')),limit:10,documents:Number(u.searchParams.get('offset'))===0?Array.from({length:10},(_,i)=>({...row,id:`aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12,'0')}`,name:`Page PDF ${i}`})):[{...row,name:'Next PDF'}]}):undefined);
  const open=vi.fn();render(kind==='search'?<LocalResearchSearch onOpenPdf={open}/>:<LocalRecentMaterials onOpenPdf={open}/>);const old=handler(await screen.findByRole('button',{name:'打开 PDF：Page PDF 0'}));
  act(()=>{fireEvent.click(screen.getAllByRole('button',{name:'下一页'})[0]);old();});expect(open).not.toHaveBeenCalled();const fresh=await screen.findByRole('button',{name:'打开 PDF：Next PDF'});act(()=>old());expect(open).not.toHaveBeenCalled();fireEvent.click(fresh);expect(open).toHaveBeenCalledExactlyOnceWith(pdfOpenSelectionFromDocument(row,scope),{documentStoreId:scope,offset:10,...(kind==='search'?{query:''}:{})});
 });
 it(`${kind}: source mismatch withdraws old handler; explicit reload establishes a new actionable scope`,async()=>{
  const other='33333333-3333-4333-8333-333333333333';let changed=false;
  fixture(row,u=>u.pathname==='/api/documents'?response(listing(row,changed?other:scope)):u.pathname==='/api/documents/choices'?response({uploadScope:changed?other:scope}):undefined);
  const open=vi.fn();render(kind==='search'?<LocalResearchSearch onOpenPdf={open}/>:<LocalRecentMaterials onOpenPdf={open}/>);const old=handler(await screen.findByRole('button',{name:'打开 PDF：Synthetic PDF'}));changed=true;fireEvent.click(screen.getByText(kind==='search'?'搜索文档':'刷新文档记录'));await screen.findByText(/文档来源已变化/);act(()=>old());expect(open).not.toHaveBeenCalled();fireEvent.click(screen.getByText('重新载入文档来源'));const fresh=await screen.findByRole('button',{name:'打开 PDF：Synthetic PDF'});act(()=>old());expect(open).not.toHaveBeenCalled();fireEvent.click(fresh);expect(open).toHaveBeenCalledExactlyOnceWith(pdfOpenSelectionFromDocument(row,other),{documentStoreId:other,offset:0,...(kind==='search'?{query:''}:{})});
 });
}
it('return to document tab requires fresh result while the previous handler remains revoked',async()=>{
 fixture();const open=vi.fn();render(<LocalResearchSearch onOpenPdf={open}/>);const old=handler(await screen.findByRole('button',{name:'打开 PDF：Synthetic PDF'}));fireEvent.click(screen.getByRole('button',{name:'转写',exact:true}));fireEvent.click(screen.getByRole('button',{name:'文档',exact:true}));const fresh=await screen.findByRole('button',{name:'打开 PDF：Synthetic PDF'});act(()=>old());expect(open).not.toHaveBeenCalled();fireEvent.click(fresh);expect(open).toHaveBeenCalledExactlyOnceWith(pdfOpenSelectionFromDocument(row,scope),{documentStoreId:scope,offset:0,query:''});
});
