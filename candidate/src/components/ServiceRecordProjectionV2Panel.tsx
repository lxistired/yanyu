import { useEffect, useReducer, useSyncExternalStore } from 'react';
import type { ServiceRecordProjectionSession, ProjectionState } from './service-record-projection-session';
import { allowLeavingUnsavedWork, useUnsavedWork } from './unsaved-work';
export type ProjectionMode={mode:'legacy-synthetic'}|{mode:'v2';session:ServiceRecordProjectionSession|null};
export function ServiceRecordProjectionV2Panel({sourceId,onDirtyChange,session}:{sourceId:string;onDirtyChange?:(id:string,dirty:boolean)=>void;session:ServiceRecordProjectionSession|null}){
 const [,render]=useReducer(x=>x+1,0);
 const state=useSyncExternalStore(session?.subscribe??(()=>()=>{}),()=>session?.state??null),preview=state?.preview?.source.id===sourceId?state.preview:null;
 const pending=Boolean(state?.pending),dirty=Boolean(!pending&&preview&&(state?.status||state?.reason||state?.selection));
 useUnsavedWork(dirty);
 useEffect(()=>{onDirtyChange?.(sourceId,dirty||pending);return()=>onDirtyChange?.(sourceId,false);},[sourceId,dirty,pending,onDirtyChange]);
 if(!session||!session.available||!state)return <p role="status">月报投影暂不可用：未取得当前机构身份，不会改用合成通道。</p>;
 const s=session,correction=Boolean(preview?.existing&&preview.existing.sourceRevision!==preview.source.revision);
 const run=(work:()=>Promise<void>|void)=>{try{void Promise.resolve(work()).catch(()=>render());}catch{render();}};
 const load=()=>{const sharedDirty=s.unsavedState().dirty;if(sharedDirty&&!allowLeavingUnsavedWork())return;run(()=>s.preview(sourceId,sharedDirty));};
 const close=()=>{if(dirty&&!allowLeavingUnsavedWork())return;run(()=>s.cancelPreview());};
 const draft=(status:ProjectionState['status'],reason:string)=>run(()=>s.setDraft(status,reason));
 return <section aria-label="机构服务记录投影" className="automation-form" style={{borderTop:'1px solid #cbd5e1',paddingTop:12,marginTop:12}}>
  <button className="secondary" disabled={state.busy||pending} onClick={load}>预览计入月报</button>
  <p className="muted">需逐条确认状态和资料。上传内容不等于已验证作者、客户阅读或外部送达。</p>
  {state.busy&&<p role="status">正在核对；离开页面不会撤销已提交的保存。</p>}
  {state.problem&&<p role="alert">{state.problem}</p>}{state.result&&<p role="status">{state.result}</p>}
  {state.pending&&<div role="status"><p>源记录 {state.pending.command.sourceId} 的原提交尚未确认。原状态、来源和更正原因已保留，不能改选后重发。</p><button disabled={state.busy} onClick={()=>run(()=>s.retry())}>核对同一提交</button></div>}
  {preview&&!pending&&<div>
   <h4>确认来源投影</h4><p>{preview.warning}</p>
   <p>源记录 {preview.source.id} · 修订 {preview.source.revision}</p>
   <p>摘要：{preview.projection.summary}</p><p>日期：{preview.projection.occurredAt} · 类型：{preview.projection.kind}</p>
   <p>客户：{preview.customerPin.organizationId} / {preview.customerPin.contactId??'机构级'} · 机构修订 {preview.customerPin.organizationRevision}</p>
   {preview.existing&&<p>已有活动 {preview.existing.id} · 源修订 {preview.existing.sourceRevision}。{correction?'更正同一活动，不新增计数。':'相同选择只核对当前活动，不代表验证了原提交回执。'}</p>}
   {preview.existing?.archivedAt&&<p role="alert">已有活动已归档，请先在服务报告中明确恢复。</p>}
   <label>明确选择活动状态 <select aria-label="投影活动状态" value={state.status} disabled={state.busy} onChange={e=>draft(e.target.value as ProjectionState['status'],state.reason)}><option value="">请选择，不推断状态</option><option value="planned">计划中</option><option value="reported-completed">自报已完成（未验证）</option><option value="cancelled">已取消</option></select></label>
   <button disabled={state.busy} onClick={()=>run(()=>s.choices())}>读取或刷新本地资料</button>
   {state.page?.nextOffset!==null&&state.page?.nextOffset!==undefined&&<button disabled={state.busy} onClick={()=>run(()=>s.choices(true))}>下一页资料</button>}
   {!preview.authority.capabilities.localDocuments&&<p role="status">本地资料来源尚未启用，仍可明确选择合成演示来源。</p>}
   {state.page&&preview.authority.capabilities.localDocuments&&state.page.items.length===0&&<p role="status">本页没有可用本地资料；不会自动改用合成来源。</p>}
   <label>明确选择文档来源 <select aria-label="投影文档来源" value={state.selection?.pin.documentId??''} disabled={state.busy} onChange={e=>run(()=>s.select(e.target.value))}><option value="">请选择并核验，不转换本地目标</option><option value={preview.syntheticSourcePin.documentId}>合成来源 synthetic-doc / v1（仅本地演示）</option>{state.page?.items.map(item=><option key={item.documentId} value={item.documentId}>{item.name}（本地提取文本）</option>)}</select></label>
   <p role="status">{state.selection?'来源版本已核验；保存时仍会重新检查可用性。':'尚未核验来源，不能保存。'}</p>
   {correction&&<label>更正原因 <input aria-label="投影更正原因" maxLength={500} value={state.reason} disabled={state.busy} onChange={e=>draft(state.status,e.target.value)}/></label>}
   <p>原 UTC 日期保留，月份由报告时区决定。保存不重写历史月报；取消预览不是撤销已提交操作。</p>
   <button className="primary" disabled={state.busy||!state.status||!state.selection||Boolean(preview.existing?.archivedAt)||correction&&!state.reason.trim()} onClick={()=>run(()=>s.submit())}>{correction?'确认更正原活动':'确认计入月报活动'}</button>
   <button className="secondary" onClick={close}>取消预览</button>
  </div>}
 </section>;
}
