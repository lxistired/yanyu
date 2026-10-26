// Current contract and production client with an in-process SQLite adapter. No HTTP/browser/network.
import './plan-session-link-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const prepared=process.env.PLAN_COLLECTION_PREPARED_RUNTIME;
const backend=name=>prepared?pathToFileURL(join(prepared,'server',name+'.mjs')).href:new URL('../backend/source/server/'+name+'.ts',import.meta.url).href;
const {DomainStore}=await import(backend('workspace-store'));
const {ManualPlanDomain}=await import(backend('manual-plan-domain'));
const {ManualPlanClient,captureCommand,validateRecord,materialLinks,sourceLink,RAW_LIMIT}=await import('../candidate/src/components/manual-plan-client.ts');
const {effectiveManualPlanLinks:effective,MANUAL_PLAN_LIMITS:L}=await import('../candidate/shared/manual-plans.ts');
const scope='a'.repeat(64),fields={title:'Manual collection',objective:'Own objective',notes:'Keep notes',targetDate:null};
const uuid=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const document=(n=1)=>({kind:'document',documentStoreId:uuid(1000),documentId:uuid(n)});
const transcript=(n=1)=>({kind:'transcript',transcriptStoreId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',jobId:`job-${n}`});
const record=(data={})=>({id:'plan',kind:'manual-research-plan',revision:1,createdAt:'2026-10-23T00:00:00.000Z',updatedAt:'2026-10-23T00:00:00.000Z',deletedAt:null,data:{schemaVersion:1,provenance:'user-authored-local',state:'draft',...fields,...data}});
const input=(extra={})=>({id:'plan',expectedRevision:1,scope,...extra});
const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'collection-client-'));let store,plans;
 const open=()=>{store=new DomainStore(root);plans=new ManualPlanDomain(store);};open();
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const c={principal:{tenantId:'tenant',subjectId:'owner',collectionIds:[]},requestId:'collection-client',signal:new AbortController().signal};
 let serial=0,dropWrite=false;const key=()=>`client-${++serial}`,calls=[];
 const plan=plans.create(c,{...fields,idempotencyKey:key()});
 const client=new ManualPlanClient(async(url,init)=>{
  const op=url.split('/').at(-1);calls.push({operation:op,body:init.body,init});
  try{
   const result=plans[op](c,JSON.parse(init.body));
   if(dropWrite&&['addMaterialLinks','removeMaterialLink'].includes(op)){dropWrite=false;throw Error('Synthetic lost response');}
   return response(result);
  }catch(error){if(!error.code)throw error;return new Response(JSON.stringify({error:{code:error.code,message:'Bounded fixture error',retryable:false}}),{status:({CONFLICT:409,NOT_FOUND:404,INVALID_REQUEST:400})[error.code]??500,headers:{'content-type':'application/json'}});}
 });
 const get=()=>plans.get(c,{id:plan.id}),bound=()=>({id:plan.id,expectedRevision:get().revision,scope:store.manualPlanScope(c)});
 return {client,plan,key,calls,get,bound,drop(){dropWrite=true;},reopen(){store.close();open();}};
}

test('new decoder accepts legacy absence and optional arrays, enforcing effective union capacity',()=>{
 const old=record();assert.deepEqual(validateRecord(old),old);assert.equal(Object.hasOwn(validateRecord(old).data,'materialLinks'),false);
 for(const data of [{materialLink:null,documentLink:null},{materialLinks:[]},{materialLink:transcript(),documentLink:document(),materialLinks:[document(),transcript(),document(2)]}])
  assert.deepEqual(validateRecord(record(data)),record(data));
 const full=Array.from({length:100},(_,i)=>document(i+1));
 assert.equal(effective(validateRecord(record({documentLink:document(),materialLinks:full})).data).length,100);
 assert.throws(()=>validateRecord(record({materialLink:transcript(),materialLinks:full})));
 for(const value of [null,{},undefined,new Array(1),Array.from({length:101},()=>document())])assert.throws(()=>validateRecord(record({materialLinks:value})));
 assert.throws(()=>validateRecord(record({materialLinks:[{...document(),preview:'not persisted'}]})));
 assert.throws(()=>validateRecord({...record(),data:{...record().data,unknown:[]}}));
});

