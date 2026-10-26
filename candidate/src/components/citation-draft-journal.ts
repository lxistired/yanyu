// Session-only recovery metadata. The caller supplies its verified documents-store
// scope and sessionStorage; source text, quotes, names and labels never enter it.
export type CitationDraftSource = {
 id:string; revision:number; sha256:string; textSha256:string; format:'txt'|'md'|'pdf';
};
export type CitationDraftRecord = {
 version:1; scope:string; documentId:string; documentRevision:number;
 documentSha256:string; textSha256:string; start:number; end:number; quoteSha256:string; rangeSha256:string;
 note:string; operationId:string|null; requestSha256:string|null; createdAt:number; updatedAt:number;
};
export type CitationDraftPayload = {
 documentRevision:number; documentSha256:string; end:number; note:string;
 operationId:string; quote:string; quoteSha256:string; rangeUnit:'utf16-code-unit';
 start:number; textSha256:string;
};
export type CitationDraftCitation = {
 id:string; documentId:string; documentSha256:string; textSha256:string;
 start:number; end:number; quote:string; quoteSha256:string; note:string;
 labelAtCreation:string; createdAt:string; level:'document-text'; page:null;
 rangeUnit?:'utf16-code-unit'; rangeConvention?:'half-open';
};
export const PREFIX='yanyu:citation-draft:v1:';
export const MAX_RECORD_BYTES=8*1024;
export const MAX_RECORDS=20;
export const DRAFT_TTL_MS=7*24*60*60*1000;
const MAX_NOTE_BYTES=4096,MAX_QUOTE_BYTES=16384;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash=/^[a-f0-9]{64}$/;
const recordFields=['version','scope','documentId','documentRevision','documentSha256','textSha256','start','end','quoteSha256','rangeSha256','note','operationId','requestSha256','createdAt','updatedAt'] as const;
const rangeFields=['scope','documentId','documentRevision','documentSha256','textSha256','start','end','quoteSha256'] as const;
const payloadFields=['documentRevision','documentSha256','end','note','operationId','quote','quoteSha256','rangeUnit','start','textSha256'] as const;
const citationFields=['id','documentId','documentSha256','textSha256','start','end','quote','quoteSha256','note','labelAtCreation','createdAt','level','page'];
const bytes=(text:string)=>new TextEncoder().encode(text).length;
function fail(message='引用恢复记录无效或已变化；已停止恢复，请保留现有草稿并核对来源。'):never{throw Error(message)}
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:fail();
const validUuid=(value:unknown):value is string=>typeof value==='string'&&uuid.test(value);
const validHash=(value:unknown):value is string=>typeof value==='string'&&hash.test(value);
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0;
function wellFormed(text:string){
 for(let i=0;i<text.length;i++){
  const code=text.charCodeAt(i);
  if(code>=0xd800&&code<=0xdbff){const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}
  else if(code>=0xdc00&&code<=0xdfff)return false;
 }
 return true;
}
function validateNote(note:unknown):asserts note is string{
 if(typeof note!=='string'||!wellFormed(note)||/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(note)||bytes(note)>MAX_NOTE_BYTES)fail('人工备注必须为有效文字，且不超过 4096 UTF-8 字节。');
}
function time(now:number){if(!integer(now))fail();return now;}
function validateRecord(value:unknown):CitationDraftRecord{
 const v=object(value);
 if(Object.keys(v).length!==recordFields.length||recordFields.some(field=>!Object.hasOwn(v,field))||v.version!==1||!validUuid(v.scope)||!validUuid(v.documentId)||!integer(v.documentRevision)||!validHash(v.documentSha256)||!validHash(v.textSha256)||!validHash(v.quoteSha256)||!validHash(v.rangeSha256)||!integer(v.start)||!integer(v.end)||v.end<=v.start||!integer(v.createdAt)||!integer(v.updatedAt)||v.updatedAt<v.createdAt)fail();
 if(!((v.operationId===null&&v.requestSha256===null)||(validUuid(v.operationId)&&validHash(v.requestSha256))))fail();
 validateNote(v.note);
 // Copy the allowlist, preventing a caller mutation during hashing and ensuring
 // extra source-content fields are rejected rather than silently persisted.
 const record=Object.fromEntries(recordFields.map(field=>[field,v[field]])) as CitationDraftRecord;
 if(bytes(JSON.stringify(record))>MAX_RECORD_BYTES)fail('引用恢复记录超过 8 KiB，未保存；请缩短人工备注。');
 return record;
}
function validateSource(value:CitationDraftSource):CitationDraftSource{
 const v=object(value);
 if(!validUuid(v.id)||!integer(v.revision)||!validHash(v.sha256)||!validHash(v.textSha256))fail();
 if(v.format!=='txt'&&v.format!=='md')fail('引用草稿恢复仅支持 TXT / MD 文档。');
 return {id:v.id,revision:v.revision,sha256:v.sha256,textSha256:v.textSha256,format:v.format};
}
const key=(record:Pick<CitationDraftRecord,'scope'|'documentId'>)=>`${PREFIX}${record.scope}:${record.documentId}`;
const equal=(a:CitationDraftRecord,b:CitationDraftRecord)=>recordFields.every(field=>a[field]===b[field]);
const sameDraft=(a:CitationDraftRecord,b:CitationDraftRecord)=>recordFields.filter(field=>field!=='operationId'&&field!=='requestSha256'&&field!=='updatedAt').every(field=>a[field]===b[field]);
const expired=(record:CitationDraftRecord,now:number)=>record.operationId===null&&now-record.updatedAt>=DRAFT_TTL_MS;
function access<T>(fn:()=>T):T{
 try{return fn()}catch{fail('无法可靠读写引用恢复记录；已停止保存或恢复。请保留现有草稿，检查此会话的存储权限与容量。');}
}
function parseRecord(raw:string,scope:string,documentId?:string):CitationDraftRecord{
 if(bytes(raw)>MAX_RECORD_BYTES)fail();
 let value:unknown;try{value=JSON.parse(raw)}catch{fail()}
 const record=validateRecord(value);
 if(record.scope!==scope||(documentId!==undefined&&record.documentId!==documentId))fail();
 return record;
}

