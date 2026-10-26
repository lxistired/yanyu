import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,act} from '@testing-library/react';
import {LocalPlanWalkthrough} from '../candidate/src/components/LocalPlanWalkthrough';
import {ManualPlanManager,ManualPlanSession} from '../candidate/src/components/ManualPlanManager';
import {ManualPlanClient} from '../candidate/src/components/manual-plan-client';
import type {ManualPlanRecord} from '../candidate/shared/manual-plans';
import {localPlanSummary} from '../candidate/src/components/local-plan-summary';
const plan=(id='one'):ManualPlanRecord=>({id,kind:'manual-research-plan',revision:1,createdAt:'2026-10-21T00:00:00.000Z',updatedAt:'2026-10-21T00:00:00.000Z',deletedAt:null,data:{schemaVersion:1,provenance:'user-authored-local',state:'draft',title:`计划${id}`,objective:`目标${id}`,notes:'',targetDate:null}});
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name}));
const input=()=>fireEvent.change(screen.getByLabelText('本次模拟问题'),{target:{value:'需核对哪些事项？'}});
const clarify=()=>{click('继续澄清范围与输出');fireEvent.change(screen.getByLabelText('本次范围与排除项'),{target:{value:'只核对已加载资料，不扩展主题'}});fireEvent.change(screen.getByLabelText('预期输出与验收要求'),{target:{value:'一份待验证事项清单'}});};
const approve=()=>{clarify();click('审阅模拟计划');click('批准此模拟计划（不开始）');};
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('walks clarification, review, separate approval and explicit manual run without transport/storage/timers',()=>{
 const fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('unexpected'));
 const storage=vi.spyOn(Storage.prototype,'setItem');const timer=vi.spyOn(globalThis,'setTimeout');
 const exit=vi.fn();render(<LocalPlanWalkthrough plan={plan()} onExit={exit}/>);
 expect((screen.getByRole('button',{name:'继续澄清范围与输出'}) as HTMLButtonElement).disabled).toBe(true);
 input();clarify();click('审阅模拟计划');expect(screen.getByText('已保存目标：目标one')).toBeTruthy();
 click('返回修改问题');expect((screen.getByLabelText('本次模拟问题') as HTMLTextAreaElement).value).toContain('核对');
 approve();expect(screen.getByRole('status').textContent).toContain('尚未开始');expect(screen.queryByRole('button',{name:'手动完成流程演示'})).toBeNull();
 click('开始本地模拟执行');expect(screen.getByRole('status').textContent).toContain('等待你手动推进');
 click('手动完成流程演示');expect(screen.getByRole('status').textContent).toContain('不代表研究已完成');
 expect(screen.getByText('原计划未修改，无结果或会话记录被保存。')).toBeTruthy();
 click('清空并重新演示');expect((screen.getByLabelText('本次模拟问题') as HTMLTextAreaElement).value).toBe('');
 click('退出模拟并清空，返回计划');expect(exit).toHaveBeenCalledOnce();
 expect(fetcher).not.toHaveBeenCalled();expect(storage).not.toHaveBeenCalled();expect(timer).not.toHaveBeenCalled();
});
it.each(['question','clarify','review','approved','running','result'])('cancels and clears all inputs and approval from %s',step=>{
 render(<LocalPlanWalkthrough plan={plan()} onExit={()=>{}}/>);input();
 if(step!=='question')clarify();if(['review','approved','running','result'].includes(step))click('审阅模拟计划');if(['approved','running','result'].includes(step))click('批准此模拟计划（不开始）');if(['running','result'].includes(step))click('开始本地模拟执行');if(step==='result')click('手动完成流程演示');
 click('取消模拟并清空输入');expect(screen.getByRole('status').textContent).toContain('问题、澄清和批准状态已清除');click('重新开始模拟');expect((screen.getByLabelText('本次模拟问题') as HTMLTextAreaElement).value).toBe('');
 input();click('继续澄清范围与输出');for(const label of ['本次范围与排除项','预期输出与验收要求'])expect((screen.getByLabelText(label) as HTMLTextAreaElement).value).toBe('');expect(screen.queryByRole('button',{name:'开始本地模拟执行'})).toBeNull();
});
it('requires nonblank clarification and invalidates approval when editing either input stage',()=>{
 render(<LocalPlanWalkthrough plan={plan()} onExit={()=>{}}/>);input();click('继续澄清范围与输出');
 const review=()=>screen.getByRole('button',{name:'审阅模拟计划'}) as HTMLButtonElement;
 expect(review().disabled).toBe(true);fireEvent.change(screen.getByLabelText('本次范围与排除项'),{target:{value:'范围'}});fireEvent.change(screen.getByLabelText('预期输出与验收要求'),{target:{value:'  '}});expect(review().disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('预期输出与验收要求'),{target:{value:'清单'}});click('审阅模拟计划');click('批准此模拟计划（不开始）');click('修改澄清并撤销批准');
 fireEvent.change(screen.getByLabelText('本次范围与排除项'),{target:{value:'新范围'}});expect(screen.queryByRole('button',{name:'开始本地模拟执行'})).toBeNull();click('审阅模拟计划');expect(screen.getByText('新范围')).toBeTruthy();click('批准此模拟计划（不开始）');click('修改问题并撤销批准');
 fireEvent.change(screen.getByLabelText('本次模拟问题'),{target:{value:'新问题'}});expect(screen.queryByRole('button',{name:'开始本地模拟执行'})).toBeNull();click('继续澄清范围与输出');click('审阅模拟计划');expect(screen.getByText('新问题')).toBeTruthy();expect(screen.getByRole('button',{name:'批准此模拟计划（不开始）'})).toBeTruthy();
});
it('retains original editor, blocks dirty entry, clears on record changes and remount',async()=>{
 const a=plan(),b=plan('two');const s=new ManualPlanSession(new ManualPlanClient());
 vi.spyOn(s,'loadList').mockResolvedValue();const get=vi.spyOn(s.client,'get').mockImplementation(async id=>id==='one'?a:b);
 const mutate=vi.spyOn(s,'mutate');render(<ManualPlanManager session={s} onClose={()=>{}}/>);
 await act(async()=>s.open('one',()=>true));click('打开本地模拟研究流程');input();approve();click('开始本地模拟执行');
 click('退出模拟并清空，返回计划');expect(screen.queryByLabelText('本次模拟问题')).toBeNull();
 fireEvent.change(screen.getByLabelText('标题'),{target:{value:'仍可编辑'}});expect((screen.getByRole('button',{name:'打开本地模拟研究流程'}) as HTMLButtonElement).disabled).toBe(true);
 act(()=>s.discard(()=>true));click('打开本地模拟研究流程');input();
 await act(async()=>s.open('two',()=>true));expect(screen.queryByLabelText('本次模拟问题')).toBeNull();click('打开本地模拟研究流程');expect((screen.getByLabelText('本次模拟问题') as HTMLTextAreaElement).value).toBe('');
 input();cleanup();render(<ManualPlanManager session={s} onClose={()=>{}}/>);expect(screen.queryByLabelText('本次模拟问题')).toBeNull();
 expect(mutate).not.toHaveBeenCalled();expect(get).toHaveBeenCalledTimes(2);
});
it('dirty editing invalidates active context; session replacement cannot retain its question',async()=>{
 const make=()=>{const s=new ManualPlanSession(new ManualPlanClient());vi.spyOn(s,'loadList').mockResolvedValue();vi.spyOn(s.client,'get').mockResolvedValue(plan());return s;};
 const first=make(),second=make();const view=render(<ManualPlanManager session={first} onClose={()=>{}}/>);await act(async()=>first.open('one',()=>true));
 click('打开本地模拟研究流程');input();fireEvent.change(screen.getByLabelText('目标'),{target:{value:'新目标'}});expect(screen.queryByLabelText('本次模拟问题')).toBeNull();
 act(()=>first.discard(()=>true));click('打开本地模拟研究流程');input();view.rerender(<ManualPlanManager session={second} onClose={()=>{}}/>);expect(screen.queryByLabelText('本次模拟问题')).toBeNull();await act(async()=>second.open('one',()=>true));click('打开本地模拟研究流程');expect((screen.getByLabelText('本次模拟问题') as HTMLTextAreaElement).value).toBe('');
});
it('deleted or unsaved plans expose no entry; busy saved plans cannot enter',async()=>{
 const s=new ManualPlanSession(new ManualPlanClient());vi.spyOn(s,'loadList').mockResolvedValue();const deleted={...plan(),deletedAt:'2026-10-22T00:00:00.000Z'};vi.spyOn(s.client,'get').mockResolvedValue(deleted);
 const view=render(<ManualPlanManager session={s} onClose={()=>{}}/>);act(()=>s.newPlan(()=>true));expect(screen.queryByRole('button',{name:'打开本地模拟研究流程'})).toBeNull();await act(async()=>s.open('one',()=>true));expect(screen.queryByRole('button',{name:'打开本地模拟研究流程'})).toBeNull();
 vi.mocked(s.client.get).mockResolvedValue(plan());await act(async()=>s.open('one',()=>true));s.detailLoading=true;view.rerender(<ManualPlanManager session={s} onClose={()=>{}}/>);expect((screen.getByRole('button',{name:'打开本地模拟研究流程'}) as HTMLButtonElement).disabled).toBe(true);
});

