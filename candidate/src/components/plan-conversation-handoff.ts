import type {ManualPlanRecord,ManualPlanSessionLink} from '../../shared/manual-plans';
import type {ManualPlanSession} from './manual-plan-session';
import type {WorkspaceWriteHost} from './workspace-write-host';
import type {WorkspaceWriteSession} from './workspace-write-session';

export type PlanConversationSource=Readonly<{session:ManualPlanSession;record:ManualPlanRecord;link:Readonly<ManualPlanSessionLink>}>;
export type PlanConversationIntent=Readonly<{source:PlanConversationSource;session:WorkspaceWriteSession;draftVersion:number;current:()=>boolean}>;
export function currentPlanConversationSource(source:PlanConversationSource):boolean {
 const {session,record,link}=source;
 return session.editor?.record===record&&!session.pending&&!session.detailLoading&&!record.deletedAt&&!!record.storeScope&&record.storeScope===link.scope&&JSON.stringify(record.data.sessionLink)===JSON.stringify(link);
}
/** Do not overwrite any retained editor, uncertain command or unread completion. */
export function cleanConversationDestination(session:WorkspaceWriteSession):boolean {
 try{const draft=session.draft;return session.available&&!session.pending&&!session.completionEvent&&!session.unsavedState().dirty&&!draft?.editor&&!draft?.importing&&!draft?.previewToken;}catch{return false;}
}
/** Owner identity belongs to the hosts; the saved link has a separate store scope. */
export function createPlanConversationIntent(source:PlanConversationSource,host:WorkspaceWriteHost,sourceCurrent:()=>boolean,owns:()=>boolean):PlanConversationIntent|null {
 const session=host.session,scope=host.identityScope,generation=host.generationId;
 if(!session||!scope||!sourceCurrent()||!currentPlanConversationSource(source)||!cleanConversationDestination(session))return null;
 const captured=Object.freeze({...source,link:Object.freeze({...source.link})});
 return Object.freeze({source:captured,session,draftVersion:session.draftVersion,current:()=>{
  try{return owns()&&sourceCurrent()&&currentPlanConversationSource(captured)&&host.session===session&&host.identityScope===scope&&host.generationId===generation&&session.available;}catch{return false;}
 }});
}
/** A fresh exact linked read is required even if the readonly viewer already loaded. */
export async function admitPlanConversation(intent:PlanConversationIntent,active:()=>boolean):Promise<boolean> {
 const current=()=>active()&&intent.current()&&intent.session.draftVersion===intent.draftVersion&&cleanConversationDestination(intent.session);
 if(!current())return false;
 const {source,session}=intent,{record,link}=source;
 await source.session.client.linkedSession({id:record.id,expectedRevision:record.revision,scope:link.scope,sessionLink:link,offset:0,limit:1});
 if(!current())return false;
 session.setDraft({view:{kind:'message',workspaceId:link.workspaceId,sessionId:link.sessionId,groupId:'*',watchlistId:'',query:'',includeDeleted:false,pinned:false,offset:0},editor:null,importing:false,importText:'',importItems:null,previewToken:null,selected:[],dirty:false});
 return true;
}
