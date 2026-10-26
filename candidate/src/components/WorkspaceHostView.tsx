import {admitPlanConversation,type PlanConversationIntent} from './plan-conversation-handoff';
import {useEffect,useReducer,useState} from 'react';
import {WorkspaceManager, type WorkspaceEntryMode} from './WorkspaceManager';
import type {WorkspaceWriteHost} from './workspace-write-host';
/** Hidden host retains the session, not a hidden modal or history/Escape listener. */
export function WorkspaceHostView({host,visible,initialWorkspaceId,onWorkspaceChange,entryMode='workspace',onOpenWorkspace,conversationIntent,onReturnToPlan}:{host:WorkspaceWriteHost;visible:boolean;initialWorkspaceId?:string;onWorkspaceChange?:(id:string|null)=>void;entryMode?:WorkspaceEntryMode;onOpenWorkspace?:()=>void;conversationIntent?:PlanConversationIntent|null;onReturnToPlan?:()=>void}){
 const [,render]=useReducer(n=>n+1,0);useEffect(()=>host.subscribe(render),[host]);
 const [admission,setAdmission]=useState<{intent:PlanConversationIntent;ready:boolean}|null>(null);
 useEffect(()=>{
  if(!visible||!conversationIntent){setAdmission(null);return;}
  let active=true;const intent=conversationIntent;setAdmission(null);
  void admitPlanConversation(intent,()=>active).then(ready=>{if(active)setAdmission({intent,ready});}).catch(()=>{if(active)setAdmission({intent,ready:false});});
  return()=>{active=false;};
 },[visible,conversationIntent]);
 if(!visible)return null;
 const session=host.session;
 if(!session)return <p role="status">{entryMode==='manual-conversation'?'本地手工会话':'工作区恢复'}暂不可用：尚未取得固定合成身份范围。</p>;
 if(conversationIntent&&(!conversationIntent.current()||conversationIntent.session!==session||admission?.intent!==conversationIntent||!admission.ready))
  return <section role="status"><p>{admission?.intent===conversationIntent||!conversationIntent.current()?'无法进入来源计划的精确会话。请返回计划核对关联，或先处理工作区中的草稿与待确认操作；未改用最近会话。':'正在重新核对来源计划、工作区与会话版本…'}</p>{onReturnToPlan&&<button onClick={onReturnToPlan}>返回来源计划</button>}{onOpenWorkspace&&<button onClick={onOpenWorkspace}>返回工作区管理</button>}</section>;
 const draft=session.draft;
 const view=draft?.view as {kind?:string}|undefined,editor=draft?.editor as {kind?:string}|null|undefined;
 const conversationKind=(kind:string|undefined)=>kind==='session'||kind==='message';
 const pendingInput=session.pending?JSON.parse(session.pending.command.body):null;
 const otherPending=pendingInput && !(conversationKind(pendingInput.kind) ||
   (Array.isArray(pendingInput.items) && pendingInput.items.every((item:{kind?:string})=>conversationKind(item.kind))));
 // Never coerce a retained non-conversation editor, import or pending command into
 // another view. Its existing host remains the only owner and recovery surface.
 if(entryMode==='manual-conversation' && (session.unsavedState().dirty||session.pending||editor||draft?.importing) &&
    (!conversationKind(view?.kind)||(editor&&!conversationKind(editor.kind))||draft?.importing||otherPending))
   return <section role="status"><p>本地手工会话，未连接 AI；消息由用户录入。</p><p>工作区仍有其他类型的草稿或待确认操作。内容与原操作已保留，请先返回工作区处理，再进入手工会话。</p>{onOpenWorkspace&&<button onClick={onOpenWorkspace}>返回工作区管理</button>}</section>;
 return <WorkspaceManager key={`${host.generationId}:${entryMode}`} session={session} initialWorkspaceId={initialWorkspaceId} onWorkspaceChange={onWorkspaceChange} entryMode={entryMode} onOpenWorkspace={onOpenWorkspace} conversationTarget={conversationIntent?.source.link} onReturnToPlan={conversationIntent?onReturnToPlan:undefined} sourcePlanTitle={conversationIntent?.source.record.data.title}/>;
}
