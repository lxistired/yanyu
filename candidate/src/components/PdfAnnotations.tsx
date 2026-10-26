import {assertPdfStoreResponse, PdfStoreMismatch, validPdfStoreScope} from './pdf-store-scope';
import {useUnsavedWork} from './unsaved-work';
import {useEffect, useRef, useState, type PointerEvent, type ReactNode} from 'react';

export type AnnotationRect = {x:number;y:number;width:number;height:number};
type Note = {id:string;page:number;rect:AnnotationRect|null;comment:string;createdAt:string;updatedAt:string};
type Snapshot = {documentId:string;sha256:string;revision:number;notes:Note[]};
type Draft = {id:string|null;page:number;rect:AnnotationRect|null;comment:string};
type Props = {storeScope:string;storeBlocked:boolean;isStoreBlocked:()=>boolean;onStoreMismatch:()=>void;documentId:string;sha256:string;pages:number;page:number;viewKey:string;imageReady:boolean;children:ReactNode;onNavigate:(page:number)=>void};
type Session = {active:boolean;generation:number;controllers:Set<AbortController>;writing:boolean;reading:boolean};
type Gesture = {pointerId:number;page:number;viewKey:string;x:number;y:number};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const bytes=(value:string)=>new TextEncoder().encode(value).length;
const validComment=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&bytes(value)<=4096&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)&&Array.from(value).every(char=>{const point=char.codePointAt(0)!;return point<0xd800||point>0xdfff;});
function validRect(value:unknown):value is AnnotationRect|null {
 if(value===null)return true;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==4||!['x','y','width','height'].every(key=>Object.prototype.hasOwnProperty.call(value,key)))return false;
 const rect=value as AnnotationRect;
 return [rect.x,rect.y,rect.width,rect.height].every(n=>typeof n==='number'&&Number.isFinite(n))&&rect.x>=0&&rect.y>=0&&rect.width>=.002&&rect.height>=.002&&rect.x+rect.width<=1&&rect.y+rect.height<=1;
}
function parseSnapshot(value:unknown,documentId:string,sha256:string,pages:number):Snapshot {
 const data=value as Snapshot|null;
 if(!data||data.documentId!==documentId||data.sha256!==sha256||!Number.isSafeInteger(data.revision)||data.revision<0||!Array.isArray(data.notes)||data.notes.length>250)throw Error('批注数据无效或原件已改变，请重新载入');
 const ids=new Set<string>();
 for(const note of data.notes) {
  if(!note||typeof note.id!=='string'||!uuid.test(note.id)||ids.has(note.id)||!Number.isInteger(note.page)||note.page<1||note.page>pages||!validRect(note.rect)||!validComment(note.comment)||typeof note.createdAt!=='string'||!Number.isFinite(Date.parse(note.createdAt))||typeof note.updatedAt!=='string'||!Number.isFinite(Date.parse(note.updatedAt)))throw Error('批注数据无效，请重新载入');
  ids.add(note.id);
 }
 return data;
}
const sameContent=(note:Note,draft:Draft)=>note.page===draft.page&&note.comment===draft.comment&&(note.rect===null?draft.rect===null:!!draft.rect&&(['x','y','width','height'] as const).every(key=>note.rect![key]===draft.rect![key]));
const styleRect=(rect:AnnotationRect)=>({left:`${rect.x*100}%`,top:`${rect.y*100}%`,width:`${rect.width*100}%`,height:`${rect.height*100}%`});
const message=(error:unknown)=>error instanceof Error?error.message:'批注请求失败，请重试';

/** Annotation writes use explicit revisions, never a blind retry. Drafts belong to a page,
 * independent of reader navigation; the keyed parent owns document identity. */
