/** Synthetic only; source specification, not executed or accepted. */
import React from 'react';
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,cleanup,act} from '@testing-library/react';
import {ManualInventoryPanel} from '../candidate/src/components/ManualInventoryPanel';
import {ManualInventorySession} from '../candidate/src/components/manual-inventory-session';
const owner='a'.repeat(64),scope='10000000-0000-0000-0000-000000000000';
it('hiding and remounting panel keeps host draft; does not send, auto-retry or read result',()=>{
 const execute=vi.fn(),result=vi.fn(),operation=vi.fn();const s=new ManualInventorySession(owner,()=>{},{execute,result,operation} as never);s.capabilities={protocol:'manual-inventory-v1',identityScope:owner,automationStoreScope:scope,documentStoreScope:null,manualDocumentInventory:{available:false,protocol:'manual-inventory-v1',maxDocuments:250,maxResultBytes:262144}};s.setDraft('draft-schedule',{mode:'workspace',workspaceId:null,folderId:null});
 const view=render(<ManualInventoryPanel session={s} schedules={[]} skills={[]} definitionsReady/>);expect(screen.getByText(/仅未分配工作区文档/)).toBeTruthy();view.unmount();render(<ManualInventoryPanel session={s} schedules={[]} skills={[]} definitionsReady/>);expect(s.draft.scheduleId).toBe('draft-schedule');expect(s.unsavedState().dirty).toBe(true);expect(execute).not.toHaveBeenCalled();expect(operation).not.toHaveBeenCalled();expect(result).not.toHaveBeenCalled();cleanup();
});
it('requires explicit scope and unavailable source disables preview without hiding history',()=>{const s=new ManualInventorySession(owner,()=>{},{} as never);s.capabilities={protocol:'manual-inventory-v1',identityScope:owner,automationStoreScope:scope,documentStoreScope:null,manualDocumentInventory:{available:false,protocol:'manual-inventory-v1',maxDocuments:250,maxResultBytes:262144}};render(<ManualInventoryPanel session={s} schedules={[]} skills={[]} definitionsReady/>);expect((screen.getByRole('button',{name:'预览选定范围'}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByRole('button',{name:'查看 / 刷新历史首页'})).toBeTruthy();fireEvent.change(screen.getByLabelText('文档范围'),{target:{value:'unassigned'}});expect(s.draft.selection).toEqual({mode:'workspace',workspaceId:null,folderId:null});cleanup();});

afterEach(cleanup);
function panelDeferred(){let resolve!:(v:any)=>void,reject!:(e:Error)=>void;const promise=new Promise<any>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function resultPanel(){
 const read=panelDeferred(),history=panelDeferred(),execute=vi.fn(),result=vi.fn(()=>read.promise),operation=vi.fn();
 const s=new ManualInventorySession(owner,()=>{},{result,history:vi.fn(()=>history.promise),execute,operation} as never);
 s.capabilities={protocol:'manual-inventory-v1',identityScope:owner,automationStoreScope:scope,documentStoreScope:null,manualDocumentInventory:{available:false,protocol:'manual-inventory-v1',maxDocuments:250,maxResultBytes:262144}};
 s.history={protocol:'manual-inventory-v1',identityScope:owner,automationStoreScope:scope,items:[{runId:'run',resultId:'result',completedAt:'2026-10-22T00:00:00.000Z',scheduleId:'schedule',scheduleRevision:1,skillId:'skill',skillRevision:1}],nextCursor:null} as never;
 const panel=()=> <ManualInventoryPanel session={s} schedules={[]} skills={[]} definitionsReady/>;
 return {s,read,history,result,execute,operation,panel};
}
it.each(['success','error'])('renders first pending read, allows close after remount, and suppresses late %s',async outcome=>{
 const h=resultPanel();const view=render(h.panel());fireEvent.click(screen.getByRole('button',{name:'验证权限并查看历史清单'}));
 expect(screen.getByText(/正在读取历史清单/)).toBeTruthy();expect((screen.getByRole('button',{name:'关闭历史结果视图（不取消执行）'}) as HTMLButtonElement).disabled).toBe(false);
 expect((screen.getByRole('button',{name:'查看 / 刷新历史首页'}) as HTMLButtonElement).disabled).toBe(true);
 view.unmount();render(h.panel());expect(h.result).toHaveBeenCalledTimes(1);fireEvent.click(screen.getByRole('button',{name:'关闭历史结果视图（不取消执行）'}));
 expect(screen.queryByRole('region',{name:'受保护的历史结果'})).toBeNull();expect((screen.getByRole('button',{name:'查看 / 刷新历史首页'}) as HTMLButtonElement).disabled).toBe(false);
 await act(async()=>{if(outcome==='success')h.read.resolve({});else h.read.reject(Error('late denied'));await h.read.promise.catch(()=>{});});
 expect(screen.queryByText(/late denied/)).toBeNull();expect(screen.queryByRole('region',{name:'受保护的历史结果'})).toBeNull();expect(h.s.busy).toBe(false);expect(h.execute).not.toHaveBeenCalled();expect(h.operation).not.toHaveBeenCalled();expect(h.result).toHaveBeenCalledTimes(1);
});
it('does not offer result dismissal as cancellation of unrelated work',async()=>{
 const h=resultPanel();h.s.resultTarget={protocol:'manual-inventory-v1',identityScope:owner,automationStoreScope:scope,runId:'run',resultId:'result'};
 render(h.panel());fireEvent.click(screen.getByRole('button',{name:'查看 / 刷新历史首页'}));
 const close=screen.getByRole('button',{name:'关闭历史结果视图（不取消执行）'}) as HTMLButtonElement;expect(close.disabled).toBe(true);fireEvent.click(close);expect(h.s.busy).toBe(true);expect(h.s.resultTarget).not.toBeNull();
 await act(async()=>{h.history.resolve(h.s.history);await h.history.promise;});expect(close.disabled).toBe(false);expect(h.execute).not.toHaveBeenCalled();
});