test('source union preserves distinct UUID contracts and rejects ambiguous, metadata-bearing and nullable pointers',()=>{
 assert.deepEqual(sourceLink(document()),document());assert.deepEqual(sourceLink(transcript()),transcript());
 for(const value of [null,undefined,[],{}, {...document(),jobId:'mixed'}, {...transcript(),documentId:uuid(1)}, {...document(),kind:'other'}, {...document(),documentId:uuid(1)+'\n'}, {...transcript(),jobId:'x\n'}, {...transcript(),transcriptStoreId:uuid(1)}, {...document(),url:'not authority'}])assert.throws(()=>sourceLink(value));
});

test('client validates dense ordinary descriptors before reading array entries or union kind',()=>{
 let invoked=0;const entry=[];Object.defineProperty(entry,'0',{enumerable:true,get(){invoked++;return document();}});
 const kind={get kind(){invoked++;return 'document';},documentStoreId:uuid(1),documentId:uuid(2)};
 const target={kind:'document',documentStoreId:uuid(1),get documentId(){invoked++;return uuid(2);}};
 for(const bad of [entry,[kind],[target],Object.assign([document()],{extra:true}),Object.assign([document()],{[Symbol('extra')]:true}),Object.setPrototypeOf([document()],null),Object.defineProperty([document()],'0',{enumerable:false}),[Object.assign(Object.create(null),document())]]){
  assert.throws(()=>materialLinks(bad));
  assert.throws(()=>captureCommand('addMaterialLinks','key',input({materialLinks:bad})));
  assert.throws(()=>validateRecord(record({materialLinks:bad})));
 }
 assert.equal(invoked,0);assert.deepEqual(materialLinks(Object.freeze([Object.freeze(document())])),[document()]);
});

test('capture freezes exact batch and remove envelopes; input mutations cannot change retried bytes',()=>{
 const batch=[document(),transcript()],command=captureCommand('addMaterialLinks','batch-key',input({materialLinks:batch}));
 assert.equal(Object.isFrozen(command),true);assert.equal(command.scope,scope);assert.equal(command.id,'plan');
 const expected={idempotencyKey:'batch-key',id:'plan',expectedRevision:1,scope,materialLinks:[document(),transcript()]};assert.deepEqual(JSON.parse(command.body),expected);
 batch[0].documentId=uuid(9);batch.push(document(3));assert.deepEqual(JSON.parse(command.body),expected);
 const selected=document(),remove=captureCommand('removeMaterialLink','remove-key',input({materialLink:selected}));selected.documentId=uuid(99);
 assert.deepEqual(JSON.parse(remove.body),{idempotencyKey:'remove-key',id:'plan',expectedRevision:1,scope,materialLink:document()});
 assert.equal(remove.scope,scope);assert.equal(Object.isFrozen(remove),true);
 const reordered=captureCommand('removeMaterialLink','remove-key',input({materialLink:{documentId:uuid(1),kind:'document',documentStoreId:uuid(1000)}}));assert.equal(reordered.body,remove.body);
});

test('collection capture rejects extra fields, missing scope, null removal and singular-type confusion before transport',()=>{
 for(const [op,args] of [['addMaterialLinks',{materialLinks:[document()]}],['removeMaterialLink',{materialLink:document()}]]){
  for(const extra of [{notes:'smuggled'},{sessionLink:null},{owner:'other'},{documentLink:document()},{scope:undefined},{scope:scope+'\n'}])assert.throws(()=>captureCommand(op,'key',input({...args,...extra})));
 }
 assert.throws(()=>captureCommand('addMaterialLinks','key',input({materialLinks:null})));
 assert.throws(()=>captureCommand('removeMaterialLink','key',input({materialLink:null})));
 assert.throws(()=>captureCommand('removeMaterialLink','key',input({materialLinks:[document()]})));
 assert.throws(()=>captureCommand('setMaterialLink','key',input({materialLink:document()})));
 assert.throws(()=>captureCommand('create','key',{...fields,materialLinks:[]}));
 assert.throws(()=>captureCommand('update','key',{id:'plan',expectedRevision:1,patch:{...fields,materialLinks:[]}}));
 assert.throws(()=>captureCommand('addMaterialLinksExtra','key',input({materialLinks:[]})));
});

