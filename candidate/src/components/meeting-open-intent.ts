import type {OrganizationWriteSession} from './organization-write-session';
import {meetingOpenSelection,type MeetingOpenSelection} from './meeting-open-selection';
/** Shell-created lifecycle provenance, not server authentication. Never read from a row. */
export type MeetingAgendaBinding = Readonly<{identityScope:string;hostGeneration:number;session:OrganizationWriteSession;isCurrent:()=>boolean}>;
export type MeetingOpenIntent = {readonly selection:MeetingOpenSelection;readonly epoch:number;readonly session:OrganizationWriteSession;readonly approvedEditorVersion:number;readonly approvedEditorToken:string|null;pending:boolean;current:()=>boolean};
export function meetingEditorApprovalCurrent(intent:MeetingOpenIntent):boolean {
 try {const s=intent.session;return s.available&&!s.pending&&!s.draftRetentionIncomplete&&s.editorVersion===intent.approvedEditorVersion&&(s.editor?.token??null)===intent.approvedEditorToken;}catch{return false;}
}
/** Snapshot arguments must be captured BEFORE the actual accepted global dirty guard. */
export function createMeetingOpenIntent(value:unknown,epoch:number,binding:MeetingAgendaBinding,approvedEditorVersion:number,approvedEditorToken:string|null,owns:()=>boolean):MeetingOpenIntent|null {
 const selection=meetingOpenSelection(value);
 if(!selection||!Number.isSafeInteger(epoch)||epoch<0||!Number.isSafeInteger(approvedEditorVersion)||approvedEditorVersion<0||(approvedEditorToken!==null&&typeof approvedEditorToken!=='string'))return null;
 const {session,identityScope,hostGeneration,isCurrent}=binding;
 const live=()=>{try{return session.available&&binding.session===session&&binding.identityScope===identityScope&&binding.hostGeneration===hostGeneration&&isCurrent()&&selection.identityScope===identityScope&&selection.hostGeneration===hostGeneration;}catch{return false;}};
 const intent:MeetingOpenIntent={selection,epoch,session,approvedEditorVersion,approvedEditorToken,pending:true,current:()=>intent.pending&&live()&&owns()};
 if(!live()||!meetingEditorApprovalCurrent(intent))return null;
 // Approval fields cannot be refreshed or caller-mutated; only pending is a one-shot latch.
 for(const key of ['selection','epoch','session','approvedEditorVersion','approvedEditorToken','current'] as const)Object.defineProperty(intent,key,{writable:false,configurable:false});
 return Object.seal(intent);
}
