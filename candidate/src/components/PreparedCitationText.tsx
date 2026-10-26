import {useRef} from 'react';

export function PreparedCitationText({text}:{text:string}) {
 const block=useRef<HTMLPreElement>(null);
 function select(){const node=block.current,selection=window.getSelection();if(!node||!selection)return;node.focus();const range=document.createRange();range.selectNodeContents(node);selection.removeAllRanges();selection.addRange(range);}
 return <section aria-label="已准备的引用文本">
  <p>已按本次来源核对结果整理。可全选后手动复制；不会写入剪贴板或保存为新引用。</p>
  <button onClick={select}>全选引用文本</button>
  <pre ref={block} role="textbox" aria-label="可手动复制的引用文本" aria-readonly="true" aria-multiline="true" tabIndex={0} style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',userSelect:'text'}}>{text}</pre>
 </section>;
}
