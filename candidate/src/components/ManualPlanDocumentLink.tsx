import {useEffect,useRef,useState} from 'react';
import type {ManualPlanRecord,ManualPlanDocumentLink as DocumentLink} from '../../shared/manual-plans';
import type {ManualPlanSession} from './manual-plan-session';
import type {LocalResearchSearchProps} from './LocalResearchSearch';
import {documentScope,ResearchRequestOwner,savedDocumentPreview} from './local-research-search';
const unavailable='已保存的文档快捷入口当前不可用：原来源无法核验、已变化，或目标已删除、关联失效。不会改指向同名或同 ID 的其他来源；可重试核验或明确清除。';
type Preview=ReturnType<typeof savedDocumentPreview>;
/** Current display data lives only in this mounted panel, never in the stored pointer. */
export function ManualPlanDocumentLink({session,record,onOpenPdf,confirm,target,onRemove}:{session:ManualPlanSession;record:ManualPlanRecord;onOpenPdf?:LocalResearchSearchProps['onOpenPdf'];confirm:(message:string)=>boolean;target?:DocumentLink;onRemove?:(link:DocumentLink)=>void}) {
 const link=target??record.data.documentLink;
 const owner=useRef(new ResearchRequestOwner()),mounted=useRef(false),accepted=useRef<{preview:Preview;current:()=>boolean}|null>(null);
 const [preview,setPreview]=useState<Preview|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const current=()=>mounted.current&&session.editor?.record===record&&!session.pending&&!session.detailLoading&&!record.deletedAt;
 const writable=()=>current()&&!session.editor?.dirty&&!session.editor?.materialBasket.length&&!!record.storeScope&&!['completed','cancelled'].includes(record.data.state);
 async function load(){
  if(!current()||!link)return;
  const request=owner.current.begin();accepted.current=null;setPreview(null);setLoading(true);setError('');
  const owns=()=>current()&&request.current();
  // Bound both header and body waits. Expiry withdraws the generation even if transport ignores abort.
  const timeout=setTimeout(()=>{if(owns()){owner.current.cancel();accepted.current=null;setPreview(null);setLoading(false);setError(unavailable+' 核验已超时。');}},15000);
  const stopTimeout=()=>clearTimeout(timeout);request.signal.addEventListener('abort',stopTimeout,{once:true});
  const get=async(url:string,headers?:Record<string,string>)=>{
   const response=await fetch(url,{method:'GET',signal:request.signal,headers,credentials:'same-origin',redirect:'error',cache:'no-store'});
   if(!owns()||!response.ok){try{void response.body?.cancel().catch(()=>{});}catch{}throw Error('unavailable');}
   const reader=response.body?.getReader();if(!reader)throw Error('empty');
   const cancel=()=>{void reader.cancel().catch(()=>{});};request.signal.addEventListener('abort',cancel,{once:true});
   const chunks:Uint8Array[]=[];let size=0;
   try{while(true){const part=await reader.read();if(!owns())throw Error('withdrawn');if(part.done)break;size+=part.value.byteLength;if(size>2*1024*1024)throw Error('oversized');chunks.push(part.value);}}
   catch(error){cancel();throw error;}finally{request.signal.removeEventListener('abort',cancel);reader.releaseLock();}
   const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
   const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!owns())throw Error('withdrawn');return value;
  };
  try{
   if(documentScope(await get('/api/documents/choices'))!==link.documentStoreId)throw Error('changed source');
   const data=await get(`/api/documents/${link.documentId}`,{'X-Citation-Store-Id':link.documentStoreId});
   if(!owns())return;const next=savedDocumentPreview(data,link.documentStoreId,link.documentId);
   accepted.current={preview:next,current:owns};setPreview(next);
  }catch{if(owns())setError(unavailable);}
  finally{clearTimeout(timeout);request.signal.removeEventListener('abort',stopTimeout);if(owns())setLoading(false);}
 }
 useEffect(()=>{mounted.current=true;accepted.current=null;setPreview(null);setLoading(false);setError('');void load();return()=>{mounted.current=false;owner.current.cancel();accepted.current=null;};},[session,record,link,!!session.pending,session.detailLoading]);
 const open=()=>{const active=accepted.current;if(!current()||!active?.current()||active.preview!==preview||!preview.pdfOpen||!onOpenPdf)return;
  // No fabricated search-return DTO. Shell guard and second fresh admission remain mandatory.
  onOpenPdf(preview.pdfOpen);
 };
 const clear=()=>{if(!link||!writable())return;if(onRemove){onRemove(link);return;}if(!confirm('是否清除此计划保存的文档快捷入口？不会删除文档，转写快捷入口及会话关联保持不变。')||!writable())return;
  owner.current.cancel();accepted.current=null;setPreview(null);void session.mutate('setDocumentLink',undefined,{scope:record.storeScope!,documentLink:null});
 };
 return <section aria-label={target?"计划文档资料详情":"计划文档快捷入口"}><p>{target?"此资料只保存来源与文档 ID；以下详情是重新核验的当前资料，不是冻结引用、PDF 阅读权限或资料归属证明。":"单份文档快捷入口独立保存，只保存来源与文档 ID；重新打开时核对当前资料。不是冻结引用、PDF 阅读权限或资料归属证明。清除单份入口不会移除资料集合中的其他表示。"}</p>
 {link?<><p>已保存文档快捷入口：{link.documentId} · 原来源：{link.documentStoreId}</p>
 {loading&&<p role="status">正在核验原来源的当前文档…</p>}{error&&<p role="alert">{error}</p>}
 {preview&&<article aria-label="文档提取文字"><h3>{preview.item.name}</h3><p>当前 {preview.item.format} 提取文字预览，不是冻结引用或事实核验。</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'28rem',overflow:'auto'}}>{preview.text}</pre></article>}
 {preview?.item.format==='pdf'&&<button disabled={!preview.pdfOpen||loading||!onOpenPdf||!current()} onClick={open}>打开已保存的当前 PDF</button>}
 <button disabled={loading||!current()} onClick={()=>void load()}>重新核验文档快捷入口</button>
 <button disabled={!writable()} onClick={clear}>{onRemove?'从资料集合移除此文档':'清除文档快捷入口'}</button>
 </>:<p>未保存文档快捷入口。可在下方本地资料检索的文档结果中明确保存一个，不会替换转写快捷入口。</p>}
 </section>;
}
