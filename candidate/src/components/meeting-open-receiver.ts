import type {OrganizationKind,OrganizationRecord} from '../../shared/organization';
import {canonicalMeetingRecord,meetingOpenSelection,pinnedMeetingRecord,type MeetingOpenSelection} from './meeting-open-selection';
import {validateOrganizationRecord} from './organization-write-session';
/** A complete current catalog is required by the caller. References are local live DTOs,
 * not ownership claims; people need not belong to the meeting's organization. */
export function acceptedMeetingRecord(raw:unknown,selection:MeetingOpenSelection,catalog:Record<OrganizationKind,OrganizationRecord[]>):OrganizationRecord<'meeting'>|null {
 try {
  const pin=meetingOpenSelection(selection);
  const record=pinnedMeetingRecord(raw);
  if(!pin||!record||record.deletedAt!==null||record.kind!=='meeting'||record.id!==pin.id||record.revision!==pin.revision||record.data.organizationId!==pin.organizationId||canonicalMeetingRecord(record)!==pin.recordJson)return null;
  const live=(kind:'organization'|'person',id:string)=>{
   const matches=catalog[kind].filter(item=>item.id===id);
   if(matches.length!==1)return false;
   const reference=validateOrganizationRecord(matches[0],kind,id);
   return reference.kind===kind&&reference.id===id&&reference.deletedAt===null;
  };
  if(record.data.organizationId!==null&&!live('organization',record.data.organizationId))return null;
  if(!record.data.attendeeIds.every(id=>live('person',id)))return null;
  return record;
 }catch{return null;}
}