export function listCitationDrafts(storage:Storage,scope:string,now=Date.now()):CitationDraftRecord[]{
 if(!validUuid(scope))fail();time(now);
 const prefix=PREFIX+scope+':',records:CitationDraftRecord[]=[],seen=new Set<string>();
 const count=access(()=>storage.length);if(!integer(count))fail();
 for(let i=0;i<count;i++){
  const name=access(()=>storage.key(i));if(name===null)fail();
  if(!name.startsWith(prefix))continue;
  if(seen.has(name))fail();seen.add(name);
  const raw=access(()=>storage.getItem(name));if(raw===null)fail();
  const record=parseRecord(raw,scope);if(key(record)!==name)fail();records.push(record);
 }
 // Validate the whole scope before any TTL removal. Unknown/corrupt entries
 // are retained, because they may represent an unresolved committed operation.
 if(records.length>MAX_RECORDS)fail('引用恢复记录超过每库 20 条的限制；请先核对现有记录。');
 for(const record of records)if(expired(record,now))clearCitationDraft(storage,record);
 return records.filter(record=>!expired(record,now)).sort((a,b)=>a.createdAt-b.createdAt||a.documentId.localeCompare(b.documentId));
}

export function readCitationDraft(storage:Storage,scope:string,documentId:string,now=Date.now()):CitationDraftRecord|null{
 if(!validUuid(documentId))fail();
 return listCitationDrafts(storage,scope,now).find(record=>record.documentId===documentId)??null;
}

export function persistCitationDraft(storage:Storage,value:CitationDraftRecord,now=Date.now()):CitationDraftRecord{
 const record=validateRecord(value);time(now);
 if(expired(record,now))fail('未提交的引用草稿已超过 7 天，请重新选择原文。');
 const records=listCitationDrafts(storage,record.scope,now),prior=records.find(item=>item.documentId===record.documentId);
 if(prior){
  if(prior.operationId!==null&&!equal(prior,record))fail('原引用保存结果仍待确认，不能覆盖或修改待确认草稿。');
  if(record.updatedAt<prior.updatedAt)fail();
  if(prior.operationId===null&&record.operationId!==null&&!sameDraft(prior,record))fail('当前引用草稿已变化，不能提交旧的保存操作。');
 }else if(records.length>=MAX_RECORDS)fail('每个文档库最多保留 20 条引用草稿；请先核对或放弃现有草稿。');
 // sessionStorage calls are synchronous. Compare once more immediately before
 // replacement, then require an exact read-back before the caller may POST.
 const current=access(()=>storage.getItem(key(record)));
 if(prior?current===null||!equal(parseRecord(current,record.scope,record.documentId),prior):current!==null)fail();
 const raw=JSON.stringify(record);
 access(()=>{storage.setItem(key(record),raw);if(storage.getItem(key(record))!==raw)throw Error('Read-back mismatch')});
 return record;
}

