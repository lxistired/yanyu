import test from 'node:test';
import assert from 'node:assert/strict';
import {localPlanSummary,appendLocalPlanSummary} from '../candidate/src/components/local-plan-summary.ts';
import {ManualPlanSession} from '../candidate/src/components/manual-plan-session.ts';
import {ManualPlanClient} from '../candidate/src/components/manual-plan-client.ts';

const inputs=Object.freeze({question:'需核对哪些事项？\n  不改写原文',scope:'仅核对已加载资料，不扩展主题 🧭',output:'待验证清单，非结论'});
const plan=(patch={})=>({id:'one',kind:'manual-research-plan',revision:3,storeScope:'a'.repeat(64),createdAt:'2026-10-21T00:00:00.000Z',updatedAt:'2026-10-21T00:00:00.000Z',deletedAt:null,data:{schemaVersion:1,provenance:'user-authored-local',state:'draft',title:'模拟验证计划',objective:'仅验证前端交互',notes:'  原备注\n保留空白及中文 🔒\n',targetDate:null,...patch}});
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
async function rig(record=plan()) {
 const calls=[];let stored=structuredClone(record),key=0,write=null;
 const client=new ManualPlanClient(async(url,init)=>{
  const request={url,body:JSON.parse(init.body),raw:init.body};calls.push(request);
  if(url.endsWith('/list'))return response({items:[stored],total:1,offset:0,nextOffset:null});
  if(url.endsWith('/get'))return response({...stored,id:request.body.id});
  if(url.endsWith('/update')) {
   if(write)return write(request);
   stored={...stored,revision:stored.revision+1,data:{...stored.data,...request.body.patch}};return response(stored);
  }
  throw Error(`Unexpected operation: ${url}`);
 });
 const session=new ManualPlanSession(client,()=>`summary-${++key}`);session.attach();await session.open(record.id,()=>true);
 return {session,client,calls,get stored(){return stored;},set stored(value){stored=value;},set write(value){write=value;}};
}

test('complete deterministic simulation-only text preserves all supplied Unicode and whitespace',()=>{
 const row=plan(),before=structuredClone({row,inputs}),summary=localPlanSummary(row,inputs);
 assert.match(summary,/模拟流程摘要，非研究结论/);assert.match(summary,/未执行资料检索、模型推理或结论生成/);
 for(const value of Object.values(inputs))assert.ok(summary.includes(value));
 assert.ok(summary.includes(row.data.objective));
 const result=appendLocalPlanSummary(row.data.notes,summary);assert.equal(result.ok,true);
 assert.equal(result.notes,row.data.notes+'\n\n'+summary);assert.equal(result.addition,'\n\n'+summary);
 assert.deepEqual({row,inputs},before);assert.equal(localPlanSummary({...row,revision:4},inputs),summary);
 assert.equal(appendLocalPlanSummary('',summary).notes,summary);
});

test('exact 8000 UTF-8 bytes accepted; excess Chinese or emoji rejected without clipping',()=>{
 const summary=localPlanSummary(plan(),inputs),size=Buffer.byteLength(summary),notes='x'.repeat(8000-size-2);
 const accepted=appendLocalPlanSummary(notes,summary);assert.equal(accepted.ok,true);assert.equal(Buffer.byteLength(accepted.notes),8000);
 for(const suffix of ['x','中','🧭']){const original=notes+suffix,result=appendLocalPlanSummary(original,summary);assert.equal(result.ok,false);assert.match(result.message,/8000 UTF-8 字节/);assert.equal(original,notes+suffix);assert.equal('notes' in result,false);}
 const large={...inputs,question:'中'.repeat(2000),scope:'中'.repeat(1200),output:'中'.repeat(1200)};
 assert.equal(appendLocalPlanSummary('',localPlanSummary(plan(),large)).ok,false);assert.equal(large.question.length,2000);
});

test('same full summary is not appended twice; unsupported text is rejected unchanged',()=>{
 const summary=localPlanSummary(plan(),inputs),first=appendLocalPlanSummary('original',summary);
 assert.equal(first.ok,true);const again=appendLocalPlanSummary(first.notes,summary);assert.equal(again.ok,false);assert.match(again.message,/未重复追加/);
 for(const bad of ['bad\u0000text','bad\ud800text']){const original='original';const result=appendLocalPlanSummary(original,bad);assert.equal(result.ok,false);assert.match(result.message,/不支持的字符/);assert.equal(original,'original');}
});

