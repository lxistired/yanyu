import {fetchPdfPageImage, PdfImageAuthorityError, type PdfImageReceipt} from './pdf-page-image';
import {assertPdfStoreResponse, PdfStoreMismatch, validPdfStoreScope} from './pdf-store-scope';
import {useEffect, useRef, useState} from 'react';
import {PdfAnnotations} from './PdfAnnotations';
import {PdfTextFind} from './PdfTextFind';
import {ResearchRequestOwner} from './local-research-search';

type Scale = 75 | 100 | 150;
type Position = {page:number; bookmark:number|null; scale:Scale};
type Reader = Position & {pages:number; sha256:string};
type Save = {position:Position; version:number; pages:number; sha256:string};
type Session = {active:boolean; controllers:Set<AbortController>; writing:boolean; pending:Save|null; desired:Save|null; version:number};
type Props = {storeScope:string;documentId:string; documentName:string; selectedSha256:string; selectedPages:number|null; onClose?:()=>void};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const errorMessage = (error:unknown) => error instanceof Error ? error.message : '请求失败，请重试';
const validSelection = (hash:unknown,pages:unknown) => typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash)&&typeof pages==='number'&&Number.isInteger(pages)&&pages>=1&&pages<=40;
function parseReader(value:unknown):Reader {
 const data=value as Reader|null;
 if(!data||!Number.isInteger(data.pages)||data.pages<1||data.pages>40||!Number.isInteger(data.page)||data.page<1||data.page>data.pages||!(data.bookmark===null||(Number.isInteger(data.bookmark)&&data.bookmark>=1&&data.bookmark<=data.pages))||![75,100,150].includes(data.scale)||typeof data.sha256!=='string'||!/^[a-f0-9]{64}$/.test(data.sha256))throw Error('阅读状态无效，请重新载入');
 return {page:data.page,bookmark:data.bookmark,scale:data.scale,pages:data.pages,sha256:data.sha256};
}
async function readResponse(response:Response,storeScope:string,selectedSha256:string,selectedPages:number|null,mismatchMessage='阅读状态与所选 PDF 原件不一致，请重新打开'):Promise<Reader> {
 if(response.status===401||response.status===403){try{void response.body?.cancel().catch(()=>{});}catch{}throw new PdfImageAuthorityError();}
 const data=await response.json().catch(()=>null);
 assertPdfStoreResponse(data,storeScope,response.status,response.ok);
 if(!response.ok)throw Error(typeof data?.error?.message==='string'?data.error.message:`请求失败 (${response.status})`);
 const reader=parseReader(data);
 if(reader.sha256!==selectedSha256||reader.pages!==selectedPages)throw Error(mismatchMessage);
 return reader;
}

/** The keyed session prevents one document's late responses from entering another reader. */
export function PdfPageReader(props:Props) {
 const key=JSON.stringify([props.storeScope,typeof props.documentId==='string'?props.documentId:null,validSelection(props.selectedSha256,props.selectedPages)?[props.selectedSha256,props.selectedPages]:null]);
 return <PdfReaderSession key={key} {...props}/>;
}