test('100 maximal transcript pointers fit unchanged canonical/raw byte limits; entry and identifier overflow fail',()=>{
 const pointers=Array.from({length:100},(_,i)=>({...transcript(),jobId:String(i).padStart(3,'0')+'x'.repeat(157)}));
 const command=captureCommand('addMaterialLinks','k'.repeat(100),{id:'p'.repeat(100),expectedRevision:Number.MAX_SAFE_INTEGER,scope,materialLinks:pointers});
 const payload=JSON.parse(command.body),{idempotencyKey,...args}=payload;
 const canonical={operation:'manual-plans.addMaterialLinks',...args};
 assert.ok(Buffer.byteLength(command.body)<=RAW_LIMIT);assert.ok(Buffer.byteLength(JSON.stringify(canonical))<=L.commandBytes);
 assert.equal(payload.materialLinks.length,100);assert.throws(()=>captureCommand('addMaterialLinks','key',input({materialLinks:[...pointers,document()]})));
 assert.throws(()=>captureCommand('addMaterialLinks','key',input({materialLinks:[{...transcript(),jobId:'x'.repeat(161)}]})));
});

test('actual client retries byte-identical lost ACKs, decodes historical receipts, then reads current scoped data',async t=>{
 const f=fixture(t),command=captureCommand('addMaterialLinks',f.key(),{...f.bound(),materialLinks:[document(),transcript()]});
 f.drop();await assert.rejects(f.client.write(command),/Synthetic lost response/);assert.equal(f.get().revision,2);f.reopen();
 const ack=await f.client.write(command);assert.equal(ack.revision,2);assert.deepEqual(f.calls.filter(x=>x.operation==='addMaterialLinks').map(x=>x.body),[command.body,command.body]);
 const loaded=await f.client.get(command.id,command.scope);assert.deepEqual(loaded.data.materialLinks,[document(),transcript()]);
 const remove=captureCommand('removeMaterialLink',f.key(),{...f.bound(),materialLink:document()});f.drop();
 await assert.rejects(f.client.write(remove));assert.equal(f.get().revision,3);f.reopen();assert.equal((await f.client.write(remove)).revision,3);
 assert.equal((await f.client.write(command)).revision,2);const current=await f.client.get(command.id,command.scope);assert.equal(current.revision,3);assert.deepEqual(current.data.materialLinks,[transcript()]);
 assert.ok(f.calls.every(x=>x.init.credentials==='same-origin'&&x.init.redirect==='error'&&x.init.cache==='no-store'));
});

test('client rejects wrong-store readback, wrong-record receipts and oversized/invalid response collections',async()=>{
 const command=captureCommand('addMaterialLinks','key',input({materialLinks:[document()]}));
 const wrongScope=new ManualPlanClient(async()=>response({...record(),storeScope:'b'.repeat(64)}));await assert.rejects(wrongScope.get('plan',scope));
 const wrongRecord=new ManualPlanClient(async()=>response({...record(),id:'other'}));await assert.rejects(wrongRecord.write(command));
 const excessive=new ManualPlanClient(async()=>response(record({materialLink:transcript(),materialLinks:Array.from({length:100},(_,i)=>document(i+1))})));await assert.rejects(excessive.write(command));
 const oversized=new ManualPlanClient(async()=>response({...record(),extra:'x'.repeat(L.pageBytes)}));await assert.rejects(oversized.write(command),error=>error.code==='INVALID_RESPONSE');
 let calls=0;const noFallback=new ManualPlanClient(async()=>{calls++;return response(record());});
 await assert.rejects(noFallback.write({...command,operation:'addMaterialLinksExtra'}),error=>error.code==='INVALID_REQUEST');
 await assert.rejects(noFallback.write({...command,body:'x'.repeat(RAW_LIMIT+1)}),error=>error.code==='INVALID_REQUEST');assert.equal(calls,0);
});