test('explicit append only dirties original notes, then existing update/readback saves the reviewed revision',async()=>{
 const r=await rig(),s=r.session,target=s.captureSimulatedSummaryTarget(),before=structuredClone(s.editor.record),count=r.calls.length;
 assert.ok(target);assert.equal(s.stageSimulatedSummary(target,inputs),null);const staged=s.editor.draft.notes;
 assert.equal(r.calls.length,count);assert.equal(s.pending,null);assert.equal(s.editor.dirty,true);assert.deepEqual(s.editor.record,before);
 assert.equal(s.editor.draft.title,before.data.title);assert.equal(s.editor.draft.objective,before.data.objective);assert.equal(s.editor.draft.targetDate,before.data.targetDate);
 assert.match(s.stageSimulatedSummary(target,inputs),/未追加摘要/);assert.equal(s.editor.draft.notes,staged);
 await s.mutate('update');const update=r.calls.find(x=>x.url.endsWith('/update'));
 assert.equal(update.body.id,before.id);assert.equal(update.body.expectedRevision,3);assert.equal(update.body.patch.notes,staged);
 assert.equal(s.editor.record.revision,4);assert.equal(s.editor.draft.notes,staged);assert.equal(s.editor.dirty,false);assert.equal(s.pending,null);
 assert.deepEqual(r.calls.slice(count).map(x=>x.url.split('/').at(-1)),['update','get','list']);
 assert.match(s.stageSimulatedSummary(s.captureSimulatedSummaryTarget(),inputs),/未重复追加/);assert.equal(s.editor.draft.notes,staged);s.detach();
});

test('changed user draft, restored draft, current reread and plan switch reject stale targets without overwrite',async()=>{
 const r=await rig(),s=r.session;
 let target=s.captureSimulatedSummaryTarget();s.edit('notes','用户较新的备注');assert.match(s.stageSimulatedSummary(target,inputs),/未追加摘要/);assert.equal(s.editor.draft.notes,'用户较新的备注');
 s.discard(()=>true);assert.match(s.stageSimulatedSummary(target,inputs),/未追加摘要/);
 target=s.captureSimulatedSummaryTarget();r.stored={...r.stored,revision:4};await s.refreshCurrent(()=>true);assert.match(s.stageSimulatedSummary(target,inputs),/未追加摘要/);assert.equal(s.editor.record.revision,4);
 target=s.captureSimulatedSummaryTarget();await s.open('two',()=>true);assert.match(s.stageSimulatedSummary(target,inputs),/未追加摘要/);assert.equal(s.editor.record.id,'two');assert.equal(s.editor.dirty,false);s.detach();
});

test('session replacement, detach/remount and live scalar revision/scope changes fence stale callbacks',async()=>{
 const a=await rig(),b=await rig(),s=a.session,target=s.captureSimulatedSummaryTarget();
 assert.match(b.session.stageSimulatedSummary(target,inputs),/未追加摘要/);assert.equal(b.session.editor.dirty,false);
 s.editor.record.revision++;assert.match(s.stageSimulatedSummary(target,inputs),/未追加摘要/);s.editor.record.revision--;
 s.editor.record.storeScope='b'.repeat(64);assert.match(s.stageSimulatedSummary(target,inputs),/未追加摘要/);s.editor.record.storeScope='a'.repeat(64);
 s.detach();assert.match(s.stageSimulatedSummary(target,inputs),/未追加摘要/);s.attach();assert.match(s.stageSimulatedSummary(target,inputs),/未追加摘要/);
 assert.equal(s.editor.dirty,false);s.detach();b.session.detach();
});

test('busy, deleted and terminal states never append; terminal plans still require explicit reopen',async()=>{
 const r=await rig(),s=r.session,target=s.captureSimulatedSummaryTarget(),before=s.editor;
 s.detailLoading=true;assert.equal(s.captureSimulatedSummaryTarget(),null);assert.match(s.stageSimulatedSummary(target,inputs),/未追加摘要/);s.detailLoading=false;
 s.pending={phase:'uncertain'};assert.match(s.stageSimulatedSummary(target,inputs),/未追加摘要/);s.pending=null;
 s.editor.record.deletedAt='2026-10-22T00:00:00.000Z';assert.equal(s.captureSimulatedSummaryTarget(),null);assert.match(s.stageSimulatedSummary(target,inputs),/未追加摘要/);s.editor.record.deletedAt=null;
 for(const state of ['completed','cancelled']){s.editor.record.data.state=state;assert.match(s.stageSimulatedSummary(target,inputs),/明确重新打开/);assert.equal(s.editor,before);}
 s.detach();
});

