import {workspaceIdentifier} from './workspace-identifier';
import {recentDocumentReturn} from './recent-document-return';
import {pdfOpenSelectionFromDocument, type PdfOpenSelection} from './pdf-open-selection';
import {validStoreId, StoreContinuityError} from './transcription-store-session';

/** One accepted search -> PDF -> Back preference; never saved rows or PDF authority. */
export type ResearchDocumentReturn = Readonly<{documentStoreId:string; offset:number; query:string}>;
export function researchDocumentReturn(value:unknown):ResearchDocumentReturn|null {
 const base=recentDocumentReturn(value);
 if(!base)return null;
 const query=(value as Record<string,unknown>).query;
 if(typeof query!=='string')return null;
 try{validateResearchQuery(query,'documents');}catch{return null;}
 return Object.freeze({...base,query});
}

/** Committed transcript search preference only; fresh source discovery is still required. */
export type ResearchTranscriptReturn = Readonly<{transcriptStoreId:string; offset:number; query:string}>;
export function researchTranscriptReturn(value:unknown):ResearchTranscriptReturn|null {
 if(!value||typeof value!=='object')return null;
 const {transcriptStoreId,offset,query}=value as Record<string,unknown>;
 if(!validStoreId(transcriptStoreId)||!Number.isInteger(offset)||typeof offset!=='number'||offset<0||offset>1000||offset%10!==0||typeof query!=='string')return null;
 try{validateResearchQuery(query,'transcripts');}catch{return null;}
 return Object.freeze({transcriptStoreId,offset,query});
}

/** Minimal, projected local-search DTOs. No provider, inference or mutation routes. */
export const RESEARCH_PAGE_SIZE = 10;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const encoder = new TextEncoder();
const malformed = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
function invalid(): never { throw Error('本地来源响应无效，请重试'); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(); return value as Record<string, unknown>; }
function text(value: unknown, bytes: number): string { if (typeof value !== 'string' || value.length > bytes || encoder.encode(value).length > bytes || malformed.test(value)) return invalid(); return value; }
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) return invalid(); return value as number; }
function identity(value: unknown): string { if (typeof value !== 'string' || !uuid.test(value)) return invalid(); return value; }
export type ResearchDocument = {id: string; name: string; format: 'txt'|'md'|'pdf'; createdAt: string; pdfOpen?: PdfOpenSelection|null};
export const researchUploadOrigins = ['unknown','file-selection','recording-draft'] as const;
export type ResearchUploadOrigin = typeof researchUploadOrigins[number];
// Absence of both fields preserves old responses; a partial or contradictory pair is invalid.
type ResearchOrigin = {uploadOrigin?: ResearchUploadOrigin; uploadOriginAssurance?: 'unknown'|'client-declared'};
function researchOrigin(d:Record<string,unknown>): ResearchOrigin {
 if (!('uploadOrigin' in d) && !('uploadOriginAssurance' in d)) return {};
 if (!researchUploadOrigins.includes(d.uploadOrigin as ResearchUploadOrigin) || d.uploadOriginAssurance !== (d.uploadOrigin === 'unknown' ? 'unknown' : 'client-declared')) return invalid();
 return {uploadOrigin:d.uploadOrigin as ResearchUploadOrigin,uploadOriginAssurance:d.uploadOriginAssurance as 'unknown'|'client-declared'};
}
export type ResearchJob = ResearchOrigin & {transcriptStoreId: string; id: string; title: string; filename: string; status: 'interrupted'|'processing'|'completed'|'cancelled'|'failed'; created: string; preview: string|null; truncated: boolean};
export type ResearchPage<T> = {items: T[]; total: number; offset: number};
export function validateResearchQuery(query: string, source: 'documents'|'transcripts'): string {
 if (encoder.encode(query).length > 512 || malformed.test(query) || (source === 'documents' ? /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f\ufffd]/u).test(query)) throw Error('查询最多 512 UTF-8 字节，且不能包含不支持的控制字符');
 return query;
}
export function documentScope(value: unknown): string { return identity(object(value).uploadScope); }
function document(value: unknown): ResearchDocument {
 const d = object(value); const format = d.format;
 if (!['txt','md','pdf'].includes(format as string) || d.trashedAt !== null) return invalid();
 return {id: identity(d.id), name: text(d.name, 512), format: format as ResearchDocument['format'], createdAt: text(d.createdAt, 128)};
}
function page(value: unknown, key: string, offset: number, max: number) {
 const data = object(value), total = integer(data.total, max);
 if (data.offset !== offset || data.limit !== RESEARCH_PAGE_SIZE || !Array.isArray(data[key]) || data[key].length > RESEARCH_PAGE_SIZE || data[key].length !== Math.min(RESEARCH_PAGE_SIZE, Math.max(0, total-offset))) return invalid();
 return {data, total, rows: data[key] as unknown[]};
}
export function documentPage(value: unknown, scope: string, offset: number): ResearchPage<ResearchDocument> {
 const {data,total,rows} = page(value, 'documents', offset, 250);
 if (identity(data.storeScope) !== scope) throw new ResearchScopeChanged();
 const items = rows.map(value=>{const item=document(value);return item.format==='pdf'?{...item,pdfOpen:pdfOpenSelectionFromDocument(value,scope)}:item;}); if (new Set(items.map(d=>d.id)).size !== items.length) return invalid();
 return {items,total,offset};
}
export function documentPreview(value: unknown, scope: string, id: string) {
 const data = object(value);
 if (identity(data.storeScope) !== scope) throw new ResearchScopeChanged();
 const item = document(data.document); if (item.id !== id) return invalid();
 return {item, text: text(data.text, 1024*1024)};
}
/** A saved shortcut needs active current metadata, not the minimal legacy text projection.
 * PDF selection is freshly derived here and must never be persisted with the plan. */
