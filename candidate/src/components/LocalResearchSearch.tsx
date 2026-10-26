import {MANUAL_PLAN_LIMITS,manualPlanSourceKey,type ManualPlanMaterialLink,type ManualPlanDocumentLink,type ManualPlanSourceLink} from '../../shared/manual-plans';
import {PDF_OPEN_UNAVAILABLE_REASON, type PdfOpenSelection} from './pdf-open-selection';
import {ExternalTranscriptionSource} from './external-transcription-source';
import {useEffect, useRef, useState} from 'react';
import {transcriptUrl} from './TranscriptRelationships';
import {researchTranscriptReturn, type ResearchTranscriptReturn, researchDocumentReturn, type ResearchDocumentReturn, documentPage, documentPreview, documentScope, researchGet, ResearchRequestOwner, ResearchScopeChanged, recoveryOffset, transcriptPage, validateResearchQuery, type ResearchDocument, type ResearchJob, type ResearchPage} from './local-research-search';

export type LocalResearchSearchProps = {
 /** Shell must perform its shared owned-history/unsaved-work guard before navigating.
  * This component never writes history. No document-ID route is invented. */
 onNavigate?: (url: string, context?:ResearchTranscriptReturn) => void;
 initialTranscriptReturn?:ResearchTranscriptReturn|null;
 onOpenPdf?: (selection:PdfOpenSelection, context?:ResearchDocumentReturn)=>void;
 initialDocumentReturn?:ResearchDocumentReturn|null;
 /** Only supplied by the manual plan panel. No implicit plan or transcript write. */
 onSaveTranscriptShortcut?: (link:ManualPlanMaterialLink)=>void;
 transcriptShortcutDisabled?:boolean;
 onSaveDocumentShortcut?: (link:ManualPlanDocumentLink)=>void;
 documentShortcutDisabled?:boolean;
 /** Plan-owned, pointer-only selection. Omit these callbacks for read-only standalone search. */
 onStageMaterial?: (link:ManualPlanSourceLink)=>void;
 onUnstageMaterial?: (link:ManualPlanSourceLink)=>void;
 stagedMaterials?:readonly ManualPlanSourceLink[];
 savedMaterials?:readonly ManualPlanSourceLink[];
 materialSelectionDisabled?:boolean;
};
type MaterialSelectionProps=Pick<LocalResearchSearchProps,'onStageMaterial'|'onUnstageMaterial'|'stagedMaterials'|'savedMaterials'|'materialSelectionDisabled'>;
function MaterialSelectionButton({link,label,selection,accept}:{link:ManualPlanSourceLink;label:string;selection:MaterialSelectionProps;accept:()=>boolean}) {
 if(!selection.onStageMaterial)return null;
 const key=manualPlanSourceKey(link),staged=!!selection.stagedMaterials?.some(value=>manualPlanSourceKey(value)===key),saved=!!selection.savedMaterials?.some(value=>manualPlanSourceKey(value)===key);
 const count=new Set([...(selection.stagedMaterials??[]),...(selection.savedMaterials??[])].map(manualPlanSourceKey)).size;
 const disabled=selection.materialSelectionDisabled||saved||(!staged&&count>=MANUAL_PLAN_LIMITS.materialLinks)||(staged&&!selection.onUnstageMaterial);
 return <button disabled={disabled} aria-pressed={saved||staged} onClick={()=>{if(disabled||!accept())return;if(staged)selection.onUnstageMaterial?.(link);else selection.onStageMaterial?.(link);}}>{saved?'已保存':staged?'取消选择':'选择'}{link.kind==='document'?'文档':'转写'}：{label}</button>;
}
type Source = 'documents'|'transcripts';
const errorText = (error: unknown) => error instanceof Error ? error.message : '本地来源暂不可用，请重试';
const labels = {interrupted:'已中断', processing:'识别中', completed:'转写完成', cancelled:'已取消', failed:'转写失败'};
function useQuery(source: Source, initial?:ResearchDocumentReturn|ResearchTranscriptReturn|null) {
 const [draft,setDraft] = useState(initial?.query??''), [query,setQuery] = useState(initial?.query??''), [offset,setOffset] = useState(initial?.offset??0), [revision,setRevision] = useState(0), [inputError,setInputError] = useState('');
 return {draft,setDraft,query,offset,setOffset,revision,inputError, refresh:()=>setRevision(n=>n+1), submit:()=>{try {validateResearchQuery(draft,source);setInputError('');setQuery(draft);setOffset(0);setRevision(n=>n+1);} catch(error) {setInputError(errorText(error));}}};
}
function SearchForm({state,label}: {state:ReturnType<typeof useQuery>;label:string}) {
 return <form onSubmit={event=>{event.preventDefault();state.submit();}}><label>{label}查询 <input aria-label={`${label}查询`} value={state.draft} onChange={event=>state.setDraft(event.target.value)} maxLength={512}/></label> <button type="submit">搜索{label}</button>{state.inputError && <p role="alert">{state.inputError}</p>}</form>;
}
function Pagination({total,offset,maximum,onPage}: {total:number;offset:number;maximum:number;onPage:(offset:number)=>void}) {
 return <nav aria-label="结果分页"><button disabled={offset===0} onClick={()=>onPage(Math.max(0,offset-10))}>上一页</button> <span>第 {offset/10+1} 页</span> <button disabled={offset+10>=total || offset+10>maximum} onClick={()=>onPage(offset+10)}>下一页</button>{total>maximum+10 && <p>接口最多浏览前 {maximum+10} 条，请缩小查询范围。</p>}</nav>;
}
function Documents({active,onOpenPdf,withdraw,initialDocumentReturn,onSaveDocumentShortcut,documentShortcutDisabled,selection}: Pick<LocalResearchSearchProps,'initialDocumentReturn'|'onOpenPdf'|'onSaveDocumentShortcut'|'documentShortcutDisabled'>&{active:boolean;withdraw:{current:()=>void};selection:MaterialSelectionProps}) {
 const initial=useRef(researchDocumentReturn(initialDocumentReturn));
 const state = useQuery('documents',initial.current), owner = useRef(new ResearchRequestOwner()), detailOwner = useRef(new ResearchRequestOwner()), scope = useRef<string|null>(null), blocked = useRef(false);
 const accepted=useRef<{page:ResearchPage<ResearchDocument>;current:()=>boolean}|null>(null);
 withdraw.current=()=>{owner.current.cancel();detailOwner.current.cancel();accepted.current=null;};
 const activeNow=useRef(active);activeNow.current=active;
 const [page,setPage] = useState<ResearchPage<ResearchDocument>|null>(null), [loading,setLoading] = useState(false), [error,setError] = useState(''), [needsReload,setNeedsReload] = useState(false);
 const [preview,setPreview] = useState<ReturnType<typeof documentPreview>|null>(null), [detailLoading,setDetailLoading] = useState(false), [detailError,setDetailError] = useState('');
 function clearDetail() { detailOwner.current.cancel();setPreview(null);setDetailError('');setDetailLoading(false); }
 function invalidateScope() {owner.current.cancel();clearDetail();scope.current=null;blocked.current=true;setNeedsReload(true);setPage(null);setLoading(false);setError(new ResearchScopeChanged().message);}
 useEffect(()=>{
  const request = owner.current.begin(); clearDetail();setPage(null);setError(blocked.current ? new ResearchScopeChanged().message : '');setLoading(false);
  if (!active || blocked.current) return ()=>owner.current.cancel();
  setLoading(true);
  void (async()=>{
   try {
    let capturedScope = scope.current;
    if (!capturedScope) {const data=await researchGet('/api/documents/choices',request.signal);if(!request.current())return;capturedScope=documentScope(data);if(initial.current&&capturedScope!==initial.current.documentStoreId)throw new ResearchScopeChanged();initial.current=null;scope.current=capturedScope;}
    const data=await researchGet(`/api/documents?${new URLSearchParams({q:state.query,view:'active',offset:String(state.offset),limit:'10'})}`,request.signal,{'X-Document-Store-Id':capturedScope});
    if(!request.current())return;
    const next=documentPage(data,capturedScope,state.offset), recovered=recoveryOffset(next.total,state.offset,250);
    if(recovered!==state.offset){state.setOffset(recovered);return;} accepted.current={page:next,current:request.current};setPage(next);
   } catch(error) {if(request.current()){if(error instanceof ResearchScopeChanged)invalidateScope();else setError(errorText(error));}}
   finally {if(request.current())setLoading(false);}
  })();
  return ()=>{owner.current.cancel();detailOwner.current.cancel();};
 },[active,state.query,state.offset,state.revision]);
 async function open(item:ResearchDocument) {
  const capturedScope=scope.current;if(!capturedScope||blocked.current||!active)return;
  const request=detailOwner.current.begin();setPreview(null);setDetailError('');setDetailLoading(true);
  try {const data=await researchGet(`/api/documents/${item.id}`,request.signal,{'X-Citation-Store-Id':capturedScope});if(request.current())setPreview(documentPreview(data,capturedScope,item.id));}
  catch(error){if(request.current()){if(error instanceof ResearchScopeChanged)invalidateScope();else setDetailError(errorText(error));}}
  finally{if(request.current())setDetailLoading(false);}
 }
 return <section hidden={!active} aria-label="本地文档搜索"><p>仅搜索未删除的本地 TXT、Markdown、PDF 文件名和提取文字；不包含 OCR、批注或外部资料。</p><SearchForm state={{...state,submit:()=>{try{validateResearchQuery(state.draft,'documents');}catch{state.submit();return;}owner.current.cancel();setPage(null);state.submit();}}} label="文档"/>
 <button onClick={()=>{owner.current.cancel();clearDetail();scope.current=null;initial.current=null;blocked.current=false;setNeedsReload(false);setPage(null);state.refresh();}}>重新载入文档来源</button>
 {loading&&<p role="status">正在读取文档…</p>}{error&&<p role="alert">{error}</p>}{!loading&&error&&!needsReload&&<button onClick={()=>{owner.current.cancel();setPage(null);state.refresh();}}>重试文档查询</button>}
 {page&&<><p>文档匹配：{page.total} 条（查询：{state.query||'全部'}）。按本地入库时间倒序，非相关性排名。</p>{page.total===0&&<p>没有匹配的文档。</p>}<ul>{page.items.map(item=><li key={item.id}><button onClick={()=>void open(item)}>{item.name}</button> <span>{item.format} · 本地入库 {item.createdAt}</span>{item.format==='pdf'&&<><button disabled={!item.pdfOpen||!onOpenPdf} onClick={()=>{const current=accepted.current;if(item.pdfOpen&&onOpenPdf&&activeNow.current&&!blocked.current&&current?.current()&&current.page.items.includes(item)&&scope.current===item.pdfOpen.storeScope)onOpenPdf(item.pdfOpen,{documentStoreId:item.pdfOpen.storeScope,query:state.query,offset:current.page.offset});}}>打开 PDF：{item.name}</button>{!item.pdfOpen&&<span>{PDF_OPEN_UNAVAILABLE_REASON}</span>}</>}{onSaveDocumentShortcut&&<button disabled={documentShortcutDisabled} onClick={()=>{const current=accepted.current,capturedScope=scope.current;if(documentShortcutDisabled||!activeNow.current||blocked.current||!capturedScope||!current?.current()||!current.page.items.includes(item))return;onSaveDocumentShortcut({kind:'document',documentStoreId:capturedScope,documentId:item.id});}}>保存此文档快捷入口：{item.name}</button>}{scope.current&&<MaterialSelectionButton link={{kind:'document',documentStoreId:scope.current,documentId:item.id}} label={item.name} selection={selection} accept={()=>{const current=accepted.current;return activeNow.current&&!blocked.current&&!!scope.current&&!!current?.current()&&current.page===page&&current.page.items.includes(item);}}/>}</li>)}</ul><Pagination total={page.total} offset={page.offset} maximum={250} onPage={offset=>{owner.current.cancel();setPage(null);state.setOffset(offset);}}/></>}
 {detailLoading&&<p role="status">正在读取提取文字…</p>}{detailError&&<p role="alert">{detailError}</p>}{(preview||detailLoading||detailError)&&<button onClick={clearDetail}>关闭文字预览</button>}{preview&&<article aria-label="文档提取文字"><h3>{preview.item.name}</h3><p>文档 ID：{preview.item.id} · 来源：{scope.current}</p><p>仅提取文字预览，不是 PDF 阅读器或事实核验。</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'28rem',overflow:'auto'}}>{preview.text}</pre></article>}
 </section>;
}
function Transcripts({active,onNavigate,initialTranscriptReturn,onSaveTranscriptShortcut,transcriptShortcutDisabled,withdraw,selection}: Pick<LocalResearchSearchProps,'onNavigate'|'initialTranscriptReturn'|'onSaveTranscriptShortcut'|'transcriptShortcutDisabled'> & {active:boolean;withdraw:{current:()=>void};selection:MaterialSelectionProps}) {
 const initial=useRef(researchTranscriptReturn(initialTranscriptReturn)).current;
 const state=useQuery('transcripts',initial),owner=useRef(new ResearchRequestOwner()),source=useRef(new ExternalTranscriptionSource(initial?.transcriptStoreId??null));
 const accepted=useRef<{page:ResearchPage<ResearchJob>;current:()=>boolean}|null>(null),activeNow=useRef(active);activeNow.current=active;
 withdraw.current=()=>{owner.current.cancel();accepted.current=null;};
 const current=(item:ResearchJob)=>activeNow.current&&!source.current.blocked&&!!accepted.current?.current()&&accepted.current.page.items.includes(item);
 const [page,setPage]=useState<ResearchPage<ResearchJob>|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  const request=owner.current.begin();setPage(null);setError(source.current.blocked?'转写来源无法核验或已变化，请明确重新载入转写来源。':'');setLoading(false);
  if(!active || source.current.blocked)return ()=>owner.current.cancel();setLoading(true);
  void(async()=>{try{
   const captured=source.current;const {data,transcriptStoreId}=await captured.read(`/api/local-asr/jobs?${new URLSearchParams({q:state.query,scope:'active',offset:String(state.offset),limit:'10'})}`,request);
   if(!request.current())return;const next=transcriptPage(data,state.offset,transcriptStoreId),recovered=recoveryOffset(next.total,state.offset,1000);
   if(recovered!==state.offset){state.setOffset(recovered);return;}captured.assertActive(transcriptStoreId);accepted.current={page:next,current:request.current};setPage(next);
  }catch(error){if(request.current())setError(errorText(error));}finally{if(request.current())setLoading(false);}})();
  return ()=>owner.current.cancel();
 },[active,state.query,state.offset,state.revision]);
 return <section hidden={!active} aria-label="本地转写搜索"><p>仅搜索未删除的本地转写：标题、原文件名、完整原始转写及当前校订文字。无需启动模型；不进行推理。</p><p>预览仅显示最多 4096 字符的原始转写；仅校订文字或预览以外的匹配可能不可见。结果及固定链接绑定首次读取的转写来源，但不是跨请求快照；旧无来源链接不能证明历史来源。</p><SearchForm state={{...state,submit:()=>{try{validateResearchQuery(state.draft,'transcripts');}catch{state.submit();return;}owner.current.cancel();setPage(null);state.submit();}}} label="转写"/><button disabled={source.current.blocked} onClick={()=>{owner.current.cancel();setPage(null);state.refresh();}}>刷新转写结果</button><button onClick={()=>{owner.current.cancel();source.current=new ExternalTranscriptionSource();setPage(null);state.setOffset(0);state.refresh();}}>重新载入转写来源</button>
 {loading&&<p role="status">正在读取转写…</p>}{error&&<p role="alert">{error}</p>}{page&&<><p>转写匹配：{page.total} 条（查询：{state.query||'全部'}）。按本地创建时间倒序，非相关性排名。</p>{page.total===0&&<p>没有匹配的转写。</p>}<ul>{page.items.map(item=><li key={item.id}><h3>{item.title}</h3><p>{item.filename} · {labels[item.status]} · 本地创建 {item.created}</p><p>任务 ID：{item.id}</p>{item.preview!==null?<><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{item.preview}</pre>{item.truncated&&<p>原始文字预览已截断。</p>}</>:<p>暂无原始转写预览。</p>}{onNavigate?<a href={transcriptUrl({transcriptStoreId:item.transcriptStoreId,jobId:item.id})} onClick={event=>{event.preventDefault();if(!current(item))return;source.current.assertActive(item.transcriptStoreId);onNavigate(transcriptUrl({transcriptStoreId:item.transcriptStoreId,jobId:item.id}),{transcriptStoreId:item.transcriptStoreId,query:state.query,offset:page.offset});}}>在转写资料库打开</a>:<p>请在现有转写资料库中查看完整记录。</p>}{onSaveTranscriptShortcut&&<button disabled={transcriptShortcutDisabled} onClick={()=>{if(transcriptShortcutDisabled||!current(item))return;source.current.assertActive(item.transcriptStoreId);onSaveTranscriptShortcut({kind:'transcript',transcriptStoreId:item.transcriptStoreId,jobId:item.id});}}>保存此转写快捷入口：{item.title}</button>}<MaterialSelectionButton link={{kind:'transcript',transcriptStoreId:item.transcriptStoreId,jobId:item.id}} label={item.title} selection={selection} accept={()=>{if(!current(item))return false;source.current.assertActive(item.transcriptStoreId);return true;}}/></li>)}</ul><Pagination total={page.total} offset={page.offset} maximum={1000} onPage={offset=>{owner.current.cancel();setPage(null);state.setOffset(offset);}}/></>}
 </section>;
}
/** Read-only research entry. Source tabs retain independent submitted queries and pagination. */
export function LocalResearchSearch({onNavigate,onOpenPdf,initialDocumentReturn,initialTranscriptReturn,onSaveTranscriptShortcut,transcriptShortcutDisabled,onSaveDocumentShortcut,documentShortcutDisabled,...selection}:LocalResearchSearchProps) {
 const [source,setSource]=useState<Source>(researchTranscriptReturn(initialTranscriptReturn)?'transcripts':'documents'),withdraw=useRef<()=>void>(()=>{}),withdrawTranscripts=useRef<()=>void>(()=>{});
 return <main><h2>本地资料检索</h2><p>仅当前有效资料（不含回收站）。文档与转写分别查询、计数和分页；没有跨来源总数、统一排名或统一快照。列表可能随本地修改而变化。</p><div role="group" aria-label="检索来源"><button aria-pressed={source==='documents'} onClick={()=>{withdrawTranscripts.current();setSource('documents');}}>文档</button><button aria-pressed={source==='transcripts'} onClick={()=>{withdraw.current();setSource('transcripts');}}>转写</button></div><Documents selection={selection} onSaveDocumentShortcut={onSaveDocumentShortcut} documentShortcutDisabled={documentShortcutDisabled} active={source==='documents'} onOpenPdf={onOpenPdf} withdraw={withdraw} initialDocumentReturn={initialDocumentReturn}/><Transcripts selection={selection} active={source==='transcripts'} onNavigate={onNavigate} initialTranscriptReturn={initialTranscriptReturn} withdraw={withdrawTranscripts} onSaveTranscriptShortcut={onSaveTranscriptShortcut} transcriptShortcutDisabled={transcriptShortcutDisabled}/></main>;
}
