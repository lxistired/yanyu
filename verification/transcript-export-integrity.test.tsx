import {Blob as NodeBlob} from 'node:buffer';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {TranscriptEditor} from '../candidate/src/components/TranscriptEditor';
import {TranscriptionStoreBoundary,useTranscriptionStore} from '../candidate/src/components/TranscriptionStoreBoundary';
import {fixtureStoreHeaders,fixtureStoreUrl} from './transcription-store-fixture';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const saved={raw:'\ufeff原文 🌱\r\n\ud800',corrected:'保存校对 🌱',revision:2,updated:null};
let create:ReturnType<typeof vi.fn>,click:ReturnType<typeof vi.spyOn>;
beforeEach(()=>{history.replaceState(null,'',fixtureStoreUrl());create=vi.fn(()=> 'blob:verified');vi.stubGlobal('URL',class extends URL {static createObjectURL=create;static revokeObjectURL=vi.fn();});click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function response(variant:'raw'|'corrected'='raw',body=saved[variant]??''){
 const bytes=new TextEncoder().encode(body),headers=fixtureStoreHeaders();
 headers.set('X-Transcript-Revision','2');headers.set('Content-Type','text/plain; charset=utf-8');headers.set('Content-Disposition',`attachment; filename="transcript-${id}-${variant}-r2.txt"`);headers.set('Content-Length',String(bytes.length));
 return {ok:true,status:200,headers,blob:vi.fn(async()=>new NodeBlob([bytes]) as unknown as Blob),json:vi.fn(async()=>({}))};
}
async function setup(reply:ReturnType<typeof response>,snapshot={...saved}){
 const fetch=vi.fn(async(url:string)=>url.endsWith('/export')?reply:{ok:true,status:200,headers:fixtureStoreHeaders(),json:async()=>snapshot});vi.stubGlobal('fetch',fetch);
 const view=render(<TranscriptionStoreBoundary><TranscriptEditor id={id} raw="preview"/></TranscriptionStoreBoundary>);await screen.findByText(/已保存版本 2/);return {fetch,...view};
}
it.each(['raw','corrected'] as const)('checks exact saved %s UTF-8 including BOM/CRLF/Unicode, ignoring dirty draft',async variant=>{
 const reply=response(variant);const {fetch}=await setup(reply);fireEvent.change(screen.getByLabelText('校对文本'),{target:{value:'未保存草稿'}});fireEvent.click(screen.getByText(variant==='raw'?'导出原始 TXT':'导出已保存校对 TXT'));
 await screen.findByText(/已核验.*并发起 TXT 下载/);expect(create).toHaveBeenCalledOnce();expect(click).toHaveBeenCalledOnce();expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe(`transcript-${id}-${variant}-r2.txt`);expect((screen.getByLabelText('校对文本') as HTMLTextAreaElement).value).toBe('未保存草稿');expect(JSON.parse((fetch.mock.calls.at(-1) as unknown as [string,RequestInit])[1].body as string)).toEqual({expectedRevision:2,variant});
});
it('accepts empty saved correction',async()=>{const reply=response('corrected','');await setup(reply,{...saved,corrected:''});fireEvent.click(screen.getByText('导出已保存校对 TXT'));await screen.findByText(/已核验.*并发起 TXT 下载/);expect(create).toHaveBeenCalledOnce();});
it.each([
 ['revision missing','X-Transcript-Revision',null],['stale revision','X-Transcript-Revision','1'],['duplicate revision','X-Transcript-Revision','2, 2'],['noncanonical revision','X-Transcript-Revision','02'],
 ['MIME missing','Content-Type',null],['HTML','Content-Type','text/html'],['wrong charset','Content-Type','text/plain; charset=gbk'],
 ['filename missing','Content-Disposition',null],['wrong job','Content-Disposition','attachment; filename="transcript-other-raw-r2.txt"'],['wrong variant','Content-Disposition',`attachment; filename="transcript-${id}-corrected-r2.txt"`],['wrong filename revision','Content-Disposition',`attachment; filename="transcript-${id}-raw-r1.txt"`],
 ['length missing','Content-Length',null],['wrong length','Content-Length','1'],
])('rejects %s before consuming body without losing draft',async(_name,header,value)=>{
 const reply=response();if(value===null)reply.headers.delete(header!);else reply.headers.set(header!,value!);await setup(reply);fireEvent.change(screen.getByLabelText('校对文本'),{target:{value:'草稿'}});fireEvent.click(screen.getByText('导出原始 TXT'));await screen.findByRole('alert');expect(reply.blob).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();expect(click).not.toHaveBeenCalled();expect((screen.getByLabelText('校对文本') as HTMLTextAreaElement).value).toBe('草稿');
});
it.each([201,204,206])('rejects unexpected successful status %s',async status=>{const reply=response();reply.status=status;await setup(reply);fireEvent.click(screen.getByText('导出原始 TXT'));await screen.findByRole('alert');expect(reply.blob).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();});
it.each(['different same-length bytes','truncated bytes','appended bytes','malformed UTF-8'])('rejects %s',async mode=>{
 const reply=response();const bytes=new TextEncoder().encode(saved.raw);const wrong=mode==='truncated bytes'?bytes.slice(1):mode==='appended bytes'?new Uint8Array([...bytes,0]):bytes.slice();if(mode==='different same-length bytes')wrong[0]=0;if(mode==='malformed UTF-8')wrong[1]=255;
 reply.blob.mockResolvedValue(new NodeBlob([wrong]) as unknown as Blob);await setup(reply);fireEvent.click(screen.getByText('导出原始 TXT'));await screen.findByRole('alert');expect(create).not.toHaveBeenCalled();expect(click).not.toHaveBeenCalled();
});
it('clears prior success on a failed second export and permits a verified retry',async()=>{const reply=response();await setup(reply);fireEvent.click(screen.getByText('导出原始 TXT'));await screen.findByText(/已核验.*并发起 TXT 下载/);reply.headers.set('X-Transcript-Revision','1');fireEvent.click(screen.getByText('导出原始 TXT'));await screen.findByRole('alert');expect(screen.queryByText(/已核验.*并发起 TXT 下载/)).toBeNull();expect(create).toHaveBeenCalledTimes(1);reply.headers.set('X-Transcript-Revision','2');fireEvent.click(screen.getByText('导出原始 TXT'));await screen.findByText(/已核验.*并发起 TXT 下载/);expect(create).toHaveBeenCalledTimes(2);});
it('does not download after unmount during delayed byte verification',async()=>{
 const reply=response();let release!:(value:ArrayBuffer)=>void;const pending=new Promise<ArrayBuffer>(resolve=>release=resolve);const bytes=new TextEncoder().encode(saved.raw);reply.blob.mockResolvedValue({size:bytes.length,arrayBuffer:()=>pending} as Blob);const view=await setup(reply);fireEvent.click(screen.getByText('导出原始 TXT'));await waitFor(()=>expect(reply.blob).toHaveBeenCalledOnce());view.unmount();release(bytes.buffer);await pending;await Promise.resolve();expect(create).not.toHaveBeenCalled();expect(click).not.toHaveBeenCalled();
});
it('retains draft on an HTTP conflict and does not consume a blob',async()=>{const reply=response();reply.ok=false;reply.status=409;reply.json.mockResolvedValue({error:{message:'版本已变化'}});await setup(reply);fireEvent.change(screen.getByLabelText('校对文本'),{target:{value:'草稿'}});fireEvent.click(screen.getByText('导出原始 TXT'));await screen.findByText('版本已变化');expect(reply.blob).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();expect((screen.getByLabelText('校对文本') as HTMLTextAreaElement).value).toBe('草稿');});

it('disables corrected export when no saved correction exists',async()=>{await setup(response(),{...saved,corrected:null} as typeof saved);expect((screen.getByText('导出已保存校对 TXT') as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByText('导出已保存校对 TXT'));expect(create).not.toHaveBeenCalled();});
it('blocks export after source mismatch during delayed byte verification and preserves dirty draft',async()=>{
 const reply=response(),bytes=new TextEncoder().encode(saved.raw);let release!:(value:ArrayBuffer)=>void;const pending=new Promise<ArrayBuffer>(resolve=>release=resolve);reply.blob.mockResolvedValue({size:bytes.length,arrayBuffer:()=>pending} as Blob);
 const foreign=fixtureStoreHeaders();foreign.set('X-Transcription-Store-Id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/export')?reply:url.endsWith('/history')?{ok:true,headers:foreign,json:async()=>({})}:{ok:true,headers:fixtureStoreHeaders(),json:async()=>saved}));
 function Probe(){const store=useTranscriptionStore();return <button onClick={()=>void store.fetch(`/api/local-asr/jobs/${id}/history`).catch(()=>{})}>模拟其他请求来源变化</button>}
 render(<TranscriptionStoreBoundary><TranscriptEditor id={id} raw="preview"/><Probe/></TranscriptionStoreBoundary>);await screen.findByDisplayValue(saved.corrected);fireEvent.change(screen.getByLabelText('校对文本'),{target:{value:'保留草稿'}});fireEvent.click(screen.getByText('导出原始 TXT'));await waitFor(()=>expect(reply.blob).toHaveBeenCalledOnce());fireEvent.click(screen.getByText('模拟其他请求来源变化'));await screen.findByText(/转写来源无法核验或已变化/);release(bytes.buffer);await pending;await Promise.resolve();expect(create).not.toHaveBeenCalled();expect(click).not.toHaveBeenCalled();expect((screen.getByLabelText('校对文本') as HTMLTextAreaElement).value).toBe('保留草稿');
});
