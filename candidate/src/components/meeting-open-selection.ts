import {agendaRequest, validateAgendaPage} from './local-meeting-agenda';
import type {OrganizationRecord} from '../../shared/organization';
export const MEETING_RECORD_PIN_BYTES = 65536;
export type MeetingOpenSelection = Readonly<{kind:'meeting'; id:string; revision:number; organizationId:string|null; identityScope:string; hostGeneration:number; recordJson:string}>;
const encoder = new TextEncoder();
const validId = (v:unknown):v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}(?![\s\S])/.test(v);
const validScope = (v:unknown):v is string => typeof v === 'string' && /^[0-9a-f]{64}(?![\s\S])/.test(v);
const integer = (v:unknown,min:number):v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
function object(value:unknown, keys:readonly string[], optional:readonly string[]=[]):Record<string,unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw Error('INVALID_MEETING_PIN');
 const names=Reflect.ownKeys(value); if(keys.some(key=>!Object.hasOwn(value,key)) || names.some(key=>typeof key!=='string'||(!keys.includes(key)&&!optional.includes(key)))) throw Error('INVALID_MEETING_PIN');
 const copy:Record<string,unknown>={};
 for(const key of [...keys,...optional.filter(key=>Object.hasOwn(value,key))]){const d=Object.getOwnPropertyDescriptor(value,key);if(!d || !d.enumerable || !('value' in d))throw Error('INVALID_MEETING_PIN');copy[key]=d.value;}
 return copy;
}
/** Strict detached canonical record. Validation never normalizes stored strings or attendee order. */
export function canonicalMeetingRecord(value:unknown):string|null {
 try {
  const r=object(value,['id','kind','revision','createdAt','updatedAt','deletedAt','data']);
  const d=object(r.data,['title','organizationId','series','category','startsAt','endsAt','timezone','location','description','attendeeIds','state','providerAvailability'],['reminderLeadSeconds']);
  if(!validId(r.id) || (d.organizationId!==null&&!validId(d.organizationId)))return null;
  const a=d.attendeeIds;if(!Array.isArray(a)||Object.getPrototypeOf(a)!==Array.prototype)return null;
  const length=Object.getOwnPropertyDescriptor(a,'length');if(!length||!('value'in length)||!integer(length.value,0)||length.value>200||Reflect.ownKeys(a).length!==length.value+1)return null;
  const attendees:string[]=[];
  for(let i=0;i<length.value;i++){const p=Object.getOwnPropertyDescriptor(a,String(i));if(!p||!p.enumerable||!('value'in p)||!validId(p.value))return null;attendees.push(p.value);}
  d.attendeeIds=attendees;r.data=d;
  validateAgendaPage({items:[r],total:1,offset:0,nextOffset:null},agendaRequest({from:'',to:'',state:''}));
  const json=JSON.stringify(r);return encoder.encode(json).length<=MEETING_RECORD_PIN_BYTES?json:null;
 }catch{return null;}
}
/** Returns a validated detached record for the receiving exact-get comparison. */
export function pinnedMeetingRecord(value:unknown):OrganizationRecord<'meeting'>|null {
 const json=canonicalMeetingRecord(value);return json===null?null:JSON.parse(json) as OrganizationRecord<'meeting'>;
}
export function meetingOpenSelection(value:unknown):MeetingOpenSelection|null {
 try {
  const s=object(value,['kind','id','revision','organizationId','identityScope','hostGeneration','recordJson']);
  if(s.kind!=='meeting'||!validId(s.id)||!integer(s.revision,1)||(s.organizationId!==null&&!validId(s.organizationId))||!validScope(s.identityScope)||!integer(s.hostGeneration,0)||typeof s.recordJson!=='string'||encoder.encode(s.recordJson).length>MEETING_RECORD_PIN_BYTES)return null;
  const r=JSON.parse(s.recordJson) as OrganizationRecord<'meeting'>;
  if(canonicalMeetingRecord(r)!==s.recordJson||r.id!==s.id||r.revision!==s.revision||r.data.organizationId!==s.organizationId)return null;
  return Object.freeze(s) as MeetingOpenSelection;
 }catch{return null;}
}
export function selectMeetingRecord(record:unknown,identityScope:string,hostGeneration:number):MeetingOpenSelection|null {
 const recordJson=canonicalMeetingRecord(record);if(recordJson===null)return null;
 const r=JSON.parse(recordJson) as OrganizationRecord<'meeting'>;
 return meetingOpenSelection({kind:'meeting',id:r.id,revision:r.revision,organizationId:r.data.organizationId,identityScope,hostGeneration,recordJson});
}