function PdfReaderSession({storeScope,documentId,documentName,selectedSha256,selectedPages,onClose}:Props) {
 const blockedRef=useRef(false);
 const [blocked,setBlocked]=useState(false);
 const [reader,setReader]=useState<Reader|null>(null);
 const [loadError,setLoadError]=useState('');
 const [loadRevision,setLoadRevision]=useState(0);
 const [jump,setJump]=useState('');
 const [jumpError,setJumpError]=useState('');
 const [imageAttempt,setImageAttempt]=useState(0);
 const [pageImage,setPageImage]=useState<(PdfImageReceipt&{key:string})|null>(null);
 const acceptedImage=useRef<(PdfImageReceipt&{key:string})|null>(null);
 const decodedImage=useRef<PdfImageReceipt|null>(null);
 const [imageStatus,setImageStatus]=useState<'loading'|'loaded'|'error'>('loading');
 const [saveStatus,setSaveStatus]=useState<'idle'|'saving'|'saved'|'error'>('idle');
 const [saveError,setSaveError]=useState('');
 const [savedPage,setSavedPage]=useState<number|null>(null);
 const sessionRef=useRef<Session|null>(null);
 const textFindOwner=useRef(new ResearchRequestOwner());
 const imageKey=reader?`${storeScope}:${documentId}:${loadRevision}:${reader.page}:${reader.scale}:${imageAttempt}`:'';
 const currentImage=useRef(imageKey);currentImage.current=imageKey;
 const live=(session:Session)=>session.active&&sessionRef.current===session;

 function blockStore(message=new PdfStoreMismatch().message){blockedRef.current=true;textFindOwner.current.cancel();setBlocked(true);const session=sessionRef.current;if(session){session.pending=null;session.desired=null;for(const request of session.controllers)request.abort();}acceptedImage.current=null;decodedImage.current=null;setPageImage(null);setImageStatus('error');setSavedPage(null);setSaveStatus('error');setSaveError(message);}

 useEffect(()=>{
  if(blockedRef.current)return;
  const session:Session={active:true,controllers:new Set(),writing:false,pending:null,desired:null,version:0};sessionRef.current=session;
  setReader(null);setLoadError('');setSaveError('');setSaveStatus('idle');setImageStatus('loading');setJumpError('');setSavedPage(null);
  const controller=new AbortController();session.controllers.add(controller);
  if(typeof documentId!=='string'||!uuid.test(documentId))setLoadError('无效文档标识');
  else if(!validPdfStoreScope(storeScope)){blockStore();setLoadError(new PdfStoreMismatch().message);}
  else if(!validSelection(selectedSha256,selectedPages))setLoadError('所选 PDF 原件信息无效，请重新打开');
  else void fetch(`/api/documents/${documentId}/reader`,{headers:{'X-Document-Store-Id':storeScope},signal:controller.signal}).then(response=>readResponse(response,storeScope,selectedSha256,selectedPages)).then(data=>{
   if(!live(session)||controller.signal.aborted)return;
   setReader(data);setJump(String(data.page));setSavedPage(data.page);
  }).catch(error=>{if(live(session)&&!controller.signal.aborted){if(error instanceof PdfStoreMismatch)blockStore();else if(error instanceof PdfImageAuthorityError)blockStore(error.message);setLoadError(errorMessage(error));}}).finally(()=>session.controllers.delete(controller));
  return ()=>{textFindOwner.current.cancel();session.active=false;session.pending=null;for(const request of session.controllers)request.abort();session.controllers.clear();};
 },[storeScope,documentId,selectedSha256,selectedPages,loadRevision]);

 useEffect(()=>{
  const session=sessionRef.current;
  textFindOwner.current.cancel();acceptedImage.current=null;decodedImage.current=null;setPageImage(null);
  if(blockedRef.current||!reader||!session||!live(session))return;
  const controller=new AbortController();session.controllers.add(controller);setImageStatus('loading');
  const current=()=>{if(blockedRef.current||!live(session)||controller.signal.aborted||currentImage.current!==imageKey)throw Error('PDF 图片请求已过期');};
  void fetchPdfPageImage({storeScope,documentId,sha256:reader.sha256,pages:reader.pages,page:reader.page,scale:reader.scale},controller.signal,current).then(receipt=>{
   current();const image={...receipt,key:imageKey};acceptedImage.current=image;setPageImage(image);
  }).catch(error=>{if(live(session)&&!controller.signal.aborted&&currentImage.current===imageKey){if(error instanceof PdfImageAuthorityError)blockStore(error.message);else {textFindOwner.current.cancel();setImageStatus('error');}}}).finally(()=>session.controllers.delete(controller));
  return ()=>{controller.abort();session.controllers.delete(controller);acceptedImage.current=null;decodedImage.current=null;};
 },[imageKey]);

 // Only one write per mounted reader is in flight. Newer desired states replace queued
 // ones; an older response can neither rewind the page nor announce the newer save.
 async function drainSaves(session:Session) {
  if(session.writing)return;
  session.writing=true;
  try {
   while(live(session)&&!blockedRef.current&&session.pending) {
    const save=session.pending;session.pending=null;
    const controller=new AbortController();session.controllers.add(controller);
    try {
     const response=await fetch(`/api/documents/${documentId}/reader`,{method:'PUT',headers:{'Content-Type':'application/json','X-Document-Store-Id':storeScope},body:JSON.stringify(save.position),signal:controller.signal});
     const data=await readResponse(response,storeScope,selectedSha256,selectedPages,'保存结果与阅读状态不一致，请重试');
     if(!live(session)||controller.signal.aborted)return;
     if(data.sha256!==save.sha256||data.pages!==save.pages||data.page!==save.position.page||data.bookmark!==save.position.bookmark||data.scale!==save.position.scale)throw Error('保存结果与阅读状态不一致，请重试');
     setSavedPage(data.page);
     if(session.version===save.version){setSaveStatus('saved');setSaveError('');}
    } catch(error) {
     if(live(session)&&!controller.signal.aborted&&(error instanceof PdfStoreMismatch||error instanceof PdfImageAuthorityError)){blockStore(error.message);return;}
     if(live(session)&&!controller.signal.aborted&&session.version===save.version){setSaveStatus('error');setSaveError(errorMessage(error));}
    } finally {session.controllers.delete(controller);}
   }
  } finally {session.writing=false;}
 }
 function savePosition(next:Reader) {
  const session=sessionRef.current;const image=acceptedImage.current;if(blockedRef.current||!session||!live(session)||!reader||!image||decodedImage.current!==image||image.key!==currentImage.current||next.page!==reader.page||next.scale!==reader.scale||next.sha256!==reader.sha256||next.pages!==reader.pages)return;
  const save:Save={position:{page:next.page,bookmark:next.bookmark,scale:next.scale},pages:next.pages,sha256:next.sha256,version:++session.version};
  session.desired=save;session.pending=save;setSaveError('');setSaveStatus('saving');void drainSaves(session);
 }
 function navigate(page:number,scale:Scale=reader?.scale??100) {
  if(blockedRef.current||!reader||!Number.isInteger(page)||page<1||page>reader.pages)return;
  setJump(String(page));setJumpError('');
  if(page===reader.page&&scale===reader.scale)return;
  textFindOwner.current.cancel();setImageStatus('loading');setReader({...reader,page,scale});
 }
 function jumpToPage() {
  if(!reader)return;
  if(!/^[1-9][0-9]*$/.test(jump)||Number(jump)>reader.pages){setJumpError(`请输入 1 至 ${reader.pages} 之间的整数页码`);return;}
  navigate(Number(jump));
 }
 function bookmark() {
  if(blockedRef.current||!reader||imageStatus!=='loaded')return;
  const next={...reader,bookmark:reader.bookmark===reader.page?null:reader.page};setReader(next);savePosition(next);
 }
 function imageLoaded(image:PdfImageReceipt&{key:string}) {
  const session=sessionRef.current;
  if(blockedRef.current||!reader||!session||!live(session)||currentImage.current!==imageKey||image.key!==imageKey||acceptedImage.current!==image||decodedImage.current===image)return;
  decodedImage.current=image;setImageStatus('loaded');savePosition(reader);
 }
 const findImage=pageImage&&imageStatus==='loaded'&&!blocked&&pageImage.key===imageKey&&acceptedImage.current===pageImage&&decodedImage.current===pageImage?pageImage:null;
 const findSourceCurrent=()=>{const session=sessionRef.current;return !!findImage&&!blockedRef.current&&!!session&&live(session)&&acceptedImage.current===findImage&&decodedImage.current===findImage&&currentImage.current===findImage.key;};
 return <section className="pdf-page-reader" aria-label="PDF 页面阅读器">
  <header><h3>{documentName}</h3>{onClose&&<button type="button" onClick={onClose}>关闭 PDF 阅读器</button>}<p>PDF 页面由本机转换成图片。链接、脚本和附件不会作为交互内容打开；可另选“预览纯文本”读取提取文字。</p></header>
  {loadError?<div role="alert">{loadError}<button type="button" disabled={blocked} onClick={()=>setLoadRevision(value=>value+1)}>重试载入阅读器</button></div>:!reader?<p role="status">正在载入 PDF 阅读状态…</p>:<>
   {findImage&&<PdfTextFind key={imageKey} selection={{storeScope,documentId,sha256:reader.sha256,pages:reader.pages}} owner={textFindOwner.current} isSourceCurrent={findSourceCurrent} onSourceInvalid={blockStore}/>}
   <p className="pdf-page-count" aria-live="polite">第 {reader.page} / {reader.pages} 页 · 缩放 {reader.scale}%</p>
   <div className="pdf-reader-controls">
    <button type="button" disabled={reader.page===1} onClick={()=>navigate(reader.page-1)}>PDF 上一页</button>
    <button type="button" disabled={reader.page===reader.pages} onClick={()=>navigate(reader.page+1)}>PDF 下一页</button>
    <form noValidate onSubmit={event=>{event.preventDefault();jumpToPage();}}><label>PDF 页码<input type="number" inputMode="numeric" min={1} max={reader.pages} step={1} value={jump} onChange={event=>{setJump(event.target.value);setJumpError('');}}/></label><button>跳转页面</button></form>
    <label>PDF 缩放<select value={reader.scale} onChange={event=>navigate(reader.page,Number(event.target.value) as Scale)}><option value={75}>75%</option><option value={100}>100%</option><option value={150}>150%</option></select></label>
   </div>
   {jumpError&&<p role="alert">{jumpError}</p>}
   <div className="pdf-bookmark-controls"><button type="button" disabled={imageStatus!=='loaded'} aria-pressed={reader.bookmark===reader.page} onClick={bookmark}>{reader.bookmark===reader.page?'移除当前页书签':'将当前页设为书签'}</button>{reader.bookmark!==null?<><span>书签：第 {reader.bookmark} 页</span><button type="button" onClick={()=>navigate(reader.bookmark!)}>转到书签</button></>:<span>尚无书签</span>}</div>
   {savedPage!==null&&<p>上次保存的阅读位置：第 {savedPage} 页</p>}
   {saveStatus==='saving'&&<p role="status">正在保存阅读位置与书签…</p>}
   {saveStatus==='saved'&&<p role="status">阅读位置与书签已保存</p>}
   {saveStatus==='error'&&<div role="alert">保存失败：{saveError}<button type="button" disabled={blocked||imageStatus!=='loaded'} onClick={()=>{const desired=sessionRef.current?.desired;if(desired)savePosition({...desired.position,pages:desired.pages,sha256:desired.sha256});}}>重试保存阅读状态</button></div>}
   {imageStatus==='loading'&&<p role="status">正在生成第 {reader.page} 页图片…</p>}
   {imageStatus==='error'&&<div role="alert">页面图片加载失败，阅读位置尚未更新。<button type="button" disabled={blocked} onClick={()=>{if(blockedRef.current)return;textFindOwner.current.cancel();setImageStatus('loading');setImageAttempt(value=>value+1);}}>重试页面图片</button></div>}
   <PdfAnnotations storeScope={storeScope} storeBlocked={blocked} isStoreBlocked={()=>blockedRef.current} onStoreMismatch={blockStore} key={`${storeScope}:${loadRevision}:${reader.sha256}`} documentId={documentId} sha256={reader.sha256} pages={reader.pages} page={reader.page} viewKey={imageKey} imageReady={imageStatus==='loaded'} onNavigate={navigate}>{pageImage?.key===imageKey&&!blocked&&<img key={imageKey} src={pageImage.dataUrl} data-source-url={pageImage.sourceUrl} alt={`${documentName}，第 ${reader.page} 页，共 ${reader.pages} 页`} hidden={imageStatus==='error'} onLoad={()=>imageLoaded(pageImage)} onError={()=>{const session=sessionRef.current;if(session&&live(session)&&currentImage.current===imageKey&&acceptedImage.current===pageImage){textFindOwner.current.cancel();acceptedImage.current=null;decodedImage.current=null;setImageStatus('error');}}}/> }</PdfAnnotations>
   <p className="local-document-hash">原件 SHA-256：{reader.sha256}</p>
  </>}
 </section>;
}