test('oversize or incomplete simulated inputs preserve exact editor and all inputs',async()=>{
 const r=await rig(plan({notes:'原'.repeat(2600)})),s=r.session,target=s.captureSimulatedSummaryTarget(),before=s.editor,count=r.calls.length,inputCopy=structuredClone(inputs);
 assert.match(s.stageSimulatedSummary(target,inputs),/8000 UTF-8 字节/);assert.equal(s.editor,before);assert.deepEqual(inputs,inputCopy);assert.equal(r.calls.length,count);
 assert.match(s.stageSimulatedSummary(target,{...inputs,scope:'  '}),/完整填写/);assert.equal(s.editor,before);s.detach();
});

test('existing recovery capacity rejection keeps the exact editor and reports why staging failed',async()=>{
 const r=await rig(),s=r.session;
 for(let i=0;i<8;i++){await s.open(`old-${i}`,()=>true);s.edit('notes',`旧草稿 ${i}`);}
 await s.open('one',()=>true);const before=s.editor,target=s.captureSimulatedSummaryTarget(),count=r.calls.length;
 assert.ok(target);assert.match(s.stageSimulatedSummary(target,inputs),/已保留八份草稿/);assert.equal(s.editor,before);assert.equal(s.editor.dirty,false);assert.equal(r.calls.length,count);s.detach();
});

test('lost save reuses identical operation key and payload, then reads back rather than duplicating summary',async()=>{
 const r=await rig(),s=r.session;assert.equal(s.stageSimulatedSummary(s.captureSimulatedSummaryTarget(),inputs),null);
 const staged=s.editor.draft.notes;let attempts=0;const requests=[];
 r.write=request=>{requests.push(request);if(++attempts===1){r.stored={...r.stored,revision:4,data:{...r.stored.data,...request.body.patch}};throw Error('simulated lost acknowledgement');}return response(r.stored);};
 await s.mutate('update');assert.equal(s.pending.phase,'uncertain');assert.equal(s.editor.draft.notes,staged);assert.equal(s.editor.dirty,true);
 await s.retry();assert.equal(requests.length,2);assert.equal(requests[0].raw,requests[1].raw);assert.equal(s.pending,null);assert.equal(s.editor.record.revision,4);assert.equal(s.editor.draft.notes,staged);assert.equal(staged.split('【模拟流程摘要，非研究结论】').length-1,1);s.detach();
});

test('conflicting save retains full appended draft and uses a newly reviewed revision only after explicit refresh',async()=>{
 const r=await rig(),s=r.session;assert.equal(s.stageSimulatedSummary(s.captureSimulatedSummaryTarget(),inputs),null);const staged=s.editor.draft.notes;
 r.write=()=>response({error:{code:'CONFLICT',message:'simulated concurrent edit',retryable:false}},409);
 await s.mutate('update');assert.equal(s.pending,null);assert.match(s.error,/计划已发生变化/);assert.equal(s.editor.draft.notes,staged);assert.equal(s.editor.dirty,true);
 r.stored={...r.stored,revision:7,data:{...r.stored.data,notes:'另一位编辑者的备注'}};await s.refreshCurrent(()=>true);assert.equal(s.editor.record.revision,7);assert.equal(s.editor.draft.notes,staged);
 r.write=null;await s.mutate('update');assert.equal(r.calls.filter(x=>x.url.endsWith('/update')).at(-1).body.expectedRevision,7);assert.equal(s.editor.record.revision,8);assert.equal(s.editor.draft.notes,staged);s.detach();
});

test('discarding an appended draft restores original saved notes without a write',async()=>{
 const r=await rig(),s=r.session,original=s.editor.draft.notes,count=r.calls.length;
 assert.equal(s.stageSimulatedSummary(s.captureSimulatedSummaryTarget(),inputs),null);s.discard(()=>true);
 assert.equal(s.editor.draft.notes,original);assert.equal(s.editor.dirty,false);assert.equal(r.calls.length,count);s.detach();
});
