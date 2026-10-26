import type {PdfOpenIntent} from './pdf-open-intent';
import {PDF_OPEN_UNAVAILABLE_REASON, pdfOpenSelectionFromDocument, samePdfOpenSelection} from './pdf-open-selection';
import {workspaceIdentifier} from './workspace-identifier';
import {allowLeavingUnsavedWork, useUnsavedWork, useUnsavedHistoryDismiss} from './unsaved-work';
import {useCallback, useEffect, useRef, useState} from 'react';
import {DocumentCitations} from './DocumentCitations';
import {PdfPageReader} from './PdfPageReader';
import {bindDocumentDownload,verifyDocumentDownload,DocumentDownloadError} from './document-download';
import {forgetUploadRecord,newUploadRecord,readUploadRecords,retainUploadRecord,UPLOAD_JOURNAL_PREFIX,validUploadScope,verifyUploadFile,verifyUploadReceipt,type UploadRecord} from './document-upload-journal';
import {DocumentUploadAttemptTimeoutError,runDocumentUploadAttempt} from './document-upload-attempt';
import './local-documents.css';

type Folder = {id:string; name:string; workspaceId:string|null};
type Choices = {workspaces:{id:string; name:string}[]; folders:Folder[]; uploadScope?:string};
type DocumentRecord = {revision:number; trashedAt:string|null;id:string; name:string; format:'txt'|'md'|'pdf'; bytes:number; sha256:string; textSha256:string; createdAt:string; pages:number|null; workspaceId:string|null; folderId:string|null; workspaceName:string|null; folderName:string|null; stale:boolean};
type DocumentPreview = {document:DocumentRecord&{storeScope:string};text:string;request:number;generation:number};
type Listing = {storeScope?:string;documents:DocumentRecord[]; total:number; offset:number; limit:number};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const invalidFolderResponse='文件夹响应无效，草稿已保留；请核对文件夹列表后再重试。';
// Validate before a React state updater can capture an untrusted response.
function createdFolder(value:unknown):Folder {
 const data=value as {folder?:unknown}|null;
 const folder=data&&typeof data==='object'&&!Array.isArray(data)?data.folder:null;
 const f=folder as Partial<Folder>|null;
 if(!f||typeof f!=='object'||Array.isArray(f)||typeof f.id!=='string'||!uuid.test(f.id)||
    typeof f.name!=='string'||!f.name.trim()||/[\\/\u0000-\u001f\u007f]/u.test(f.name)||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(f.name)||new TextEncoder().encode(f.name).length>512||
    !(f.workspaceId===null||workspaceIdentifier(f.workspaceId))){
  throw Error(invalidFolderResponse);
 }
 return {id:f.id,name:f.name,workspaceId:f.workspaceId};
}
async function checked(response:Response) {
 if (!response.ok) {
  const body = await response.json().catch(()=>null);
  throw Object.assign(new Error(typeof body?.error?.message === 'string' ? body.error.message : `请求失败 (${response.status})`),{status:response.status});
 }
 return response;
}
const message = (error:unknown) => error instanceof Error ? error.message : '请求失败，请重试';
// Disposal is best-effort and never becomes another wait after an attempt expires.
function discardUploadResponse(response:Response){try{void response.body?.cancel().catch(()=>{});}catch{}}

