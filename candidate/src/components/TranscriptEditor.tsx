import {useTranscriptionStore} from './TranscriptionStoreBoundary';
import {useUnsavedWork} from './unsaved-work';
import {useEffect, useMemo, useRef, useState} from 'react';
import {countTranscriptMatches, transcriptMatchRange, MAX_SEARCH_CODE_UNITS} from './transcript-matches';
type Transcript={raw:string;corrected:string|null;revision:number;updated:string|null};
type Version={revision:number;text:string|null;updated:string|null;kind:'correction'|'original'|'restore'|'migration';sourceRevision:number|null};
type History={versions:Omit<Version,'text'>[];earliestRevision:number|null;legacyGap:boolean};
const kindLabels={correction:'校对保存',original:'原始转写',restore:'历史版本恢复',migration:'迁移时保留的版本'};
type EditorProps={id:string;raw:string;rawPreview?:boolean;explicitOpenDisabled?:boolean};
function validTranscript(value:unknown):value is Transcript{
 if(!value||typeof value!=='object')return false;
 const t=value as Transcript;
 return typeof t.raw==='string'&&(t.corrected===null||typeof t.corrected==='string')&&Number.isSafeInteger(t.revision)&&t.revision>=0&&(t.updated===null||typeof t.updated==='string');
}
function validVersion(value:unknown,withText=false):value is Version{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Version;
 return Number.isSafeInteger(v.revision)&&v.revision>0&&typeof v.updated==='string'&&
  typeof v.kind==='string'&&Object.prototype.hasOwnProperty.call(kindLabels,v.kind)&&
  (v.kind==='restore'?typeof v.sourceRevision==='number'&&Number.isSafeInteger(v.sourceRevision)&&v.sourceRevision>0&&v.sourceRevision<v.revision:v.sourceRevision===null)&&
  (!withText||v.text===null||typeof v.text==='string');
}
function validHistory(value:unknown):value is History{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const h=value as History;
 if(!Array.isArray(h.versions)||typeof h.legacyGap!=='boolean')return false;
 if(!h.versions.every((v,i)=>validVersion(v)&&(i===0||h.versions[i-1].revision>v.revision)))return false;
 const earliest=h.versions.at(-1)?.revision??null;
 return h.earliestRevision===earliest&&h.legacyGap===(earliest!==null&&earliest>1);
}
function matchingVersion(v:Version,metadata:Omit<Version,'text'>){return v.revision===metadata.revision&&v.kind===metadata.kind&&v.updated===metadata.updated&&v.sourceRevision===metadata.sourceRevision}
// The host already keys rows by ID. This boundary also protects standalone ID reuse.
export function TranscriptEditor(props:EditorProps){const store=useTranscriptionStore();return <TranscriptEditorSession key={store.key(props.id)} {...props}/>}
function TranscriptEditorSession({id,raw,rawPreview=false,explicitOpenDisabled=false}:EditorProps){
 const store=useTranscriptionStore(),scopedFetch=store.fetch;
 const [saved,setSaved]=useState<Transcript|null>(null),[draft,setDraft]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState<'reload'|'revert'|null>(null),[query,setQuery]=useState('');
 const [history,setHistory]=useState<History|null>(null),[historyOpen,setHistoryOpen]=useState(false),[selected,setSelected]=useState<Version|null>(null),[restoreConfirm,setRestoreConfirm]=useState(false);
 const alive=useRef(true),lock=useRef(false);
 const textarea=useRef<HTMLTextAreaElement>(null);
 const [matchIndex,setMatchIndex]=useState<number|null>(null);
 const matchEpoch=useRef(0);
 const resetMatch=()=>{matchEpoch.current++;setMatchIndex(null)};
 const loadGeneration=useRef(0),snapshotGeneration=useRef(0),ready=useRef<number|null>(null);
 const activeLoad=useRef<{generation:number;controller:AbortController}|null>(null);
 const [loadedGeneration,setLoadedGeneration]=useState<number|null>(null),[openedGeneration,setOpenedGeneration]=useState<number|null>(null);
 const base=`/api/local-asr/jobs/${id}`;
 const acceptSnapshot=(value:unknown)=>{
  store.assertActive();
  if(!validTranscript(value))throw Error('转写内容格式无效，请重试读取');
  resetMatch();
  const generation=++snapshotGeneration.current;
  ready.current=generation;setLoadedGeneration(generation);setOpenedGeneration(null);
  setSaved(value);setDraft(value.corrected??value.raw);
 };
 async function load(){
  if(lock.current)return;
  resetMatch();
  const request={generation:++loadGeneration.current,controller:new AbortController()};
  activeLoad.current=request;lock.current=true;setBusy(true);setError('');
  ready.current=null;setLoadedGeneration(null);setOpenedGeneration(null);
  const current=()=>alive.current&&activeLoad.current===request&&loadGeneration.current===request.generation&&!request.controller.signal.aborted;
  try{
   const r=await scopedFetch(base+'/transcript',{signal:request.controller.signal});const d=await r.json();store.assertActive();
   if(!current())return;
   if(!r.ok)throw Error(d.error?.message||'读取失败');
   acceptSnapshot(d);setNotice('已载入最新版本');
  }catch(e){if(current())setError(e instanceof Error?e.message:'读取失败')}
  finally{if(activeLoad.current===request){activeLoad.current=null;lock.current=false;if(alive.current)setBusy(false)}}
 }
 useEffect(()=>{
  alive.current=true;void load();
  return()=>{alive.current=false;loadGeneration.current++;ready.current=null;
   if(activeLoad.current){activeLoad.current.controller.abort();activeLoad.current=null;lock.current=false;}
  };
 },[id]);
 async function refreshHistory(){
  setSelected(null);setRestoreConfirm(false);
  const r=await scopedFetch(base+'/history');const d=await r.json();store.assertActive();
  if(!r.ok)throw Error(d.error?.message||'读取历史失败');
  if(!validHistory(d))throw Error('历史记录格式无效，未更新列表；请重试。未保存修改仍保留。');
  if(alive.current)setHistory(d);
 }
 async function showHistory(){if(lock.current)return;lock.current=true;setBusy(true);setError('');setHistoryOpen(true);try{await refreshHistory()}catch(e){if(alive.current)setError(e instanceof Error?e.message:'读取历史失败')}finally{lock.current=false;if(alive.current)setBusy(false)}}
 async function preview(revision:number){
  if(lock.current)return;
  const metadata=history?.versions.find(v=>v.revision===revision);if(!metadata)return;
  lock.current=true;setBusy(true);setError('');setSelected(null);setRestoreConfirm(false);
  try{
   const r=await scopedFetch(base+'/history/'+revision);const d=await r.json();store.assertActive();
   if(!r.ok)throw Error(d.error?.message||'读取历史失败');
   if(!validVersion(d,true)||!matchingVersion(d,metadata))throw Error('历史版本与所选记录不一致，不能恢复；请刷新历史。未保存修改仍保留。');
   if(alive.current)setSelected(d);
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:'读取历史失败')}
  finally{lock.current=false;if(alive.current)setBusy(false)}
 }
 async function restore(){
  if(!saved||!selected||lock.current)return;
  const snapshot=saved,version=selected,generation=snapshotGeneration.current;
  const current=()=>alive.current&&snapshotGeneration.current===generation;
  lock.current=true;setBusy(true);setError('');setNotice('');
  try{
   const r=await scopedFetch(base+'/transcript-restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:snapshot.revision,sourceRevision:version.revision})});const d=await r.json();store.assertActive();
   if(!current())return;
   if(!r.ok)throw Error(d.error?.message||'恢复失败');
   if(!validTranscript(d)||d.raw!==snapshot.raw||d.corrected!==version.text||d.revision!==snapshot.revision+1||typeof d.updated!=='string')throw Error('恢复响应与所选版本不一致，未替换当前草稿；请核对最新版本后再操作。');
   acceptSnapshot(d);setSelected(null);setNotice(`已将历史版本 ${version.revision} 恢复为新版本 ${d.revision}；原有历史仍保留`);await refreshHistory();
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:'恢复失败')}
  finally{lock.current=false;if(alive.current)setBusy(false)}
 }
 async function save(text:string|null){if(!saved||lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');try{const r=await scopedFetch(base+'/transcript',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:saved.revision,text})});const d=await r.json();store.assertActive();if(!r.ok)throw Error(d.error?.message||'保存失败');if(alive.current){acceptSnapshot(d);setNotice(text===null?'已恢复原始转写；原文未被修改':'校对文本已保存');if(historyOpen)await refreshHistory()}}catch(e){if(alive.current)setError(e instanceof Error?e.message:'保存失败')}finally{lock.current=false;if(alive.current)setBusy(false)}}
 async function download(variant:'raw'|'corrected'){
  if(!saved||lock.current)return;
  const snapshot=saved,generation=snapshotGeneration.current;
  const text=variant==='raw'?snapshot.raw:snapshot.corrected;
  if(text===null)return;
  const expected=new TextEncoder().encode(text);
  const filename=`transcript-${id}-${variant}-r${snapshot.revision}.txt`;
  const current=()=>alive.current&&snapshotGeneration.current===generation;
  const invalid=()=>Error('导出内容与已载入的保存版本不一致，未开始下载；请重试或载入最新版本。未保存修改仍保留。');
  lock.current=true;setBusy(true);setError('');setNotice('');
  try{
   const r=await scopedFetch(base+'/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:snapshot.revision,variant})});
   if(!r.ok){const d=await r.json();store.assertActive();throw Error(d.error?.message||'导出失败')}
   store.assertActive();if(!current())return;
   // This is the local host's exact UTF-8 export contract, not proof of server authenticity.
   if(r.status!==200||r.headers.get('X-Transcript-Revision')!==String(snapshot.revision)||
    !/^text\/plain;\s*charset=utf-8$/i.test(r.headers.get('Content-Type')??'')||
    r.headers.get('Content-Disposition')!==`attachment; filename="${filename}"`||
    r.headers.get('Content-Length')!==String(expected.byteLength))throw invalid();
   const blob=await r.blob();store.assertActive();if(!current())return;
   if(blob.size!==expected.byteLength)throw invalid();
   const bytes=new Uint8Array(await blob.arrayBuffer());store.assertActive();if(!current())return;
   if(bytes.length!==expected.length||!bytes.every((byte,index)=>byte===expected[index]))throw invalid();
   const url=URL.createObjectURL(blob);const a=document.createElement('a');
   try{a.href=url;a.download=filename;document.body.append(a);a.click();setNotice(`已核验${variant==='raw'?'原始':'已保存校对'}文本并发起 TXT 下载；请检查浏览器下载结果`)}
   finally{a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  }catch(e){if(current())setError(e instanceof Error?e.message:'导出失败')}
  finally{lock.current=false;if(alive.current)setBusy(false)}
 }

 const dirty=!!saved&&draft!==(saved.corrected??saved.raw);
 // Textarea DOM values normalize CRLF/CR to LF. Search the visible editing
 // surface so selection offsets stay exact, without rewriting the saved/draft text.
 const searchText=useMemo(()=>draft.length>MAX_SEARCH_CODE_UNITS?draft:draft.replace(/\r\n?/g,'\n'),[draft]);
 const matches=useMemo(()=>countTranscriptMatches(searchText,query),[searchText,query]);
 useUnsavedWork(dirty);
 const canExplicitOpen=!store.blocked&&!explicitOpenDisabled&&loadedGeneration!==null&&ready.current===loadedGeneration&&!!saved&&!busy&&!confirm&&!restoreConfirm;
 const openBody=()=>{
  const target=textarea.current,generation=loadedGeneration;
  if(!canExplicitOpen||lock.current||!alive.current||generation===null||ready.current!==generation||!target?.isConnected||target.disabled)return;
  try{target.focus();}catch{return;}
  if(alive.current&&ready.current===generation&&textarea.current===target&&target.isConnected&&!target.disabled&&target.ownerDocument.activeElement===target)setOpenedGeneration(generation);
 };
 const canNavigate=canExplicitOpen&&matches!==null&&matches>0;
 const navigateMatch=(direction:1|-1)=>{
  const target=textarea.current,generation=loadedGeneration,epoch=matchEpoch.current;
  const current=()=>alive.current&&!store.blocked&&!lock.current&&ready.current===generation&&matchEpoch.current===epoch&&textarea.current===target&&!!target?.isConnected&&!target.disabled&&target.value===searchText;
  if(!canNavigate||matches===null||generation===null||!target||!current())return;
  const index=matchIndex===null?(direction===1?0:matches-1):(matchIndex+direction+matches)%matches;
  const range=transcriptMatchRange(searchText,query,index);if(!range)return;
  try{
   target.focus();
   if(!current()||target.ownerDocument.activeElement!==target)return;
   target.setSelectionRange(range.start,range.end);
   if(current()&&target.selectionStart===range.start&&target.selectionEnd===range.end)setMatchIndex(index);
  }catch{/* A detached/unsupported selection must not publish a successful match. */}
 };
 return <section aria-label="转写校对与导出">
 <button type="button" disabled={!canExplicitOpen} onClick={openBody}>查看正文</button>
 <p role="status">{!canExplicitOpen?'当前暂不可通过按钮打开正文':openedGeneration===loadedGeneration?'本次已通过按钮打开正文':'本次尚未通过此按钮打开正文'}</p>
 <p>仅记录当前页面中通过此按钮定位已载入正文的操作；不代表已阅读，不跨页面或设备保存。重新载入或保存新版本后需重新打开；来源标识由本页固定校验，但不证明物理文件或内容真实性。</p>
 <details><summary>原始转写（只读）</summary><p style={{whiteSpace:'pre-wrap'}}>{(saved?.raw??raw)||'未识别到文字'}</p></details>
 {!saved&&rawPreview&&<p role="status">当前仅显示原文预览，完整原文将在校对内容读取成功后显示。</p>}
 <p>原文保留不变，校对内容单独保存。TXT 导出只含文字；暂不提供字幕时间轴。</p>
 {saved&&<><p>已保存版本 {saved.revision} · {saved.corrected===null?'原始文本':'校对文本'}{dirty?' · 有未保存修改':''}</p>
 <label>校对文本<textarea ref={textarea} aria-label="校对文本" value={draft} disabled={busy} onChange={e=>{resetMatch();setDraft(e.target.value);setNotice('')}} style={{display:'block',width:'100%',minHeight:140}}/></label>
 <label>查找文字<input aria-label="查找文字" value={query} onChange={e=>{resetMatch();setQuery(e.target.value)}}/></label>
 <button type="button" disabled={!canNavigate} onClick={()=>navigateMatch(-1)}>上一处</button>
 <button type="button" disabled={!canNavigate} onClick={()=>navigateMatch(1)}>下一处</button>
 {matches===null?<p role="status">当前文本或查询超过查找上限（16 Mi 个 UTF-16 单元），暂不定位；文本未被截断。</p>:query?<p role="status">当前编辑文本中找到 {matches} 处（区分大小写） · 当前 {matchIndex===null?0:matchIndex+1}/{matches}</p>:<p role="status">输入文字后可定位匹配 · 当前 0/0</p>}
 <p>按字面查找，不使用正则，不重叠计数。首次下一处从开头、上一处从末尾开始；到达首尾后循环。仅选中编辑框内文字，不保存或标记“查看正文”；长文本可能仍需手动滚动。</p>
 <button disabled={store.blocked||busy||!dirty} onClick={()=>void save(draft)}>保存校对</button>
 <button disabled={busy||!dirty} onClick={()=>{resetMatch();setDraft(saved.corrected??saved.raw);setNotice('已撤销未保存修改')}}>撤销未保存修改</button>
 <button disabled={store.blocked||busy||(saved.corrected===null&&!dirty)} onClick={()=>setConfirm('revert')}>恢复原始转写</button>
 <button disabled={store.blocked||busy} onClick={()=>dirty?setConfirm('reload'):void load()}>载入最新版本</button>
 <button disabled={store.blocked||busy} onClick={()=>historyOpen?setHistoryOpen(false):void showHistory()}>{historyOpen?'隐藏版本历史':'查看版本历史'}</button>
 <button disabled={store.blocked||busy} onClick={()=>void download('raw')}>导出原始 TXT</button>
 <button disabled={store.blocked||busy||saved.corrected===null} onClick={()=>void download('corrected')}>导出已保存校对 TXT</button>
 {dirty&&<p>导出使用已保存版本，不包含未保存修改；离开或刷新页面会丢失未保存修改。</p>}
 </>}
 {saved&&historyOpen&&<section aria-label="版本历史"><h3>版本历史</h3><p>恢复会创建新版本，不覆盖历史；恢复原始转写也会保留已有校对历史。</p><button disabled={store.blocked||busy} onClick={()=>void showHistory()}>刷新版本历史</button>
 {history?.legacyGap&&<p>此记录由旧数据迁移。更早的历史未被记录，无法还原；此处仅显示实际保留的版本。</p>}
 {history&&<><p>最早可用版本：{history.earliestRevision??'无'}</p><ol>{history.versions.map(v=><li key={v.revision}><button disabled={store.blocked||busy} onClick={()=>void preview(v.revision)}>查看版本 {v.revision}</button> · {kindLabels[v.kind]}{v.revision===saved.revision?' · 当前版本':''}{v.sourceRevision!==null?` · 来源版本 ${v.sourceRevision}`:''} · {v.updated?new Date(v.updated).toLocaleString():'时间未记录'}</li>)}</ol></>}
 {selected&&<div><h4>历史版本 {selected.revision}（只读）</h4><textarea aria-label="历史版本文本（只读）" readOnly value={selected.text??saved.raw} style={{display:'block',width:'100%',minHeight:140}}/><button disabled={store.blocked||busy} onClick={()=>setRestoreConfirm(true)}>恢复此版本为新版本</button></div>}
 </section>}
 {restoreConfirm&&selected&&<div role="alertdialog" aria-label="确认恢复历史版本"><p>确认将版本 {selected.revision} 恢复为新版本？当前已保存版本和全部历史都会保留。{dirty?'未保存修改将被替换。':''}</p><button disabled={store.blocked||busy} onClick={()=>{setRestoreConfirm(false);void restore()}}>确认创建新版本</button><button disabled={busy} onClick={()=>setRestoreConfirm(false)}>取消</button></div>}
 {!saved&&!busy&&<button disabled={store.blocked} onClick={()=>void load()}>重试读取校对</button>}
 {confirm&&<div role="alertdialog" aria-label="确认替换编辑内容"><p>{confirm==='revert'?'确认恢复原始转写？将创建新版本，已有校对历史仍保留；未保存修改会丢失。':'载入最新版本会丢失未保存修改。是否继续？'}</p><button disabled={store.blocked||busy} onClick={()=>{const action=confirm;setConfirm(null);if(action==='revert')void save(null);else void load()}}>确认替换</button><button onClick={()=>setConfirm(null)}>取消</button></div>}
 {busy&&<p role="status">正在处理…</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
 </section>
}
