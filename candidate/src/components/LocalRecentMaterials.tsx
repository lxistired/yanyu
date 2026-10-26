import {recentTranscriptReturn, type RecentTranscriptReturn} from './recent-transcript-return';
import {recentDocumentReturn, type RecentDocumentReturn} from './recent-document-return';
import {PDF_OPEN_UNAVAILABLE_REASON, type PdfOpenSelection} from './pdf-open-selection';
import {StagedStatusFilter, type FilterGroup, type FilterSelection} from './staged-status-filter/StagedStatusFilter';
import {createdDateBounds, storedCreatedInstant, type CreatedDateSelection} from './transcription-created-date.mjs';
import {ExternalTranscriptionSource} from './external-transcription-source';
import {useEffect, useRef, useState} from 'react';
import {transcriptUrl} from './TranscriptRelationships';
import {documentPage, documentPreview, documentScope, researchGet, ResearchRequestOwner, ResearchScopeChanged, recoveryOffset, transcriptPage, researchUploadOrigins, type ResearchUploadOrigin, type ResearchDocument, type ResearchJob, type ResearchPage} from './local-research-search';

export type LocalRecentMaterialsProps = {onNavigate?: (url: string, context?:RecentTranscriptReturn) => void; initialTranscriptReturn?:RecentTranscriptReturn|null; initialDocumentReturn?:RecentDocumentReturn|null; onOpenPdf?: (selection:PdfOpenSelection, context?:RecentDocumentReturn)=>void};
const scopeMessage = '文档来源已变化。请明确重新载入文档来源；不会自动改用其他来源。';
const errorText = (error: unknown) => error instanceof Error ? error.message : '本地来源暂不可用，请重试';
type LocalStatus = ResearchJob['status'];
const statusOrder: readonly LocalStatus[] = ['interrupted','processing','completed','cancelled','failed'];
const statusLabels = {interrupted:'已中断', processing:'识别中', completed:'转写完成', cancelled:'已取消', failed:'转写失败'};

const originLabels = {unknown:'来源未知', 'file-selection':'选择音频文件', 'recording-draft':'录音面板（当前录音或已保存草稿）'};

const statusGroups: readonly FilterGroup<'status',LocalStatus>[] = [{id:'status',label:'任务状态',choices:statusOrder.map(value=>({value,label:statusLabels[value]}))}];

function Pages({label, offset, total, maximum, busy, onPage, totalLabel='此来源共'}: {label:string; offset:number; total:number; maximum:number; busy:boolean; onPage:(offset:number)=>void; totalLabel?:string}) {
 return <nav aria-label={`${label}分页`}>
  <button disabled={busy || offset===0} onClick={()=>onPage(offset-10)}>上一页</button>
  <span>第 {offset/10+1} 页 · {totalLabel} {total} 条</span>
  <button disabled={busy || offset+10>=total || offset+10>maximum} onClick={()=>onPage(offset+10)}>下一页</button>
  {total>maximum+10 && <p>此页最多浏览该来源前 {maximum+10} 条；不是完整历史。</p>}
 </nav>;
}

