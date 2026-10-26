import {validStoreId} from './transcription-store-session';

/** One shell-local document return preference, never rows, text or PDF admission. */
export type RecentDocumentReturn = Readonly<{documentStoreId:string; offset:number}>;
/** Copy only bounded committed fields. An invalid context must not prevent PDF opening. */
export function recentDocumentReturn(value:unknown):RecentDocumentReturn|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const {documentStoreId,offset}=value as Record<string,unknown>;
 if(!validStoreId(documentStoreId)||!Number.isSafeInteger(offset)||typeof offset!=='number'||offset<0||offset>250||offset%10!==0)return null;
 return Object.freeze({documentStoreId,offset});
}
