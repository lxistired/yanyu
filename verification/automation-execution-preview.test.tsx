import React from 'react';
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,cleanup,fireEvent,act,within} from '@testing-library/react';
import {AutomationExecutionPreview} from '../candidate/src/components/AutomationExecutionPreview';
import {AutomationManager} from '../candidate/src/components/AutomationManager';
import type {ScheduleRecord} from '../candidate/shared/automation';
const schedule={id:'schedule',revision:1,deletedAt:null,data:{name:'Test definition',skillId:'skill',sourceIds:[],instructions:'原指令',cadence:{kind:'daily',time:'09:00',timezone:'UTC'},enabled:false,state:'paused',misfirePolicy:'coalesce',graceSeconds:60,nextRunAt:null,lastRunAt:null}} as ScheduleRecord;
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
function setup(){vi.useFakeTimers();const fetch=vi.fn();vi.stubGlobal('fetch',fetch); const view=render(<AutomationExecutionPreview schedules={[schedule]} ready/>);fireEvent.change(screen.getByLabelText('模拟任务定义'),{target:{value:'schedule'}});return {view,fetch};}
function start(){fireEvent.click(screen.getByRole('button',{name:'开始本地模拟'}));}
function finish(){act(()=>vi.advanceTimersByTime(700));act(()=>vi.advanceTimersByTime(1200));}
it('simulates queued/running/completed using a frozen snapshot and makes no API call; closing details does not reopen',()=>{
 const {view,fetch}=setup();start(); expect(screen.getByRole('status').textContent).toContain('模拟待执行');
 fireEvent.click(screen.getByRole('button',{name:'开始本地模拟'}));expect(screen.getAllByRole('listitem')).toHaveLength(1);
 view.rerender(<AutomationExecutionPreview schedules={[{...schedule,data:{...schedule.data,instructions:'新指令'}}]} ready/>);
 act(()=>vi.advanceTimersByTime(700)); expect(screen.getByRole('status').textContent).toContain('模拟执行中');
 fireEvent.click(screen.getByRole('button',{name:'收起模拟详情'}));act(()=>vi.advanceTimersByTime(1200));
 expect(screen.queryByRole('region',{name:'模拟结果详情'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'查看模拟 1'}));expect(screen.getByText(/模拟快照（仅回显，未执行）：原指令/)).toBeTruthy();expect(fetch).not.toHaveBeenCalled();
});
it('failure retries as a separate run with the old snapshot and selected success scenario',()=>{
 const {fetch}=setup();fireEvent.change(screen.getByLabelText('模拟结果场景'),{target:{value:'failed'}});start();finish();
 expect(screen.getByText(/演示失败：/)).toBeTruthy();fireEvent.change(screen.getByLabelText('模拟结果场景'),{target:{value:'completed'}});
 fireEvent.click(screen.getByRole('button',{name:'重新模拟 #1'}));finish();expect(screen.getAllByRole('listitem')).toHaveLength(2);
 expect(screen.getByText(/使用 #1 的原始快照重试/)).toBeTruthy();expect(screen.getByText(/模拟快照（仅回显，未执行）：原指令/)).toBeTruthy();expect(fetch).not.toHaveBeenCalled();
});
it.each([false,true])('cancels %s running state without late completion and allows a new run',running=>{
 setup();start();if(running)act(()=>vi.advanceTimersByTime(700));fireEvent.click(screen.getByRole('button',{name:'取消模拟'}));finish();
 expect(screen.getByText('模拟已取消，未产生执行结果。可重新模拟。')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'重新模拟 #1'}));finish();expect(screen.getByText(/模拟快照/)).toBeTruthy();
});
it('hiding cancels the timer, preserves terminal history and does not reopen details on return',()=>{
 const {view}=setup();start();view.rerender(<AutomationExecutionPreview schedules={[schedule]} ready visible={false}/>);finish();view.rerender(<AutomationExecutionPreview schedules={[schedule]} ready/>);
 expect(screen.getByRole('status').textContent).toContain('模拟已取消');expect(screen.queryByRole('region',{name:'模拟结果详情'})).toBeNull();expect(vi.getTimerCount()).toBe(0);
});
it('manager shows the simulation only in runs while real execution remains disabled',async()=>{
 const fetch=vi.fn(async(input:string)=>new Response(JSON.stringify(input.endsWith('listSchedules')?[schedule]:[]),{status:200}));vi.stubGlobal('fetch',fetch);
 render(<AutomationManager definitionsOnly/>);await screen.findByRole('heading',{name:'Test definition'});
 expect(screen.queryByRole('region',{name:'原创本地执行模拟'})).toBeNull();
 expect((screen.getByRole('button',{name:'检查到期任务'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'运行记录',exact:true}));expect(screen.getByRole('region',{name:'原创本地执行模拟'})).toBeTruthy();
 expect(screen.getByText('暂无运行记录')).toBeTruthy();expect(fetch.mock.calls.every(([url])=>/list/.test(url))).toBe(true);
});