export function savedDocumentPreview(value:unknown,scope:string,id:string) {
 const preview=documentPreview(value,scope,id), raw=object(object(value).document);
 const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}(?![\s\S])/.test(v);
 if(raw.stale!==false||!preview.item.name.trim()||/[\\/\u0000-\u001f\u007f]/u.test(preview.item.name)||
    !Number.isSafeInteger(raw.revision)||(raw.revision as number)<0||!Number.isSafeInteger(raw.bytes)||(raw.bytes as number)<1||(raw.bytes as number)>8*1024*1024||
    !hash(raw.sha256)||!hash(raw.textSha256)||!(raw.workspaceId===null||workspaceIdentifier(raw.workspaceId))||
    !(raw.folderId===null||typeof raw.folderId==='string'&&raw.folderId.length===36&&uuid.test(raw.folderId)))return invalid();
 const pdfOpen=preview.item.format==='pdf'?pdfOpenSelectionFromDocument(raw,scope):null;
 if(preview.item.format==='pdf'?!pdfOpen:raw.pages!==null)return invalid();
 return {...preview,pdfOpen};
}
export function transcriptPage(value: unknown, offset: number, transcriptStoreId: string): ResearchPage<ResearchJob> {
 if(!validStoreId(transcriptStoreId))throw new StoreContinuityError();
 const {data,total,rows} = page(value, 'jobs', offset, Number.MAX_SAFE_INTEGER);
 if (typeof data.hasMore !== 'boolean' || data.hasMore !== (offset + rows.length < total)) return invalid();
 const items = rows.map(value => {
  const d = object(value); if (!['interrupted','processing','completed','cancelled','failed'].includes(d.status as string) || d.deleted_at !== null) return invalid();
  let preview: string|null = null, truncated = false;
  if (d.result !== null) { const r = object(d.result); preview = text(r.text, 16384); if (Array.from(preview).length > 4096 || typeof r.text_preview_truncated !== 'boolean') return invalid(); truncated = r.text_preview_truncated; }
  return {...researchOrigin(d), transcriptStoreId, id: identity(d.id), title: text(d.title, 512), filename: text(d.filename, 1024), status: d.status as ResearchJob['status'], created: text(d.created,128), preview, truncated};
 });
 if (new Set(items.map(d=>d.id)).size !== items.length) return invalid();
 return {items,total,offset};
}
export class ResearchScopeChanged extends Error { constructor() { super('文档来源已变化，请明确重新载入来源后再搜索'); } }
export async function researchGet(url: string, signal: AbortSignal, headers?: Record<string,string>): Promise<unknown> {
 const response = await fetch(url, {method:'GET', signal, ...(headers ? {headers} : {})});
 if (response.status === 409) throw new ResearchScopeChanged();
 if (!response.ok) throw Error(`本地来源暂不可用 (${response.status})，请重试`);
 return response.json();
}
/** Abort plus generation fencing also rejects a late JSON decode from an ignored abort. */
export class ResearchRequestOwner {
 private generation = 0; private controller: AbortController|null = null;
 cancel() { ++this.generation; this.controller?.abort(); this.controller = null; }
 begin() { this.cancel(); const generation = this.generation; const controller = new AbortController(); this.controller = controller; return {signal:controller.signal, current:()=>this.generation === generation && !controller.signal.aborted}; }
}
export function recoveryOffset(total: number, offset: number, maximum: number) { return Math.min(maximum, Math.max(0, Math.floor((Math.max(1,total)-1)/RESEARCH_PAGE_SIZE)*RESEARCH_PAGE_SIZE), offset); }
