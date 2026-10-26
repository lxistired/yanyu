// Actual owner-scoped plan SQLite and current client/session; response loss is explicit synthetic transport injection.
import './plan-session-link-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
const prepared=process.env.PLAN_COLLECTION_PREPARED_RUNTIME;
const backend=name=>prepared?pathToFileURL(join(prepared,'server',name+'.mjs')).href:new URL('../backend/source/server/'+name+'.ts',import.meta.url).href;
const {DomainStore}=await import(backend('workspace-store'));
const {ManualPlanDomain}=await import(backend('manual-plan-domain'));
const {ManualPlanClient}=await import('../candidate/src/components/manual-plan-client.ts');
const {ManualPlanSession,MANUAL_PLAN_EDITOR_BYTES}=await import('../candidate/src/components/manual-plan-session.ts');
const {effectiveManualPlanLinks}=await import('../candidate/shared/manual-plans.ts');
const storeId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const transcript=(id='selected-a')=>({kind:'transcript',transcriptStoreId:storeId,jobId:id});
const doc=(id='11111111-1111-4111-8111-111111111111')=>({kind:'document',documentStoreId:storeId,documentId:id});
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'plan-collection-session-'));const store=new DomainStore(root),domain=new ManualPlanDomain(store);
 const context={principal:{tenantId:'synthetic-tenant',subjectId:'synthetic-owner',collectionIds:[]},requestId:'collection-session',signal:new AbortController().signal};
 let serial=0,loseAck=false,failReadback=false,substituteScope=false;const calls=[];
 const key=()=>`command-${++serial}`;
 const a=domain.create(context,{idempotencyKey:key(),title:'A',objective:'Keep objective',notes:'Keep notes',targetDate:'2026-11-01'});
 const b=domain.create(context,{idempotencyKey:key(),title:'B',objective:'Other objective'});
 const transport=async(url,init)=>{
  const op=String(url).split('/').at(-1),input=JSON.parse(init.body);calls.push({op,body:init.body,input});
  if(op==='get'&&failReadback){failReadback=false;throw Error('Synthetic current readback failure');}
  try{let value=domain[op](context,input);if(op==='get'&&substituteScope)value={...value,storeScope:'f'.repeat(64)};
   if(op==='addMaterialLinks'&&loseAck){loseAck=false;throw Object.assign(Error('Synthetic lost acknowledgement'),{lost:true});}
   return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  }catch(error){if(error.lost)throw error;const status=error.code==='CONFLICT'?409:error.code==='NOT_FOUND'?404:400;return new Response(JSON.stringify({error:{code:error.code??'FAILED',message:'bounded test rejection'}}),{status,headers:{'content-type':'application/json'}});}
 };
 const session=new ManualPlanSession(new ManualPlanClient(transport),key);session.attach();
 t.after(()=>{session.detach();store.close();rmSync(root,{recursive:true,force:true});});
 const get=()=>domain.get(context,{id:a.id});
 return {store,domain,context,session,key,calls,a,b,get,open:()=>session.open(a.id,()=>true),loseAck(){loseAck=true;},failReadback(){failReadback=true;},substituteScope(value){substituteScope=value;}};
}
test('basket remains pointer-only and exact-plan-owned across detach, switch, cancel, reopen and clear',async t=>{
 const f=fixture(t);await f.open();const r=f.session.editor.record,pointer=transcript();
 assert.equal(f.session.stageMaterial(pointer,r),true);pointer.jobId='caller-mutated';assert.deepEqual(f.session.editor.materialBasket,[transcript()]);assert.equal(f.session.hasUnsaved(),true);assert.equal(f.session.editor.dirty,false);
 const before=f.session.editor;await f.session.open(f.b.id,()=>false);assert.equal(f.session.editor,before);
 f.session.detach();assert.equal(f.session.stageMaterial(doc(),r),false);f.session.attach();assert.deepEqual(f.session.editor.materialBasket,[transcript()]);
 await f.session.open(f.b.id,()=>true);assert.deepEqual(f.session.editor.materialBasket,[]);assert.equal(f.session.stageMaterial(doc(),r),false);
 await f.open();assert.deepEqual(f.session.editor.materialBasket,[transcript()]);assert.notEqual(f.session.editor.record,r);assert.equal(f.session.stageMaterial(doc(),r),false);
 f.session.clearMaterials(()=>false);assert.equal(f.session.editor.materialBasket.length,1);f.session.clearMaterials(()=>true);assert.equal(f.session.hasUnsaved(),false);assert.deepEqual(f.get().data,f.a.data);
});
test('saving authored text preserves staged pointers, while state/legacy/exact remove do not silently discard a basket',async t=>{
 const f=fixture(t);await f.open();f.session.stageMaterial(doc(),f.session.editor.record);f.session.edit('notes','Changed authored notes');
 assert.equal(f.session.stageMaterial(transcript(),f.session.editor.record),false);await f.session.saveMaterials();assert.equal(f.calls.filter(x=>x.op==='addMaterialLinks').length,0);
 await f.session.mutate('update');assert.equal(f.session.editor.dirty,false);assert.deepEqual(f.session.editor.materialBasket,[doc()]);assert.equal(f.get().data.notes,'Changed authored notes');
 for(const op of ['setState','setMaterialLink','setDocumentLink','removeMaterialLink'])await f.session.mutate(op,'completed',{scope:f.session.editor.record.storeScope,materialLink:transcript(),documentLink:doc()});
 assert.equal(f.calls.filter(x=>['setState','setMaterialLink','setDocumentLink','removeMaterialLink'].includes(x.op)).length,0);assert.equal(f.session.editor.materialBasket.length,1);
 await f.session.saveMaterials();assert.equal(f.session.pending,null);assert.deepEqual(f.session.editor.materialBasket,[]);assert.deepEqual(effectiveManualPlanLinks(f.get().data),[doc()]);assert.equal(f.get().data.notes,'Changed authored notes');
});
test('lost ACK retries precisely the frozen batch once, clears only after current scoped readback',async t=>{
 const f=fixture(t);await f.open();const r=f.session.editor.record;f.session.stageMaterial(doc(),r);f.session.stageMaterial(transcript(),r);f.loseAck();await f.session.saveMaterials();
 assert.equal(f.session.pending.phase,'uncertain');assert.equal(f.get().revision,2);assert.equal(f.session.editor.materialBasket.length,2);assert.equal(f.session.stageMaterial(transcript('other'),r),false);f.session.clearMaterials(()=>true);assert.equal(f.session.editor.materialBasket.length,2);
 await f.session.retry();const writes=f.calls.filter(x=>x.op==='addMaterialLinks');assert.equal(writes.length,2);assert.equal(writes[0].body,writes[1].body);assert.equal(f.get().revision,2);assert.equal(f.session.pending,null);assert.equal(f.session.hasUnsaved(),false);assert.deepEqual(effectiveManualPlanLinks(f.get().data),[doc(),transcript()]);
 assert(f.calls.some(x=>x.op==='get'&&x.input.scope===r.storeScope));
});
test('acknowledged failed or wrong-scope readback retains basket and retries only reading',async t=>{
 const f=fixture(t);await f.open();f.session.stageMaterial(transcript(),f.session.editor.record);f.failReadback();await f.session.saveMaterials();
 assert.equal(f.session.pending.phase,'readback');assert.equal(f.session.editor.materialBasket.length,1);assert.equal(f.get().revision,2);
 f.substituteScope(true);await f.session.retry();assert.equal(f.session.pending.phase,'readback');assert.equal(f.session.editor.materialBasket.length,1);
 f.substituteScope(false);await f.session.retry();assert.equal(f.session.pending,null);assert.equal(f.session.editor.materialBasket.length,0);assert.equal(f.calls.filter(x=>x.op==='addMaterialLinks').length,1);
});
test('CAS conflict preserves selections; explicit refresh keeps choices with reviewed revision and retry uses a new command',async t=>{
 const f=fixture(t);await f.open();const r=f.session.editor.record;f.session.stageMaterial(transcript(),r);
 f.domain.update(f.context,{id:r.id,expectedRevision:r.revision,idempotencyKey:f.key(),patch:{notes:'Concurrent independent note'}});
 await f.session.saveMaterials();assert.equal(f.session.pending,null);assert.match(f.session.error,/发生变化/);assert.deepEqual(f.session.editor.materialBasket,[transcript()]);assert.equal(f.session.editor.record.revision,1);
 await f.session.refreshCurrent(()=>true);assert.equal(f.session.editor.record.revision,2);assert.equal(f.session.editor.draft.notes,'Concurrent independent note');assert.deepEqual(f.session.editor.materialBasket,[transcript()]);assert.equal(f.session.stageMaterial(doc(),r),false);
 await f.session.saveMaterials();assert.equal(f.get().revision,3);assert.equal(f.get().data.notes,'Concurrent independent note');assert.equal(f.session.hasUnsaved(),false);
});
test('explicit discard clears authored draft and basket together; basket-only discard also works',async t=>{
 const f=fixture(t);await f.open();f.session.stageMaterial(doc(),f.session.editor.record);f.session.edit('notes','Unsaved');f.session.discard(()=>false);assert.equal(f.session.editor.materialBasket.length,1);assert.equal(f.session.editor.dirty,true);
 f.session.discard(()=>true);assert.equal(f.session.editor.draft.notes,'Keep notes');assert.deepEqual(f.session.editor.materialBasket,[]);assert.equal(f.session.editor.dirty,false);
 f.session.stageMaterial(transcript(),f.session.editor.record);f.session.discard(()=>true);assert.equal(f.session.hasUnsaved(),false);
});
test('100 effective pointers count legacy singles, deduplicate exact tuples and reject capacity without truncation',async t=>{
 const f=fixture(t);const r=f.get();f.domain.setMaterialLink(f.context,{id:r.id,expectedRevision:r.revision,idempotencyKey:f.key(),scope:r.storeScope,materialLink:transcript('legacy')});await f.open();const current=f.session.editor.record;
 assert.equal(f.session.stageMaterial(transcript('legacy'),current),true);assert.equal(f.session.editor.materialBasket.length,0);
 for(let i=0;i<99;i++)assert.equal(f.session.stageMaterial(transcript('job-'+i+'x'.repeat(145)),current),true);
 assert.equal(f.session.stageMaterial(transcript('overflow'),current),false);assert.equal(f.session.editor.materialBasket.length,99);assert.match(f.session.error,/100/);
 const payloadBytes=Buffer.byteLength(JSON.stringify(f.session.editor));assert(payloadBytes<MANUAL_PLAN_EDITOR_BYTES);await f.session.saveMaterials();assert.equal(effectiveManualPlanLinks(f.get().data).length,100);assert.equal(f.session.editor.materialBasket.length,0);assert(Buffer.byteLength(JSON.stringify(f.session.editor))<MANUAL_PLAN_EDITOR_BYTES);
 assert.equal(f.session.stageMaterial(doc(),f.session.editor.record),false);assert.equal(f.get().revision,3);
});
test('eight retained basket editors are bounded; a ninth selection is refused with no saved data loss',async t=>{
 const f=fixture(t);const ids=[f.a.id,f.b.id];for(let i=2;i<9;i++)ids.push(f.domain.create(f.context,{idempotencyKey:f.key(),title:'P'+i,objective:'O'}).id);
 for(let i=0;i<8;i++){await f.session.open(ids[i],()=>true);assert.equal(f.session.stageMaterial(transcript('selection-'+i),f.session.editor.record),true);}
 await f.session.open(ids[8],()=>true);assert.equal(f.session.retainedKeys().length,8);assert.equal(f.session.stageMaterial(transcript('ninth'),f.session.editor.record),false);assert.deepEqual(f.session.editor.materialBasket,[]);
 await f.session.open(ids[0],()=>true);assert.deepEqual(f.session.editor.materialBasket,[transcript('selection-0')]);f.session.clearMaterials(()=>true);assert.equal(f.session.retainedKeys().length,7);
});
