import {useEffect,useRef,useState} from 'react';
import type {ManualPlanRecord,ManualPlanMaterialLink as TranscriptLink} from '../../shared/manual-plans';
import type {ManualPlanSession} from './manual-plan-session';
import type {LocalResearchSearchProps} from './LocalResearchSearch';
import {ExternalTranscriptionSource} from './external-transcription-source';
import {ResearchRequestOwner,transcriptPage,type ResearchJob} from './local-research-search';
import {transcriptUrl} from './TranscriptRelationships';
const labels={interrupted:'已中断',processing:'识别中',completed:'转写完成',cancelled:'已取消',failed:'转写失败'};
/** User-selected pointer only. Fresh source-bound metadata is not a frozen citation. */
export function ManualPlanMaterialLink({session,record,onNavigate,confirm,target,onRemove}:{session:ManualPlanSession;record:ManualPlanRecord;onNavigate?:LocalResearchSearchProps['onNavigate'];confirm:(message:string)=>boolean;target?:TranscriptLink;onRemove?:(link:TranscriptLink)=>void}) {
 const link=target??record.data.materialLink;
 const owner=useRef(new ResearchRequestOwner()),mounted=useRef(false),accepted=useRef<{item:ResearchJob;current:()=>boolean}|null>(null);
 const [item,setItem]=useState<ResearchJob|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const current=()=>mounted.current&&session.editor?.record===record&&!session.pending&&!session.detailLoading&&!record.deletedAt;
 const writable=()=>current()&&!session.editor?.dirty&&!session.editor?.materialBasket.length&&!!record.storeScope&&!['completed','cancelled'].includes(record.data.state);
 async function load(){
  if(!current()||!link)return;const request=owner.current.begin();accepted.current=null;setItem(null);setLoading(true);setError('');
  try{
   // Never silently bind a saved shortcut to a newly discovered source.
   const source=new ExternalTranscriptionSource(link.transcriptStoreId);
   const {data,transcriptStoreId}=await source.read(`/api/local-asr/jobs?${new URLSearchParams({jobId:link.jobId,scope:'active',offset:'0',limit:'10'})}`,request);
   if(!current()||!request.current())return;
   const page=transcriptPage(data,0,transcriptStoreId);
   if(page.total!==1||page.items.length!==1||page.items[0].id!==link.jobId)throw Error('Saved shortcut target unavailable');
   source.assertActive(link.transcriptStoreId);const selected=page.items[0];
   accepted.current={item:selected,current:()=>request.current()&&!source.blocked};setItem(selected);
  }catch{if(current()&&request.current())setError('已保存的转写快捷入口当前不可用：原来源无法核验、已变化，或目标已删除。不会改指向同名或同 ID 的其他来源；可重试核验或明确清除。');}
  finally{if(current()&&request.current())setLoading(false);}
 }
 useEffect(()=>{mounted.current=true;accepted.current=null;setItem(null);setLoading(false);setError('');void load();return()=>{mounted.current=false;owner.current.cancel();accepted.current=null;};},[session,record,link,!!session.pending,session.detailLoading]);
 const open=()=>{const active=accepted.current;if(!current()||!link||!active?.current()||active.item!==item||!onNavigate)return;
  // No invented search-return context: this is a persisted shortcut, not a search result.
  onNavigate(transcriptUrl({transcriptStoreId:link.transcriptStoreId,jobId:link.jobId}));
 };
 const clear=()=>{if(!link||!writable())return;if(onRemove){onRemove(link);return;}if(!confirm('是否清除此计划保存的转写快捷入口？不会删除转写，也不会更改文档快捷入口或会话关联。')||!writable())return;
  void session.mutate('setMaterialLink',undefined,{scope:record.storeScope!,materialLink:null});
 };
 return <section aria-label={target?"计划转写资料详情":"计划转写快捷入口"}><p>{target?"此资料只保存来源与任务 ID；以下详情是重新核验的当前转写，不是冻结引用或资料归属证明。":"单份转写快捷入口独立保存，只保存来源与任务 ID，不保存文字、标题或版本；打开的是当前转写，不是冻结引用或资料归属证明。清除单份入口不会移除资料集合中的其他表示。"}</p>
 {link?<><p>已保存转写快捷入口：{link.jobId} · 原来源：{link.transcriptStoreId}</p>
 {loading&&<p role="status">正在核验原来源的当前转写…</p>}{error&&<p role="alert">{error}</p>}
 {item&&<p>当前转写：{item.title} · {labels[item.status]}。内容与状态可能继续变化。</p>}
 <button disabled={!item||loading||!onNavigate||!current()} onClick={open}>打开已保存的当前转写</button>
 <button disabled={loading||!current()} onClick={()=>void load()}>重新核验转写快捷入口</button>
 <button disabled={!writable()} onClick={clear}>{onRemove?'从资料集合移除此转写':'清除转写快捷入口'}</button>
 </>:<p>未保存转写快捷入口。可在下方本地资料检索的转写结果中明确保存一个。</p>}
 </section>;
}
