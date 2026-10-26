import {useEffect,useRef,useState} from 'react';
import {ResearchRequestOwner,validateResearchQuery} from './local-research-search';
import {literalPdfMatches,nextPdfMatch,pdfFindContext,PdfTextSourceError,readPdfFindText,type PdfFindSelection} from './pdf-text-find';

type Props={selection:PdfFindSelection;owner:ResearchRequestOwner;isSourceCurrent:()=>boolean;onSourceInvalid:(message:string)=>void};
/** Mounted only while the parent's current PDF page is verified and decoded. */
export function PdfTextFind({selection,owner,isSourceCurrent,onSourceInvalid}:Props){
 const opened=useRef(false),accepted=useRef<(()=>boolean)|null>(null);
 const [open,setOpen]=useState(false),[text,setText]=useState<string|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const [query,setQuery]=useState(''),[queryError,setQueryError]=useState(''),[submitted,setSubmitted]=useState(false),[matches,setMatches]=useState<Uint32Array>(new Uint32Array(0)),[index,setIndex]=useState(-1);
 useEffect(()=>()=>{opened.current=false;accepted.current=null;owner.cancel();},[owner]);
 const current=()=>opened.current&&isSourceCurrent();
 const clearMatches=()=>{setMatches(new Uint32Array(0));setIndex(-1);setSubmitted(false);setQueryError('');};
 async function load(){
  if(!isSourceCurrent())return;
  opened.current=true;setOpen(true);accepted.current=null;setText(null);setError('');setLoading(true);clearMatches();
  const request=owner.begin();
  try{const value=await readPdfFindText(selection,request,current);if(request.current()&&current()){accepted.current=request.current;setText(value);}}
  catch(error){if(request.current()&&current()){if(error instanceof PdfTextSourceError){owner.cancel();accepted.current=null;setText(null);setLoading(false);onSourceInvalid(error.message);}else setError(error instanceof Error?error.message:'提取文字读取失败，请重试');}}
  finally{if(request.current()&&current())setLoading(false);}
 }
 function close(){opened.current=false;accepted.current=null;owner.cancel();setOpen(false);setText(null);setLoading(false);setError('');setQuery('');clearMatches();}
 function search(){
  if(!current()||!accepted.current?.()||text===null)return;
  try{validateResearchQuery(query,'documents');const found=literalPdfMatches(text,query);setMatches(found);setIndex(found.length?0:-1);setSubmitted(!!query);setQueryError('');}
  catch(error){clearMatches();setQueryError(error instanceof Error?error.message:'查找词无效');}
 }
 function move(direction:1|-1){if(current()&&accepted.current?.())setIndex(value=>nextPdfMatch(value,matches.length,direction));}
 return <section className="pdf-text-find" aria-label="PDF 提取文字查找">
  {!open?<button type="button" onClick={()=>void load()}>查找 PDF 提取文字</button>:<>
   <header><h4>文内文字查找</h4><button type="button" onClick={close}>关闭文内查找</button></header>
   <p>仅定位此 PDF 的提取文字，不定位原 PDF 页或图中坐标；不含 OCR、批注，也不代表原版等价。文字绑定已核验页面的原件标识，但此次查找不会独立重验原 PDF 字节。翻页或缩放会关闭查找。</p>
   <p>区分大小写，按原样字面匹配，命中不重叠；查找词最多 512 UTF-8 字节。</p>
   {loading&&<p role="status">正在读取并核验提取文字…</p>}
   {error&&<div role="alert">{error}<button type="button" onClick={()=>void load()}>重试读取查找文字</button></div>}
   {text!==null&&<>
    {text.length===0?<p role="status">此 PDF 没有可查找的提取文字；未进行 OCR。</p>:<>
     <form onSubmit={event=>{event.preventDefault();search();}}><label>文内查找词<input type="search" value={query} maxLength={512} onChange={event=>{setQuery(event.target.value);clearMatches();}}/></label><button type="submit">查找文字</button></form>
     {queryError&&<p role="alert">{queryError}</p>}
     {!submitted&&!queryError&&<p role="status">输入查找词并点击“查找文字”。</p>}
     {submitted&&<><p role="status">{matches.length?`第 ${index+1} / ${matches.length} 个命中`:'没有匹配的提取文字。'}</p><div className="pdf-text-find-controls"><button type="button" disabled={!matches.length} onClick={()=>move(-1)}>上一个命中</button><button type="button" disabled={!matches.length} onClick={()=>move(1)}>下一个命中</button></div></>}
     {matches.length>0&&<><p>当前命中附近的文字片段（非 PDF 页面）；深色并带边框的是当前命中，浅色的是其他命中。</p><pre aria-label="命中文字片段">{pdfFindContext(text,query,matches,index).map((part,i)=>part.match?<mark key={i} className={part.current?'is-current':''} aria-current={part.current?'true':undefined}>{part.text}</mark>:part.text)}</pre></>}
    </>}
   </>}
  </>}
 </section>;
}
