/** Copy regression specification. Synthetic fixtures only; not browser/device or service acceptance. */
import React from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {AutomationManager} from '../candidate/src/components/AutomationManager';
import {ManualInventorySession} from '../candidate/src/components/manual-inventory-session';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import type {AutomationDefinitionWriteHost} from '../candidate/src/components/automation-definition-write-host';
vi.mock('../candidate/src/components/ServiceReportsEntry',()=>({ServiceReportsEntry:()=>null}));
vi.mock('../candidate/src/components/AutomationDefinitionHostView',()=>({AutomationDefinitionHostView:()=>null}));
const owner='a'.repeat(64), scope='10000000-0000-0000-0000-000000000000';
const skill={id:'skill',revision:1,deletedAt:null,data:{name:'Inventory fixture',enabled:true,handler:'local-document-inventory',description:''},availability:{status:'available',code:'local_only',detail:'fixture',capabilities:[]}};
const schedule={id:'schedule',revision:1,deletedAt:null,data:{name:'Copy definition',skillId:'skill',sourceIds:[],instructions:'',cadence:{kind:'daily',time:'09:00',timezone:'UTC'},enabled:true,state:'active',misfirePolicy:'coalesce',graceSeconds:60,nextRunAt:'2027-01-01T09:00:00.000Z',lastRunAt:null}};
function transport(runs:unknown[]=[]){
 const fetch=vi.fn(async(input:string)=>new Response(JSON.stringify(input.endsWith('listSkills')?[skill]:input.endsWith('listSchedules')?[schedule]:input.endsWith('listRuns')?runs:[]),{status:200}));
 vi.stubGlobal('fetch',fetch);return fetch;
}
function session(available:boolean|null){
 const api={capabilities:vi.fn(()=>new Promise<never>(()=>{})),execute:vi.fn(),preview:vi.fn(),operation:vi.fn(),result:vi.fn()};
 const s=new ManualInventorySession(owner,()=>{},api as never);
 if(available!==null)s.capabilities={protocol:'manual-inventory-v1',identityScope:owner,automationStoreScope:scope,documentStoreScope:available?scope:null,manualDocumentInventory:{available,protocol:'manual-inventory-v1',maxDocuments:250,maxResultBytes:262144}};
 return {s,api};
}
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();history.replaceState(null,'','/');});
it.each([false,true])('shell copy scopes manual entry to host presence %s without asserting source availability',host=>{
 transport();history.replaceState(null,'','/?page=home');
 const {container}=render(<OrdinaryNavigationShell lifetime={new OrdinaryRequestLifetime()} automationDefinitionWriteHost={host?{} as AutomationDefinitionWriteHost:undefined}/>);
 const boundary=container.querySelector('.ordinary-boundary')!.textContent!;
 expect(boundary).toContain('通用任务与定时执行未接通，通知投递未接通');
 if(host){for(const text of ['须取得有效身份与手动会话','来源未知或不可用时不能新建','先预览范围，再明确确认','不读取正文、不调用 AI、不发送通知'])expect(boundary).toContain(text);}
 else {expect(boundary).toContain('此入口未提供专用手动清单');expect(boundary).not.toContain('可用时须先预览');}
});
it('manager without a manual session never promises a panel below and scopes empty history',async()=>{
 const fetch=transport();render(<AutomationManager definitionsOnly/>);await screen.findByRole('heading',{name:'Copy definition'});
 expect(screen.getByText(/通知投递未接通；此入口未提供专用手动清单/)).toBeTruthy();
 expect(screen.queryByRole('region',{name:'手动本地文档清单'})).toBeNull();expect(screen.queryByText(/下方专用手动清单/)).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'运行记录',exact:true}));
 await screen.findByText('当前筛选下没有通用任务运行记录；专用手动清单记录不在此列表。');
 expect(screen.getByText(/此处只读展示通用任务历史/)).toBeTruthy();
 expect(fetch.mock.calls.every(([url])=>/\/list(Skills|DataSources|Schedules|Runs|Notifications)$/.test(url))).toBe(true);
});
it.each([null,false,true])('manual session with current availability %s does not mean execution has happened',async available=>{
 const fetch=transport(),{s,api}=session(available);render(<AutomationManager definitionsOnly manualInventorySession={s}/>);
 await screen.findByRole('heading',{name:'Copy definition'});
 expect(screen.getByText(/下方专用手动清单须核验当前来源；来源未知或不可用时不能新建/)).toBeTruthy();
 expect(screen.getByRole('region',{name:'手动本地文档清单'})).toBeTruthy();
 expect(screen.getByText(/不读取正文、不执行指令、不调用 AI、不发送通知/)).toBeTruthy();
 expect((screen.getByRole('button',{name:'预览选定范围'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.queryByRole('button',{name:'确认保存一次清单'})).toBeNull();
 if(available===false)expect(screen.getByText(/当前文档来源不可用/)).toBeTruthy();
 for(const name of ['检查到期任务','立即创建运行']){const button=screen.getByRole('button',{name}) as HTMLButtonElement;expect(button.disabled).toBe(true);fireEvent.click(button);}
 expect(fetch.mock.calls.some(([url])=>/dispatchDue|runNow|execute|retry|markNotification/.test(url))).toBe(false);
 expect(api.execute).not.toHaveBeenCalled();expect(api.preview).not.toHaveBeenCalled();expect(api.operation).not.toHaveBeenCalled();expect(api.result).not.toHaveBeenCalled();
 expect(screen.queryByText(/已提交并保存一次固定历史清单/)).toBeNull();
});
it('an eligible source still requires explicit scope, preview and a separate confirmation',async()=>{
 transport();const {s,api}=session(true);const execute=vi.spyOn(s,'executePreview').mockResolvedValue(undefined);
 const view=render(<AutomationManager definitionsOnly manualInventorySession={s}/>);await screen.findByRole('heading',{name:'Copy definition'});
 fireEvent.change(screen.getByLabelText('任务定义'),{target:{value:'schedule'}});
 expect((screen.getByRole('button',{name:'预览选定范围'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('文档范围'),{target:{value:'all'}});
 expect((screen.getByRole('button',{name:'预览选定范围'}) as HTMLButtonElement).disabled).toBe(false);
 expect(screen.queryByRole('button',{name:'确认保存一次清单'})).toBeNull();expect(execute).not.toHaveBeenCalled();
 // Synthetic preview insertion isolates copy/control boundaries; no claim of real preview execution.
 s.preview={selection:s.draft.selection,scheduleId:'schedule',scheduleRevision:1,skillId:'skill',skillRevision:1,documentStoreScope:scope,count:0,totalBytes:0,observedAt:'2026-10-22T00:00:00.000Z',inventoryDigest:'fixture'} as never;
 view.rerender(<AutomationManager definitionsOnly manualInventorySession={s}/>);
 expect(execute).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'确认保存一次清单'}));expect(execute).toHaveBeenCalledOnce();expect(api.execute).not.toHaveBeenCalled();
});

it('generic retry wording leaves the dedicated original-operation check separate',async()=>{
 const fetch=transport([{id:'run',revision:1,deletedAt:null,data:{scheduleId:'schedule',state:'queued',trigger:'manual',scheduledAt:'2026-10-22T00:00:00.000Z',detail:'Synthetic queued fixture'}}]);
 render(<AutomationManager definitionsOnly/>);await screen.findByRole('heading',{name:'Copy definition'});
 fireEvent.click(screen.getByRole('button',{name:'运行记录',exact:true}));
 await screen.findByText('此处运行记录仅供只读查看，不能执行、取消或重试；专用手动清单的原操作核对在独立入口进行。');
 expect((screen.getByRole('button',{name:'执行本地任务'}) as HTMLButtonElement).disabled).toBe(true);
 expect(fetch.mock.calls.some(([url])=>/executeLocalRun|cancelRun|retryRun/.test(url))).toBe(false);
});