const finish=()=>{input();approve();click('开始本地模拟执行');click('手动完成流程演示');};
it('previews the exact full addition, stages it only on request, focuses notes and saves only on a second explicit action',async()=>{
 const source=plan();source.data.notes='  保留原备注\n';const s=new ManualPlanSession(new ManualPlanClient());
 vi.spyOn(s,'loadList').mockResolvedValue();vi.spyOn(s.client,'get').mockResolvedValue(source);const mutate=vi.spyOn(s,'mutate').mockResolvedValue();
 render(<ManualPlanManager session={s} onClose={()=>{}}/>);await act(async()=>s.open(source.id,()=>true));click('打开本地模拟研究流程');finish();
 const preview=screen.getByLabelText('将追加的完整文本（模拟流程摘要，非研究结论）') as HTMLTextAreaElement;
 const addition=preview.value;expect(preview.readOnly).toBe(true);expect(addition.startsWith('\n\n【模拟流程摘要，非研究结论】')).toBe(true);
 expect(s.editor!.draft.notes).toBe(source.data.notes);expect(mutate).not.toHaveBeenCalled();
 click('追加模拟摘要到当前计划备注草稿');expect(screen.queryByLabelText('本地模拟研究流程')).toBeNull();
 expect((screen.getByLabelText('备注') as HTMLTextAreaElement).value).toBe(source.data.notes+addition);expect(document.activeElement).toBe(screen.getByLabelText('备注'));
 expect(s.editor!.record).toBe(source);expect(s.editor!.dirty).toBe(true);expect(mutate).not.toHaveBeenCalled();expect(screen.getByRole('status').textContent).toContain('尚未保存');
 click('保存计划');expect(mutate).toHaveBeenCalledExactlyOnceWith('update');
});
it.each(['取消模拟并清空输入','退出模拟并清空，返回计划'])('result dismissal through %s never stages notes or saves',async label=>{
 const source=plan();source.data.notes='原备注';const s=new ManualPlanSession(new ManualPlanClient());
 vi.spyOn(s,'loadList').mockResolvedValue();vi.spyOn(s.client,'get').mockResolvedValue(source);const stage=vi.spyOn(s,'stageSimulatedSummary'),mutate=vi.spyOn(s,'mutate');
 render(<ManualPlanManager session={s} onClose={()=>{}}/>);await act(async()=>s.open(source.id,()=>true));click('打开本地模拟研究流程');finish();click(label);
 expect(stage).not.toHaveBeenCalled();expect(mutate).not.toHaveBeenCalled();expect(s.editor!.draft.notes).toBe('原备注');expect(s.editor!.dirty).toBe(false);
});
it('over-limit append keeps the entire result preview and inputs available for editing',async()=>{
 const source=plan();source.data.notes='原'.repeat(2600);const s=new ManualPlanSession(new ManualPlanClient());
 vi.spyOn(s,'loadList').mockResolvedValue();vi.spyOn(s.client,'get').mockResolvedValue(source);const mutate=vi.spyOn(s,'mutate');
 render(<ManualPlanManager session={s} onClose={()=>{}}/>);await act(async()=>s.open(source.id,()=>true));click('打开本地模拟研究流程');finish();
 const preview=screen.getByLabelText('将追加的完整文本（模拟流程摘要，非研究结论）') as HTMLTextAreaElement,whole=preview.value;
 click('追加模拟摘要到当前计划备注草稿');expect(screen.getByRole('alert').textContent).toContain('8000 UTF-8 字节');expect(preview.value).toBe(whole);expect(s.editor!.draft.notes).toBe(source.data.notes);expect(s.editor!.dirty).toBe(false);
 click('返回修改模拟输入');expect((screen.getByLabelText('本次范围与排除项') as HTMLTextAreaElement).value).toBe('只核对已加载资料，不扩展主题');expect((screen.getByLabelText('预期输出与验收要求') as HTMLTextAreaElement).value).toBe('一份待验证事项清单');
 click('返回修改问题');expect((screen.getByLabelText('本次模拟问题') as HTMLTextAreaElement).value).toBe('需核对哪些事项？');expect(mutate).not.toHaveBeenCalled();
});
it.each(['completed','cancelled'] as const)('finished %s plan permits simulation but requires explicit reopen before notes append',async state=>{
 const source=plan();source.data.state=state;const s=new ManualPlanSession(new ManualPlanClient());
 vi.spyOn(s,'loadList').mockResolvedValue();vi.spyOn(s.client,'get').mockResolvedValue(source);const mutate=vi.spyOn(s,'mutate');
 render(<ManualPlanManager session={s} onClose={()=>{}}/>);await act(async()=>s.open(source.id,()=>true));click('打开本地模拟研究流程');finish();
 expect((screen.getByRole('button',{name:'追加模拟摘要到当前计划备注草稿'}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByRole('button',{name:'重新打开为草稿'})).toBeTruthy();expect(mutate).not.toHaveBeenCalled();expect(s.editor!.dirty).toBe(false);
});
it('repeated append clicks call the receiver only once',()=>{
 const source=plan(),append=vi.fn((_inputs:Parameters<typeof localPlanSummary>[1]):string|null=>null);render(<LocalPlanWalkthrough plan={source} onExit={()=>{}} onAppendSummary={append}/>);finish();click('追加模拟摘要到当前计划备注草稿');click('追加模拟摘要到当前计划备注草稿');expect(append).toHaveBeenCalledOnce();
 const passed=append.mock.calls[0][0];expect(localPlanSummary(source,passed)).toContain('模拟流程摘要，非研究结论');
});
