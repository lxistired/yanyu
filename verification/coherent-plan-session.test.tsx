import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {ManualPlanHost} from '../candidate/src/components/manual-plan-host';
import {createLocalHarness,handlerIdentity} from './local-handler-harness.mjs';
// The report panel is unrelated and normally stays mounted while hidden. Stub only
// this unrelated panel; shell, plan host/view/manager/selector/client/session are real.
vi.mock('../candidate/src/components/ServiceReportsEntry',()=>({ServiceReportsEntry:()=>null}));
const evidence=resolve('transcript-shortcut-evidence/session-link-regression');
const hosts:ManualPlanHost[]=[];
let harness:ReturnType<typeof createLocalHarness>|undefined;
afterEach(()=>{cleanup();hosts.splice(0).forEach(h=>h.dispose());harness?.persist();harness?.close();harness=undefined;vi.restoreAllMocks();history.replaceState(null,'','/');});
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name,exact:true}));
const snapshot=(name:string)=>writeFileSync(resolve(evidence,name+'.html'),document.body.innerHTML);
function mount(){const h=new ManualPlanHost(harness!.fetcher);hosts.push(h);h.activate();h.setAuthority('a'.repeat(64),true);history.replaceState(null,'','/?page=planner');render(<OrdinaryNavigationShell lifetime={new OrdinaryRequestLifetime()} manualPlanHost={h}/>);return h;}
async function openPlan(){click((await screen.findByRole('button',{name:'合成研究计划',exact:true})).textContent!);await screen.findByLabelText('计划编辑器');await waitFor(()=>expect((screen.getByRole('button',{name:'管理计划会话关联'}) as HTMLButtonElement).disabled).toBe(false));}

it('real current shell → selector → server callback → SQLite save → full reopen → linked names → confirmed clear',async()=>{
 const f=harness=createLocalHarness(evidence);
 const forbidNetwork=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('Unexpected external/global transport');});
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 const w=await f.post('workspace','create',{kind:'workspace',id:'flow-workspace',idempotencyKey:'seed-workspace',data:{name:'资料核对工作区'}});
 const s=await f.post('workspace','create',{kind:'session',id:'flow-session',idempotencyKey:'seed-session',data:{workspaceId:w.id,title:'已有普通会话'}});
 const p=await f.post('manual-plans','create',{idempotencyKey:'seed-plan',title:'合成研究计划',objective:'核对资料与会话关联',notes:'仍为手工记录',targetDate:null});
 let host=mount();await openPlan();
 const scopeText=screen.getByText(/手工研究计划是独立原创/).textContent!;
 expect(scopeText).toContain('可明确关联一个已有普通会话');expect(scopeText).toContain('明确选择并批量保存最多 100 份不同文档或转写资料');expect(scopeText).toContain('保留原有单份快捷入口');expect(scopeText).toContain('不自动执行研究');expect(scopeText).not.toContain('不关联工作区或会话');
 click('管理计划会话关联');await screen.findByText('当前未保存会话关联。');snapshot('01-unlinked');
 fireEvent.change(screen.getByLabelText('关联工作区'),{target:{value:w.id}});
 const sessionSelector=await screen.findByLabelText('关联会话');
 expect((sessionSelector as HTMLSelectElement).value).toBe('');expect((screen.getByRole('button',{name:'保存会话关联'}) as HTMLButtonElement).disabled).toBe(true);
 expect(f.calls.filter(c=>c.path.endsWith('/setSessionLink'))).toHaveLength(0);
 fireEvent.change(sessionSelector,{target:{value:s.id}});click('保存会话关联');
 await waitFor(()=>expect(host.session!.editor!.record!.revision).toBe(2));
 expect(host.session!.pending).toBeNull();
 const saved=host.session!.editor!.record!;
 expect(saved.data.sessionLink).toEqual({scope:saved.storeScope,workspaceId:w.id,sessionId:s.id,workspaceRevision:w.revision,sessionRevision:s.revision});
 const savedWrites=f.calls.filter(c=>c.path.endsWith('/setSessionLink'));
 expect(savedWrites).toHaveLength(1);expect(savedWrites[0].status).toBe(200);
 const writeIndex=f.calls.indexOf(savedWrites[0]);
 expect(f.calls.slice(writeIndex+1).some(c=>c.path==='/api/manual-plans/get'&&c.input.scope===saved.storeScope&&c.payload.revision===2)).toBe(true);
 snapshot('02-saved-readback');
 cleanup();host.dispose();f.reopen();host=mount();await openPlan();
 expect(host.session!.editor!.record!.data.sessionLink).toEqual(saved.data.sessionLink);
 expect(host.session!.editor!.record!.revision).toBe(2);
 click('管理计划会话关联');await screen.findByText('已保存关联当前可用：资料核对工作区 / 已有普通会话。');snapshot('03-reopened-current-names');
 const selector=screen.getByRole('region',{name:'计划会话关联选择'});
 expect(within(selector).getByText(/不执行研究、读取消息或调用模型/)).toBeTruthy();
 click('清除会话关联');expect(confirm).toHaveBeenCalledOnce();expect(f.calls.filter(c=>c.path.endsWith('/setSessionLink'))).toHaveLength(1);
 confirm.mockReturnValue(true);click('清除会话关联');
 await waitFor(()=>expect(host.session!.editor!.record!.revision).toBe(3));expect(host.session!.editor!.record!.data.sessionLink).toBeNull();
 click('管理计划会话关联');await screen.findByText('当前未保存会话关联。');snapshot('04-cleared-current');
 cleanup();host.dispose();f.reopen();
 const final=await f.post('manual-plans','get',{id:p.id,includeDeleted:true,scope:saved.storeScope});
 expect(final.revision).toBe(3);expect(final.data.sessionLink).toBeNull();expect(final.data.notes).toBe(p.data.notes);
 expect(await f.post('workspace','get',{kind:'workspace',id:w.id})).toEqual(w);
 expect(await f.post('workspace','get',{kind:'session',id:s.id})).toEqual(s);
 expect(f.store.read(f.context(),tx=>tx.list('message'))).toEqual([]);
 expect(f.calls.filter(c=>c.path.endsWith('/setSessionLink')).map(c=>c.input.sessionLink)).toEqual([{workspaceId:w.id,workspaceRevision:w.revision,sessionId:s.id,sessionRevision:s.revision},null]);
 expect(f.calls.every(c=>c.status===200)).toBe(true);expect(forbidNetwork).not.toHaveBeenCalled();
 writeFileSync(resolve(evidence,'flow-result.json'),JSON.stringify({result:'PASS',handlerIdentity,scope:'One coherent actual-component/production-callback/SQLite synthetic flow; no browser or HTTP listener',planId:p.id,planRevisions:[1,2,3],saveSurvivedFullHostAndDatabaseReopen:true,linkedCurrentTitlesVisible:true,cancelledClearDidNotWrite:true,clearSurvivedDatabaseReopen:true,targetRecordsUnchanged:true,messagesCreated:0,productionChange:'Regression of existing session link under new transcript-shortcut candidate',directSessionRoute:'Not implemented or claimed; ordinary routing has no exact-session destination contract',skipped:['browser/device: 受阻跳过','real network/HTTP','AI/research execution','full product acceptance']},null,2)+'\n');
});
