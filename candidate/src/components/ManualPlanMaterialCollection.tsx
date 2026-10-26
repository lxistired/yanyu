import {useLayoutEffect,useRef,useState} from 'react';
import {effectiveManualPlanLinks,MANUAL_PLAN_LIMITS,manualPlanSourceKey,type ManualPlanRecord,type ManualPlanSourceLink} from '../../shared/manual-plans';
import type {ManualPlanSession} from './manual-plan-session';
import type {LocalResearchSearchProps} from './LocalResearchSearch';
import {ManualPlanDocumentLink} from './ManualPlanDocumentLink';
import {ManualPlanMaterialLink} from './ManualPlanMaterialLink';
const identity=(link:ManualPlanSourceLink)=>link.kind==='document'?{type:'文档',source:link.documentStoreId,id:link.documentId}:{type:'转写',source:link.transcriptStoreId,id:link.jobId};
type Props={session:ManualPlanSession;record:ManualPlanRecord;confirm:(message:string)=>boolean;onNavigate?:LocalResearchSearchProps['onNavigate'];onOpenPdf?:LocalResearchSearchProps['onOpenPdf']};
/** A bounded pointer list, not retained previews. Only an explicitly expanded item reads its source. */
export function ManualPlanMaterialCollection({session,record,confirm,onNavigate,onOpenPdf}:Props) {
 const [expanded,setExpanded]=useState<string|null>(null),mounted=useRef(true);
 useLayoutEffect(()=>{mounted.current=true;setExpanded(null);return()=>{mounted.current=false;};},[session,record]);
 const current=()=>mounted.current&&session.editor?.record===record&&!session.pending&&!session.detailLoading&&!record.deletedAt;
 const writable=()=>current()&&!session.editor?.dirty&&!!record.storeScope&&!['completed','cancelled'].includes(record.data.state);
 const saved=effectiveManualPlanLinks(record.data),basket=session.editor?.record===record?session.editor.materialBasket:[];
 const total=new Set([...saved,...basket].map(manualPlanSourceKey)).size;
 const canRemove=()=>writable()&&!session.editor?.materialBasket.length;
 function remove(link:ManualPlanSourceLink){
  if(!canRemove()||!saved.some(value=>manualPlanSourceKey(value)===manualPlanSourceKey(link)))return;
  const item=identity(link);
  if(!confirm(`是否从此计划移除${item.type} ${item.id}（来源 ${item.source}）？仅移除此精确资料的全部入口表示，不会删除源资料，也不会更改其他资料或会话关联。`)||!canRemove())return;
  void session.mutate('removeMaterialLink',undefined,{scope:record.storeScope!,materialLink:link});
 }
 const toggle=(key:string)=>{if(current())setExpanded(value=>value===key?null:key);};
 return <section aria-label="计划资料集合">
 <h4>计划资料集合</h4><p>已保存 {saved.length} 份 · 待添加 {basket.length} 份 · 合计 {total} / {MANUAL_PLAN_LIMITS.materialLinks} 份。上限包含单份快捷入口，同一类型、来源和记录 ID 只计一次。</p>
 <p>只保存来源与记录 ID，不保存标题、预览或冻结版本。展开一份资料时才核验当前详情；不可用资料仍可明确移除，不会自动改指向其他来源。</p>
 {!saved.length&&<p>尚未保存资料。可在下方检索中选择多份文档或转写，再明确添加。</p>}
 <ul>{saved.map(link=>{const key=manualPlanSourceKey(link),item=identity(link),open=expanded===key;return <li key={key} aria-label={`已保存资料 ${link.kind} ${item.source} ${item.id}`}>
 <p>{item.type} · {item.id} · 来源：{item.source}</p><p>{open?'正在显示此资料的当前核验面板。':'当前详情尚未核验。'}</p>
 <button disabled={!current()} aria-expanded={open} onClick={()=>toggle(key)}>{open?'收起当前资料':'查看当前资料'}：{item.id}</button>
 <button disabled={!canRemove()} onClick={()=>remove(link)}>移除资料：{item.id}</button>
 {open&&(link.kind==='document'?<ManualPlanDocumentLink key={key} session={session} record={record} target={link} onRemove={remove} confirm={confirm} onOpenPdf={onOpenPdf}/>:<ManualPlanMaterialLink key={key} session={session} record={record} target={link} onRemove={remove} confirm={confirm} onNavigate={onNavigate}/>)}
 </li>;})}</ul>
 <section aria-label="待添加资料"><h5>待添加资料</h5><p>选择暂存在此计划的当前用户内存会话中，可跨查询、分页和来源标签保留。关闭后重新打开可继续；刷新或切换身份不保留。</p>
 {!basket.length?<p>尚未选择待添加资料。</p>:<ul>{basket.map(link=>{const item=identity(link);return <li key={manualPlanSourceKey(link)} aria-label={`待添加资料 ${link.kind} ${item.source} ${item.id}`}><span>{item.type} · {item.id} · 来源：{item.source}</span><button disabled={!current()} onClick={()=>{if(current())session.unstageMaterial(link,record);}}>取消选择资料：{item.id}</button></li>;})}</ul>}
 <button disabled={!basket.length||!writable()} onClick={()=>{if(writable())void session.saveMaterials();}}>添加所选 {basket.length} 份资料</button>
 <button disabled={!basket.length||!current()} onClick={()=>{if(current())session.clearMaterials(confirm);}}>清空待添加资料</button>
 {!!basket.length&&<p>待添加资料尚未保存。先保存或清空此选择，再更改状态、会话或已有资料入口。保存计划文字不会清空选择。</p>}
 </section>
 <section aria-label="单份快捷入口兼容管理"><p>原单份快捷入口仍可独立保存或清除。集合移除会清除该精确资料的所有入口表示；清除单份入口不会移除另行添加的集合资料。</p>
 <button disabled={!current()} aria-expanded={expanded==='legacy-transcript'} onClick={()=>toggle('legacy-transcript')}>管理单份转写快捷入口</button>
 <button disabled={!current()} aria-expanded={expanded==='legacy-document'} onClick={()=>toggle('legacy-document')}>管理单份文档快捷入口</button>
 {expanded==='legacy-transcript'&&<ManualPlanMaterialLink session={session} record={record} confirm={confirm} onNavigate={onNavigate}/>}
 {expanded==='legacy-document'&&<ManualPlanDocumentLink session={session} record={record} confirm={confirm} onOpenPdf={onOpenPdf}/>}
 </section>
 </section>;
}
