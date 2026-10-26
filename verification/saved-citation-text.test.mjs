import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareSavedCitationText,citationTextContext,citationTextHeaders} from '../candidate/src/components/saved-citation-text.ts';
const text='😀 cafe\u0301\r\n重复 quote\r\n重复 quote\n<script>literal & text</script>';
const source={id:'11111111-1111-4111-8111-111111111111',name:'preview.pdf',revision:4,sha256:'a'.repeat(64),textSha256:'b'.repeat(64),storeScope:'77777777-7777-4777-8777-777777777777'};
const start=text.lastIndexOf('重复 quote');
const selected={id:'22222222-2222-4222-8222-222222222222',documentId:source.id,documentSha256:source.sha256,textSha256:source.textSha256,start,end:text.length,quote:text.slice(start),quoteSha256:'c'.repeat(64),note:'独立备注\r\n<img src=x> & 😀',labelAtCreation:'original.pdf',createdAt:'2026-10-23T20:00:00Z',level:'document-text',page:null};
const response=()=>({text,citation:{...selected,rangeUnit:'utf16-code-unit',rangeConvention:'half-open'},document:{...source,name:'renamed & <literal>.pdf',revision:9,trashedAt:null,stale:false,pages:12,savedPage:7}});
const format=(r=response(),s=selected)=>prepareSavedCitationText(r,s,source,text);
test('uses freshly reopened title, preserves saved title, exact quote/note and second occurrence',()=>{
 const r=response(),snapshot=JSON.stringify(r),out=format(r);
 assert.ok(out.startsWith('来源（核对时名称）：renamed & <literal>.pdf\n保存时名称：original.pdf\n'));
 assert.ok(out.includes(`位置：UTF-16 代码单元 [${start}, ${text.length})`));
 assert.ok(out.includes('\n引文（原始提取文字）：\n'+selected.quote+'\n\n人工备注（非原文）：\n'+selected.note));
 assert.ok(out.includes('引用 ID：'+selected.id));assert.equal(JSON.stringify(r),snapshot);
});
test('never invents a PDF page from document page count or reader position',()=>{const out=format();assert.ok(out.includes('无已验证 PDF 页码'));assert.ok(!out.includes('第 7 页'));assert.ok(!out.includes('第 12 页'));});
test('explicitly identifies a stale association, not normal current-source approval',()=>{const r=response();r.document.stale=true;assert.ok(format(r).includes('来源关联已失效；此引文仍绑定原文档，不代表当前关联有效。'));});
test('unchanged title and absent note do not add duplicate or invented text',()=>{const r=response();r.document.name=selected.labelAtCreation;r.citation.note='';const out=format(r,{...selected,note:''});assert.ok(!out.includes('保存时名称：'));assert.ok(!out.includes('人工备注'));assert.ok(out.endsWith(selected.quote));});
test('quote is untouched plain text, including CRLF, combining mark, Unicode and markup',()=>{const r=response();r.citation={...r.citation,start:0,end:text.length,quote:text};const s={...selected,start:0,end:text.length,quote:text};assert.ok(format(r,s).includes('\n引文（原始提取文字）：\n'+text+'\n'));});
for(const [name,change] of [
 ['wrong citation ID',r=>r.citation.id='other'],['wrong document ID',r=>r.citation.documentId='other'],['wrong reopened document ID',r=>r.document.id='other'],
 ['wrong original hash',r=>r.citation.documentSha256='d'.repeat(64)],['wrong text hash',r=>r.document.textSha256='d'.repeat(64)],
 ['same text at different range',r=>{r.citation.start=10;r.citation.end=18;r.citation.quote=text.slice(10,18);} ],
 ['changed quote hash',r=>r.citation.quoteSha256='d'.repeat(64)],['changed saved title',r=>r.citation.labelAtCreation='invented.pdf'],
 ['changed note',r=>r.citation.note='changed'],['changed source text',r=>r.text+='other'],['trashed document',r=>r.document.trashedAt='2026-10-23T21:00:00Z'],
 ['invented page',r=>r.citation.page=7],['wrong citation level',r=>r.citation.level='pdf-page'],['wrong range convention',r=>r.citation.rangeConvention='inclusive'],
 ['missing current title',r=>delete r.document.name],['missing source document',r=>delete r.document],['unconfirmed stale state',r=>delete r.document.stale]
])test(`rejects ${name}`,()=>{const r=response();change(r);assert.throws(()=>format(r),/未准备引用文本/);});
for(const [start,end] of [[-1,2],[0,0],[1,2],[0,1],[0,1.5],[0,Number.MAX_SAFE_INTEGER+1],[0,text.length+1]])test(`rejects invalid or split-surrogate range [${start}, ${end}) even if selected row agrees`,()=>{
 const r=response(),s={...selected,start,end,quote:text.slice(start,end)};r.citation={...r.citation,...s};assert.throws(()=>format(r,s),/未准备引用文本/);
});
test('source-context guard changes for scope, identity, revision, title, hash or exact preview text',()=>{
 const key=citationTextContext(source,text);for(const patch of [{id:'other'},{storeScope:'other'},{revision:5},{name:'renamed'},{sha256:'d'.repeat(64)},{textSha256:'d'.repeat(64)}])assert.notEqual(citationTextContext({...source,...patch},text),key);
 assert.notEqual(citationTextContext(source,text+' '),key);assert.equal(citationTextContext({...source},text),key);
});

test('new prepare request pins the preview store scope and rejects absent or malformed scope before fetch',()=>{assert.deepEqual(citationTextHeaders(source),{'X-Citation-Store-Id':source.storeScope});for(const storeScope of [undefined,'','wrong'])assert.throws(()=>citationTextHeaders({...source,storeScope}),/未准备引用文本/);});
