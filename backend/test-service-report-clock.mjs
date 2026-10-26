import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {compose} from './composition.mjs';
const root=mkdtempSync(join(tmpdir(),'service-report-clock-'));
const prepared=join(root,'prepared'),build=join(prepared,'runtime');
let active;
try {
 mkdirSync(prepared);const stat=lstatSync(prepared,{bigint:true});
 const output=execFileSync(process.execPath,[join(import.meta.dirname,'prepare-backend.mjs'),'--owned-root',prepared,`${stat.dev}:${stat.ino}`],{encoding:'utf8',timeout:30000});
 assert.equal(output.trim(),build);
 for(const mode of ['wall-clock','explicit-clock']) {
  const storage=join(root,mode);mkdirSync(storage);
  let instant=Date.parse('2031-04-05T06:07:08.000Z');
  const options=mode==='explicit-clock'?{clock:()=>new Date(instant)}:{};
  active=mode==='explicit-clock'?await compose(build,storage,options):await compose(build,storage);
  const ctx=active.context(),scope=active.identity.identityScope,pin=active.identity.syntheticSourcePin;
  const customer={organizationId:'synthetic-org',contactId:null};
  let sequence=0;
  const command=()=>({scope,idempotencyKey:`clock-${++sequence}`});
  // Wall time is bounded per operation, not asserted against an assumed date/time zone.
  // The explicit clock is a deterministic dependency, not a real-time acceptance claim.
  async function timed(operation,select){
   if(mode==='explicit-clock')instant+=1000;
   const before=Date.now(),value=await operation(),after=Date.now();
   for(const stamp of select(value)) {
    if(mode==='explicit-clock')assert.equal(stamp,new Date(instant).toISOString());
    else {assert(Number.isFinite(Date.parse(stamp)));assert(Date.parse(stamp)>=before&&Date.parse(stamp)<=after,`${stamp} not within ${before}..${after}`)}
   }
   return value;
  }
  const input={customer,kind:'meeting',status:'reported-completed',occurredAt:'2026-10-03T09:15:00.000Z',summary:'Synthetic clock regression',references:[{pin}]};
  let activity=(await timed(()=>active.reports.createActivity(ctx,{...command(),activity:input}),v=>[v.activity.version.recordedAt])).activity;
  const first=structuredClone(activity);
  activity=(await timed(()=>active.reports.correctActivity(ctx,{...command(),id:activity.id,expectedRevision:activity.revision,activity:{...input,summary:'Corrected synthetic clock regression'},reason:'Clock test correction'}),v=>[v.activity.version.recordedAt])).activity;
  assert.equal(activity.version.value.occurredAt,input.occurredAt);
  const reportCommand={...command(),customer,month:'2026-10',timeZone:'UTC',supersedes:null};
  const report=(await timed(()=>active.reports.createReport(ctx,reportCommand),v=>[v.report.snapshot.generatedAt,v.report.authorization.checkedAt])).report;
  const originalSnapshot=structuredClone(report.snapshot);
  const replay=(await timed(()=>active.reports.createReport(ctx,reportCommand),v=>[v.report.authorization.checkedAt])).report;
  assert.deepEqual(replay.snapshot,originalSnapshot);
  await timed(async()=>{
   const download=await active.reports.exportReport(ctx,{reportId:report.id,expectedRevision:report.revision,format:'json'});download.checkPublication();
   const envelope=JSON.parse(download.content.toString());assert.deepEqual(envelope.snapshot,originalSnapshot);return envelope;
  },v=>[v.authorization.checkedAt]);
  await timed(()=>active.reports.archiveActivity(ctx,{...command(),id:activity.id,expectedRevision:activity.revision,archived:true}),v=>[v.archivedAt]);
  await timed(()=>active.reports.archiveReport(ctx,{...command(),id:report.id,expectedRevision:report.revision,archived:true}),v=>[v.state.archivedAt]);
  let source=active.organization.create(ctx,{kind:'service-record',id:'clock-source',idempotencyKey:'clock-source-create',data:{...customer,activity:'meeting',occurredAt:input.occurredAt,summary:'Synthetic bridge clock',notes:'No real materials'}});
  const project=async(reason)=>{
   const p=active.bridge.previewServiceRecord(ctx,{sourceId:source.id});
   return active.bridge.importServiceRecord(ctx,{sourceId:source.id,token:p.token,status:'reported-completed',sourcePin:pin,...(reason?{reason}:{})});
  };
  const imported=(await timed(()=>project(),v=>[v.activity.version.recordedAt])).activity;
  source=active.organization.update(ctx,{kind:'service-record',id:source.id,expectedRevision:source.revision,idempotencyKey:'clock-source-update',patch:{summary:'Synthetic bridge correction'}});
  const corrected=(await timed(()=>project('Explicit correction'),v=>[v.activity.version.recordedAt])).activity;
  assert.equal(corrected.id,imported.id);assert.equal(corrected.version.value.occurredAt,input.occurredAt);
  const duplicate=await project();assert.equal(duplicate.unchanged,true);assert.deepEqual(duplicate.activity,corrected);
  // Immutable recorded history survives restart and switching to the real default clock.
  active.close();active=await compose(build,storage);
  assert.deepEqual((await active.reports.getActivity(active.context(),{id:corrected.id})).activity,corrected);
  const restartBefore=Date.now();
  const reread=await active.reports.getReport(active.context(),{id:report.id});
  const restartedCheck=Date.parse(reread.report.authorization.checkedAt);
  assert(restartedCheck>=restartBefore&&restartedCheck<=Date.now());
  assert.deepEqual(reread.report.snapshot,originalSnapshot);
  assert.notEqual(first.versionId,activity.versionId);
  assert.equal(readFileSync(join(storage,'data','service-reports.sqlite')).subarray(0,16).toString(),'SQLite format 3\0');
  active.close();active=null;
  console.log(`PASS ${mode}: create/correct/archive/report/export/bridge/replay/restart; synthetic sources, genuine local SQLite`);
 }
} finally {active?.close();rmSync(root,{recursive:true,force:true})}
