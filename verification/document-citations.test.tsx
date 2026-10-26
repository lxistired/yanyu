import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,act} from '@testing-library/react';
import {webcrypto} from 'node:crypto';
import {TextEncoder} from 'node:util';
import {DocumentCitations} from '../candidate/src/components/DocumentCitations';
import {allowLeavingUnsavedWork} from '../candidate/src/components/unsaved-work';
const source={id:'11111111-1111-4111-8111-111111111111',name:'source.txt',revision:4,sha256:'a'.repeat(64),textSha256:'b'.repeat(64)},text='😀 cafe\u0301\r\n重复 quote\r\n重复 quote\n<script>literal</script>',base=`/api/documents/${source.id}/citations`;
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status});
const saved={id:'22222222-2222-4222-8222-222222222222',documentId:source.id,documentSha256:source.sha256,textSha256:source.textSha256,start:text.lastIndexOf('重复 quote'),end:text.lastIndexOf('重复 quote')+8,quote:'重复 quote',quoteSha256:'c'.repeat(64),note:'human',labelAtCreation:'old.txt',createdAt:'2026-10-15',level:'document-text',page:null};
function setup(handler?:(path:string,init?:RequestInit)=>Promise<Response>|undefined){vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('TextEncoder',TextEncoder);const fetcher=vi.fn((path:string,init?:RequestInit)=>handler?.(path,init)??Promise.resolve(json({citations:[]})));vi.stubGlobal('fetch',fetcher);return {...render(<DocumentCitations document={source} text={text}/>),fetcher};}
function select(start:number,end:number){const pre=screen.getByLabelText('可选择的原始提取文字'),r=document.createRange();r.setStart(pre.firstChild!,start);r.setEnd(pre.firstChild!,end);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(r);fireEvent.mouseUp(pre);}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();window.getSelection()?.removeAllRanges();});
it('requires explicit selection and preserves second repeated occurrence exact UTF-16 offsets',async()=>{let payload:any;const {fetcher}=setup((path,init)=>init?.method==='POST'?(payload=JSON.parse(init.body as string),Promise.resolve(json({citation:{...saved,...payload}},201))):undefined);await screen.findByText('尚无已保存引用');expect(screen.queryByText('保存所选文字引用')).toBeNull();expect(screen.getByLabelText('可选择的原始提取文字').textContent).toBe(text);select(saved.start,saved.end);fireEvent.change(screen.getByLabelText('人工备注（可选）'),{target:{value:'独立备注'}});fireEvent.click(screen.getByText('保存所选文字引用'));fireEvent.click(screen.getByText('保存所选文字引用'));await screen.findByText('文字引用已保存。仅确认来源绑定，不验证事实。');expect(payload).toMatchObject({start:saved.start,end:saved.end,quote:'重复 quote',note:'独立备注',documentRevision:4,rangeUnit:'utf16-code-unit',documentSha256:source.sha256,textSha256:source.textSha256});expect(payload.quoteSha256).toMatch(/^[a-f0-9]{64}$/);expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);});
it('reopens validated original range and displays fresh document label without changing quote',async()=>{setup(path=>Promise.resolve(path===base?json({citations:[saved]}):json({citation:saved,text,document:{...source,name:'renamed.txt',stale:true}})));await screen.findByText('定位原文引用');fireEvent.click(screen.getByText('定位原文引用'));await screen.findByText(/来源关联已失效/);expect(document.querySelector('mark')?.textContent).toBe(saved.quote);expect(screen.getByText('已保存引用 · renamed.txt')).toBeTruthy();expect(screen.getByText(/保存时名称：old.txt/)).toBeTruthy();expect(document.querySelector('script,img,iframe')).toBeNull();});
it('stale source failures retain saved quote and never highlight unrelated text',async()=>{setup(path=>Promise.resolve(path===base?json({citations:[saved]}):json({error:{message:'Source is in trash; restore document before reopening'}},409)));await screen.findByText('定位原文引用');fireEvent.click(screen.getByText('定位原文引用'));await screen.findByRole('alert');expect(document.querySelector('mark')).toBeNull();expect(screen.getByText(saved.quote)).toBeTruthy();});
it('cancel clears draft and navigation guard protects unsaved selection',async()=>{setup();await screen.findByText('尚无已保存引用');select(0,2);const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);expect(allowLeavingUnsavedWork()).toBe(false);expect(confirm).toHaveBeenCalledOnce();fireEvent.click(screen.getByText('取消所选引用'));expect(allowLeavingUnsavedWork()).toBe(true);expect(screen.queryByText('保存所选文字引用')).toBeNull();});
it('save error preserves draft and note for review',async()=>{setup((path,init)=>init?.method==='POST'?Promise.resolve(json({error:{message:'Document metadata changed; reopen before citing'}},409)):undefined);await screen.findByText('尚无已保存引用');select(0,2);fireEvent.change(screen.getByLabelText('人工备注（可选）'),{target:{value:'keep'}});fireEvent.click(screen.getByText('保存所选文字引用'));await screen.findByRole('alert');expect((screen.getByLabelText('人工备注（可选）') as HTMLTextAreaElement).value).toBe('keep');});
it('unmount aborts list and ignores late result',async()=>{let resolve!:(r:Response)=>void;let signal:AbortSignal|null|undefined;const {unmount}=setup((path,init)=>{signal=init?.signal;return new Promise(r=>resolve=r);});unmount();expect(signal?.aborted).toBe(true);await act(async()=>resolve(json({citations:[saved]})));expect(screen.queryByText('定位原文引用')).toBeNull();});
it('reopened mismatched text does not highlight or claim successful location',async()=>{setup(path=>Promise.resolve(path===base?json({citations:[saved]}):json({citation:saved,text:'changed',document:source})));await screen.findByText('定位原文引用');fireEvent.click(screen.getByText('定位原文引用'));await screen.findByText('当前预览已过期，请关闭并重新打开');expect(document.querySelector('mark')).toBeNull();});
it('freezes the captured range while a save is in flight',async()=>{
 let resolve!:(r:Response)=>void;let payload:any;
 setup((path,init)=>init?.method==='POST'?(payload=JSON.parse(init.body as string),new Promise(r=>resolve=r)):undefined);
 await screen.findByText('尚无已保存引用');select(saved.start,saved.end);
 fireEvent.change(screen.getByLabelText('人工备注（可选）'),{target:{value:'original note'}});
 fireEvent.click(screen.getByText('保存所选文字引用'));await waitFor(()=>expect(payload).toBeTruthy());
 select(0,2);
 expect(screen.getByText(`已选范围 [${saved.start}, ${saved.end})`)).toBeTruthy();
 await act(async()=>resolve(json({citation:{...saved,...payload}},201)));
 await screen.findByText('文字引用已保存。仅确认来源绑定，不验证事实。');
 expect(screen.queryByText('保存所选文字引用')).toBeNull();
});
it('retries an unknown save outcome with the same operation ID and one displayed citation',async()=>{
 const payloads:any[]=[];
 setup((path,init)=>{
  if(init?.method!=='POST')return undefined;
  const payload=JSON.parse(init.body as string);payloads.push(payload);
  return payloads.length===1?Promise.reject(Error('Synthetic lost response')):Promise.resolve(json({citation:{...saved,...payload}},201));
 });
 await screen.findByText('尚无已保存引用');select(saved.start,saved.end);
 fireEvent.click(screen.getByText('保存所选文字引用'));await screen.findByText('Synthetic lost response');
 fireEvent.click(screen.getByText('保存所选文字引用'));await screen.findByText('文字引用已保存。仅确认来源绑定，不验证事实。');
 expect(payloads).toHaveLength(2);expect(payloads[0].operationId).toMatch(/^[a-f0-9-]{36}$/);
 expect(payloads[1]).toEqual(payloads[0]);expect(screen.getAllByText('定位原文引用')).toHaveLength(1);
});
