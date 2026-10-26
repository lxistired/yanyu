import type {PlanConversationSource} from './plan-conversation-handoff';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {MANUAL_PLAN_LIMITS, type ManualPlanLinkedSession as SessionPage, type ManualPlanRecord, type ManualPlanSessionLink} from '../../shared/manual-plans';
import type {ManualPlanSession} from './manual-plan-session';
/** An explicit, transient read intent. No ordinary workspace host or write session is used. */
export function ManualPlanLinkedSession({session,record,sessionLink,isCurrent,onClose,onOpenConversation}:{session:ManualPlanSession;record:ManualPlanRecord;sessionLink:Readonly<ManualPlanSessionLink>;isCurrent:()=>boolean;onClose:()=>void;onOpenConversation?:(source:PlanConversationSource)=>void}){
 const [page,setPage]=useState<SessionPage|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[previous,setPrevious]=useState<number[]>([]);
 const mounted=useRef(false),generation=useRef(0),active=useRef<SessionPage|null>(null);
 const current=()=>mounted.current&&isCurrent()&&session.editor?.record===record&&!session.pending&&!session.detailLoading&&!record.deletedAt&&record.storeScope===sessionLink.scope&&JSON.stringify(record.data.sessionLink)===JSON.stringify(sessionLink);
 const invalidate=()=>{generation.current++;active.current=null;};
 const close=()=>{invalidate();mounted.current=false;onClose();};
 async function load(offset=0,history:number[]=[]){
  if(!current())return;const attempt=++generation.current;active.current=null;setPage(null);setError('');setBusy(true);
  try{
   const result=await session.client.linkedSession({id:record.id,expectedRevision:record.revision,scope:sessionLink.scope,sessionLink,offset,limit:MANUAL_PLAN_LIMITS.defaultLimit});
   if(!current()||attempt!==generation.current)return;
   active.current=result;setPage(result);setPrevious(history);
  }catch{if(current()&&attempt===generation.current)setError('已关联会话查看不可用。请核对计划、目标版本及服务支持；不会使用旧结果或退回未绑定范围的查询。目标变化时须明确重新选择并保存关联。');}
  finally{if(current()&&attempt===generation.current)setBusy(false);}
 }
 useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;invalidate();};},[session,record,sessionLink]);
 useEffect(()=>{void load();},[session,record,sessionLink]);
 return <section aria-label="已关联会话只读查看">
 <h4>已关联会话（只读）</h4>
 <button onClick={close}>关闭会话查看</button>
 <p>仅查看已保存的本地手工消息，不是可编辑对话，不调用 AI。角色、模式和模型偏好只是保存的标签，不代表模型已运行。每页重新核对当前数据，不是冻结的会话快照。</p>
 {busy&&<p role="status">正在读取已关联会话…</p>}{error&&<p role="alert">{error}</p>}
 {page&&<>
 {onOpenConversation&&<button disabled={busy} onClick={()=>{if(current()&&active.current===page)onOpenConversation({session,record,link:sessionLink});}}>转到此会话手工记录</button>}
 <p>工作区：{page.workspace.title} · {page.workspace.id} · 版本 {page.workspace.revision}</p>
 <p>会话：{page.session.title} · {page.session.id} · 版本 {page.session.revision}</p>
 <p>保存的模式：{page.session.mode} · 模型偏好：{page.session.model||'未设置'}</p>
 <p>本页 {page.items.length} 条手工消息，共 {page.total} 条；起始偏移量 {page.offset}。按原手工消息顺序显示，其他编辑可能改变分页。</p>
 {!page.items.length&&<p>此会话没有当前可用的手工消息。</p>}
 <div className="company-grid wm-messages">{page.items.map(message=><article key={message.id} className="panel company-card" aria-label={`手工消息 ${message.id}`}>
 <div className="company-card-top"><span>{({user:'用户',assistant:'助手',system:'系统'})[message.data.role]} · 手工记录</span><span className="wm-meta">版本 {message.revision}</span></div>
 <p className="company-description" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'none'}}>{message.data.content}</p>
 <p className="wm-meta">更新于 {message.updatedAt} · {message.id}</p>
 </article>)}</div>
 <button disabled={busy||!previous.length} onClick={()=>{if(current()&&active.current===page&&previous.length)void load(previous[previous.length-1],previous.slice(0,-1));}}>上一页消息</button>
 <button disabled={busy||page.nextOffset===null} onClick={()=>{if(current()&&active.current===page&&page.nextOffset!==null)void load(page.nextOffset,[...previous,page.offset]);}}>下一页消息</button>
 </>}
 <button disabled={busy} onClick={()=>void load()}>重新读取会话</button>
 </section>;
}
