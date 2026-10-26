import React from 'react';
import {beforeAll,afterAll,afterEach,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {fork,spawnSync,type ChildProcess} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {webcrypto} from 'node:crypto';
import {boundedTransport} from '../visual-harness/bounded-transport';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {MonthlyServiceReportsView} from '../candidate/src/components/MonthlyServiceReportsView';
import {createServiceReportsClient,createServiceReportsCommands,serviceReportsCommandFingerprint,readServiceReportsPending,type ServiceReportsCommand,type ServiceReportsIntent} from '../candidate/src/adapters/service-reports';
const nativeFetch=globalThis.fetch;
let child:ChildProcess,origin:string,scope:string,pin:any,sequence=0;
const root=mkdtempSync(join(tmpdir(),'yanyu-recovery-client-'));
const report=JSON.parse(readFileSync('verification/fixtures/synthetic-report.json','utf8'));
beforeAll(async()=>{
 vi.stubGlobal('crypto',webcrypto);
 // Source-only checkouts run tests before build; use the already installed local tool only.
 if(!existsSync(join(process.cwd(),'dist/index.html'))){
  const built=spawnSync(process.execPath,[join(process.cwd(),'node_modules/vite/bin/vite.js'),'build'],{encoding:'utf8'});
  expect(built.status,built.stderr||built.stdout).toBe(0);
 }
 const prep=spawnSync(process.execPath,['backend/prepare-backend.mjs'],{encoding:'utf8'});expect(prep.status,prep.stderr).toBe(0);
 const storage=join(root,'store');mkdirSync(storage);
 await new Promise<void>((resolve,reject)=>{child=fork(join(process.cwd(),'backend/server.mjs'),[prep.stdout.trim(),storage,join(root,'events.jsonl'),'0'],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,HOME:root,YANYU_PYTHON:'/nonexistent/synthetic-test-python'}});let err='';child.stderr!.on('data',b=>err+=b);child.once('message',(m:any)=>{origin=m.origin;resolve()});child.once('exit',code=>reject(Error(`Synthetic server exit ${code}: ${err}`)));child.once('error',reject)});
 const identity=await(await nativeFetch(origin+'/api/demo/identity')).json();scope=identity.identityScope;pin=identity.syntheticSourcePin;
},20000);
afterAll(async()=>{vi.unstubAllGlobals();if(child?.exitCode===null)await new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.kill('SIGTERM')})});
afterEach(()=>{cleanup();sessionStorage.clear()});
const intent=():ServiceReportsIntent=>({action:'createActivity',input:{activity:{customer:{organizationId:'synthetic-org',contactId:null},kind:'other',status:'reported-completed',occurredAt:'2026-10-05T09:00:00.000Z',summary:'Client retained synthetic operation',references:[{pin}]}}});
type Mode='normal'|'drop-before'|'drop-after'|'hold'|'tamper-cancel';
async function setup(){
 let mode:Mode='normal',held:((r:Response)=>void)|null=null,actor={binding:'recovery-http-synthetic',epoch:1};
 const calls:{path:string;body:string}[]=[];
 const send=async(path:any,init?:RequestInit)=>nativeFetch(origin+String(path),init);
 const network=vi.fn(async(path:any,init?:RequestInit)=>{
  calls.push({path:String(path),body:String(init?.body)});
  const selected=mode;
  if(String(path).endsWith('/scope'))return send(path,init);
  if(selected==='drop-before')throw new TypeError('Synthetic loss before dispatch');
  if(selected==='hold')return new Promise<Response>(resolve=>{held=resolve});
  const response=await send(path,init);
  if(selected==='drop-after'){await response.arrayBuffer();throw new TypeError('Synthetic lost acknowledgement after real commit')}
  if(selected==='tamper-cancel'&&String(path).endsWith('/cancelCommand')){
   const body=await response.json();body.cancellation.fingerprint='0'.repeat(64);return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
  }
  return response;
 });
 const client=createServiceReportsClient({fetch:boundedTransport(new OrdinaryRequestLifetime(),network as typeof fetch),getActor:()=>actor});await client.scope();
 const commands=createServiceReportsCommands(client,{storage:sessionStorage,createKey:()=>`client-recovery-${++sequence}`});
 return {client,commands,calls,network,setMode:(m:Mode)=>{mode=m},release:()=>{held!(new Response('{}',{status:503,headers:{'Content-Type':'application/json'}}))},changeActor:()=>{actor={...actor,epoch:2}}};
}
it('preserves original key/body after unknown outcome, absent check, newer draft edits and exact retry over real HTTP',async()=>{
 const s=await setup(),draft=intent();s.setMode('drop-before');await expect(s.commands.submit(draft)).rejects.toMatchObject({code:'PROVIDER_ERROR'});
 const pending=s.commands.view().pending!;expect(pending.phase).toBe('uncertain');const original=s.calls.at(-1)!.body;
 (draft.input as any).activity.summary='An unsent later edit';s.setMode('normal');
 await expect(s.commands.check(pending.token)).resolves.toMatchObject({outcome:'absent'});expect(s.commands.view().pending?.token).toBe(pending.token);
 await expect(s.commands.submit(intent())).rejects.toMatchObject({code:'PENDING'});
 const result:any=await s.commands.retry(pending.token);expect(result.activity.version.value.summary).toBe('Client retained synthetic operation');expect(s.calls.at(-1)!.body).toBe(original);expect(s.commands.view().pending).toBeNull();s.commands.dispose();
});
it('single-flight lock rejects repeated retry/check/cancel/new clicks without releasing the active lock',async()=>{
 const s=await setup();s.setMode('drop-before');await expect(s.commands.submit(intent())).rejects.toMatchObject({code:'PROVIDER_ERROR'});const token=s.commands.view().pending!.token;s.setMode('hold');const pending=s.commands.retry(token);await vi.waitFor(()=>expect(s.network).toHaveBeenCalledTimes(3));
 expect(s.commands.view().pending).toMatchObject({phase:'sending',canRetrySame:false,canCheck:false,canCancel:false});
 for(const call of [()=>s.commands.retry(token),()=>s.commands.check(token),()=>s.commands.cancel(token),()=>s.commands.submit(intent())])await expect(call()).rejects.toMatchObject({code:'PENDING'});
 expect(s.network).toHaveBeenCalledTimes(3);s.release();await expect(pending).rejects.toMatchObject({code:'PROVIDER_ERROR'});expect(s.commands.view().pending?.token).toBe(token);s.setMode('normal');await s.commands.cancel(token);expect(s.commands.view().pending).toBeNull();s.commands.dispose();
});
it('retained operation survives controller recreation and committed-result check settles only its own key',async()=>{
 const first=await setup();first.setMode('drop-after');await expect(first.commands.submit(intent())).rejects.toMatchObject({code:'PROVIDER_ERROR'});const token=first.commands.view().pending!.token;first.commands.dispose();
 const next=await setup();expect(next.commands.view().pending?.token).toBe(token);const result:any=await next.commands.check(token);expect(result.outcome).toBe('committed');expect(next.commands.view().pending).toBeNull();expect(next.calls.filter(c=>c.path.endsWith('/createActivity'))).toHaveLength(0);next.commands.dispose();
});
it('same-payload retry after lost real commit returns one existing activity and settles the retained record',async()=>{
 const s=await setup();s.setMode('drop-after');await expect(s.commands.submit(intent())).rejects.toMatchObject({code:'PROVIDER_ERROR'});const token=s.commands.view().pending!.token,original=s.calls.at(-1)!.body;s.setMode('normal');const result:any=await s.commands.retry(token);const recovered:any=await s.client.recoverCommand({command:{action:'createActivity',input:JSON.parse(original)}});expect(recovered.receipt.id).toBe(result.activity.id);expect(s.calls.filter(c=>c.path.endsWith('/createActivity')).map(c=>c.body)).toEqual([original,original]);expect(s.commands.view().pending).toBeNull();s.commands.dispose();
});
it('cancellation verifies server fingerprint, persists a tombstone and prevents later original execution',async()=>{
 const s=await setup();s.setMode('drop-before');await expect(s.commands.submit(intent())).rejects.toMatchObject({code:'PROVIDER_ERROR'});const token=s.commands.view().pending!.token,command:ServiceReportsCommand={action:'createActivity',input:JSON.parse(s.calls.at(-1)!.body)};s.setMode('normal');
 const result:any=await s.commands.cancel(token);expect(result).toMatchObject({outcome:'cancelled',cancellation:{idempotencyKey:token,fingerprint:await serviceReportsCommandFingerprint(command)}});expect(s.commands.view().pending).toBeNull();await expect(s.client.mutate(command)).rejects.toMatchObject({code:'CONFLICT'});s.commands.dispose();
});
it('rejects mismatched cancellation proof without erasing journal; valid recheck settles retained tombstone',async()=>{
 const s=await setup();s.setMode('drop-before');await expect(s.commands.submit(intent())).rejects.toMatchObject({code:'PROVIDER_ERROR'});const token=s.commands.view().pending!.token;s.setMode('tamper-cancel');await expect(s.commands.cancel(token)).rejects.toMatchObject({code:'INVALID_RESPONSE'});expect(s.commands.view().pending?.token).toBe(token);s.setMode('normal');await expect(s.commands.check(token)).resolves.toMatchObject({outcome:'cancelled'});expect(s.commands.view().pending).toBeNull();s.commands.dispose();
});
it('client/domain fingerprint parity holds for cancellation of all five action shapes and timezone alias',async()=>{
 const s=await setup();const value=(intent().input as any).activity;
 const values:any[]=[['createActivity',{activity:value}],['correctActivity',{id:'missing',expectedRevision:1,activity:value,reason:'Synthetic'}],['archiveActivity',{id:'missing',expectedRevision:1,archived:true}],['createReport',{customer:value.customer,month:'2026-10',timeZone:'Etc/UTC',supersedes:null}],['archiveReport',{id:'missing',expectedRevision:1,archived:true}]];
 for(const [action,input] of values){const command={action,input:{scope,idempotencyKey:`parity-${++sequence}`,...input}} as ServiceReportsCommand;expect(await s.client.cancelCommand({command})).toMatchObject({outcome:'cancelled',cancellation:{fingerprint:await serviceReportsCommandFingerprint(command)}})}s.commands.dispose();
});
it('identity transition prevents stale recovery settlement and retains original authority-bound journal',async()=>{
 const s=await setup();s.setMode('drop-before');await expect(s.commands.submit(intent())).rejects.toMatchObject({code:'PROVIDER_ERROR'});const oldAuthority=s.client.authority()!,token=s.commands.view().pending!.token;s.setMode('hold');const checking=s.commands.check(token);await vi.waitFor(()=>expect(s.network).toHaveBeenCalledTimes(3));s.changeActor();s.client.authority();s.release();await expect(checking).rejects.toMatchObject({code:'FORBIDDEN'});expect(readServiceReportsPending(sessionStorage,oldAuthority,token)?.command.input.idempotencyKey).toBe(token);s.commands.dispose();
});
function viewProps(){const unknown={state:'unknown',message:'Synthetic test'};return {authority:{state:'available',scope:'a'.repeat(64),message:'Synthetic only'},customerChoices:{state:'ready',value:[]},selection:{customer:report.snapshot.customer,month:'2026-10',timeZone:'UTC',includeArchived:false},activities:{read:unknown,resetNotice:null},reportCards:{read:unknown,resetNotice:null},selectedReport:unknown,draft:null,sourceChoices:unknown,pending:{token:'retained-key',label:'生成月报',phase:'uncertain',message:'待确认',canCheck:true,canRetrySame:true,canCancel:true},mutationError:null,sourceError:null,exportError:null,exporting:null,openingSource:false,...Object.fromEntries(['onSelectionChange','onRefreshCustomers','onActivitiesPage','onReportsPage','onChooseReport','onCloseReport','onBeginActivity','onCorrectActivity','onArchiveActivity','onDraftChange','onSubmitActivity','onCancelDraft','onRefreshSources','onCreateReport','onArchiveReport','onExportReport','onOpenSource','onRetryPending','onCheckPending','onCancelPending'].map(k=>[k,vi.fn()]))} as any}
it('three recovery controls are enabled only for available authority, uncertain state and their exact capability',()=>{
 const p=viewProps(),v=render(<MonthlyServiceReportsView {...p}/>),cases=[['检查原操作结果','onCheckPending','canCheck'],['使用原内容重试','onRetryPending','canRetrySame'],['取消未提交的原操作','onCancelPending','canCancel']];
 for(const [label,handler] of cases){const b=screen.getByRole('button',{name:label}) as HTMLButtonElement;expect(b.disabled).toBe(false);fireEvent.click(b);expect(p[handler]).toHaveBeenCalledExactlyOnceWith('retained-key')}
 for(const change of [{authority:{state:'unavailable',message:'Withdrawn'}},{pending:{...p.pending,phase:'sending'}},{pending:{...p.pending,canCheck:false,canRetrySame:false,canCancel:false}}]){v.rerender(<MonthlyServiceReportsView {...p} {...change}/>);for(const [label] of cases)expect((screen.getByRole('button',{name:label}) as HTMLButtonElement).disabled).toBe(true)}
 for(const [label,,capability] of cases){v.rerender(<MonthlyServiceReportsView {...p} pending={{...p.pending,[capability]:false}}/>);expect((screen.getByRole('button',{name:label}) as HTMLButtonElement).disabled).toBe(true)}
});