function RecentDocuments({onOpenPdf,initialDocumentReturn}:Pick<LocalRecentMaterialsProps,'onOpenPdf'|'initialDocumentReturn'>) {
 const initial=useRef(recentDocumentReturn(initialDocumentReturn)).current;
 const owner=useRef(new ResearchRequestOwner()), detailOwner=useRef(new ResearchRequestOwner());
 const accepted=useRef<{page:ResearchPage<ResearchDocument>;current:()=>boolean}|null>(null);
 // An expected store is not a live scope: every returned mount must discover it afresh.
 const expectedScope=useRef(initial?.documentStoreId??null);
 const scope=useRef<string|null>(null), blocked=useRef(false);
 const [offset,setOffset]=useState(initial?.offset??0), [revision,setRevision]=useState(0);
 const [page,setPage]=useState<ResearchPage<ResearchDocument>|null>(null), [busy,setBusy]=useState(true), [error,setError]=useState(''), [needsReload,setNeedsReload]=useState(false);
 const [preview,setPreview]=useState<ReturnType<typeof documentPreview>|null>(null), [detailBusy,setDetailBusy]=useState(false), [detailError,setDetailError]=useState('');
 function closePreview() {detailOwner.current.cancel();setPreview(null);setDetailBusy(false);setDetailError('');}
 function scopeChanged() {
  owner.current.cancel();accepted.current=null;closePreview();scope.current=null;blocked.current=true;
  setPage(null);setBusy(false);setNeedsReload(true);setError(scopeMessage);
 }
 // Cancel synchronously at the user action, not merely when the next effect runs.
 function refresh(nextOffset=offset, reload=false) {
  owner.current.cancel();accepted.current=null;closePreview();setPage(null);setError('');
  if(reload) {expectedScope.current=null;scope.current=null;blocked.current=false;setNeedsReload(false);}
  setBusy(true);setOffset(nextOffset);setRevision(value=>value+1);
 }
 useEffect(()=>{
  const request=owner.current.begin();accepted.current=null;
  if(blocked.current) {setBusy(false);return ()=>owner.current.cancel();}
  setBusy(true);
  void (async()=>{
   try {
    let captured=scope.current;
    if(!captured) {
     const choices=await researchGet('/api/documents/choices',request.signal).catch(failure=>{if(expectedScope.current!==null&&failure instanceof SyntaxError)throw new ResearchScopeChanged();throw failure;});
     if(!request.current())return;
     try {captured=documentScope(choices);} catch(failure) {if(expectedScope.current!==null)throw new ResearchScopeChanged();throw failure;}
     if(expectedScope.current!==null&&captured!==expectedScope.current)throw new ResearchScopeChanged();
     scope.current=captured;
    }
    const data=await researchGet(`/api/documents?${new URLSearchParams({q:'',view:'active',offset:String(offset),limit:'10'})}`,request.signal,{'X-Document-Store-Id':captured});
    if(!request.current())return;
    const next=documentPage(data,captured,offset), recovered=recoveryOffset(next.total,offset,250);
    if(recovered!==offset) {refresh(recovered);return;}
    accepted.current={page:next,current:request.current};setPage(next);
   } catch(failure) {if(request.current()) {if(failure instanceof ResearchScopeChanged)scopeChanged();else setError(errorText(failure));}}
   finally {if(request.current())setBusy(false);}
  })();
  return ()=>{owner.current.cancel();detailOwner.current.cancel();};
 },[offset,revision]);
 async function open(item:ResearchDocument) {
  const captured=scope.current;
  if(!captured || blocked.current || busy)return;
  const request=detailOwner.current.begin();setPreview(null);setDetailError('');setDetailBusy(true);
  try {
   const data=await researchGet(`/api/documents/${item.id}`,request.signal,{'X-Citation-Store-Id':captured});
   if(request.current())setPreview(documentPreview(data,captured,item.id));
  } catch(failure) {if(request.current()) {if(failure instanceof ResearchScopeChanged)scopeChanged();else setDetailError(errorText(failure));}}
  finally {if(request.current())setDetailBusy(false);}
 }
 return <section aria-label="文档入库">
  <h3>文档入库</h3><p>仅未删除的本地 TXT、Markdown、PDF；按入库时间倒序，同时间按记录 ID 倒序。入库时间不是修改时间。</p>
  <button disabled={busy || needsReload} onClick={()=>refresh()}>刷新文档记录</button>{' '}
  <button onClick={()=>refresh(0,true)}>重新载入文档来源</button>
  {busy&&<p role="status">正在读取文档记录…</p>}{error&&<p role="alert">{error}</p>}
  {error&&!needsReload&&<button disabled={busy} onClick={()=>refresh()}>重试文档记录</button>}
  {page&&<>{page.total===0&&<p>暂无未删除的本地文档。</p>}
   <ul>{page.items.map(item=><li key={item.id}><h4>{item.name}</h4><p>文档 ID：{item.id}</p><p>{item.format} · 入库时间：{item.createdAt}</p><button onClick={()=>void open(item)}>查看提取文字：{item.name}</button>{item.format==='pdf'&&<><button disabled={!item.pdfOpen||!onOpenPdf} onClick={()=>{const current=accepted.current;if(item.pdfOpen&&onOpenPdf&&!blocked.current&&current?.current()&&current.page.items.includes(item)&&scope.current===item.pdfOpen.storeScope)onOpenPdf(item.pdfOpen,{documentStoreId:scope.current,offset:current.page.offset});}}>打开 PDF：{item.name}</button>{!item.pdfOpen&&<span>{PDF_OPEN_UNAVAILABLE_REASON}</span>}</>}</li>)}</ul>
   <Pages label="文档入库" offset={page.offset} total={page.total} maximum={250} busy={busy} onPage={next=>refresh(next)}/>
  </>}
  {detailBusy&&<p role="status">正在读取提取文字…</p>}{detailError&&<p role="alert">{detailError} 可重新选择同一文档重试；缺失或已删除的文档不会替换为其他文档。</p>}
  {(preview||detailBusy||detailError)&&<button onClick={closePreview}>关闭文字预览</button>}
  {preview&&<article aria-label="近期文档提取文字"><h4>{preview.item.name}</h4><p>文档 ID：{preview.item.id}</p><p>仅提取文字，不是 PDF 阅读器、OCR 或事实核验。</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'28rem',overflow:'auto'}}>{preview.text}</pre></article>}
 </section>;
}