export function clearCitationDraft(storage:Storage,value:CitationDraftRecord):void{
 const record=validateRecord(value),name=key(record),raw=access(()=>storage.getItem(name));
 if(raw===null)return;
 const current=parseRecord(raw,record.scope,record.documentId);
 if(!equal(current,record))fail('引用草稿已经变化，未删除较新的草稿。');
 access(()=>{storage.removeItem(name);if(storage.getItem(name)!==null)throw Error('Removal not confirmed')});
}

async function sha(text:string){
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),value=>value.toString(16).padStart(2,'0')).join('');
}
// A checksum of the original selection identity catches isolated metadata
// corruption, including movement to an identical passage before first save.
// It is not an authentication signature against rewriting the entire record.
const rangeHash=(record:Pick<CitationDraftRecord,typeof rangeFields[number]>)=>sha(JSON.stringify(rangeFields.map(field=>[field,record[field]])));
function boundary(text:string,index:number){
 return index===0||index===text.length||!(text.charCodeAt(index-1)>=0xd800&&text.charCodeAt(index-1)<=0xdbff&&text.charCodeAt(index)>=0xdc00&&text.charCodeAt(index)<=0xdfff);
}
function selectedQuote(text:string,start:number,end:number){
 if(typeof text!=='string'||!wellFormed(text)||!integer(start)||!integer(end)||end<=start||end>text.length||!boundary(text,start)||!boundary(text,end))fail('引用范围无效：必须使用 UTF-16 半开范围，且不能拆开代理对。');
 const quote=text.slice(start,end);if(bytes(quote)>MAX_QUOTE_BYTES)fail('所选引文不能超过 16384 UTF-8 字节。');
 return quote;
}
async function verifiedQuote(record:CitationDraftRecord,source:CitationDraftSource,text:string){
 const current=validateSource(source);
 if(record.documentId!==current.id||record.documentSha256!==current.sha256||record.textSha256!==current.textSha256)fail('当前文档与草稿原件或提取文字不符，不能恢复引用。');
 if(record.operationId===null&&record.documentRevision!==current.revision)fail('文档版本已变化，请重新打开并选择引用。');
 if(await rangeHash(record)!==record.rangeSha256)fail('引用原始范围的哈希不符，不能恢复或提交引用。');
 const quote=selectedQuote(text,record.start,record.end);
 if(await sha(text)!==record.textSha256||await sha(quote)!==record.quoteSha256)fail('原文或精确引用范围的哈希不符，不能恢复引用。');
 return quote;
}
function payload(record:CitationDraftRecord,quote:string,operationId:string):CitationDraftPayload{
 return {documentRevision:record.documentRevision,documentSha256:record.documentSha256,end:record.end,note:record.note,operationId,quote,quoteSha256:record.quoteSha256,rangeUnit:'utf16-code-unit',start:record.start,textSha256:record.textSha256};
}
const requestHash=(request:CitationDraftPayload)=>sha(JSON.stringify(payloadFields.map(field=>[field,request[field]])));

export async function createCitationDraft(scope:string,source:CitationDraftSource,text:string,range:{start:number;end:number},note:string,now=Date.now()):Promise<CitationDraftRecord>{
 if(!validUuid(scope))fail();time(now);validateNote(note);
 const current=validateSource(source),start=range.start,end=range.end,quote=selectedQuote(text,start,end);
 if(await sha(text)!==current.textSha256)fail('当前提取文字哈希不符，不能创建引用草稿。');
 const record:Omit<CitationDraftRecord,'rangeSha256'>={version:1,scope,documentId:current.id,documentRevision:current.revision,documentSha256:current.sha256,textSha256:current.textSha256,start,end,quoteSha256:await sha(quote),note,operationId:null,requestSha256:null,createdAt:now,updatedAt:now};
 return validateRecord({...record,rangeSha256:await rangeHash(record)});
}

