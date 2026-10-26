import {useEffect,useRef,useState} from 'react';
import type {ManualPlanRecord,ManualPlanSessionChoices} from '../../shared/manual-plans';
import type {ManualPlanSession} from './manual-plan-session';
/** Explicit local-only selection; retained commands and readback belong to the existing host session. */
export function ManualPlanSessionLink({session,record,onClose,confirm}:{session:ManualPlanSession;record:ManualPlanRecord;onClose:()=>void;confirm:(message:string)=>boolean}) {
 const [page,setPage]=useState<ManualPlanSessionChoices|null>(null),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const mounted=useRef(false),generation=useRef(0),scope=useRef(record.storeScope),activePage=useRef<ManualPlanSessionChoices|null>(null);
 const current=()=>mounted.current&&session.editor?.record===record&&!session.pending&&!session.detailLoading&&!session.editor.dirty&&!!scope.current&&!record.deletedAt&&!['completed','cancelled'].includes(record.data.state);
 async function load(workspaceId:string|null,offset=0){
  if(!current())return;const attempt=++generation.current;activePage.current=null;setPage(null);setSelected('');setBusy(true);setError('');
  try{const result=await session.client.sessionChoices({id:record.id,expectedRevision:record.revision,workspaceId,offset,scope:scope.current!});
   if(!current()||attempt!==generation.current)return;scope.current=result.scope;activePage.current=result;setPage(result);
  }catch{if(current()&&attempt===generation.current)setError('无法读取当前范围的关联选项。请重新读取计划并核对版本；不使用旧选项。');}
  finally{if(current()&&attempt===generation.current)setBusy(false);}
 }
 useEffect(()=>{mounted.current=true;void load(null);return()=>{mounted.current=false;generation.current++;activePage.current=null;};},[session,record]);
 const save=()=>{if(!current()||busy||!page?.workspace||activePage.current!==page)return;const chosen=page.items.find(x=>x.id===selected);if(!chosen)return;
  void session.mutate('setSessionLink',undefined,{scope:page.scope,sessionLink:{workspaceId:page.workspace.id,workspaceRevision:page.workspace.revision,sessionId:chosen.id,sessionRevision:chosen.revision}});
 };
 const clear=()=>{if(!current()||busy||!page||activePage.current!==page||!record.data.sessionLink||!confirm('是否清除此计划保存的会话关联？不会删除工作区、会话或消息。')||!current()||activePage.current!==page)return;
  void session.mutate('setSessionLink',undefined,{scope:page.scope,sessionLink:null});
 };
 return <section aria-label="计划会话关联选择">
 <p>本地独立测试支持：一次只关联一个已有普通会话，不执行研究、读取消息或调用模型。选择尚未保存，关闭后丢弃。</p>
 <button onClick={()=>{activePage.current=null;generation.current++;onClose();}}>关闭关联选择</button>
 {busy&&<p role="status">正在读取当前范围的选项…</p>}{error&&<p role="alert">{error}</p>}
 {page&&<>
 <p role="status">{page.currentLink.status==='none'?'当前未保存会话关联。':page.currentLink.status==='unavailable'?'已保存关联不可用：目标已删除、移动或存储范围已变化。可明确清除或重新选择。':page.currentLink.status==='stale'?`已保存关联的目标版本已变化：${page.currentLink.workspaceTitle} / ${page.currentLink.sessionTitle}。请重新选择并保存以核对最新版本。`:`已保存关联当前可用：${page.currentLink.workspaceTitle} / ${page.currentLink.sessionTitle}。`}</p>
 {page.workspace?<>
 <p>已选工作区：{page.workspace.title}（版本 {page.workspace.revision}）</p>
 <button onClick={()=>void load(null)}>重新选择工作区</button>
 <label>关联会话<select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">请明确选择会话</option>{page.items.map(x=><option key={x.id} value={x.id}>{x.title}（版本 {x.revision}）</option>)}</select></label>
 <button disabled={!selected} onClick={save}>保存会话关联</button>
 </>:<label>关联工作区<select value="" onChange={e=>{if(page.items.some(x=>x.id===e.target.value))void load(e.target.value);}}><option value="">请明确选择工作区</option>{page.items.map(x=><option key={x.id} value={x.id}>{x.title}</option>)}</select></label>}
 <p>本页 {page.items.length} 条，共 {page.total} 条当前可选记录。</p>
 <button disabled={page.offset===0} onClick={()=>void load(page.workspace?.id??null,Math.max(0,page.offset-25))}>关联选项上一页</button>
 <button disabled={page.nextOffset===null} onClick={()=>void load(page.workspace?.id??null,page.nextOffset!)}>关联选项下一页</button>
 <button disabled={!record.data.sessionLink} onClick={clear}>清除会话关联</button>
 </>}
 <button disabled={busy} onClick={()=>void load(null)}>刷新关联选项</button>
 </section>;
}
