import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {fetchPdfPageImage,PdfImageAuthorityError,PDF_IMAGE_MAX_BYTES} from '../candidate/src/components/pdf-page-image';
import {imageResponse,installPdfCrypto,png,pngSha} from './pdf-image-fixture';
const selection={storeScope:'44444444-4444-4444-8444-444444444444',documentId:'11111111-1111-4111-8111-111111111111',sha256:'a'.repeat(64),pages:3,page:1,scale:100 as const};
const path=`/api/documents/${selection.documentId}/page?page=1&scale=100&storeScope=${selection.storeScope}`;
const response=()=>imageResponse(path,selection.sha256,3);
function run(value:Response,assert=()=>{},signal=new AbortController().signal){return fetchPdfPageImage(selection,signal,assert,vi.fn().mockResolvedValue(value));}
beforeEach(installPdfCrypto);
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('binds exact local route, request policy, bytes and digest without claiming decoding',async()=>{
 const transport=vi.fn().mockResolvedValue(response());const current=vi.fn();
 const receipt=await fetchPdfPageImage(selection,new AbortController().signal,current,transport);
 expect(transport).toHaveBeenCalledWith(path,expect.objectContaining({method:'GET',headers:{'X-Document-Store-Id':selection.storeScope},cache:'no-store',redirect:'error',credentials:'same-origin'}));
 expect(receipt).toEqual({dataUrl:`data:image/png;base64,${Buffer.from(png).toString('base64')}`,imageSha256:pngSha,sourceUrl:path});expect(current).toHaveBeenCalled();
});
it.each(['X-Document-Store-Id','X-Document-Id','X-Document-Sha256','X-Document-Pages','X-Document-Page','X-Document-Scale','X-Image-Sha256','Content-Type','Content-Length','Cache-Control','X-Content-Type-Options'])('rejects missing or duplicated %s before reading bytes',async name=>{
 for(const mode of ['missing','duplicate']){const value=response();const cancel=vi.spyOn(value.body!,'cancel');if(mode==='missing')value.headers.delete(name);else value.headers.append(name,value.headers.get(name)!);await expect(run(value)).rejects.toBeInstanceOf(PdfImageAuthorityError);expect(cancel).toHaveBeenCalled();}
});
it.each([401,403,404,409,410,503])('treats %s as terminal without reading error content',async status=>{const value=new Response('not read',{status});const cancel=vi.spyOn(value.body!,'cancel');await expect(run(value)).rejects.toBeInstanceOf(PdfImageAuthorityError);expect(cancel).toHaveBeenCalled();});
it.each([201,206,422,500])('rejects non-exact success/status %s without accepting bytes',async status=>{await expect(run(new Response(png.slice(),{status}))).rejects.toThrow();});
it.each(['0','01','1.5','-1',String(PDF_IMAGE_MAX_BYTES+1)])('rejects noncanonical or oversized length %s',async length=>{const value=response();value.headers.set('Content-Length',length);await expect(run(value)).rejects.toBeInstanceOf(PdfImageAuthorityError);});
it('rejects wrong source, digest and redirected responses',async()=>{
 for(const name of ['X-Document-Store-Id','X-Document-Id','X-Document-Sha256','X-Document-Pages','X-Document-Page','X-Document-Scale','X-Image-Sha256']){const value=response();value.headers.set(name,name.includes('Sha256')?'b'.repeat(64):'2');await expect(run(value)).rejects.toBeInstanceOf(PdfImageAuthorityError);}
 const value=response();Object.defineProperty(value,'redirected',{value:true});await expect(run(value)).rejects.toBeInstanceOf(PdfImageAuthorityError);
});
it('rejects truncated and excess streams and cancels on overflow',async()=>{
 for(const length of [png.length-1,png.length+1]){const value=response();value.headers.set('Content-Length',String(length));await expect(run(value)).rejects.toBeInstanceOf(PdfImageAuthorityError);}
 const cancel=vi.fn();const headers=response().headers;const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(png.length+1));},cancel});await expect(run(new Response(stream,{headers}))).rejects.toBeInstanceOf(PdfImageAuthorityError);expect(cancel).toHaveBeenCalled();
});
it.each([0,12,16,20,-1])('rejects PNG signature/IHDR/dimension/IEND mutation at %s even with matching digest',async at=>{
 const bytes=png.slice();if(at===16||at===20){new DataView(bytes.buffer).setUint32(at,1201);}else bytes[at<0?bytes.length-1:at]^=1;
 const headers=response().headers;headers.set('X-Image-Sha256',createHash('sha256').update(bytes).digest('hex'));await expect(run(new Response(bytes,{headers}))).rejects.toBeInstanceOf(PdfImageAuthorityError);
});
it('rejects stale capture before transport and after digest',async()=>{
 const transport=vi.fn();await expect(fetchPdfPageImage(selection,new AbortController().signal,()=>{throw Error('stale');},transport)).rejects.toThrow('stale');expect(transport).not.toHaveBeenCalled();
 let stale=false;const digest=crypto.subtle.digest.bind(crypto.subtle);vi.spyOn(crypto.subtle,'digest').mockImplementation(async(...args)=>{const value=await digest(...args);stale=true;return value;});await expect(run(response(),()=>{if(stale)throw Error('stale');})).rejects.toThrow('stale');
});
it('bounds a transport ignoring abort and cancels its late response',async()=>{
 vi.useFakeTimers();let resolve!:(r:Response)=>void;const transport=vi.fn(()=>new Promise<Response>(r=>resolve=r));const pending=fetchPdfPageImage(selection,new AbortController().signal,()=>{},transport);const rejected=expect(pending).rejects.toThrow('超时');await vi.advanceTimersByTimeAsync(30_000);await rejected;const late=response();const cancel=vi.spyOn(late.body!,'cancel');resolve(late);await Promise.resolve();expect(cancel).toHaveBeenCalled();
});
it('cancels a stalled stream on external abort',async()=>{
 const cancel=vi.fn();const value=new Response(new ReadableStream({cancel}),{headers:response().headers});const controller=new AbortController();const pending=run(value,()=>{},controller.signal);const rejected=expect(pending).rejects.toThrow('取消');await Promise.resolve();await Promise.resolve();controller.abort();await rejected;expect(cancel).toHaveBeenCalled();
});
it('rejects external URL-like identity before requesting anything',async()=>{const transport=vi.fn();await expect(fetchPdfPageImage({...selection,documentId:'https://example.invalid/x'},new AbortController().signal,()=>{},transport)).rejects.toBeInstanceOf(PdfImageAuthorityError);expect(transport).not.toHaveBeenCalled();});

it('accepts genuine cross-realm Uint8Array stream chunks without weakening byte validation',async()=>{const foreign=runInNewContext('Uint8Array.from(bytes)',{bytes:Array.from(png)});expect(foreign instanceof Uint8Array).toBe(false);const value=new Response(new ReadableStream({start(c){c.enqueue(foreign);c.close();}}),{headers:response().headers});expect((await run(value)).imageSha256).toBe(pngSha);});
it.each(['Uint8ClampedArray','Int8Array','Uint16Array','DataView','array','spoof'])('rejects %s stream chunks including forged string tags',async kind=>{const chunk=runInNewContext(kind==='spoof'?"({byteLength:68,[Symbol.toStringTag]:'Uint8Array'})":kind==='array'?"Array(68).fill(0)":kind==='DataView'?"new DataView(new ArrayBuffer(68))":`new ${kind}(68)`);if(kind!=='spoof')Object.defineProperty(chunk,Symbol.toStringTag,{value:'Uint8Array'});const cancel=vi.fn();const value=new Response(new ReadableStream({start(c){c.enqueue(chunk);},cancel}),{headers:response().headers});await expect(run(value)).rejects.toBeInstanceOf(PdfImageAuthorityError);expect(cancel).toHaveBeenCalled();});