function RecentTranscripts({onNavigate,initialTranscriptReturn}:LocalRecentMaterialsProps) {
 const initial=useRef(recentTranscriptReturn(initialTranscriptReturn)).current;
 const owner=useRef(new ResearchRequestOwner()), source=useRef(new ExternalTranscriptionSource(initial?.transcriptStoreId??null));
 const [offset,setOffset]=useState(initial?.offset??0), [revision,setRevision]=useState(0);
 const [statuses,setStatuses]=useState<LocalStatus[]>(initial?.statuses??[]), [statusOpen,setStatusOpen]=useState(false);
 const [dates,setDates]=useState<CreatedDateSelection>(initial?.dates??{createdFrom:'',createdThrough:''}), [dateDraft,setDateDraft]=useState<CreatedDateSelection>(initial?.dates??{createdFrom:'',createdThrough:''});
 const [dateOpen,setDateOpen]=useState(false), [dateError,setDateError]=useState('');
 const [origin,setOrigin]=useState<ResearchUploadOrigin|''>(initial?.origin??''), [originDraft,setOriginDraft]=useState<ResearchUploadOrigin|''>(initial?.origin??'');
 const [originOpen,setOriginOpen]=useState(false), [originError,setOriginError]=useState('');
 const datesActive=Boolean(dates.createdFrom||dates.createdThrough);
 const accepted=useRef<{page:ResearchPage<ResearchJob>;current:()=>boolean}|null>(null);
 const [page,setPage]=useState<ResearchPage<ResearchJob>|null>(null), [busy,setBusy]=useState(true), [error,setError]=useState('');
 function refresh(nextOffset=offset, reload=false) {owner.current.cancel();accepted.current=null;if(reload)source.current=new ExternalTranscriptionSource();setPage(null);setError('');setBusy(true);setOffset(nextOffset);setRevision(value=>value+1);}
 function commitStatuses(selection:FilterSelection<'status',LocalStatus>) {
  const values=selection.status;
  if(!Array.isArray(values)||new Set(values).size!==values.length||values.some(value=>!statusOrder.includes(value)))return false;
  const next=statusOrder.filter(value=>values.includes(value));
  if(next.length===statuses.length&&next.every((value,index)=>value===statuses[index]))return true;
  // Fence both response publication and old row handlers before React commits the new view.
  refresh(0);setStatuses(next);return true;
 }
 function commitDates() {
  if(!createdDateBounds(dateDraft.createdFrom||undefined,dateDraft.createdThrough||undefined)) {setDateError('请输入有效的 YYYY-MM-DD 日期（0001–9999）；开始日期不能晚于结束日期。');return;}
  if(dates.createdFrom===dateDraft.createdFrom&&dates.createdThrough===dateDraft.createdThrough) {setDateOpen(false);setDateError('');return;}
  // Reuse synchronous ownership fencing; a date change never rediscovers the source.
  refresh(0);setDates({...dateDraft});setDateOpen(false);setDateError('');
 }
 function commitOrigin() {
  if(originDraft!==''&&!researchUploadOrigins.includes(originDraft)) {setOriginError('请选择有效的提交入口。');return;}
  if(originDraft===origin) {setOriginOpen(false);setOriginError('');return;}
  // Preserve date/status selections and source ownership, fencing old rows synchronously.
  refresh(0);setOrigin(originDraft);setOriginOpen(false);setOriginError('');
 }
 function open(item:ResearchJob) {
  const current=accepted.current;
  if(busy||source.current.blocked||!current?.current()||!current.page.items.includes(item))return;
  source.current.assertActive(item.transcriptStoreId);onNavigate?.(transcriptUrl({transcriptStoreId:item.transcriptStoreId,jobId:item.id}),{transcriptStoreId:item.transcriptStoreId,offset:current.page.offset,statuses:[...statuses],dates:{...dates},origin});
 }
 useEffect(()=>{
  const request=owner.current.begin();accepted.current=null;if(source.current.blocked){setBusy(false);setError('转写来源无法核验或已变化，请明确重新载入转写来源。');return ()=>owner.current.cancel();}setBusy(true);
  void (async()=>{
   try {
    const captured=source.current;const {data,transcriptStoreId}=await captured.read(`/api/local-asr/jobs?${new URLSearchParams({q:'',scope:'active',offset:String(offset),limit:'10',...(statuses.length?{statuses:statuses.join(',')}:{}),...(dates.createdFrom?{createdFrom:dates.createdFrom}:{}),...(dates.createdThrough?{createdThrough:dates.createdThrough}:{}),...(origin?{origin}:{})})}`,request);
    if(!request.current())return;
    const next=transcriptPage(data,offset,transcriptStoreId);
    if(statuses.length&&next.items.some(item=>!statuses.includes(item.status)))throw Error('本地转写来源返回了不匹配所选状态的记录，请重试');
    if(origin&&next.items.some(item=>item.uploadOrigin!==origin))throw Error('本地转写来源返回了无法核验或不匹配所选提交入口的记录，请重试');
    if(datesActive) {
     const bounds=createdDateBounds(dates.createdFrom||undefined,dates.createdThrough||undefined);
     if(!bounds||next.items.some(item=>{const instant=storedCreatedInstant(item.created);return instant===null||(bounds.start!==null&&instant<bounds.start)||(bounds.endExclusive!==null&&instant>=bounds.endExclusive);}))throw Error('本地转写来源返回了无法核验或不匹配所选创建日期的记录，请重试');
    }
    const recovered=recoveryOffset(next.total,offset,1000);
    if(recovered!==offset) {refresh(recovered);return;}
    captured.assertActive(transcriptStoreId);accepted.current={page:next,current:request.current};setPage(next);
   } catch(failure) {if(request.current())setError(errorText(failure));}
   finally {if(request.current())setBusy(false);}
  })();
  return ()=>owner.current.cancel();
 },[offset,revision,statuses,dates,origin]);
 return <section aria-label="转写记录">
  <h3>转写记录</h3><p>仅未删除的本地记录；按保存的创建时间原始文本倒序，文本相同时按记录 ID 倒序。历史日期格式混用时不保证精确时间顺序。创建时间不是状态变更时间。状态是本地转写状态，不表示后台任务调度。</p>
  <p>记录及固定链接绑定首次读取的转写来源，但不是跨请求快照。旧无来源链接不能证明历史来源。最多浏览前 1010 条，可在资料检索中缩小范围。</p>
  <StagedStatusFilter groups={statusGroups} value={{status:statuses}} open={statusOpen} onCommit={commitStatuses} onOpenChange={open=>{setStatusOpen(open);return true;}} labels={{trigger:'转写状态筛选',title:'筛选近期转写状态',all:'全部状态',reset:'重置',confirm:'确认筛选',cancel:'取消筛选',badge:'个已选状态'}}/>
  <p>提交入口（客户端声明）：{origin?originLabels[origin]:'全部入口'}</p>
  <button aria-expanded={originOpen} onClick={()=>{if(!originOpen){setOriginDraft(origin);setOriginError('');}setOriginOpen(!originOpen);}}>提交入口筛选</button>
  {originOpen&&<form aria-label="提交入口筛选（客户端声明）" onSubmit={event=>{event.preventDefault();commitOrigin();}}>
   <label>提交入口（客户端声明）<select aria-label="提交入口（客户端声明）" value={originDraft} onChange={event=>{setOriginDraft(event.target.value as ResearchUploadOrigin|'');setOriginError('');}}>
    <option value="">全部入口</option>{researchUploadOrigins.map(value=><option key={value} value={value}>{originLabels[value]}</option>)}
   </select></label>
   <button type="submit">应用入口筛选</button>
   <button type="button" onClick={()=>{setOriginDraft('');setOriginError('');}}>重置暂存入口</button>
   <button type="button" onClick={()=>{setOriginDraft(origin);setOriginOpen(false);setOriginError('');}}>取消入口筛选</button>
   {originError&&<p role="alert">{originError}</p>}
  </form>}
  <p>入口仅记录首次提交时客户端声明，不证明音频实际录制设备或来源；来源未知包括旧记录和未声明入口的记录。重置暂存入口后需应用才改变结果。旧响应未提供入口字段时仅能在全部入口下显示，不推断为已核验的未知入口。</p>
  <p>创建日期（UTC）：{dates.createdFrom||'不限开始'} 至 {dates.createdThrough||'不限结束'}（包含结束当天）。仅筛选本地保存记录的创建日期，不是录音或最后编辑时间。</p>
  <button aria-expanded={dateOpen} onClick={()=>{if(!dateOpen){setDateDraft({...dates});setDateError('');}setDateOpen(!dateOpen);}}>创建日期筛选</button>
  {dateOpen&&<form aria-label="创建日期筛选（UTC）" onSubmit={event=>{event.preventDefault();commitDates();}}>
   <label>开始日期（UTC）<input aria-label="开始日期（UTC）" placeholder="YYYY-MM-DD" maxLength={10} value={dateDraft.createdFrom} onChange={event=>{setDateDraft({...dateDraft,createdFrom:event.target.value});setDateError('');}}/></label>
   <label>结束日期（UTC，含当天）<input aria-label="结束日期（UTC，含当天）" placeholder="YYYY-MM-DD" maxLength={10} value={dateDraft.createdThrough} onChange={event=>{setDateDraft({...dateDraft,createdThrough:event.target.value});setDateError('');}}/></label>
   <button type="submit">应用日期筛选</button>
   <button type="button" onClick={()=>{setDateDraft({createdFrom:'',createdThrough:''});setDateError('');}}>重置暂存日期</button>
   <button type="button" onClick={()=>{setDateDraft({...dates});setDateOpen(false);setDateError('');}}>取消日期筛选</button>
   {dateError&&<p role="alert">{dateError}</p>}
  </form>}
  <p>空白表示不限；重置暂存日期后需点击应用才会改变结果。旧的纯日期记录按 UTC 午夜处理；日期格式无法确认的历史记录在日期筛选时不显示。</p>
  <button disabled={busy || source.current.blocked} onClick={()=>refresh()}>刷新转写记录</button><button onClick={()=>refresh(0,true)}>重新载入转写来源</button>
  {busy&&<p role="status">正在读取转写记录…</p>}{error&&<p role="alert">{error}</p>}{error&&!source.current.blocked&&<button disabled={busy} onClick={()=>refresh()}>重试转写记录</button>}
  {page&&<>{page.total===0&&<p>{datesActive||origin?'没有匹配所选筛选条件的本地转写记录。':statuses.length?'没有匹配所选状态的本地转写记录。':'暂无未删除的本地转写记录。'}</p>}
   <ul>{page.items.map(item=><li key={item.id}><h4>{item.title}</h4><p>任务 ID：{item.id}</p><p>{item.filename} · {statusLabels[item.status]} · 创建时间：{item.created}</p>
    {onNavigate?<button onClick={()=>open(item)}>打开转写记录：{item.title}</button>:<p>当前入口未提供记录导航。</p>}
   </li>)}</ul>
   <Pages label="转写记录" totalLabel={statuses.length||datesActive||origin?'当前筛选共':'此来源共'} offset={page.offset} total={page.total} maximum={1000} busy={busy} onPage={next=>refresh(next)}/>
  </>}
 </section>;
}

/** Original local read-only composition, not an activity/audit stream or source API reconstruction.
 * Independent mounted sections retain independent paging. Shell owns guarded navigation. */
export function LocalRecentMaterials({onNavigate,onOpenPdf,initialTranscriptReturn,initialDocumentReturn}:LocalRecentMaterialsProps) {
 return <main><h2>近期本地资料</h2><p>原创本地设计：最近保存的资料。文档入库与转写记录分别读取、计数和分页，没有跨来源合并排序、总数、统一快照或活动审计日志。列表可随本地资料变化；只读浏览不会上传、修改、启动转写或调度任务。</p>
  <RecentDocuments onOpenPdf={onOpenPdf} initialDocumentReturn={initialDocumentReturn}/><RecentTranscripts onNavigate={onNavigate} initialTranscriptReturn={initialTranscriptReturn}/>
 </main>;
}