export function PdfAnnotations({storeScope,storeBlocked,isStoreBlocked,onStoreMismatch,documentId,sha256,pages,page,viewKey,imageReady,children,onNavigate}:Props) {
 const blockedRef=useRef(false);if(storeBlocked)blockedRef.current=true;
 const [scopeError,setScopeError]=useState(false);
 const blocked=storeBlocked||scopeError;
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
 const [draft,setDraft]=useState<Draft|null>(null);
 useUnsavedWork(draft !== null);
 const [loading,setLoading]=useState(true);
 const [saving,setSaving]=useState(false);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [mustReload,setMustReload]=useState(false);
 const [review,setReview]=useState(false);
 const [drawing,setDrawing]=useState(false);
 const [preview,setPreview]=useState<AnnotationRect|null>(null);
 const [selected,setSelected]=useState<string|null>(null);
 const sessionRef=useRef<Session|null>(null);
 const snapshotRef=useRef<Snapshot|null>(null);
 const draftRef=useRef<Draft|null>(null);draftRef.current=draft;
 const gestureRef=useRef<Gesture|null>(null);
 const uncertainRef=useRef<{draft:Draft;before:Snapshot}|null>(null);
 const reloadNeededRef=useRef(false);
 const viewRef=useRef({page,viewKey,imageReady});viewRef.current={page,viewKey,imageReady};
 const live=(session:Session)=>session.active&&sessionRef.current===session;
 const base=`/api/documents/${documentId}/annotations`;

 function blockStore(){blockedRef.current=true;setScopeError(true);setError(new PdfStoreMismatch().message);onStoreMismatch();}

 async function load(session:Session,explicit=false) {
  if(blockedRef.current||isStoreBlocked()||!live(session)||session.writing)return;
  if(!validPdfStoreScope(storeScope)){blockStore();setLoading(false);return;}
  const previous=snapshotRef.current;const generation=++session.generation;session.reading=true;
  const controller=new AbortController();session.controllers.add(controller);setLoading(true);setError('');
  try {
   const response=await fetch(base,{headers:{'X-Document-Store-Id':storeScope},signal:controller.signal});const data=await response.json().catch(()=>null);
   if(blockedRef.current||isStoreBlocked()||!live(session)||controller.signal.aborted||generation!==session.generation)return;
   assertPdfStoreResponse(data,storeScope,response.status,response.ok);
   if(!response.ok)throw Error(data?.error?.message||`批注载入失败 (${response.status})`);
   const next=parseSnapshot(data,documentId,sha256,pages);
   snapshotRef.current=next;setSnapshot(next);
   if(explicit&&(reloadNeededRef.current||!!draftRef.current&&previous?.revision!==next.revision)) {
    const uncertain=uncertainRef.current;
    // A lost response may have committed. Reconcile exact content before offering
    // another POST, so retrying after a network interruption cannot duplicate it.
    if(uncertain) {
     const matches=next.notes.filter(note=>sameContent(note,uncertain.draft)&&(uncertain.draft.id?note.id===uncertain.draft.id:!uncertain.before.notes.some(old=>old.id===note.id)));
     if(matches.length===1&&draftRef.current) {
      const reconciled={...draftRef.current,id:matches[0].id};setDraft(reconciled);draftRef.current=reconciled;setSelected(matches[0].id);
      setNotice('发现与提交内容一致的已保存批注。草稿已保留，请核对列表；再次保存将编辑该批注。');
     } else setNotice('已载入最新批注。请对照列表核对草稿，再确认保存；上次提交的结果可能不确定。');
    } else setNotice('已载入最新批注。请对照列表核对草稿，再确认保存。');
    setReview(!!draftRef.current);
   } else if(explicit)setNotice('批注已重新载入，未保存的草稿已保留。');
   reloadNeededRef.current=false;setMustReload(false);uncertainRef.current=null;
  } catch(reason) {if(live(session)&&!controller.signal.aborted&&generation===session.generation){if(reason instanceof PdfStoreMismatch)blockStore();else setError(message(reason));}}
  finally {session.controllers.delete(controller);if(live(session)&&generation===session.generation){session.reading=false;setLoading(false);}}
 }
 useEffect(()=>{
  const session:Session={active:true,generation:0,controllers:new Set(),writing:false,reading:false};sessionRef.current=session;
  void load(session);
  return ()=>{session.active=false;for(const controller of session.controllers)controller.abort();session.controllers.clear();};
 },[storeScope,documentId,sha256,pages]);
 useEffect(()=>{if(storeBlocked){const session=sessionRef.current;if(session){session.generation++;for(const controller of session.controllers)controller.abort();}setLoading(false);setSaving(false);}},[storeBlocked]);
 useEffect(()=>{gestureRef.current=null;setPreview(null);setDrawing(false);},[page,viewKey]);

 function start(note?:Note,rectangle=false) {
  if(blockedRef.current||isStoreBlocked()||draft||saving||loading||mustReload||!snapshot)return;
  setDraft(note?{id:note.id,page:note.page,rect:note.rect,comment:note.comment}:{id:null,page,rect:null,comment:''});
  setSelected(note?.id??null);setError('');setNotice('');setReview(false);setDrawing(rectangle);
  if(note&&note.page!==page)onNavigate(note.page);
 }
 async function save() {
  const session=sessionRef.current;const before=snapshotRef.current;const current=draftRef.current;
  if(blockedRef.current||isStoreBlocked()||!session||!live(session)||session.writing||session.reading||loading||mustReload||!before||!current)return;
  if(!validComment(current.comment)){setError('请输入批注内容，最多 4096 个 UTF-8 字节。');return;}
  if(!validRect(current.rect)){setError('矩形范围无效，请重新框选。');return;}
  if(current.id===null&&before.notes.length>=250){setError('每份文档最多保存 250 条批注。');return;}
  session.writing=true;setSaving(true);setError('');setNotice('');setDrawing(false);gestureRef.current=null;setPreview(null);
  const controller=new AbortController();session.controllers.add(controller);
  let definitelyRejected=false;
  try {
   const response=await fetch(current.id?`${base}/${current.id}`:base,{method:current.id?'PUT':'POST',headers:{'Content-Type':'application/json','X-Document-Store-Id':storeScope},body:JSON.stringify({sha256,revision:before.revision,page:current.page,rect:current.rect,comment:current.comment}),signal:controller.signal});
   const data=await response.json().catch(()=>null);
   if(blockedRef.current||isStoreBlocked()||!live(session)||controller.signal.aborted)return;
   assertPdfStoreResponse(data,storeScope,response.status,response.ok);
   if(!response.ok) {
    definitelyRejected=response.status>=400&&response.status<500;
    if(response.status===409){reloadNeededRef.current=true;setMustReload(true);setReview(false);throw Error('批注已在其他位置更新。草稿已保留，请先重新载入最新批注。');}
    throw Error(typeof data?.error?.message==='string'?data.error.message:`批注保存失败 (${response.status})`);
   }
   const next=parseSnapshot(data,documentId,sha256,pages);
   const changed=current.id?next.notes.find(note=>note.id===current.id):next.notes.find(note=>!before.notes.some(old=>old.id===note.id));
   if(next.revision!==before.revision+1||next.notes.length!==before.notes.length+(current.id?0:1)||!changed||!sameContent(changed,current))throw Error('批注保存结果不一致，请重新载入核对');
   snapshotRef.current=next;setSnapshot(next);setSelected(changed.id);setDraft(null);draftRef.current=null;setReview(false);setNotice('批注已保存');uncertainRef.current=null;
  } catch(reason) {
   if(live(session)&&!controller.signal.aborted) {
    if(reason instanceof PdfStoreMismatch){blockStore();return;}
    if(!definitelyRejected){uncertainRef.current={draft:current,before};reloadNeededRef.current=true;setMustReload(true);setReview(false);}
    setError(message(reason));
   }
  } finally {session.controllers.delete(controller);session.writing=false;if(live(session))setSaving(false);}
 }
 function point(event:PointerEvent<HTMLDivElement>) {
  const bounds=event.currentTarget.getBoundingClientRect();
  if(bounds.width<=0||bounds.height<=0)return null;
  return {x:Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width)),y:Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height))};
 }
 function rectangle(start:Gesture,end:{x:number;y:number}):AnnotationRect {return {x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(start.x-end.x),height:Math.abs(start.y-end.y)};}
 function pointerDown(event:PointerEvent<HTMLDivElement>) {
  if(!drawing||!imageReady||saving||!draft||draft.page!==page||event.button!==0||gestureRef.current)return;
  const at=point(event);if(!at)return;
  event.preventDefault();gestureRef.current={pointerId:event.pointerId,page,viewKey,...at};setPreview(null);
  event.currentTarget.setPointerCapture?.(event.pointerId);
 }
 function pointerMove(event:PointerEvent<HTMLDivElement>) {
  const gesture=gestureRef.current;if(!gesture||gesture.pointerId!==event.pointerId)return;
  const at=point(event);if(at)setPreview(rectangle(gesture,at));
 }
 function pointerUp(event:PointerEvent<HTMLDivElement>) {
  const gesture=gestureRef.current;if(!gesture||gesture.pointerId!==event.pointerId)return;
  gestureRef.current=null;setPreview(null);
  const at=point(event);const view=viewRef.current;
  if(!at||view.page!==gesture.page||view.viewKey!==gesture.viewKey||!view.imageReady)return;
  const rect=rectangle(gesture,at);
  if(!validRect(rect)){setError('框选范围太小，请重新拖动（宽和高至少为页面的 0.2%）。');return;}
  setDraft(old=>old&&old.page===gesture.page?{...old,rect}:old);setDrawing(false);setError('');
 }
 const count=snapshot?.notes.length??0;
 const onPage=snapshot?.notes.filter(note=>note.page===page&&note.rect)??[];
 return <section className="pdf-annotations" aria-label="PDF 批注">
  <div className="pdf-annotation-toolbar"><h4>页面批注（{count} / 250）</h4><button type="button" disabled={blocked||!snapshot||loading||saving||!!draft||mustReload||count>=250} onClick={()=>start()}>新增当前页批注</button><button type="button" disabled={blocked||!snapshot||loading||saving||!!draft||mustReload||count>=250||!imageReady} onClick={()=>start(undefined,true)}>框选区域批注</button><button type="button" disabled={blocked||loading||saving} onClick={()=>{const session=sessionRef.current;if(session)void load(session,true);}}>重新载入最新批注</button></div>
  <p>批注保存在本地，与 PDF 原件分开；框选只标记图片区域，不提供文字选取或 OCR。</p>
  {loading&&<p role="status">正在载入批注…</p>}
  {(error||blocked)&&<p role="alert">{blocked?new PdfStoreMismatch().message:error}{!blocked&&mustReload&&' 未保存的草稿会保留；重新载入并核对后才能再次保存。'}</p>}
  {notice&&<p role="status">{notice}</p>}
  <div className="pdf-page-viewport" aria-busy={!imageReady}>
   <div className="pdf-annotation-page">{children}
    {imageReady&&<div className={`pdf-annotation-overlay${drawing&&draft?.page===page?' is-drawing':''}`} role={drawing?'region':undefined} aria-label={drawing?'在页面图片上拖动框选批注区域':undefined} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={()=>{gestureRef.current=null;setPreview(null);}} onLostPointerCapture={()=>{gestureRef.current=null;setPreview(null);}}>
     {onPage.map(note=><button type="button" key={note.id} className={`pdf-annotation-rect${selected===note.id?' is-selected':''}`} style={styleRect(note.rect!)} aria-label={`查看第 ${note.page} 页区域批注：${note.comment}`} disabled={drawing} onClick={()=>setSelected(note.id)}/>) }
     {draft?.page===page&&draft.rect&&<div className="pdf-annotation-rect is-draft" style={styleRect(draft.rect)} aria-label="当前草稿的批注区域"/>}
     {preview&&<div className="pdf-annotation-rect is-draft" style={styleRect(preview)} aria-label="正在框选的批注区域"/>}
    </div>}
   </div>
  </div>
  {draft&&<form className="pdf-annotation-editor" noValidate onSubmit={event=>{event.preventDefault();void save();}}>
   <h4>{draft.id?'编辑':'新增'}第 {draft.page} 页{draft.rect?'区域':'页面'}批注</h4>
   {draft.page!==page&&<p>草稿仍属于第 {draft.page} 页。<button type="button" onClick={()=>onNavigate(draft.page)}>返回草稿页面</button></p>}
   <label>批注内容<textarea rows={4} value={draft.comment} disabled={saving} onChange={event=>setDraft({...draft,comment:event.target.value})}/></label>
   <p aria-live="polite">{bytes(draft.comment)} / 4096 UTF-8 字节</p>
   {draft.rect&&<p>区域：左 {Math.round(draft.rect.x*1000)/10}% · 上 {Math.round(draft.rect.y*1000)/10}% · 宽 {Math.round(draft.rect.width*1000)/10}% · 高 {Math.round(draft.rect.height*1000)/10}%</p>}
   {drawing&&<p role="status">请在图片上拖动框选。也可取消框选，保存整页批注。</p>}
   <div className="pdf-annotation-actions"><button type="button" disabled={saving||draft.page!==page||!imageReady} onClick={()=>{setDrawing(!drawing);gestureRef.current=null;setPreview(null);}}>{drawing?'取消框选':'重新框选区域'}</button>{draft.rect&&<button type="button" disabled={saving} onClick={()=>{setDraft({...draft,rect:null});setDrawing(false);}}>改为整页批注</button>}<button type="submit" disabled={blocked||saving||loading||mustReload||drawing||!validComment(draft.comment)}>{saving?'正在保存批注…':review?'确认保存草稿':'保存批注'}</button><button type="button" disabled={saving} onClick={()=>{setDraft(null);draftRef.current=null;setDrawing(false);gestureRef.current=null;setPreview(null);setReview(false);setError(mustReload?'请先重新载入最新批注，再继续编辑。':'');setNotice('');}}>放弃草稿</button></div>
  </form>}
  {snapshot&&<div className="pdf-annotation-list" aria-label="已保存的批注列表">{count===0?<p>尚无批注</p>:<ol>{snapshot.notes.map(note=><li key={note.id} className={selected===note.id?'is-selected':''} aria-current={selected===note.id?'true':undefined}><strong>第 {note.page} 页 · {note.rect?'区域批注':'页面批注'}</strong><p className="pdf-annotation-comment">{note.comment}</p><small>更新于 {note.updatedAt}</small><div className="pdf-annotation-actions"><button type="button" onClick={()=>{setSelected(note.id);onNavigate(note.page);}}>查看第 {note.page} 页批注</button><button type="button" disabled={blocked||!!draft||saving||loading||mustReload} onClick={()=>start(note)}>编辑批注</button></div></li>)}</ol>}</div>}
 </section>;
}
