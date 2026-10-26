// Formatting convenience after a successful source-checked reopen, not a new
// citation, PDF page mapping, or factual verification. Never persist this text.
export type CitationTextSource = {id:string;name:string;revision:number;sha256:string;textSha256:string;storeScope?:string};
type SavedCitation = {id:string;documentId:string;documentSha256:string;textSha256:string;start:number;end:number;quote:string;quoteSha256:string;note:string;labelAtCreation:string;createdAt:string;level:'document-text';page:null};
const identityFields = ['id','documentId','documentSha256','textSha256','start','end','quote','quoteSha256','note','labelAtCreation','createdAt','level','page'] as const;
const hash = /^[a-f0-9]{64}$/;
const fail = ():never => {throw Error('引用或来源与当前预览不一致，未准备引用文本。请关闭并重新打开预览。');};
const object = (value:unknown):Record<string,unknown> => value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:fail();
const boundary = (text:string,n:number) => n===0||n===text.length||!(text.charCodeAt(n-1)>=0xd800&&text.charCodeAt(n-1)<=0xdbff&&text.charCodeAt(n)>=0xdc00&&text.charCodeAt(n)<=0xdfff);

export function citationTextHeaders(source:CitationTextSource):Record<string,string> {
 if(typeof source.storeScope!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(source.storeScope))return fail();
 return {'X-Citation-Store-Id':source.storeScope};
}

export function citationTextContext(source:CitationTextSource,text:string):string {
 return JSON.stringify([source.storeScope??null,source.id,source.name,source.revision,source.sha256,source.textSha256,text]);
}

export function prepareSavedCitationText(value:unknown,selected:SavedCitation,source:CitationTextSource,text:string):string {
 const data=object(value),citation=object(data.citation),document=object(data.document);
 if(data.text!==text||identityFields.some(key=>citation[key]!==selected[key])||citation.documentId!==source.id||document.id!==source.id||citation.documentSha256!==source.sha256||document.sha256!==source.sha256||citation.textSha256!==source.textSha256||document.textSha256!==source.textSha256)fail();
 if(citation.level!=='document-text'||citation.page!==null||citation.rangeUnit!=='utf16-code-unit'||citation.rangeConvention!=='half-open'||document.trashedAt!==null||typeof document.stale!=='boolean'||typeof document.name!=='string'||!document.name.trim())fail();
 if(typeof citation.id!=='string'||!citation.id||typeof citation.quote!=='string'||!citation.quote||typeof citation.note!=='string'||typeof citation.labelAtCreation!=='string'||!citation.labelAtCreation.trim()||typeof citation.quoteSha256!=='string'||!hash.test(citation.quoteSha256)||!hash.test(source.sha256)||!hash.test(source.textSha256))fail();
 const start=citation.start,end=citation.end;
 if(typeof start!=='number'||typeof end!=='number'||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>text.length||!boundary(text,start)||!boundary(text,end)||text.slice(start,end)!==citation.quote)fail();
 const lines=[`来源（核对时名称）：${document.name}`];
 if(document.name!==citation.labelAtCreation)lines.push(`保存时名称：${citation.labelAtCreation}`);
 lines.push(`文档 ID：${source.id}`,`引用 ID：${citation.id}`,`位置：UTF-16 代码单元 [${start}, ${end})，起点包含、终点不包含。`,'文档／文字级引用；无已验证 PDF 页码。');
 if(document.stale)lines.push('来源关联已失效；此引文仍绑定原文档，不代表当前关联有效。');
 lines.push('仅确认来源绑定，不验证事实。','','引文（原始提取文字）：',selected.quote);
 if(selected.note)lines.push('','人工备注（非原文）：',selected.note);
 return lines.join('\n');
}
