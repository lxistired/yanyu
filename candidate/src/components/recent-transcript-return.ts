import {createdDateBounds, type CreatedDateSelection} from './transcription-created-date.mjs';
import {researchUploadOrigins, type ResearchUploadOrigin, type ResearchJob} from './local-research-search';
import {validStoreId} from './transcription-store-session';

/** One shell-local return ticket. View preferences only: never rows, text or authority. */
export type RecentTranscriptReturn = {
 transcriptStoreId:string; offset:number; statuses:ResearchJob['status'][];
 dates:CreatedDateSelection; origin:ResearchUploadOrigin|'';
};
const statuses:readonly ResearchJob['status'][]=['interrupted','processing','completed','cancelled','failed'];
/** Copy only the bounded committed fields; never retain a caller's larger object. */
export function recentTranscriptReturn(value:RecentTranscriptReturn|null|undefined):RecentTranscriptReturn|null {
 if(!value||!validStoreId(value.transcriptStoreId)||!Number.isInteger(value.offset)||value.offset<0||value.offset>1000||value.offset%10!==0)return null;
 if(!Array.isArray(value.statuses)||value.statuses.length>statuses.length||new Set(value.statuses).size!==value.statuses.length||value.statuses.some(item=>!statuses.includes(item)))return null;
 if(value.origin!==''&&!researchUploadOrigins.includes(value.origin))return null;
 if(!value.dates||typeof value.dates.createdFrom!=='string'||typeof value.dates.createdThrough!=='string'||value.dates.createdFrom.length>10||value.dates.createdThrough.length>10||!createdDateBounds(value.dates.createdFrom||undefined,value.dates.createdThrough||undefined))return null;
 return {transcriptStoreId:value.transcriptStoreId,offset:value.offset,statuses:statuses.filter(item=>value.statuses.includes(item)),dates:{createdFrom:value.dates.createdFrom,createdThrough:value.dates.createdThrough},origin:value.origin};
}
