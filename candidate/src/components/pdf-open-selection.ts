import {workspaceIdentifier} from './workspace-identifier';

/** Ephemeral provenance, never authorization or a persisted/deep-link entitlement. */
export type PdfOpenSelection = Readonly<{storeScope:string; documentId:string; format:'pdf'; sha256:string; pages:number; revision:number; workspaceId:string|null; folderId:string|null}>;
export const PDF_OPEN_UNAVAILABLE_REASON = '此条记录暂不能直接打开 PDF，请在文档库重新核对';
const fields = ['documentId','folderId','format','pages','revision','sha256','storeScope','workspaceId'];
const uuid = (value:unknown):value is string => typeof value==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(value);
const record = (value:unknown):value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value) && (Object.getPrototypeOf(value)===Object.prototype || Object.getPrototypeOf(value)===null);
/** Strict DTO boundary; all fields are required, even nullable associations. */
export function pdfOpenSelection(value:unknown):PdfOpenSelection|null {
 if(!record(value) || Object.keys(value).sort().join(',')!==fields.join(','))return null;
 if(!uuid(value.storeScope)||!uuid(value.documentId)||value.format!=='pdf'||typeof value.sha256!=='string'||!/^[a-f0-9]{64}(?![\s\S])/.test(value.sha256)||!Number.isSafeInteger(value.pages)||(value.pages as number)<1||(value.pages as number)>40||!Number.isSafeInteger(value.revision)||(value.revision as number)<0||!(value.workspaceId===null||workspaceIdentifier(value.workspaceId))||!(value.folderId===null||uuid(value.folderId)))return null;
 return Object.freeze({storeScope:value.storeScope,documentId:value.documentId,format:'pdf',sha256:value.sha256,pages:value.pages as number,revision:value.revision as number,workspaceId:value.workspaceId,folderId:value.folderId});
}
/** Optional capability: a rejected PDF pin must not reject legacy text-preview rows. */
export function pdfOpenSelectionFromDocument(value:unknown,storeScope:string):PdfOpenSelection|null {
 if(!record(value)||value.trashedAt!==null||value.stale!==false)return null;
 return pdfOpenSelection({storeScope,documentId:value.id,format:value.format,sha256:value.sha256,pages:value.pages,revision:value.revision,workspaceId:value.workspaceId,folderId:value.folderId});
}
export function samePdfOpenSelection(left:PdfOpenSelection,right:PdfOpenSelection):boolean {
 return left.storeScope===right.storeScope&&left.documentId===right.documentId&&left.format===right.format&&left.sha256===right.sha256&&left.pages===right.pages&&left.revision===right.revision&&left.workspaceId===right.workspaceId&&left.folderId===right.folderId;
}
