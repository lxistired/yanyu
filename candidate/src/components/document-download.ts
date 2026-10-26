/** Integrity checks for an explicit local original download. No filesystem-save claim. */
export const DOCUMENT_DOWNLOAD_LIMIT = 8 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
export type DownloadBinding = Readonly<{id:string;format:'txt'|'md'|'pdf';bytes:number;sha256:string;scope:string}>;
export class DocumentDownloadError extends Error {
 constructor(message='原件下载无法核验，请刷新文档列表后重试') {super(message);this.name='DocumentDownloadError';}
}
export function bindDocumentDownload(value:unknown, scope:unknown):DownloadBinding {
 const item=value as Partial<DownloadBinding>|null;
 if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.id!=='string'||!uuid.test(item.id)||
   !['txt','md','pdf'].includes(item.format as string)||!Number.isSafeInteger(item.bytes)||
   (item.bytes??0)<1||(item.bytes??0)>DOCUMENT_DOWNLOAD_LIMIT||typeof item.sha256!=='string'||!sha.test(item.sha256)||
   typeof scope!=='string'||!uuid.test(scope))throw new DocumentDownloadError('文档身份或原件摘要无效，请刷新文档列表后重试');
 return Object.freeze({id:item.id,format:item.format!,bytes:item.bytes!,sha256:item.sha256,scope});
}
function cancel(body:ReadableStream<Uint8Array>|null) {try {void body?.cancel().catch(()=>undefined);} catch {/* already locked */}}
/** Requires all three bindings: original list metadata, server headers, and actual response bytes. */
export async function verifyDocumentDownload(response:Response,binding:DownloadBinding,signal?:AbortSignal,isCurrent:()=>boolean=()=>true):Promise<Blob> {
 const current=()=>{if(signal?.aborted||!isCurrent())throw new DocumentDownloadError('下载已取消，未请求保存文件');};
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 const abort=()=>{try {void reader?.cancel().catch(()=>undefined);} catch {/* no pending reader */}};
 try {
  current();binding=bindDocumentDownload(binding,binding.scope);
  if(response.status!==200||response.redirected)throw new DocumentDownloadError('原件下载未获得有效响应，请刷新核对后重试');
  if(response.headers.get('Content-Type')?.trim().toLowerCase()!=='application/octet-stream'||
    !/^[1-9][0-9]*$/.test(response.headers.get('Content-Length')??'')||
    Number(response.headers.get('Content-Length'))!==binding.bytes||
    response.headers.get('X-Document-Sha256')!==binding.sha256||
    response.headers.get('X-Document-Store-Id')!==binding.scope||
    ![null,'identity'].includes(response.headers.get('Content-Encoding')))throw new DocumentDownloadError('原件响应与所选文档不一致，请刷新核对后重试');
  if(!response.body)throw new DocumentDownloadError();
  reader=response.body.getReader();signal?.addEventListener('abort',abort,{once:true});current();
  const bytes=new Uint8Array(binding.bytes);let size=0;
  while(true){
   const part=await reader.read();current();if(part.done)break;
   if(!(ArrayBuffer.isView(part.value)&&Object.prototype.toString.call(part.value)==='[object Uint8Array]')||size+part.value.byteLength>binding.bytes)throw new DocumentDownloadError('原件字节数不一致，已停止下载');
   bytes.set(part.value,size);size+=part.value.byteLength;
  }
  if(size!==binding.bytes)throw new DocumentDownloadError('原件字节数不一致，已停止下载');
  current();const digest=await crypto.subtle.digest('SHA-256',bytes.buffer);current();
  const actual=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
  if(actual!==binding.sha256)throw new DocumentDownloadError('原件摘要不一致，已停止下载');
  return new Blob([bytes.buffer],{type:'application/octet-stream'});
 } catch(error) {
  if(reader)abort();else cancel(response.body);
  throw error instanceof DocumentDownloadError?error:new DocumentDownloadError();
 } finally {signal?.removeEventListener('abort',abort);try{reader?.releaseLock();}catch{/* cancellation may have released it */}}
}