/** Local-only document storage. Extracted source text is never rendered as markup. */
export function LocalDocuments({pdfOpenIntent=null}:{pdfOpenIntent?:PdfOpenIntent|null}={}) {
 const [view,setView]=useState<'active'|'trash'>('active');
 const [editing,setEditing]=useState<DocumentRecord|null>(null);
 // Each opening owns its immutable raw-input baseline and revision, independent of list refreshes.
 const editSession=useRef<{owner:symbol; baseline:DocumentRecord; scope:string|undefined}|null>(null);
 const metadataInputs=(document:DocumentRecord)=>JSON.stringify([document.name,document.workspaceId,document.folderId]);
 useUnsavedWork(!!editing&&!!editSession.current&&metadataInputs(editing)!==metadataInputs(editSession.current.baseline));
 const [confirmTrash,setConfirmTrash]=useState<DocumentRecord|null>(null);
 const [choices,setChoices]=useState<Choices>({workspaces:[],folders:[]});
 const [choicesReady,setChoicesReady]=useState(false);
 const [workspace,setWorkspace]=useState('');
 const [folder,setFolder]=useState('');
 const [folderName,setFolderName]=useState('');
 const [file,setFile]=useState<File|null>(null);
 // Selection identity belongs to this in-memory draft, not merely to a filename.
 const uploadDraft=useRef<{owner:symbol; operationId?:string}|null>(null);
 const folderDraft=useRef<symbol|null>(null);
 useUnsavedWork(file!==null);
 useUnsavedWork(folderName!=='');
 const [pendingUploads,setPendingUploads]=useState<UploadRecord[]>([]);
 const [retryFiles,setRetryFiles]=useState<Record<string,File>>({});
 const [uploadStorageError,setUploadStorageError]=useState('');
 const [query,setQuery]=useState('');
 const [search,setSearch]=useState('');
 const [offset,setOffset]=useState(0);
 const [revision,setRevision]=useState(0);
 const [listing,setListing]=useState<Listing>({documents:[],total:0,offset:0,limit:10});
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState('');
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [preview,setPreview]=useState<DocumentPreview|null>(null);
 const [readerDocument,setReaderDocument]=useState<{document:DocumentRecord;storeScope:string}|null>(null);
 const [pdfOpenStatus,setPdfOpenStatus]=useState('');
 const pdfAdmission=useRef<AbortController|null>(null);
 const currentIntent=useRef(pdfOpenIntent);currentIntent.current=pdfOpenIntent;
 // Any newer local interaction wins before its handler can create a draft or viewer.
 const withdrawPdfOpen=()=>{
  if(!pdfOpenIntent?.pending)return;
  pdfOpenIntent.pending=false;pdfAdmission.current?.abort();
  setPdfOpenStatus('已取消直接打开；可在文档列表重新选择。');
 };
 useEffect(()=>{
  const intent=pdfOpenIntent;if(!intent?.current())return;
  const controller=new AbortController();pdfAdmission.current=controller;
  const owns=()=>!controller.signal.aborted&&pdfAdmission.current===controller&&currentIntent.current===intent&&intent.current();
  const get=async(url:string,headers?:Record<string,string>)=>{
   const response=await fetch(url,{signal:controller.signal,headers});
   if(!owns())throw Error('withdrawn');
   if(!response.ok)throw Error('unavailable');
   const reader=response.body?.getReader();if(!reader)throw Error('empty');
   const abortBody=()=>{void reader.cancel().catch(()=>{});};
   controller.signal.addEventListener('abort',abortBody,{once:true});
   const chunks:Uint8Array[]=[];let size=0;
   try{while(true){const part=await reader.read();if(!owns())throw Error('withdrawn');if(part.done)break;size+=part.value.byteLength;if(size>2*1024*1024)throw Error('oversized');chunks.push(part.value);}}
   catch(error){await reader.cancel().catch(()=>{});throw error;}finally{controller.signal.removeEventListener('abort',abortBody);reader.releaseLock();}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
   const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!owns())throw Error('withdrawn');return value;
  };
  const timeout=setTimeout(()=>{if(owns()){intent.pending=false;setPdfOpenStatus('所选 PDF 核对超时，未打开；请在文档列表重新选择。');controller.abort();}},15000);
  setPdfOpenStatus('正在核对所选 PDF…');
  void (async()=>{
   try{
    const discovery=await get('/api/documents/choices') as {uploadScope?:unknown}|null;
    if(!discovery||discovery.uploadScope!==intent.selection.storeScope)throw Error('changed');
    const detail=await get(`/api/documents/${intent.selection.documentId}`,{'X-Citation-Store-Id':intent.selection.storeScope}) as {storeScope?:unknown;document?:DocumentRecord}|null;
    const pin=detail&&typeof detail.storeScope==='string'?pdfOpenSelectionFromDocument(detail.document,detail.storeScope):null;
    if(!pin||!samePdfOpenSelection(pin,intent.selection)||!detail?.document||typeof detail.document.name!=='string'||detail.document.name.length>512)throw Error('changed');
    if(!owns())return;
    // Discovery and admission are not authority: PdfPageReader performs its own live gates.
    intent.pending=false;setReaderDocument({document:{...detail.document},storeScope:pin.storeScope});setPdfOpenStatus('');
   }catch{
    if(!owns())return;
    intent.pending=false;setPdfOpenStatus('所选 PDF 已变化或暂不可用，未打开；请在文档列表重新核对并选择。');
   }finally{clearTimeout(timeout);}
  })();
  // StrictMode aborts this request but leaves an unconsumed intent restartable.
  return ()=>{clearTimeout(timeout);controller.abort();if(pdfAdmission.current===controller)pdfAdmission.current=null;};
 },[pdfOpenIntent]);
 const fileInput=useRef<HTMLInputElement>(null);
 const alive=useRef(false);
 const controllers=useRef(new Set<AbortController>());
 // The controller owns this lock; a retired attempt may never release a newer one.
 const lock=useRef<AbortController|null>(null);
 const previewRequest=useRef(0);
 const listingGeneration=useRef(0);
 const visibleScope=useRef<string|undefined>(undefined);visibleScope.current=listing.storeScope;
 const filteredFolders=choices.folders.filter(item=>item.workspaceId===(workspace||null));
 useEffect(()=>{
  alive.current=true;
  const controller=new AbortController();controllers.current.add(controller);
  fetch('/api/documents/choices',{signal:controller.signal}).then(checked).then(r=>r.json()).then((data:Choices)=>{if(!controller.signal.aborted){setChoices(data);setChoicesReady(true);}}).catch(e=>{if(!controller.signal.aborted)setError(message(e));}).finally(()=>controllers.current.delete(controller));
  return ()=>{alive.current=false;for(const request of controllers.current)request.abort();controllers.current.clear();};
 },[]);
 function refreshUploads(scope:string){
  try{const records=readUploadRecords(window.localStorage,scope);setPendingUploads(records);setUploadStorageError('');return records}
  catch(error){setUploadStorageError(message(error));throw error}
 }
 useEffect(()=>{
  if(!choicesReady)return;
  if(!validUploadScope(choices.uploadScope)){setUploadStorageError('未取得本地文档库标识，暂不可上传；请刷新文档页。');return}
  const scope=choices.uploadScope;
  const refresh=()=>{try{refreshUploads(scope)}catch{/* The visible storage error blocks new uploads. */}};
  refresh();
  const changed=(event:StorageEvent)=>{if(event.key===null||event.key.startsWith(UPLOAD_JOURNAL_PREFIX+scope+':'))refresh()};
  window.addEventListener('storage',changed);return ()=>window.removeEventListener('storage',changed);
 },[choicesReady,choices.uploadScope]);
 useEffect(()=>{
  listingGeneration.current++;
  setListing({documents:[],total:0,offset,limit:10});
  if(!choicesReady)return;
  const scope=choices.uploadScope;
  if(!validUploadScope(scope)){setLoading(false);return;}
  const controller=new AbortController();controllers.current.add(controller);setLoading(true);
  const params=new URLSearchParams({q:search,offset:String(offset),limit:'10',view});
  if(workspace)params.set('workspaceId',workspace);
  if(folder)params.set('folderId',folder);
  fetch(`/api/documents?${params}`,{headers:{'X-Document-Store-Id':scope},signal:controller.signal}).then(checked).then(r=>r.json()).then((data:Listing)=>{
   if(!data||data.storeScope!==scope||!Array.isArray(data.documents))throw new DocumentDownloadError('文档库范围或列表响应已变化，请重新进入文档页核对');
   if(!controller.signal.aborted)setListing(data);
  }).catch(()=>{if(!controller.signal.aborted){setError(editSession.current?'无法核对当前文档库，现有编辑仍保留；保存将使用打开时的版本。请稍后重试。':'无法核对当前文档库，请重新进入文档页重试');}}).finally(()=>{controllers.current.delete(controller);if(!controller.signal.aborted)setLoading(false);});
  return ()=>controller.abort();
 },[workspace,folder,search,offset,revision,view,choicesReady,choices.uploadScope]);
 const ownsAction=(controller:AbortController)=>alive.current&&lock.current===controller&&!controller.signal.aborted;
 async function action(label:string,work:(controller:AbortController)=>Promise<void>,uploadAttempt=false) {
  if(lock.current)return;
  const controller=new AbortController();lock.current=controller;controllers.current.add(controller);
  setBusy(label);setError('');setNotice('');
  try {if(uploadAttempt)await runDocumentUploadAttempt(controller,()=>work(controller));else await work(controller);}
  catch(e) {
   if(alive.current&&lock.current===controller){
    if(uploadAttempt&&e instanceof DocumentUploadAttemptTimeoutError)setNotice(e.message);
    else if(!controller.signal.aborted)setError(message(e));
   }
  }
  finally {
   controllers.current.delete(controller);
   if(lock.current===controller){lock.current=null;if(alive.current)setBusy('');}
  }
 }
 const closePreview=useCallback(()=>{editSession.current=null;setEditing(null);setConfirmTrash(null);previewRequest.current++;setPreview(null);setReaderDocument(null);},[]);
 const dismissHistory=useCallback(()=>{
  if(currentIntent.current)currentIntent.current.pending=false;pdfAdmission.current?.abort();
  closePreview();uploadDraft.current=null;folderDraft.current=null;
  setFile(null);setFolderName('');if(fileInput.current)fileInput.current.value='';
 },[closePreview]);
 const historyIssue = useUnsavedHistoryDismiss(dismissHistory);
 function openMetadata(document:DocumentRecord){
  if(lock.current||!allowLeavingUnsavedWork())return;
  closePreview();editSession.current={owner:Symbol('document-metadata'),baseline:{...document},scope:choices.uploadScope};setEditing({...document});
 }
 function saveMetadata(document:DocumentRecord){
  const session=editSession.current;if(!session||lock.current)return;
  // Saving this form is not abandonment of this or another mounted editor.
  void action('metadata',async controller=>{
   const owns=()=>alive.current&&!controller.signal.aborted&&editSession.current===session;
   if(session.scope!==choices.uploadScope)throw Error('文档库范围已变化，原编辑仍保留，请取消后重新打开。');
   try{
    await checked(await fetch(`/api/documents/${document.id}/metadata`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:session.baseline.revision,name:document.name,workspaceId:document.workspaceId,folderId:document.folderId}),signal:controller.signal}));
   }catch(error){if(owns())throw error;return;}
   if(!owns())return;
   editSession.current=null;setEditing(null);setOffset(0);setRevision(v=>v+1);setNotice('文档资料已更新；原件内容未改变。');
  });
 }
 function changeWorkspace(value:string){if(!allowLeavingUnsavedWork())return;setWorkspace(value);setFolder('');setOffset(0);closePreview();setError('');}
 function finishUpload(record:UploadRecord,data:{receipt:unknown;document:DocumentRecord}){
  const receipt=verifyUploadReceipt(record,data.receipt);
  if(!data.document||data.document.id!==receipt.documentId||data.document.sha256!==receipt.sha256)throw Error('上传结果与原操作不符，已保留待确认记录。');
  forgetUploadRecord(window.localStorage,record);refreshUploads(record.scope);
  setRetryFiles(old=>{const next={...old};delete next[record.operationId];return next});
  // Receipt reconciliation may concern an older operation while a different file is selected.
  if(uploadDraft.current?.operationId===record.operationId){
   uploadDraft.current=null;setFile(null);if(fileInput.current)fileInput.current.value='';
  }
  setOffset(0);setRevision(v=>v+1);
  setNotice(data.document.trashedAt?'已核实原上传已保存，目前在文档回收站；没有再次创建文档。':'已核实文档已保存到本地。同一上传操作只保存一次；若未显示，请清除筛选后查看。');
 }
 async function sendUpload(record:UploadRecord,selected:File,controller:AbortController){
  retainUploadRecord(window.localStorage,record);refreshUploads(record.scope);
  const params=new URLSearchParams({name:record.name});if(record.workspaceId)params.set('workspaceId',record.workspaceId);if(record.folderId)params.set('folderId',record.folderId);
  try{
   const response=await fetch(`/api/documents/upload?${params}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Upload-Operation-Id':record.operationId,'X-Upload-Store-Id':record.scope},body:selected,signal:controller.signal});
   if(!ownsAction(controller)){discardUploadResponse(response);return;}
   const data=await (await checked(response)).json();if(!ownsAction(controller))return;finishUpload(record,data);
  }catch(error){
   // A rejected attempt cannot establish the outcome of an earlier same-operation request.
   // Only a verified committed receipt or explicit local abandonment settles this journal entry.
   if(ownsAction(controller))setNotice('未取得成功回执，已保留原操作。请先核对结果，或重新选择原文件后用原操作重试。校验拒绝也不会自动清除恢复记录。');
   throw error;
  }
 }
 function upload(){
  if(!file)return;
  if(!/\.(txt|md|pdf)$/i.test(file.name)){setError('仅支持 TXT、MD 或 PDF 文件');return;}
  if(!file.size||file.size>8*1024*1024){setError('文件必须非空且不超过 8 MiB');return;}
  const selected=file,scope=choices.uploadScope,session=uploadDraft.current;
  if(!validUploadScope(scope)){setError('未取得本地文档库标识，暂不可上传');return}
  void action('upload',async controller=>{
   if(refreshUploads(scope).length)throw Error('请先核对待确认的上传，避免创建重复文档。');
   const record=await newUploadRecord(scope,selected,workspace||null,folder||null);
   if(!ownsAction(controller))return;
   if(uploadDraft.current===session&&session)session.operationId=record.operationId;
   await sendUpload(record,selected,controller);
  },true);
 }
 function checkUpload(record:UploadRecord){
  void action('check-'+record.operationId,async controller=>{
   const response=await fetch(`/api/documents/upload-operations/${record.operationId}`,{signal:controller.signal});
   if(!ownsAction(controller)){discardUploadResponse(response);return;}
   const data=await (await checked(response)).json();
   if(!ownsAction(controller))return;
   if(data.scope!==record.scope||data.operationId!==record.operationId)throw Error('本地文档库或上传操作已改变，已保留原恢复记录。');
   if(data.outcome==='absent'){setNotice('暂未查到提交回执，不能据此认定上传失败。原操作仍保留；可以稍后再核对，或重新选择原文件后用原操作重试。');return}
   if(data.outcome!=='committed')throw Error('无法确认上传结果，已保留原操作。');
   finishUpload(record,data);
  },true);
 }
 function retryUpload(record:UploadRecord){
  const selected=retryFiles[record.operationId];if(!selected)return;
  void action('retry-'+record.operationId,async controller=>{
   await verifyUploadFile(record,selected);if(!ownsAction(controller))return;
   await sendUpload(record,selected,controller);
  },true);
 }
 function abandonUpload(record:UploadRecord){
  if(lock.current||!window.confirm('仅移除此浏览器中的恢复记录，不会取消服务端上传或删除已保存文档。原操作可能仍会完成；之后重新上传会作为新操作，可能创建重复文档。确定放弃追踪吗？'))return;
  try{forgetUploadRecord(window.localStorage,record);refreshUploads(record.scope);setRetryFiles(old=>{const next={...old};delete next[record.operationId];return next});setNotice('已移除本地恢复记录。服务端上传没有被取消；重新上传前请检查文档列表，避免重复。')}
  catch(error){setError(message(error))}
 }
 function createFolder(){
  // Submitting this draft is not abandoning another mounted editor.
  const name=folderName.trim(),session=folderDraft.current;if(!name||!session)return;
  void action('folder',async controller=>{
   const owns=()=>alive.current&&!controller.signal.aborted&&folderDraft.current===session;
   let created:Folder;
   try{
    const response=await checked(await fetch('/api/documents/folders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,workspaceId:workspace||null}),signal:controller.signal}));
    created=createdFolder(await response.json().catch(()=>{throw Error(invalidFolderResponse)}));
   }catch(error){
    // Only the submitting draft may surface its failure; action still releases its lock.
    if(owns())throw error;
    return;
   }
   if(!owns())return;
   setChoices(old=>({...old,folders:[...old.folders.filter(f=>f.id!==created.id),created]}));
   folderDraft.current=null;setFolder(created.id);setOffset(0);setFolderName('');setNotice('本地文件夹已创建');
  });
 }
 function openPreview(document:DocumentRecord){if(!allowLeavingUnsavedWork())return;
  if(lock.current)return;
  closePreview();const request=++previewRequest.current;
  const id=document.id,scope=listing.storeScope,generation=listingGeneration.current;
  void action(`preview-${id}`,async controller=>{
   const current=()=>alive.current&&!controller.signal.aborted&&request===previewRequest.current&&listingGeneration.current===generation&&visibleScope.current===scope;
   try {
    if(!uuid.test(id))throw new Error('无效文档标识');
    if(!validUploadScope(scope)||scope!==choices.uploadScope)throw new Error('文档库范围已变化，请刷新文档列表后重新打开预览');
    const response=await checked(await fetch(`/api/documents/${id}`,{headers:{'X-Citation-Store-Id':scope},signal:controller.signal}));
    const value:unknown=await response.json();
    if(!current())return;
    const data=value as {storeScope?:unknown;document?:DocumentRecord;text?:unknown}|null;
    if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('文档预览响应无效，请刷新文档列表后重新打开预览');
    if(data.storeScope!==scope)throw new Error('文档库范围已变化，请刷新文档列表后重新打开预览');
    if(!data.document||typeof data.document!=='object'||Array.isArray(data.document)||data.document.id!==id||typeof data.text!=='string')throw new Error('文档预览响应无效，请刷新文档列表后重新打开预览');
    setPreview({document:{...data.document,storeScope:scope},text:data.text,request,generation});
   } catch(error) {if(current())throw error;}
  });
 }

 function showReader(document:DocumentRecord,storeScope:string){
  closePreview();setError('');setReaderDocument({document:{...document},storeScope});
 }
 function openPreviewReader(source:DocumentPreview){
  // Retained detail identity, not a new list selection or a text-offset/page mapping.
  const current=()=>alive.current&&!lock.current&&source.request===previewRequest.current&&source.generation===listingGeneration.current&&visibleScope.current===source.document.storeScope&&choices.uploadScope===source.document.storeScope;
  if(!current())return;
  const pin=pdfOpenSelectionFromDocument(source.document,source.document.storeScope);
  if(!pin){setError(PDF_OPEN_UNAVAILABLE_REASON);return;}
  if(!allowLeavingUnsavedWork()||!current())return;
  // PdfPageReader still rechecks live access, store identity and source hash/page count.
  showReader(source.document,pin.storeScope);
 }
 function openReader(document:DocumentRecord){if(!allowLeavingUnsavedWork())return;
  if(lock.current)return;
  if(!uuid.test(document.id)||document.format!=='pdf'){setError('无效 PDF 文档标识');return;}
  const scope=listing.storeScope;if(typeof scope!=='string'||!uuid.test(scope)){setError('文档库范围无效，请刷新列表后重新打开');return;}
  showReader(document,scope);
 }
 function download(document:DocumentRecord){
  const scope=listing.storeScope,generation=listingGeneration.current;
  void action(`download-${document.id}`,async controller=>{
   const current=()=>alive.current&&!controller.signal.aborted&&listingGeneration.current===generation&&visibleScope.current===scope;
   try {
    if(scope!==choices.uploadScope)throw new DocumentDownloadError('文档库已变化，请重新进入文档页核对');
    const binding=bindDocumentDownload(document,scope);
    const response=await fetch(`/api/documents/${binding.id}/download`,{headers:{'X-Document-Store-Id':binding.scope},signal:controller.signal});
    const blob=await verifyDocumentDownload(response,binding,controller.signal,current);if(!current())return;
    const url=URL.createObjectURL(blob);let link:HTMLAnchorElement|undefined;
    try {link=window.document.createElement('a');link.href=url;link.download=`document-${binding.id}.${binding.format}`;window.document.body.append(link);if(!current())return;link.click();}
    finally {try{link?.remove();}finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}}
    if(current())setNotice('已请求下载原始文件（已核对字节完整性；是否保存由浏览器决定）');
   } catch(error) {if(current())throw error instanceof DocumentDownloadError?error:new DocumentDownloadError();}
  });
 }
 function manage(document:DocumentRecord,operation:'trash'|'restore'){
  if(!allowLeavingUnsavedWork())return;
  void action(operation,async controller=>{
   const data={revision:document.revision};
   await checked(await fetch(`/api/documents/${document.id}/${operation}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:controller.signal}));
   if(!alive.current||controller.signal.aborted)return;
   closePreview();setOffset(0);setRevision(v=>v+1);setNotice(operation==='trash'?'文档已移入回收站。原件、文字、阅读位置和笔记仍保留。':operation==='restore'?'文档已恢复；如原关联已失效，请重新分配。':'文档资料已更新；原件内容未改变。');
  });
 }
 const previewPdf=preview?pdfOpenSelectionFromDocument(preview.document,preview.document.storeScope):null;
 return <section className="local-documents" aria-label="本地文档库" onClickCapture={withdrawPdfOpen} onChangeCapture={withdrawPdfOpen} onSubmitCapture={withdrawPdfOpen}>
  {pdfOpenStatus&&<p role="status">{pdfOpenStatus}</p>}
  {historyIssue && <p role="alert">{historyIssue}</p>}
  <header><h2>本地研究文档</h2><p>仅保存在本机隔离服务；固定合成身份，非生产账户。未连接远程服务、模型或发布功能。</p><p>上传 TXT / MD / PDF，每次 1 个，单文件最多 8 MiB；PDF 最多 40 页，提取文字最多 1 MiB。文档库最多 250 个文件、原件与提取文字分别合计 64 MiB。支持显示名称与归属编辑、可恢复回收站；不提供永久删除。回收站仍占用存储额度。TXT / MD 仅接受严格 UTF-8 文本。</p><p>文件内容是未经核实的来源文本，不代表已验证的投资事实。Markdown 以纯文本显示；PDF 可逐页查看本机生成的图片，或明确选择纯文本预览。</p></header>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {uploadStorageError&&<p role="alert">{uploadStorageError}</p>}
  {pendingUploads.length>0&&<section className="document-upload-recovery" aria-label="上传结果恢复"><h3>待核对的上传</h3><p>刷新后不会自动重新上传。浏览器只保留操作编号、文件名、摘要和目标位置，不保存文件内容。未查到回执不等于上传失败；重试需重新选择原文件。</p>{pendingUploads.map(record=><div key={record.operationId}><h4>{record.name}</h4><p>原文件：{record.bytes} 字节 · SHA-256 {record.sha256}<br/>原目标：{record.workspaceId??'未关联工作区'} / {record.folderId??'未关联文件夹'}</p><button disabled={!!busy} onClick={()=>checkUpload(record)}>核对上传结果</button><label>为{record.name}重新选择原文件<input type="file" accept=".txt,.md,.pdf" disabled={!!busy} onChange={e=>{const selected=e.target.files?.[0];setRetryFiles(old=>{const next={...old};if(selected)next[record.operationId]=selected;else delete next[record.operationId];return next})}}/></label><button disabled={!!busy||!retryFiles[record.operationId]} onClick={()=>retryUpload(record)}>用原操作重试上传</button><button disabled={!!busy} onClick={()=>abandonUpload(record)}>放弃追踪此上传</button></div>)}</section>}
  <div aria-label="文档视图"><button disabled={!!busy} aria-pressed={view==='active'} onClick={()=>{if(!allowLeavingUnsavedWork())return;setView('active');setOffset(0);closePreview();}}>在用文档</button><button disabled={!!busy} aria-pressed={view==='trash'} onClick={()=>{if(!allowLeavingUnsavedWork())return;setView('trash');setOffset(0);closePreview();}}>文档回收站</button></div>
  {view==='trash'&&<p>回收站内文档不出现在在用列表或搜索中。恢复会保留原件、提取文字、阅读位置、书签与笔记，不自动恢复已失效的工作区。</p>}
  <fieldset disabled={!!busy||!choicesReady}><legend>保存位置与列表筛选</legend>
   <label>工作区<select value={workspace} onChange={e=>changeWorkspace(e.target.value)}><option value="">全部工作区（上传到未关联工作区）</option>{choices.workspaces.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
   <label>本地文件夹<select value={folder} onChange={e=>{if(!allowLeavingUnsavedWork())return;setFolder(e.target.value);setOffset(0);closePreview();setError('');}}><option value="">全部文件夹（上传不关联文件夹）</option>{filteredFolders.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
   <form onSubmit={e=>{e.preventDefault();createFolder();}}><label>新文件夹名称<input value={folderName} maxLength={120} onChange={e=>{folderDraft.current=Symbol('folder-draft');setFolderName(e.target.value)}}/></label><button disabled={!folderName.trim()}>{busy==='folder'?'创建中…':'创建本地文件夹'}</button></form>
   <form onSubmit={e=>{e.preventDefault();upload();}}><label>选择文档<input ref={fileInput} type="file" accept=".txt,.md,.pdf" onChange={e=>{const selected=e.target.files?.[0]??null;uploadDraft.current=selected?{owner:Symbol('upload-draft')}:null;setFile(selected)}}/></label><button disabled={!file||!!uploadStorageError||pendingUploads.length>0}>{busy==='upload'?'上传中…':'上传并保存'}</button></form>
  </fieldset>
  {!choicesReady&&<p>保存位置尚未就绪。若加载失败，请重新进入文档页重试。</p>}
  <form onSubmit={e=>{e.preventDefault();if(!allowLeavingUnsavedWork())return;setSearch(query);setOffset(0);setError('');setRevision(v=>v+1);closePreview();}}><label>搜索文档<input value={query} maxLength={500} onChange={e=>setQuery(e.target.value)} placeholder="按名称或提取文字搜索"/></label><button disabled={loading||!!busy}>搜索</button><button type="button" disabled={!!busy} onClick={()=>{if(!allowLeavingUnsavedWork())return;setQuery('');setSearch('');setOffset(0);setError('');setRevision(v=>v+1);closePreview();}}>清除搜索</button></form>
  {loading?<p role="status">正在加载文档…</p>:<><p>共 {listing.total} 个文档；第 {Math.floor(offset/10)+1} 页</p>{!listing.documents.length&&<p>没有匹配的文档。上传文件，或调整筛选条件。</p>}
   <ul className="local-document-list">{listing.documents.map(document=><li key={document.id}><h3>{document.name}</h3><p>{document.format.toUpperCase()} · {document.bytes} 字节{document.pages!==null?` · ${document.pages} 页`:''} · {document.createdAt}</p><p>工作区：{document.workspaceName??'未关联'} · 文件夹：{document.folderName??'未关联'}</p>{document.stale&&<p role="status">关联的工作区或文件夹已失效；文档原件仍保留。</p>}{!document.trashedAt&&<>{document.format==='pdf'&&<button disabled={!!busy} onClick={()=>openReader(document)}>阅读 PDF 页面</button>}<button disabled={!!busy} onClick={()=>openPreview(document)}>预览纯文本</button><button disabled={!!busy} onClick={()=>download(document)}>下载原始文件</button><button disabled={!!busy} onClick={()=>openMetadata(document)}>编辑名称与归属</button><button disabled={!!busy} onClick={()=>{if(!allowLeavingUnsavedWork())return;closePreview();setConfirmTrash(document);}}>移入文档回收站</button></>}{document.trashedAt&&<button disabled={!!busy} onClick={()=>manage(document,'restore')}>恢复文档</button>}</li>)}</ul>
   <div className="local-document-pagination"><button disabled={offset===0||!!busy} onClick={()=>{if(!allowLeavingUnsavedWork())return;setOffset(v=>Math.max(0,v-10));closePreview();}}>上一页</button><button disabled={offset+listing.documents.length>=listing.total||!!busy} onClick={()=>{if(!allowLeavingUnsavedWork())return;setOffset(v=>v+10);closePreview();}}>下一页</button></div></>}
  {editing&&(loading||listing.storeScope!==editSession.current?.scope||!listing.documents.some(item=>item.id===editing.id&&item.revision===editing.revision))&&<p role="status">当前列表尚未核实此编辑版本（可能正在刷新、已被筛选或已变化）；草稿保留，保存仍使用打开时的版本检查。</p>}
  {editing&&<form aria-label="编辑文档资料" onSubmit={e=>{e.preventDefault();saveMetadata(editing);}}><fieldset disabled={!!busy}><legend>编辑名称与归属（版本 {editing.revision}）</legend><label>显示名称<input value={editing.name} onChange={e=>setEditing({...editing,name:e.target.value})}/></label><label>目标工作区<select value={editing.workspaceId??''} onChange={e=>setEditing({...editing,workspaceId:e.target.value||null,folderId:null})}><option value="">未关联</option>{editing.workspaceId&&!choices.workspaces.some(w=>w.id===editing.workspaceId)&&<option value={editing.workspaceId}>原工作区（当前不可用）：{editing.workspaceId}</option>}{choices.workspaces.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label><label>目标文件夹<select value={editing.folderId??''} onChange={e=>setEditing({...editing,folderId:e.target.value||null})}><option value="">未关联</option>{editing.folderId&&!choices.folders.some(f=>f.id===editing.folderId&&f.workspaceId===editing.workspaceId)&&<option value={editing.folderId}>原文件夹（当前不可用）：{editing.folderId}</option>}{choices.folders.filter(f=>f.workspaceId===editing.workspaceId).map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label><p>本次编辑保留打开时的版本，不随列表刷新自动覆盖。更换工作区会清空原文件夹；名称仅用于显示，不修改原件或文件格式。版本冲突时请取消并刷新列表后重试。</p><button>保存资料</button><button type="button" onClick={()=>{if(allowLeavingUnsavedWork()){editSession.current=null;setEditing(null);}}}>取消编辑</button></fieldset></form>}
  {confirmTrash&&<section aria-label="确认文档回收站"><p>将「{confirmTrash.name}」移入文档回收站？原件、文字、阅读位置、书签与笔记会保留；可随时恢复。没有永久删除。</p><button disabled={!!busy} onClick={()=>manage(confirmTrash,'trash')}>确认移入文档回收站</button><button disabled={!!busy} onClick={()=>setConfirmTrash(null)}>取消移入</button></section>}
  {busy.startsWith('preview-')&&<p role="status">正在提取已保存的预览…</p>}
  {busy.startsWith('download-')&&<p role="status">正在准备下载…</p>}
  {readerDocument&&<PdfPageReader storeScope={readerDocument.storeScope} documentId={readerDocument.document.id} documentName={readerDocument.document.name} selectedSha256={readerDocument.document.sha256} selectedPages={readerDocument.document.pages} onClose={()=>{if(allowLeavingUnsavedWork())closePreview();}}/>}
  {preview&&<section aria-label="文档纯文本预览" className="local-document-preview"><h3>{preview.document.name}</h3><button onClick={()=>{if(allowLeavingUnsavedWork())closePreview();}}>关闭预览</button>{preview.document.format==='pdf'&&<><button type="button" disabled={!!busy||!previewPdf} onClick={()=>openPreviewReader(preview)}>打开此 PDF 页面阅读器（上次阅读位置）</button><p>打开此 PDF 上次保存的阅读位置；首次阅读从第 1 页开始。不会按所选文字或引用定位 PDF 页码。</p>{!previewPdf&&<p role="status">{PDF_OPEN_UNAVAILABLE_REASON}</p>}</>}<p>未经核实的来源文本；不代表投资事实。以下内容仅作为文字显示。</p><p className="local-document-hash">原件 SHA-256：{preview.document.sha256}<br/>提取文字 SHA-256：{preview.document.textSha256}</p>{!preview.text.trim()&&<p role="status">未提取到可检索文字，可能是扫描件。当前不支持 OCR；原始文件仍可下载。</p>}<DocumentCitations key={preview.document.id} document={preview.document} text={preview.text} disabled={!!busy}/></section>}
 </section>;
}
