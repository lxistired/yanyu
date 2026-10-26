import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {ManualPlanHost} from '../candidate/src/components/manual-plan-host';
import {createLocalHarness,handlerIdentity} from './local-handler-harness.mjs';
vi.mock('../candidate/src/components/ServiceReportsEntry',()=>({ServiceReportsEntry:()=>null}));
const evidence=resolve('transcript-shortcut-evidence');
const transcriptStoreId='10000000-0000-4000-8000-000000000001',jobId='20000000-0000-4000-8000-000000000002';
const hosts:ManualPlanHost[]=[];let harness:ReturnType<typeof createLocalHarness>|undefined;
afterEach(()=>{cleanup();hosts.splice(0).forEach(h=>h.dispose());harness?.persist();harness?.close();harness=undefined;vi.restoreAllMocks();history.replaceState(null,'','/');});
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name,exact:true}));
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','X-Transcription-Store-Id':transcriptStoreId}});
function mount(){const h=new ManualPlanHost(harness!.fetcher);hosts.push(h);h.activate();h.setAuthority('a'.repeat(64),true);history.replaceState(null,'','/?page=planner');render(<OrdinaryNavigationShell lifetime={new OrdinaryRequestLifetime()} manualPlanHost={h} identityScope={'a'.repeat(64)}/>);return h;}
async function openPlan(){click((await screen.findByRole('button',{name:'转写快捷入口合成计划',exact:true})).textContent!);await screen.findByLabelText('计划编辑器');click('管理单份转写快捷入口');}
const snapshot=(name:string)=>writeFileSync(resolve(evidence,name+'.html'),document.body.innerHTML);
it('current components + exact plan server route + real SQLite: save, reopen, guarded exact open, clear; transcript reads remain synthetic',async()=>{
 const f=harness=createLocalHarness(evidence);let title='已选转写初始标题';
 const reads=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  const url=String(input);
  if(url==='/api/documents/choices')return json({uploadScope:transcriptStoreId,folders:[],workspaces:[]});
  if(url.startsWith('/api/documents?'))return json({storeScope:transcriptStoreId,documents:[],total:0,offset:0,limit:10});
  if(url==='/api/local-asr/identity')return json({transcriptionStoreId:transcriptStoreId});
  if(url==='/api/local-asr/choices')return json({workspaces:[],sessions:[]});
  if(url.startsWith('/api/local-asr/jobs?')){
   expect(new Headers(init?.headers).get('X-Transcription-Store-Id')).toBe(transcriptStoreId);
   return json({total:1,offset:0,limit:10,hasMore:false,activeJobCount:0,jobs:[{id:jobId,title,filename:'synthetic.wav',status:'failed',created:'2026-10-22T00:00:00Z',deleted_at:null,result:null,error:'synthetic',workspace_id:null,session_id:null}],model:{maxSeconds:7200,maxBytes:268435456,chunkSeconds:30,overlapSeconds:1,deadlineSeconds:14400}});
  }
  throw Error('Unexpected transport '+url);
 });
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 const w=await f.post('workspace','create',{kind:'workspace',id:'shortcut-workspace',idempotencyKey:'seed-workspace',data:{name:'不应更改的工作区'}});
 const s=await f.post('workspace','create',{kind:'session',id:'shortcut-session',idempotencyKey:'seed-session',data:{workspaceId:w.id,title:'不应更改的会话'}});
 const p=await f.post('manual-plans','create',{idempotencyKey:'seed-plan',title:'转写快捷入口合成计划',objective:'私有研究目标不得出现在检索请求',notes:'原备注',targetDate:'2026-10-31'});
 const got=await f.post('manual-plans','get',{id:p.id});
 const linked=await f.post('manual-plans','setSessionLink',{id:p.id,expectedRevision:1,idempotencyKey:'seed-session-link',scope:got.storeScope,sessionLink:{workspaceId:w.id,workspaceRevision:1,sessionId:s.id,sessionRevision:1}});
 let host=mount();await openPlan();click('为此计划查找本地资料');click('转写');
 const save=await screen.findByRole('button',{name:'保存此转写快捷入口：已选转写初始标题'});
 expect(f.calls.filter(c=>c.path.endsWith('/setMaterialLink'))).toHaveLength(0);
 fireEvent.click(save);fireEvent.click(save);await waitFor(()=>expect(host.session!.editor!.record!.revision).toBe(3));
 expect(host.session!.pending).toBeNull();const saved=host.session!.editor!.record!;
 expect(saved.data.materialLink).toEqual({kind:'transcript',transcriptStoreId,jobId});expect(saved.data.sessionLink).toEqual(linked.data.sessionLink);
 expect(saved.data.notes).toBe(p.data.notes);expect(saved.data.targetDate).toBe(p.data.targetDate);
 const writes=f.calls.filter(c=>c.path.endsWith('/setMaterialLink'));expect(writes).toHaveLength(1);expect(writes[0].input.scope).toBe(saved.storeScope);
 const writeIndex=f.calls.indexOf(writes[0]);expect(f.calls.slice(writeIndex+1).some(c=>c.path.endsWith('/get')&&c.input.scope===saved.storeScope&&c.payload.revision===3)).toBe(true);
 click('管理单份转写快捷入口');await screen.findByText(/当前转写：已选转写初始标题/);snapshot('01-saved-current');
 cleanup();host.dispose();f.reopen();title='当前转写已更名';host=mount();await openPlan();
 await screen.findByText(/当前转写：当前转写已更名/);expect(host.session!.editor!.record!.data.materialLink).toEqual(saved.data.materialLink);snapshot('02-reopened-current-title');
 fireEvent.change(screen.getByLabelText('备注'),{target:{value:'未保存草稿保持'}});click('打开已保存的当前转写');expect(location.search).toBe('?page=planner');expect(confirm).toHaveBeenCalledTimes(1);
 confirm.mockReturnValue(true);click('打开已保存的当前转写');await screen.findByText('当前转写已更名');
 expect(new URL(location.href).searchParams.get('transcriptStoreId')).toBe(transcriptStoreId);expect(new URL(location.href).searchParams.get('transcriptJob')).toBe(jobId);expect(host.session!.editor!.draft.notes).toBe('未保存草稿保持');
 await act(async()=>{history.back();await new Promise(resolve=>setTimeout(resolve,100));});await screen.findByRole('button',{name:'为此计划查找本地资料'});expect(screen.queryByLabelText('转写查询')).toBeNull();
 click('管理单份转写快捷入口');click('放弃草稿');confirm.mockReturnValue(false);click('清除转写快捷入口');expect(f.calls.filter(c=>c.path.endsWith('/setMaterialLink'))).toHaveLength(1);
 confirm.mockReturnValue(true);click('清除转写快捷入口');await waitFor(()=>expect(host.session!.editor!.record!.revision).toBe(4));expect(host.session!.editor!.record!.data.materialLink).toBeNull();snapshot('03-cleared');
 cleanup();host.dispose();f.reopen();const final=await f.post('manual-plans','get',{id:p.id,scope:saved.storeScope});expect(final.data.materialLink).toBeNull();expect(final.data.sessionLink).toEqual(linked.data.sessionLink);expect(final.data.notes).toBe(p.data.notes);expect(final.data.targetDate).toBe(p.data.targetDate);
 expect(await f.post('workspace','get',{kind:'workspace',id:w.id})).toEqual(w);expect(await f.post('workspace','get',{kind:'session',id:s.id})).toEqual(s);expect(f.store.read(f.context(),tx=>tx.list('message'))).toEqual([]);
 expect(reads.mock.calls.every(([,init])=>!init?.method||init.method==='GET')).toBe(true);expect(JSON.stringify(reads.mock.calls)).not.toContain(p.data.objective);
 writeFileSync(resolve(evidence,'coherent-result.json'),JSON.stringify({result:'PASS',handlerIdentity,scope:'Real current UI, host, client, production plan callback and prepared runtime into real temporary SQLite. Transcript identity/rows and authenticated principal are synthetic fixtures.',saveSurvivedDatabaseAndHostReopen:true,currentNotFrozenTitle:true,clearCancelledThenPersisted:true,sessionLinkPreserved:true,targetRecordsUnchanged:true,guardedExactNavigation:true,noInventedSearchReturnContext:true,network:false,browserDevice:'受阻跳过',fullProductAcceptance:false},null,2)+'\n');
});
