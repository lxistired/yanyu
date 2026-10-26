import {savedDocumentPreview, validateResearchQuery} from './local-research-search';
import {validPdfStoreScope} from './pdf-store-scope';

export type PdfFindSelection = Readonly<{storeScope:string; documentId:string; sha256:string; pages:number}>;
type Request = {signal:AbortSignal; current:()=>boolean};
export class PdfTextSourceError extends Error {
 constructor(){super('提取文字来源或完整性无法核实，已停止查找。请保留批注草稿，关闭后从最新文档列表重新打开。');}
}
const maxTextBytes=1024*1024;
const encoder=new TextEncoder();
const cancel=(response:Response)=>{try{void response.body?.cancel().catch(()=>{});}catch{}};

/** Requires the parent's already verified AND decoded current page image. This
 * binds extracted text to that PDF identity; it does not rehash original bytes. */
export async function readPdfFindText(selection:PdfFindSelection,request:Request,isSourceCurrent:()=>boolean,transport:typeof fetch=fetch):Promise<string> {
 const current=()=>{if(!request.current()||!isSourceCurrent())throw Error('文字查找请求已失效');};
 current();
 if(!validPdfStoreScope(selection.storeScope)||selection.storeScope.length!==36||!validPdfStoreScope(selection.documentId)||selection.documentId.length!==36||typeof selection.sha256!=='string'||!/^[a-f0-9]{64}(?![\s\S])/.test(selection.sha256)||!Number.isInteger(selection.pages)||selection.pages<1||selection.pages>40)throw new PdfTextSourceError();
 const response=await transport(`/api/documents/${selection.documentId}`,{method:'GET',headers:{'X-Citation-Store-Id':selection.storeScope},signal:request.signal,credentials:'same-origin',cache:'no-store',redirect:'error'});
 try{current();}catch(error){cancel(response);throw error;}
 if([401,403,404,409,410].includes(response.status)){cancel(response);throw new PdfTextSourceError();}
 if(!response.ok){cancel(response);throw Error(`提取文字暂不可用 (${response.status})，请重试`);}
 if(response.redirected||response.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json'){cancel(response);throw new PdfTextSourceError();}
 let data:unknown;
 try{data=await response.json();}catch{current();throw new PdfTextSourceError();}
 current();
 let text:string,textSha256:string;
 try{
  const preview=savedDocumentPreview(data,selection.storeScope,selection.documentId);
  if(!preview.pdfOpen||preview.pdfOpen.sha256!==selection.sha256||preview.pdfOpen.pages!==selection.pages)throw new PdfTextSourceError();
  text=preview.text;textSha256=(data as {document:{textSha256:string}}).document.textSha256;
 }catch{throw new PdfTextSourceError();}
 current();
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text))),value=>value.toString(16).padStart(2,'0')).join('');
 current();if(digest!==textSha256)throw new PdfTextSourceError();
 return text;
}

/** Case-sensitive, non-overlapping literal matches; never construct a RegExp
 * from user input. The existing 1 MiB text ceiling bounds offsets to 4 MiB. */
export function literalPdfMatches(text:string,query:string):Uint32Array {
 if(text.length>maxTextBytes||encoder.encode(text).length>maxTextBytes)throw Error('提取文字超过 1 MiB 上限');
 validateResearchQuery(query,'documents');
 if(!query)return new Uint32Array(0);
 const offsets=new Uint32Array(text.length);let count=0,from=0;
 while(from<=text.length-query.length){const found=text.indexOf(query,from);if(found<0)break;offsets[count++]=found;from=found+query.length;}
 return offsets.slice(0,count);
}
export function nextPdfMatch(index:number,count:number,direction:1|-1):number {
 if(!Number.isSafeInteger(count)||count<1)return -1;
 if(!Number.isInteger(index)||index<0||index>=count)return direction===1?0:count-1;
 return (index+direction+count)%count;
}
export type PdfFindPart={text:string; match:boolean; current:boolean};
/** Only a small context window enters the DOM, even for a million matches. */
export function pdfFindContext(text:string,query:string,matches:Uint32Array,index:number):PdfFindPart[] {
 if(!query||index<0||index>=matches.length)return [];
 const offset=matches[index];let start=Math.max(0,offset-160),end=Math.min(text.length,offset+query.length+160),first=index;
 while(first>0&&matches[first-1]>=start)--first;
 if(start>0&&/[\uDC00-\uDFFF]/.test(text[start]))--start;
 if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))++end;
 const parts:PdfFindPart[]=[];let cursor=start;
 if(start)parts.push({text:'…',match:false,current:false});
 for(let i=first;i<matches.length&&matches[i]+query.length<=end;i++){
  const position=matches[i];
  if(position>cursor)parts.push({text:text.slice(cursor,position),match:false,current:false});
  parts.push({text:text.slice(position,position+query.length),match:true,current:i===index});cursor=position+query.length;
 }
 if(cursor<end)parts.push({text:text.slice(cursor,end),match:false,current:false});
 if(end<text.length)parts.push({text:'…',match:false,current:false});
 return parts;
}
