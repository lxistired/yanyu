import {useEffect,useReducer} from 'react';
import type {ScheduleRecord,SkillView} from '../../shared/automation';
import {MANUAL_INVENTORY_PROTOCOL,type ManualInventorySelection} from '../../shared/manual-inventory-protocol';
import type {ManualInventorySession} from './manual-inventory-session';

export function manualInventoryEligibility(schedule:ScheduleRecord,skills:readonly SkillView[]):string {
 const skill=skills.find(s=>s.id===schedule.data.skillId);
 if(schedule.deletedAt||!schedule.data.enabled||schedule.data.state!=='active')return '任务须未删除、启用且处于活动状态';
 if(schedule.data.sourceIds.length!==0)return '资料范围须在此明确选择；任务的逻辑数据源列表必须为空';
 if(!skill||skill.deletedAt||!skill.data.enabled||skill.data.handler!=='local-document-inventory')return '须选择已启用的本地文档清单技能';
 return '';
}
const selectionLabel=(s:ManualInventorySelection)=>s.mode==='all'?'全部当前可访问的活动文档（包括未分配文档）':s.mode==='workspace'?`工作区：${s.workspaceId??'未分配工作区'}（所有文件夹）`:`文件夹：${s.folderId}；工作区：${s.workspaceId??'未分配工作区'}`;
/** Separate additive entry. Never enables generic runNow/retry, dispatch or scheduler. */
export function ManualInventoryPanel({session,schedules,skills,definitionsReady}:{session:ManualInventorySession;schedules:readonly ScheduleRecord[];skills:readonly SkillView[];definitionsReady:boolean}){
 const [,render]=useReducer(x=>x+1,0);
 useEffect(()=>session.subscribe(render),[session]);
 // Only identity discovery, never execute, replay, history or protected result access.
 useEffect(()=>{if(!session.capabilities)void session.discover();},[session]);
 const caps=session.capabilities;
 const schedule=schedules.find(s=>s.id===session.draft.scheduleId);
 const skill=skills.find(s=>s.id===schedule?.data.skillId);
 const eligibility=schedule?manualInventoryEligibility(schedule,skills):'请选择任务定义';
 const selections:{value:string;label:string;selection:ManualInventorySelection}[]=[
  {value:'all',label:'全部可访问活动文档（包含未分配文档）',selection:{mode:'all',workspaceId:null,folderId:null}},
  {value:'unassigned',label:'仅未分配工作区文档',selection:{mode:'workspace',workspaceId:null,folderId:null}},
  ...(session.choices?.workspaces.map(w=>({value:`workspace:${w.id}`,label:`工作区：${w.name}`,selection:{mode:'workspace' as const,workspaceId:w.id,folderId:null}}))??[]),
  ...(session.choices?.folders.map(f=>({value:`folder:${f.id}`,label:`文件夹：${f.name}（${f.workspaceId??'未分配工作区'}）`,selection:{mode:'folder' as const,workspaceId:f.workspaceId,folderId:f.id}}))??[]),
 ];
 const selected=selections.find(s=>JSON.stringify(s.selection)===JSON.stringify(session.draft.selection));
 const locked=session.busy||!!session.pending||session.recoveryBlocked;
 const previewCurrent=!!session.preview&&!!schedule&&!!skill&&definitionsReady&&!eligibility&&schedule.id===session.preview.scheduleId&&schedule.revision===session.preview.scheduleRevision&&skill.id===session.preview.skillId&&skill.revision===session.preview.skillRevision&&!!caps?.manualDocumentInventory.available&&caps.documentStoreScope===session.preview.documentStoreScope;
 const canPreview=!locked&&definitionsReady&&!eligibility&&!!skill&&!!session.draft.selection&&!!caps?.manualDocumentInventory.available&&!!caps.documentStoreScope;
 function preview(){if(!canPreview||!caps?.documentStoreScope||!schedule||!skill||!session.draft.selection)return;void session.prepare({protocol:MANUAL_INVENTORY_PROTOCOL,identityScope:caps.identityScope,automationStoreScope:caps.automationStoreScope,documentStoreScope:caps.documentStoreScope,scheduleId:schedule.id,scheduleRevision:schedule.revision,skillId:skill.id,skillRevision:skill.revision,selection:session.draft.selection});}
 if(session.authorityInvalid)return <section aria-label="手动清单身份已变化"><p role="alert">{session.message} 原操作不会自动取消或重新执行。</p></section>;
 return <section aria-label="手动本地文档清单" className="manual-inventory-panel">
  <h2>手动本地文档清单</h2>
  <p>仅按明确选择的范围保存文档元数据，不读取正文、不执行指令、不调用 AI、不发送通知；不会启用调度器或修改任务时间。</p>
  <p>历史结果不是实时目录；其中哈希是已存上传元数据，不代表本次重新验证文件内容。最多 250 份文档、256 KiB 结果。</p>
  <p>恢复信息仅保留在当前浏览器标签会话，不保证关闭浏览器后恢复，也不保证跨标签去重。记录缺失时请先查看历史，勿直接重复新建。</p>
  <button type="button" disabled={session.busy} onClick={()=>void session.discover()}>读取身份与能力 / 发现原操作</button>
  {caps&&!caps.manualDocumentInventory.available&&<p role="status">当前文档来源不可用；仍可查询原操作回执及历史。结果访问将单独检查。</p>}
  {session.message&&<p role="status">{session.message}</p>}
  {session.recoveryBlocked&&<p role="alert">恢复记录或身份无法验证，已阻止新建与重试。可先查看历史；不会自动清除原记录。</p>}
  {session.pending&&<section aria-label="原操作回执">
   <h3>原操作 {session.pending.envelope.operationId}</h3>
   <p>此处只确认提交结果，不自动读取文档信息。离开或断开连接不会取消服务器操作。</p>
   {!session.proof&&<><p>状态未确定，禁止另外新建。查询未找到也不代表不会提交。</p>
    <button type="button" disabled={session.busy||session.recoveryBlocked} onClick={()=>void session.lookup()}>查询原操作回执</button>
    <button type="button" disabled={session.busy||session.recoveryBlocked} onClick={()=>void session.retryOriginal()}>明确重试原封包（同一操作标识）</button>
   </>}
   {session.proof?.state==='committed'&&<><p>已提交 · {session.proof.committedAt} · 运行 {session.proof.runId}</p><button type="button" disabled={session.busy} onClick={()=>{if(session.proof?.state==='committed')void session.openResult(session.proof.runId,session.proof.resultId);}}>验证权限并查看已保存清单</button></>}
   {session.proof?.state==='rejected'&&<p>已明确拒绝，未创建清单：{session.proof.code}</p>}
   {session.proof&&<button type="button" disabled={session.busy||session.recoveryBlocked} onClick={()=>{try{session.beginNew();}catch(e){session.message=e instanceof Error?e.message:'原记录无法清除';render();}}}>结束本次核对，准备新的独立运行</button>}
  </section>}
  <fieldset disabled={locked}>
   <legend>新运行的范围预览（不会保存清单）</legend>
   <label>任务定义<select value={session.draft.scheduleId} onChange={e=>session.setDraft(e.target.value,session.draft.selection)}><option value="">明确选择任务</option>{schedules.filter(s=>!s.deletedAt).map(s=><option key={s.id} value={s.id}>{s.data.name} · r{s.revision}</option>)}</select></label>
   <p>{eligibility||'该定义可用于专用手动清单；服务器还会核对修订和范围。'}</p>
   {!definitionsReady&&<p role="alert">定义列表尚未完整读取，不能预览新运行。</p>}
   <button type="button" disabled={!caps?.manualDocumentInventory.available} onClick={()=>void session.loadChoices()}>读取当前授权的工作区与文件夹选项</button>
   {session.choicesError&&<p role="alert">{session.choicesError}</p>}
   <label>文档范围<select value={selected?.value??''} onChange={e=>session.setDraft(session.draft.scheduleId,selections.find(s=>s.value===e.target.value)?.selection??null)}><option value="">必须明确选择范围</option>{selections.map(s=><option key={s.value} value={s.value}>{s.label}</option>)}</select></label>
   {session.draft.selection&&!selected&&<p role="status">保留的范围：{selectionLabel(session.draft.selection)}。刷新选项未替换该范围。</p>}
   <button type="button" disabled={!canPreview} onClick={preview}>预览选定范围</button>
   {session.preview&&<section aria-label="固定范围预览"><h3>请核对后明确执行</h3><p>{selectionLabel(session.preview.selection)}</p><p>任务 {session.preview.scheduleId} r{session.preview.scheduleRevision}；技能 {session.preview.skillId} r{session.preview.skillRevision}</p><p>{session.preview.count} 份文档 · {session.preview.totalBytes} 字节 · 观察时间 {session.preview.observedAt}</p><p>清单摘要 {session.preview.inventoryDigest}。若提交前有变化，将拒绝本次原请求，不会自动换成新范围。</p><button type="button" disabled={!previewCurrent} onClick={()=>void session.executePreview()}>确认保存一次清单</button></section>}
   {(session.preview||session.draft.scheduleId||session.draft.selection)&&<button type="button" onClick={()=>session.cancelPreview()}>放弃未发送的预览</button>}
  </fieldset>
  <section aria-label="专用手动清单历史"><h3>已提交历史（与结果访问分开）</h3>
   <button type="button" disabled={session.busy||!caps} onClick={()=>void session.loadHistory()}>查看 / 刷新历史首页</button>
   {session.historyError&&<p role="alert">历史读取不可用：{session.historyError}。这不是执行失败。</p>}
   {session.history&&<><ul>{session.history.items.map(i=><li key={i.runId}>已提交 · {i.completedAt} · 任务 {i.scheduleId} r{i.scheduleRevision} · 运行 {i.runId} · 结果权限未检查 <button type="button" disabled={session.busy} onClick={()=>void session.openResult(i.runId,i.resultId)}>验证权限并查看历史清单</button></li>)}</ul>{session.history.items.length===0&&<p>本页没有已保存的手动清单。</p>}{session.history.nextCursor&&<button type="button" disabled={session.busy} onClick={()=>void session.loadHistory(session.history!.nextCursor)}>下一页历史</button>}</>}
  </section>
  {(session.resultTarget||session.result)&&<section aria-label="受保护的历史结果"><h3>历史结果访问</h3>
   {session.resultLoading&&<p role="status">正在读取历史清单；可关闭此视图，不会取消执行。</p>}
   {session.resultError&&<p role="alert">{session.resultError} 执行回执和已提交历史不变。</p>}
   {session.resultTarget&&!session.result&&<button type="button" disabled={session.busy} onClick={()=>{const t=session.resultTarget;if(t)void session.openResult(t.runId,t.resultId);}}>只重试结果读取（不重新执行）</button>}
   {session.result&&<><p>固定历史清单 · 观察于 {session.result.observedAt} · 保存于 {session.result.completedAt} · {session.result.count} 份 / {session.result.totalBytes} 字节</p><p>{selectionLabel(session.result.binding.selection)}</p><ul>{session.result.documents.map(d=><li key={d.id}>{d.name} · {d.format} · {d.bytes} 字节 · 修订 {d.revision} · 文档 {d.id}<details><summary>保存时的元数据</summary><p>创建时间 {d.createdAt}；页数 {d.pages??"不适用"}；工作区 {d.workspaceId??"未分配"}；文件夹 {d.folderId??"未分配"}</p><p>已存文件哈希：{d.sha256}</p><p>已存提取文本哈希：{d.textSha256}（不读取或展示正文）</p></details></li>)}</ul></>}
   <button type="button" disabled={!session.canCloseResult} onClick={()=>session.closeResult()}>关闭历史结果视图（不取消执行）</button>
  </section>}
 </section>;
}
