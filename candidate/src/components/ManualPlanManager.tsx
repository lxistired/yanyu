import type {PlanConversationSource} from './plan-conversation-handoff';
import {ManualPlanLinkedSession} from './ManualPlanLinkedSession';
import {ManualPlanMaterialCollection} from './ManualPlanMaterialCollection';
import {ManualPlanSessionLink} from './ManualPlanSessionLink';
import {LocalPlanWalkthrough} from './LocalPlanWalkthrough';
import {LocalResearchSearch, type LocalResearchSearchProps} from './LocalResearchSearch';
import React, {useEffect, useLayoutEffect, useRef, useReducer, useState} from 'react';
import {MANUAL_PLAN_STATES, effectiveManualPlanLinks, type ManualPlanState} from '../../shared/manual-plans';
import {ManualPlanSession, type Editor, type SimulatedPlanSummaryTarget} from './manual-plan-session';
export {ManualPlanSession} from './manual-plan-session';
/** One same-session, exact loaded plan revision return, never a persisted relationship. */
export type PlanMaterialReturn = {
 session:ManualPlanSession;
 record:NonNullable<NonNullable<ManualPlanSession['editor']>['record']>;
} & Pick<LocalResearchSearchProps,'initialDocumentReturn'|'initialTranscriptReturn'>;
export type ManualPlanManagerProps = {
 initialMaterialReturn?:PlanMaterialReturn|null;
 onOpenConversation?:(source:PlanConversationSource)=>void;
 session:ManualPlanSession;
 /** Mandatory host callback: it performs the shared aggregate navigation check once. */
 onClose:()=>void;
 confirmLeave?:(message:string)=>boolean;
 onNavigateMaterial?:LocalResearchSearchProps['onNavigate'];
 onOpenPdf?:LocalResearchSearchProps['onOpenPdf'];
};
const stateLabels:Record<ManualPlanState,string>={draft:'草稿',planned:'已计划','in-progress':'进行中',completed:'已完成',cancelled:'已取消'};
const transitions:Record<ManualPlanState,ManualPlanState[]>={draft:['planned','in-progress','completed','cancelled'],planned:['draft','in-progress','completed','cancelled'],'in-progress':['planned','completed','cancelled'],completed:[],cancelled:[]};
/** Original standalone owner-level manual editor, mounted only through the host-owned recovery wrapper. */
export function ManualPlanManager({session:s,onClose,confirmLeave=message=>window.confirm(message),onNavigateMaterial,onOpenPdf,initialMaterialReturn,onOpenConversation}:ManualPlanManagerProps){
 const [,render]=useReducer(x=>x+1,0);const [query,setQuery]=useState(String(s.filter.query??''));const [status,setStatus]=useState(s.filter.state??'');const [from,setFrom]=useState(s.filter.fromDate??'');const [to,setTo]=useState(s.filter.toDate??'');const [deleted,setDeleted]=useState(s.filter.includeDeleted??false);const [sort,setSort]=useState<'updatedAt'|'targetDate'>(s.filter.sort??'updatedAt');const [direction,setDirection]=useState<'asc'|'desc'>(s.filter.direction??'desc');
 useEffect(()=>{const stop=s.subscribe(render);s.attach();return()=>{stop();s.detach();};},[s]);

 const [materials,setMaterials]=useState<PlanMaterialReturn|null>(()=>initialMaterialReturn?.session===s&&initialMaterialReturn.record===s.editor?.record&&!s.pending&&!s.detailLoading&&!initialMaterialReturn.record.deletedAt?initialMaterialReturn:null);
 const e=s.editor,r=e?.record,busy=!!s.pending||s.detailLoading,terminal=r?.data.state==='completed'||r?.data.state==='cancelled',readonly=busy||!!r?.deletedAt||terminal,hasBasket=!!e?.materialBasket.length;
 const [viewer,setViewer]=useState<{session:ManualPlanSession;record:NonNullable<typeof r>;link:NonNullable<NonNullable<typeof r>['data']['sessionLink']>}|null>(null);
 const viewerOwner=useRef(viewer);
 const closeViewer=()=>{viewerOwner.current=null;setViewer(null);};
 useLayoutEffect(()=>{if(viewer&&(viewer.session!==s||viewer.record!==r||busy))closeViewer();},[s,r,busy]);
 useLayoutEffect(()=>()=>{viewerOwner.current=null;},[]);
 const viewerCurrent=()=>!!viewer&&viewerOwner.current===viewer&&viewer.session===s&&s.editor?.record===viewer.record&&!s.pending&&!s.detailLoading&&!viewer.record.deletedAt&&viewer.record.storeScope===viewer.link.scope&&JSON.stringify(viewer.record.data.sessionLink)===JSON.stringify(viewer.link);
 const openViewer=()=>{if(s.editor?.record!==r||s.pending||s.detailLoading||!r?.storeScope||r.deletedAt||!r.data.sessionLink||r.data.sessionLink.scope!==r.storeScope)return;const selection={session:s,record:r,link:Object.freeze({...r.data.sessionLink})};viewerOwner.current=selection;setViewer(selection);};
 const [association,setAssociation]=useState<{session:ManualPlanSession;record:NonNullable<typeof r>}|null>(null);
 useLayoutEffect(()=>{setAssociation(null);},[s,r,busy,e?.dirty,hasBasket]);
 const associationCurrent=!!association&&association.session===s&&association.record===r&&!busy&&!e?.dirty&&!hasBasket&&!r?.deletedAt&&!terminal&&!!r.storeScope;
 const [walkthrough,setWalkthrough]=useState<SimulatedPlanSummaryTarget|null>(null);
 const walkthroughOwner=useRef(walkthrough),notesInput=useRef<HTMLTextAreaElement>(null);
 const [summaryNotice,setSummaryNotice]=useState<Editor|null>(null);
 const closeWalkthrough=()=>{walkthroughOwner.current=null;setWalkthrough(null);};
 useLayoutEffect(()=>{if(walkthrough&&(walkthrough.session!==s||walkthrough.editor!==e||busy||e?.dirty))closeWalkthrough();},[s,e,busy,walkthrough]);
 useLayoutEffect(()=>()=>{walkthroughOwner.current=null;},[]);
 const walkthroughCurrent=!!walkthrough&&walkthroughOwner.current===walkthrough&&walkthrough.session===s&&walkthrough.editor===e&&walkthrough.record===r&&!busy&&!e?.dirty&&!r?.deletedAt;
 const materialOwner=useRef(materials);
 const changeMaterials=(value:typeof materials)=>{materialOwner.current=value;setMaterials(value);};
 useLayoutEffect(()=>{if(materials&&(materials.session!==s||materials.record!==r||busy))changeMaterials(null);},[s,r,busy]);
 useLayoutEffect(()=>{materialOwner.current=materials;return()=>{materialOwner.current=null;};},[materials]);
 const materialCurrent=()=>!!materials&&materialOwner.current===materials&&materials.session===s&&s.editor?.record===materials.record&&!!materials.record&&!materials.record.deletedAt&&!s.pending&&!s.detailLoading;
 return <section aria-label="手动计划">
 <header><h2>手动计划</h2><p>当前用户的独立计划。状态由用户手动标记，不代表自动执行进度。不包含 AI、提醒或调度；可明确关联一个已有普通会话。</p><button onClick={onClose}>关闭手动计划</button></header>
 <p>草稿恢复仅保存在当前用户会话的内存中：最多八份草稿（每份保留内容不超过 128 KiB，包含已加载计划及待添加资料）及一条结果未确定的操作。刷新页面、结束会话或切换身份可能丢失恢复信息。离开不会取消写入。</p>
 {s.pending&&<aside role="status"><p>{s.pending.phase==='uncertain'?'写入结果尚不确定，原操作标识及内容已完整保留。':s.pending.acknowledgedId?'确认回执是历史记录，必须重新读取当前数据。':'正在写入，暂时无法编辑；离开不会取消写入。'}</p>
 {s.pending.phase==='uncertain'&&<button onClick={()=>void s.retry()}>重试原操作</button>}
 {['readback','ready'].includes(s.pending.phase)&&<button onClick={()=>void s.reviewPending(confirmLeave)}>读取已确认计划的当前数据</button>}
 {s.pending.phase==='uncertain'&&<button onClick={()=>void s.reviewPending(confirmLeave)}>查看已保留的提交草稿</button>}</aside>}
 {s.error&&<p role="alert">{s.error}</p>}
 <form aria-label="计划筛选" onSubmit={event=>{event.preventDefault();s.changeFilter({query,...(status?{state:status as ManualPlanState}:{}),...(from?{fromDate:from}:{}),...(to?{toDate:to}:{}),includeDeleted:deleted,sort,direction},confirmLeave);}}>
 <label>搜索标题、目标或备注<input value={query} maxLength={600} onChange={x=>setQuery(x.target.value)}/></label>
 <label>手动状态<select value={status} onChange={x=>setStatus(x.target.value as ManualPlanState|'')}><option value="">全部状态</option>{MANUAL_PLAN_STATES.map(x=><option key={x} value={x}>{stateLabels[x]}</option>)}</select></label>
 <label>目标日期起始（含当天）<input type="date" value={from} min="1970-01-01" max="2100-12-31" onChange={x=>setFrom(x.target.value)}/></label>
 <label>目标日期截止（不含当天）<input type="date" value={to} min="1970-01-01" max="2100-12-31" onChange={x=>setTo(x.target.value)}/></label>
 <label><input type="checkbox" checked={deleted} onChange={x=>setDeleted(x.target.checked)}/>同时显示正常及回收站中的计划</label>
 <label>排序字段<select value={sort} onChange={x=>setSort(x.target.value as typeof sort)}><option value="updatedAt">最后更新</option><option value="targetDate">目标日期</option></select></label><label>排序方向<select value={direction} onChange={x=>setDirection(x.target.value as typeof direction)}><option value="desc">降序</option><option value="asc">升序</option></select></label><button>应用筛选</button></form>
 <button onClick={()=>s.newPlan(confirmLeave)}>新建手动计划</button><button disabled={s.loading} onClick={()=>void s.loadList()}>刷新列表</button>
 {s.loading?<p role="status">正在加载计划…</p>:s.listError?<p role="alert">{s.listError}</p>:s.page&&<div><p>{s.page.total} 个匹配计划。本页显示 {s.page.items.length} 条，起始偏移量为 {s.page.offset}。其他编辑可能导致分页结果变化。</p>{!s.page.items.length&&<p>没有匹配的计划。</p>}<ul>{s.page.items.map(row=><li key={row.id}><button onClick={()=>void s.open(row.id,confirmLeave)}>{row.data.title}</button> · {stateLabels[row.data.state]} · {row.deletedAt?'回收站中':'正常'} · 目标日期： {row.data.targetDate??'未设置'}</li>)}</ul><button disabled={!s.previous.length} onClick={()=>s.back(confirmLeave)}>上一页</button><button disabled={s.page.nextOffset===null} onClick={()=>s.next(confirmLeave)}>下一页</button></div>}
 {!!s.retainedKeys().length&&<nav aria-label="已保留的草稿">{s.retainedKeys().map(key=><button key={key} onClick={()=>key==='new'?s.newPlan(confirmLeave):void s.open(key,confirmLeave)}>恢复 {key==='new'?'新计划':key}</button>)}</nav>}
 {s.detailLoading&&<p role="status">正在读取当前计划…</p>}
 {e&&<article aria-label="计划编辑器"><h3>{r?'编辑手动计划':'新建手动计划'}</h3>{r&&<p>版本 {r.revision} · {stateLabels[r.data.state]} · {r.deletedAt?'回收站中':'正常'} · 用户编写的本地计划</p>}
 {terminal&&<p>已完成或已取消的计划需要明确重新打开后才能编辑。从回收站恢复不会重新打开计划。</p>}
 {r?.deletedAt&&<p>此计划已移入回收站。恢复后将保留原状态及目标日期。</p>}
 <form onSubmit={event=>{event.preventDefault();void s.mutate(r?'update':'create');}}>
 <label>标题<input required value={e.draft.title} disabled={readonly} maxLength={720} onChange={x=>s.edit('title',x.target.value)}/></label>
 <label>目标<textarea required value={e.draft.objective} disabled={readonly} maxLength={8000} onChange={x=>s.edit('objective',x.target.value)}/></label>
 <label>备注<textarea ref={notesInput} value={e.draft.notes} disabled={readonly} maxLength={8000} onChange={x=>s.edit('notes',x.target.value)}/></label>
 {summaryNotice===e&&<p role="status">模拟流程摘要已追加到备注草稿，原备注已保留，尚未保存。请核对后点击“保存计划”；这不是研究结论。</p>}
 <label>目标日期（仅日期）<input type="date" value={e.draft.targetDate??''} disabled={readonly} min="1970-01-01" max="2100-12-31" onChange={x=>s.edit('targetDate',x.target.value)}/></label>
 <p>目标日期仅表示日历日期，不是计划执行时间。</p><button disabled={readonly||!!r&&!e.dirty}>保存计划</button></form>
 {r&&e.dirty&&<details><summary>查看已加载的当前版本，比较差异</summary><p>标题: {r.data.title}</p><p>目标: {r.data.objective}</p><p>备注: {r.data.notes}</p><p>目标日期： {r.data.targetDate??'未设置'}</p><p>保存时使用此已加载版本。如果服务端随后发生变化，保存将报告冲突。</p></details>}
 <button disabled={busy||(!e.dirty&&!hasBasket)} onClick={()=>s.discard(confirmLeave)}>放弃草稿</button>{r&&<button disabled={busy} onClick={()=>void s.refreshCurrent(confirmLeave)}>读取当前版本并保留草稿</button>}
 {r&&!r.deletedAt&&!terminal&&transitions[r.data.state].map(value=><button key={value} disabled={busy||e.dirty||hasBasket} onClick={()=>void s.mutate('setState',value)}>标记为{stateLabels[value]}</button>)}
 {r&&!r.deletedAt&&terminal&&<button disabled={busy||e.dirty||hasBasket} onClick={()=>{if(confirmLeave('是否将这份已结束的计划重新打开为草稿，并保留原内容及日期？'))void s.mutate('reopen');}}>重新打开为草稿</button>}
 {r&&<button disabled={busy||e.dirty||hasBasket} onClick={()=>{if(confirmLeave(r.deletedAt?'是否恢复此计划，并保留原状态？':'是否将此计划移入回收站？其他记录不受影响。'))void s.mutate(r.deletedAt?'restore':'remove');}}>{r.deletedAt?'恢复计划':'移入回收站'}</button>}
 {r&&<section aria-label="计划会话关联">
 <p>{r.data.sessionLink?`已保存会话关联：${r.data.sessionLink.workspaceId} / ${r.data.sessionLink.sessionId}。保存的版本仅为关联时快照，每次查看会重新校验当前目标。`:'未保存会话关联。'}</p>
 <button disabled={readonly||e.dirty||hasBasket||!r.storeScope} aria-expanded={associationCurrent} onClick={()=>{if(!s.pending&&!s.detailLoading&&!s.editor?.dirty&&!s.editor?.materialBasket.length&&s.editor?.record===r)setAssociation({session:s,record:r});}}>管理计划会话关联</button>
 {r.data.sessionLink&&<button disabled={busy||!!r.deletedAt||!r.storeScope||r.data.sessionLink.scope!==r.storeScope} aria-expanded={viewerCurrent()} onClick={openViewer}>打开已关联会话（只读）</button>}
 {viewerCurrent()&&viewer&&<ManualPlanLinkedSession session={s} record={viewer.record} sessionLink={viewer.link} isCurrent={viewerCurrent} onClose={closeViewer} onOpenConversation={onOpenConversation}/>}
 {associationCurrent&&<ManualPlanSessionLink key={r.id+':'+r.revision} session={s} record={r} confirm={confirmLeave} onClose={()=>setAssociation(null)}/>}
 </section>}
 {r&&!r.deletedAt&&<ManualPlanMaterialCollection key={r.id+':'+r.revision} session={s} record={r} confirm={confirmLeave} onNavigate={onNavigateMaterial} onOpenPdf={onOpenPdf}/>}
 {r&&!r.deletedAt&&<section aria-label="计划流程演示入口">
 <button disabled={busy||e.dirty} aria-expanded={walkthroughCurrent} onClick={()=>{if(s.editor?.record!==r)return;const target=s.captureSimulatedSummaryTarget();if(target){walkthroughOwner.current=target;setWalkthrough(target);}}}>打开本地模拟研究流程</button>
 <p>需先保存或放弃当前草稿。仅演示问题、范围与输出澄清、清单审阅、独立批准、手动开始与流程结果；批准不会开始执行，不保存会话关联，不执行真实研究。完成后可将明确标注的模拟摘要追加到备注草稿，仍需另行保存计划。</p>
 {walkthroughCurrent&&walkthrough&&<LocalPlanWalkthrough plan={r} onExit={closeWalkthrough} onAppendSummary={inputs=>{if(walkthroughOwner.current!==walkthrough)return '模拟来源已失效，未追加或覆盖任何草稿。';const error=s.stageSimulatedSummary(walkthrough,inputs);if(error)return error;closeWalkthrough();setSummaryNotice(s.editor);notesInput.current?.focus();return null;}}/>}
 </section>}
 {r&&!r.deletedAt&&<section aria-label="计划资料检索">
 <button disabled={busy} aria-expanded={materialCurrent()} onClick={()=>changeMaterials(materialCurrent()?null:{session:s,record:r})}>{materialCurrent()?'收起计划资料检索':'为此计划查找本地资料'}</button>
 <p>查找或选择不会自动写入计划；可跨来源选择多份资料，再使用“添加所选资料”一次保存。集合最多 100 份，包含原有单份文档与转写快捷入口；只保存来源与记录 ID，打开时重新核对当前资料，不是冻结引用或资料归属证明，不自动执行研究。选择或保存资料前须保存或放弃文字草稿；打开资料时仍会检查未保存草稿。从检索结果打开后立即返回，可在当前身份和同一已加载计划版本内恢复该来源已提交的查询与页码；保存的快捷入口不恢复检索状态，刷新不保留。</p>
 {materialCurrent()&&<><h4>当前已保存计划：{r.data.title}</h4><p>请自行输入检索词；不会自动发送计划标题、目标或备注。</p><LocalResearchSearch stagedMaterials={e.materialBasket} savedMaterials={effectiveManualPlanLinks(r.data)} materialSelectionDisabled={readonly||e.dirty||!r.storeScope} onStageMaterial={link=>{if(materialCurrent())s.stageMaterial(link,r);}} onUnstageMaterial={link=>{if(materialCurrent())s.unstageMaterial(link,r);}} onSaveDocumentShortcut={link=>{if(!materialCurrent()||s.editor?.dirty||s.editor?.materialBasket.length||terminal||!r.storeScope)return;if(r.data.documentLink&&JSON.stringify(r.data.documentLink)!==JSON.stringify(link)&&!confirmLeave('是否替换此计划的文档快捷入口？原文档不会删除，转写快捷入口及会话关联保持不变。'))return;if(materialCurrent()&&!s.editor?.dirty&&!s.editor?.materialBasket.length)void s.mutate('setDocumentLink',undefined,{scope:r.storeScope,documentLink:link});}} documentShortcutDisabled={readonly||e.dirty||hasBasket||!r.storeScope} onSaveTranscriptShortcut={link=>{if(materialCurrent()&&!s.editor?.dirty&&!s.editor?.materialBasket.length&&!terminal&&r.storeScope)void s.mutate('setMaterialLink',undefined,{scope:r.storeScope,materialLink:link});}} transcriptShortcutDisabled={readonly||e.dirty||hasBasket||!r.storeScope} initialDocumentReturn={materials?.initialDocumentReturn} initialTranscriptReturn={materials?.initialTranscriptReturn} onNavigate={onNavigateMaterial?(url,context)=>{if(materialCurrent())onNavigateMaterial(url,context);}:undefined} onOpenPdf={onOpenPdf?(selection,context)=>{if(materialCurrent())onOpenPdf(selection,context);}:undefined}/></>}
 </section>}
 </article>}
 </section>;
}
