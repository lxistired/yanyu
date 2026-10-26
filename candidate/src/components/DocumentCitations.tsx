import {useEffect,useRef,useState} from 'react';
import {citationTextContext,citationTextHeaders,prepareSavedCitationText} from './saved-citation-text';
import {PreparedCitationText} from './PreparedCitationText';
import {useUnsavedWork} from './unsaved-work';
import {RecoverableDocumentCitations} from './RecoverableDocumentCitations';
type Source={storeScope?:string;format?:'txt'|'md'|'pdf';id:string;name:string;revision:number;sha256:string;textSha256:string};
type Citation={id:string;documentId:string;documentSha256:string;textSha256:string;start:number;end:number;quote:string;quoteSha256:string;note:string;labelAtCreation:string;createdAt:string;level:'document-text';page:null};
const sha=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(v=>v.toString(16).padStart(2,'0')).join('');
async function json(response:Response){const data=await response.json();if(!response.ok)throw Error(data?.error?.message??'引用操作失败');return data;}
function LegacyDocumentCitations({document:source,text,disabled=false}:{document:Source;text:string;disabled?:boolean}){
 const attempt=useRef<{fingerprint:string;operationId:string}|null>(null);
 const pre=useRef<HTMLPreElement>(null),lock=useRef(false),alive=useRef(false),controllers=useRef(new Set<AbortController>());
 const [selection,setSelection]=useState<{start:number;end:number;quote:string}|null>(null);
 const [note,setNote]=useState(''),[citations,setCitations]=useState<Citation[]>([]),[error,setError]=useState(''),[status,setStatus]=useState(''),[busy,setBusy]=useState(false),[ready,setReady]=useState(false);
 const [reopened,setReopened]=useState<Citation|null>(null),[currentName,setCurrentName]=useState(source.name);
 useUnsavedWork(!!selection||!!note);
 const textContext=citationTextContext(source,text),currentTextContext=useRef(textContext),preparationVersion=useRef(0);
 currentTextContext.current=disabled?'':textContext;
 const [preparedText,setPreparedText]=useState<{context:string;text:string}|null>(null);
 useEffect(()=>{++preparationVersion.current;setPreparedText(null);},[textContext,disabled]);
 const path=`/api/documents/${source.id}/citations`;
 useEffect(()=>{alive.current=true;const c=new AbortController();controllers.current.add(c);fetch(path,{signal:c.signal}).then(json).then(data=>{if(!c.signal.aborted){setCitations(data.citations??[]);setReady(true);}}).catch(e=>{if(!c.signal.aborted)setError(e.message);}).finally(()=>controllers.current.delete(c));return()=>{alive.current=false;for(const c of controllers.current)c.abort();controllers.current.clear();};},[path]);
 function capture(){if(disabled||lock.current)return;const s=window.getSelection(),element=pre.current;if(!s||s.rangeCount!==1||s.isCollapsed||!element)return;const r=s.getRangeAt(0);if(!element.contains(r.startContainer)||!element.contains(r.endContainer))return;const prefix=r.cloneRange();prefix.selectNodeContents(element);prefix.setEnd(r.startContainer,r.startOffset);const start=prefix.toString().length,quote=r.toString(),end=start+quote.length;if(!quote||text.slice(start,end)!==quote){setError('所选文字与原提取文本不一致，请重新选择');return;}setSelection({start,end,quote});setReopened(null);setPreparedText(null);setError('');setStatus('');}
 async function work(fn:(c:AbortController)=>Promise<void>){if(disabled||lock.current)return;lock.current=true;setBusy(true);setError('');setStatus('');const c=new AbortController();controllers.current.add(c);try{await fn(c);}catch(e){if(alive.current&&!c.signal.aborted)setError(e instanceof Error?e.message:'引用操作失败');}finally{controllers.current.delete(c);lock.current=false;if(alive.current)setBusy(false);}}
 function save(){if(!selection)return;const chosen=selection,humanNote=note;void work(async c=>{const quoteSha256=await sha(chosen.quote);if(c.signal.aborted)return;const payload={...chosen,quoteSha256,note:humanNote,rangeUnit:'utf16-code-unit',documentRevision:source.revision,documentSha256:source.sha256,textSha256:source.textSha256};const fingerprint=JSON.stringify(payload);if(attempt.current?.fingerprint!==fingerprint)attempt.current={fingerprint,operationId:crypto.randomUUID()};const data=await json(await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},signal:c.signal,body:JSON.stringify({...payload,operationId:attempt.current.operationId})}));if(!alive.current||c.signal.aborted)return;setCitations(old=>[...old.filter(item=>item.id!==data.citation.id),data.citation]);attempt.current=null;setSelection(null);setNote('');setStatus('文字引用已保存。仅确认来源绑定，不验证事实。');});}
 function reopen(citation:Citation,prepare=false){void work(async c=>{const version=preparationVersion.current;setReopened(null);setPreparedText(null);const data=await json(await fetch(`${path}/${citation.id}`,{headers:prepare?citationTextHeaders(source):undefined,signal:c.signal}));if(!alive.current||c.signal.aborted||version!==preparationVersion.current||currentTextContext.current!==textContext)return;if(data.text!==text||data.citation.quote!==text.slice(data.citation.start,data.citation.end))throw Error('当前预览已过期，请关闭并重新打开');const prepared=prepare?prepareSavedCitationText(data,citation,source,text):null;setCurrentName(data.document.name);setReopened(data.citation);if(prepared!==null)setPreparedText({context:textContext,text:prepared});setStatus(prepare?'引用文本已准备。请核对来源和引文后手动复制。':data.document.stale?'来源关联已失效；文字引用仍指向原文档。':'已定位原始提取文字；没有经过验证的 PDF 页码映射。');});}
 useEffect(()=>{if(reopened){pre.current?.querySelector('mark')?.scrollIntoView?.({block:'center'});}},[reopened]);
 return <section className="document-citations" aria-label="文档文字引用">
  <p>在下方原文中用鼠标或键盘选择文字，再明确保存引用。范围采用 UTF-16 代码单元，起点包含、终点不包含；不会自动匹配其他同文段落。</p>
  <pre ref={pre} aria-disabled={busy||disabled} tabIndex={0} aria-label="可选择的原始提取文字" onMouseUp={capture} onKeyUp={capture}>{reopened?<>{text.slice(0,reopened.start)}<mark>{text.slice(reopened.start,reopened.end)}</mark>{text.slice(reopened.end)}</>:text}</pre>
  <p>文档／文字级引用，无已验证页码。引用不是事实核验，人工备注不属于原文。</p>
  {error&&<p role="alert">{error}</p>}{status&&<p role="status">{status}</p>}
  {preparedText?.context===textContext&&!busy&&!disabled&&!selection&&<PreparedCitationText text={preparedText.text}/>}
  {selection&&<div><p>已选范围 [{selection.start}, {selection.end})</p><blockquote style={{whiteSpace:'pre-wrap'}}>{selection.quote}</blockquote><label>人工备注（可选）<textarea disabled={busy||disabled} value={note} onChange={e=>setNote(e.target.value)}/></label><button disabled={busy||disabled||!ready} onClick={save}>保存所选文字引用</button><button disabled={busy||disabled} onClick={()=>{attempt.current=null;setSelection(null);setNote('');}}>取消所选引用</button></div>}
  <h4>已保存引用 · {currentName}</h4>{!ready?<p>正在载入引用…</p>:!citations.length?<p>尚无已保存引用</p>:<ul>{citations.map(c=><li key={c.id}><p>保存时名称：{c.labelAtCreation} · [{c.start}, {c.end}) · 文档／文字级</p><blockquote style={{whiteSpace:'pre-wrap'}}>{c.quote}</blockquote>{c.note&&<p>人工备注：{c.note}</p>}<p className="local-document-hash">引用 ID：{c.id}<br/>原件：{c.documentSha256}<br/>提取文字：{c.textSha256}<br/>引文：{c.quoteSha256}</p><button disabled={busy||disabled||!!selection} onClick={()=>reopen(c)}>定位原文引用</button><button disabled={busy||disabled||!!selection} onClick={()=>reopen(c,true)}>准备引用文本</button></li>)}</ul>}
 </section>;
}

export function DocumentCitations(props:{document:Source;text:string;disabled?:boolean}){
 const format=props.document.format;
 return format==='txt'||format==='md'?<RecoverableDocumentCitations {...props} document={{...props.document,format}}/>:<LegacyDocumentCitations {...props}/>;
}
