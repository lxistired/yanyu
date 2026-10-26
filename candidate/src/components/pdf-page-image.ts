/** A bounded, identity-bound raster response. Decoding is still a separate browser event. */
export type PdfImageSelection={storeScope:string;documentId:string;sha256:string;pages:number;page:number;scale:75|100|150};
export type PdfImageReceipt={dataUrl:string;imageSha256:string;sourceUrl:string};
export const PDF_IMAGE_MAX_BYTES=16*1024*1024;
export class PdfImageAuthorityError extends Error {
 constructor(){super('PDF 图片来源或当前访问权限无法核实，已停止显示和保存。批注草稿仍保留，请复制后从最新文档列表重新打开。');}
}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash=/^[a-f0-9]{64}$/;
const positive=/^[1-9][0-9]*$/;
const pngSignature=[137,80,78,71,13,10,26,10];
const pngEnd=[0,0,0,0,73,69,78,68,174,66,96,130];
const bytesEqual=(bytes:Uint8Array,offset:number,expected:number[])=>expected.every((value,index)=>bytes[offset+index]===value);
const typedArrayTag=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),Symbol.toStringTag)!.get!;
const isByteChunk=(value:unknown):value is Uint8Array=>ArrayBuffer.isView(value)&&typedArrayTag.call(value)==='Uint8Array';
const cancel=(response:Response)=>{try{void response.body?.cancel().catch(()=>{});}catch{}};
export async function fetchPdfPageImage(selection:PdfImageSelection,signal:AbortSignal,assertCurrent:()=>void,transport:typeof fetch=fetch):Promise<PdfImageReceipt>{
 if(typeof selection.storeScope!=='string'||typeof selection.documentId!=='string'||typeof selection.sha256!=='string'||!uuid.test(selection.storeScope)||!uuid.test(selection.documentId)||!hash.test(selection.sha256)||!Number.isInteger(selection.pages)||selection.pages<1||selection.pages>40||!Number.isInteger(selection.page)||selection.page<1||selection.page>selection.pages||![75,100,150].includes(selection.scale))throw new PdfImageAuthorityError();
 const sourceUrl=`/api/documents/${selection.documentId}/page?page=${selection.page}&scale=${selection.scale}&storeScope=${selection.storeScope}`;
 const own=new AbortController();let timedOut=false;let stream:ReadableStreamDefaultReader<Uint8Array>|null=null;let finished=false;
 const abort=()=>{own.abort();try{void stream?.cancel().catch(()=>{});}catch{}};
 const timer=setTimeout(()=>{timedOut=true;abort();},30_000);
 signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 const current=()=>{if(signal.aborted||own.signal.aborted)throw Error(timedOut?'PDF 图片请求超时，请重试':'PDF 图片请求已取消');assertCurrent();};
 const wait=<T,>(promise:Promise<T>):Promise<T>=>new Promise((resolve,reject)=>{const stopped=()=>{own.signal.removeEventListener('abort',stopped);reject(Error(timedOut?'PDF 图片请求超时，请重试':'PDF 图片请求已取消'));};own.signal.addEventListener('abort',stopped,{once:true});if(own.signal.aborted)stopped();promise.then(resolve,reject).finally(()=>own.signal.removeEventListener('abort',stopped));});
 try{
  current();const response=await wait(transport(sourceUrl,{method:'GET',headers:{'X-Document-Store-Id':selection.storeScope},cache:'no-store',redirect:'error',credentials:'same-origin',signal:own.signal}).then(response=>{if(own.signal.aborted){cancel(response);throw Error('PDF 图片请求已取消');}return response;}));
  try{current();}catch(error){cancel(response);throw error;}
  if(response.status!==200){cancel(response);if([401,403,404,409,410,503].includes(response.status))throw new PdfImageAuthorityError();throw Error(`PDF 图片请求失败 (${response.status})`);}
  const headers=response.headers;
  const expected:Record<string,string>={'X-Document-Store-Id':selection.storeScope,'X-Document-Id':selection.documentId,'X-Document-Sha256':selection.sha256,'X-Document-Pages':String(selection.pages),'X-Document-Page':String(selection.page),'X-Document-Scale':String(selection.scale)};
  const rawLength=headers.get('Content-Length')??'';const length=Number(rawLength);const imageSha256=headers.get('X-Image-Sha256')??'';
  if(response.redirected||headers.get('Content-Type')!=='image/png'||headers.get('X-Content-Type-Options')!=='nosniff'||headers.get('Cache-Control')!=='no-store'||!positive.test(rawLength)||!Number.isSafeInteger(length)||length<45||length>PDF_IMAGE_MAX_BYTES||!hash.test(imageSha256)||Object.entries(expected).some(([key,value])=>headers.get(key)!==value)||!response.body){cancel(response);throw new PdfImageAuthorityError();}
  stream=response.body.getReader();const bytes=new Uint8Array(length);let size=0;let chunks=0;
  while(true){current();const next=await wait(stream.read());current();if(next.done)break;if(++chunks>65_536||!isByteChunk(next.value)||size+next.value.byteLength>length||size+next.value.byteLength>PDF_IMAGE_MAX_BYTES)throw new PdfImageAuthorityError();bytes.set(next.value,size);size+=next.value.byteLength;}
  if(size!==length)throw new PdfImageAuthorityError();
  const view=new DataView(bytes.buffer);const width=view.getUint32(16),height=view.getUint32(20),side=selection.scale*12;
  if(!bytesEqual(bytes,0,pngSignature)||!bytesEqual(bytes,12,[73,72,68,82])||!bytesEqual(bytes,size-12,pngEnd)||!width||!height||width>side||height>side)throw new PdfImageAuthorityError();
  current();const digest=Array.from(new Uint8Array(await wait(crypto.subtle.digest('SHA-256',bytes.buffer))),value=>value.toString(16).padStart(2,'0')).join('');current();if(digest!==imageSha256)throw new PdfImageAuthorityError();
  const parts:string[]=[];for(let start=0;start<bytes.length;start+=24_576){current();parts.push(btoa(String.fromCharCode(...bytes.subarray(start,start+24_576))));}
  const dataUrl='data:image/png;base64,'+parts.join('');current();finished=true;return {dataUrl,imageSha256,sourceUrl};
 }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);if(!finished){try{void stream?.cancel().catch(()=>{});}catch{}own.abort();}try{stream?.releaseLock();}catch{}}
}