export function updateCitationDraftNote(value:CitationDraftRecord,note:string,now=Date.now()):CitationDraftRecord{
 const record=validateRecord(value);time(now);validateNote(note);
 if(record.operationId!==null)fail('原引用保存结果仍待确认，不能修改人工备注。');
 if(expired(record,now))fail('未提交的引用草稿已超过 7 天，请重新选择原文。');
 return validateRecord({...record,note,updatedAt:Math.max(now,record.updatedAt)});
}

export async function rebuildCitationPayload(value:CitationDraftRecord,source:CitationDraftSource,text:string):Promise<CitationDraftPayload>{
 const record=validateRecord(value),quote=await verifiedQuote(record,source,text);
 if(record.operationId===null)fail('请先冻结并保留原引用保存操作，再重建提交请求。');
 const request=payload(record,quote,record.operationId);
 if(await requestHash(request)!==record.requestSha256)fail('引用保存请求哈希不符，已保留待确认记录。');
 return request;
}

// Safe recovery/preview validation: never generates an operation ID or writes.
export async function validateCitationDraft(value:CitationDraftRecord,source:CitationDraftSource,text:string):Promise<void>{
 const record=validateRecord(value);
 if(record.operationId!==null)await rebuildCitationPayload(record,source,text);
 else await verifiedQuote(record,source,text);
}

export async function beginCitationSave(value:CitationDraftRecord,source:CitationDraftSource,text:string,now=Date.now()):Promise<CitationDraftRecord>{
 const record=validateRecord(value);time(now);
 if(record.operationId!==null){await rebuildCitationPayload(record,source,text);return record;}
 if(expired(record,now))fail('未提交的引用草稿已超过 7 天，请重新选择原文。');
 const quote=await verifiedQuote(record,source,text),operationId=crypto.randomUUID();
 const request=payload(record,quote,operationId);
 return validateRecord({...record,operationId,requestSha256:await requestHash(request),updatedAt:Math.max(now,record.updatedAt)});
}

export async function verifyCitationReceipt(value:CitationDraftRecord,receiptValue:unknown,source:CitationDraftSource,text:string):Promise<CitationDraftCitation>{
 const record=validateRecord(value);
 // This also proves the stored original request digest, original revision,
 // full extracted text and exact UTF-16 quote, without searching for text.
 const request=await rebuildCitationPayload(record,source,text),receipt=object(receiptValue);
 const envelope=['storeScope','operationId','outcome','requestSha256','citation'];
 if(Object.keys(receipt).length!==envelope.length||envelope.some(field=>!Object.hasOwn(receipt,field))||receipt.storeScope!==record.scope||receipt.operationId!==record.operationId||receipt.outcome!=='committed'||receipt.requestSha256!==record.requestSha256)fail('引用回执与原文档库或原保存操作不符，已保留待确认草稿。');
 const citation=object(receipt.citation),allowed=[...citationFields,'rangeUnit','rangeConvention'];
 if(citationFields.some(field=>!Object.hasOwn(citation,field))||Object.keys(citation).some(field=>!allowed.includes(field))||!validUuid(citation.id)||citation.documentId!==record.documentId||citation.level!=='document-text'||citation.page!==null||('rangeUnit' in citation&&citation.rangeUnit!=='utf16-code-unit')||('rangeConvention' in citation&&citation.rangeConvention!=='half-open'))fail();
 for(const field of ['documentSha256','textSha256','start','end','quote','quoteSha256','note'] as const)if(citation[field]!==request[field])fail('引用回执的原件、范围或内容与原操作不符，已保留待确认草稿。');
 if(typeof citation.labelAtCreation!=='string'||!citation.labelAtCreation.trim()||!wellFormed(citation.labelAtCreation)||/[\u0000-\u001f\u007f]/u.test(citation.labelAtCreation)||bytes(citation.labelAtCreation)>512||typeof citation.createdAt!=='string'||citation.createdAt.length>64||!Number.isFinite(Date.parse(citation.createdAt)))fail();
 return {...citation} as CitationDraftCitation;
}
