// Actual temporary SQLite and current plan domain. No HTTP, listener, browser, network or source mutation.
import './plan-session-link-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const prepared=process.env.PLAN_COLLECTION_PREPARED_RUNTIME;
const backend=name=>prepared?pathToFileURL(join(prepared,'server',name+'.mjs')).href:new URL('../backend/source/server/'+name+'.ts',import.meta.url).href;
const {DomainStore}=await import(backend('workspace-store'));
const {ManualPlanDomain}=await import(backend('manual-plan-domain'));
const {WorkspaceDomain}=await import(backend('workspace-domain'));
const {effectiveManualPlanLinks:effective,manualPlanSourceKey:keyOf,MANUAL_PLAN_LIMITS:L}=await import('../candidate/shared/manual-plans.ts');
const {validateRecord,validatePage}=await import('../candidate/src/components/manual-plan-client.ts');
const context=(subjectId='owner',tenantId='tenant')=>({principal:{tenantId,subjectId,collectionIds:[]},requestId:'collection-test',signal:new AbortController().signal});
const fields={title:'Bounded manual collection',objective:'Unchanged objective',notes:'Authored text\n原文',targetDate:'2026-12-31'};
const uuid=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const document=(n=1,store=uuid(1000))=>({kind:'document',documentStoreId:store,documentId:uuid(n)});
const transcript=(n=1,store='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')=>({kind:'transcript',transcriptStoreId:store,jobId:`job-${n}`});
const rejects=(run,code)=>assert.throws(run,cause=>cause.code===code);
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'plan-material-collection-'));let store,plans,workspace;
 const open=()=>{store=new DomainStore(root);plans=new ManualPlanDomain(store);workspace=new WorkspaceDomain(store);};open();
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const c=context();let serial=0;const key=()=>`collection-${++serial}`;
 const w=workspace.create(c,{kind:'workspace',id:'w',data:{name:'Own workspace'},idempotencyKey:key()});
 const s=workspace.create(c,{kind:'session',id:'s',data:{title:'Own session',workspaceId:w.id},idempotencyKey:key()});
 workspace.create(c,{kind:'message',id:'m',data:{sessionId:s.id,role:'user',content:'Not plan material'},idempotencyKey:key()});
 const plan=plans.create(c,{...fields,idempotencyKey:key()});
 const scope=()=>store.manualPlanScope(c),get=()=>plans.get(c,{id:plan.id,scope:scope()});
 const mutation=(extra={})=>({id:plan.id,expectedRevision:get().revision,idempotencyKey:key(),...extra});
 const add=(targets,extra={})=>plans.addMaterialLinks(c,{...mutation(),scope:scope(),materialLinks:targets,...extra});
 const remove=(target,extra={})=>plans.removeMaterialLink(c,{...mutation(),scope:scope(),materialLink:target,...extra});
 const legacy=(op,target)=>plans[op](c,{...mutation(),scope:scope(),[op==='setMaterialLink'?'materialLink':'documentLink']:target});
 const session=()=>plans.setSessionLink(c,{...mutation(),scope:scope(),sessionLink:{workspaceId:w.id,sessionId:s.id,workspaceRevision:w.revision,sessionRevision:s.revision}});
 return {root,c,plan,key,scope,get,mutation,add,remove,legacy,session,get plans(){return plans;},get store(){return store;},
  targets:()=>store.read(c,tx=>['workspace','session','message'].map(kind=>tx.list(kind,true))),reopen(){store.close();open();}};
}

test('typed identity and stable effective union preserve legacy order without mutating inputs',()=>{
 const a=transcript(),b=document(),sameIdOtherStore=transcript(1,'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb');
 const crossKind={kind:'transcript',transcriptStoreId:b.documentStoreId,jobId:b.documentId};
 const data=Object.freeze({materialLink:Object.freeze(a),documentLink:Object.freeze(b),materialLinks:Object.freeze([b,sameIdOtherStore,a,crossKind])});
 assert.deepEqual(effective(data),[a,b,sameIdOtherStore,crossKind]);
 assert.notEqual(keyOf(a),keyOf(sameIdOtherStore));assert.notEqual(keyOf(b),keyOf(crossKind));
 assert.deepEqual(effective({}),[]);assert.deepEqual(effective({materialLink:null,documentLink:null}),[]);
 assert.deepEqual(data.materialLinks,[b,sameIdOtherStore,a,crossKind]);
});

test('old absent/null records and historical receipts remain readable without eager array migration',t=>{
 const f=fixture(t),initial=f.get();assert.equal(Object.hasOwn(initial.data,'materialLinks'),false);
 assert.deepEqual(validateRecord(initial),initial);f.reopen();assert.deepEqual(f.get(),initial);
 const created=f.plans.create(f.c,{...fields,idempotencyKey:'historical-create'});
 f.plans.addMaterialLinks(f.c,{id:created.id,expectedRevision:1,idempotencyKey:f.key(),scope:f.scope(),materialLinks:[document()]});
 const receipt=f.plans.create(f.c,{...fields,idempotencyKey:'historical-create'});
 assert.deepEqual(receipt,created);assert.equal(Object.hasOwn(validateRecord(receipt).data,'materialLinks'),false);
 assert.deepEqual(validateRecord({...initial,data:{...initial.data,materialLink:null,documentLink:null,materialLinks:[]}}).data.materialLinks,[]);
});

test('one mixed batch deduplicates, survives reopen, and preserves authored fields, legacy links and session data',t=>{
 const f=fixture(t);f.session();f.legacy('setMaterialLink',transcript());f.legacy('setDocumentLink',document());
 const before=f.get(),targets=f.targets(),added=[document(2),transcript(2),document(3),transcript(3)];
 const row=f.add([document(),...added,transcript(),document(2)]);
 assert.equal(row.revision,before.revision+1);assert.deepEqual(row.data,{...before.data,materialLinks:added});
 assert.deepEqual(effective(row.data),[transcript(),document(),...added]);
 f.reopen();assert.deepEqual(f.get().data,row.data);assert.deepEqual(f.targets(),targets);
 const changed=f.plans.update(f.c,{...f.mutation(),patch:{notes:'Explicit note edit'}});
 assert.deepEqual(changed.data,{...row.data,notes:'Explicit note edit'});
 assert.deepEqual(validateRecord(f.get()),f.get());
});

test('empty and duplicate-only add and absent exact removal are no-op receipts, not revisions or array creation',t=>{
 const f=fixture(t),before=f.get();
 assert.equal(f.add([]).revision,1);assert.equal(f.remove(document()).revision,1);assert.deepEqual(f.get(),before);
 f.legacy('setDocumentLink',document());const linked=f.get();
 assert.equal(f.add([document(),document()]).revision,linked.revision);assert.deepEqual(f.get(),linked);
 assert.equal(Object.hasOwn(f.get().data,'materialLinks'),false);
 f.add([transcript()]);const selected=f.get();
 assert.equal(f.add([document(),transcript(),transcript()]).revision,selected.revision);assert.deepEqual(f.get(),selected);
});

test('legacy slot setters stay independent while exact removal clears all representations of only its typed identity',t=>{
 const f=fixture(t),a=document(),b=document(2),c=transcript(),sameIdOtherSource=document(1,uuid(2000));
 f.session();f.add([a,b,c,sameIdOtherSource]);f.legacy('setDocumentLink',a);f.legacy('setMaterialLink',c);
 const before=f.get(),sources=f.targets();
 assert.deepEqual(effective(before.data),[c,a,b,sameIdOtherSource]);
 const cleared=f.legacy('setDocumentLink',null);
 assert.deepEqual(cleared.data.materialLinks,[a,b,c,sameIdOtherSource]);assert.deepEqual(effective(cleared.data),[c,a,b,sameIdOtherSource]);
 f.legacy('setDocumentLink',a);const removed=f.remove(a);
 assert.equal(removed.data.documentLink,null);assert.deepEqual(removed.data.materialLinks,[b,c,sameIdOtherSource]);
 assert.deepEqual(removed.data.materialLink,c);assert.deepEqual(removed.data.sessionLink,before.data.sessionLink);
 const middle=f.remove(c);assert.equal(middle.data.materialLink,null);assert.deepEqual(effective(middle.data),[b,sameIdOtherSource]);
 f.reopen();assert.deepEqual(f.get().data,middle.data);assert.deepEqual(f.targets(),sources);
 for(const name of Object.keys(fields))assert.deepEqual(f.get().data[name],fields[name]);
});

test('removing a legacy-only identity leaves the optional supplemental field absent',t=>{
 const f=fixture(t);f.legacy('setMaterialLink',transcript());f.legacy('setDocumentLink',document());
 const removed=f.remove(transcript());assert.equal(removed.data.materialLink,null);assert.deepEqual(removed.data.documentLink,document());
 assert.equal(Object.hasOwn(removed.data,'materialLinks'),false);
});

test('effective 100-pointer cap includes legacy singles; rejection is atomic and singular setters cannot exceed it',t=>{
 const f=fixture(t);f.legacy('setMaterialLink',transcript());f.legacy('setDocumentLink',document());
 const added=Array.from({length:98},(_,i)=>document(i+2));f.add(added);const full=f.get();
 assert.equal(effective(full.data).length,L.materialLinks);assert.deepEqual(validateRecord(full),full);
 rejects(()=>f.add([document(101),document(102)]),'INVALID_REQUEST');assert.deepEqual(f.get(),full);
 rejects(()=>f.add(Array.from({length:101},()=>document())),'INVALID_REQUEST');assert.deepEqual(f.get(),full);
 // Replacing a legacy-only item stays level; a legacy slot duplicated in the array can increase the union.
 f.legacy('setDocumentLink',document(101));assert.equal(effective(f.get().data).length,100);
 f.legacy('setDocumentLink',document(2));assert.equal(effective(f.get().data).length,99);
 f.add([document(102)]);const overlapped=f.get();
 rejects(()=>f.legacy('setDocumentLink',document(103)),'INVALID_REQUEST');assert.deepEqual(f.get(),overlapped);
 f.legacy('setMaterialLink',null);f.add([transcript()]);f.legacy('setMaterialLink',transcript());const overlaid=f.get();
 rejects(()=>f.legacy('setMaterialLink',transcript(3)),'INVALID_REQUEST');assert.deepEqual(f.get(),overlaid);
 f.remove(document(50));assert.equal(effective(f.get().data).length,99);f.add([document(103)]);assert.equal(effective(f.get().data).length,100);
});

test('new writes reject smuggled authored/session fields and create/update cannot smuggle a collection',t=>{
 const f=fixture(t),before=f.get();
 for(const materialLinks of [null,[],[document()]]){
  rejects(()=>f.plans.create(f.c,{...fields,idempotencyKey:f.key(),materialLinks}),'INVALID_REQUEST');
  rejects(()=>f.plans.update(f.c,{...f.mutation(),patch:{notes:'valid',materialLinks}}),'INVALID_REQUEST');
 }
 for(const extra of [{notes:'not admitted'},{sessionLink:null},{materialLink:transcript()},{owner:'other'},{storeScope:f.scope()}])
  rejects(()=>f.add([document()],extra),'INVALID_REQUEST');
 rejects(()=>f.remove(document(),{materialLinks:[document()]}),'INVALID_REQUEST');assert.deepEqual(f.get(),before);
});

test('strict collection validation rejects sparse/custom/accessor arrays and invalid union pointers without executing getters',t=>{
 const f=fixture(t),before=f.get();let invoked=0;
 const getter={kind:'document',documentStoreId:uuid(1),get documentId(){invoked++;return uuid(2);}};
 const indexGetter=[];Object.defineProperty(indexGetter,'0',{enumerable:true,get(){invoked++;return document();}});
 const kindGetter={get kind(){invoked++;return 'document';},documentStoreId:uuid(1),documentId:uuid(2)};
 const arrays=[undefined,null,{},'[]',new Array(1),Object.assign([document()],{extra:true}),Object.assign([document()],{[Symbol('hidden')]:true}),Object.defineProperty([document()],'0',{enumerable:false}),indexGetter,new Proxy([document()],{}),Object.setPrototypeOf([document()],null)];
 const invalid=[null,undefined,{},[],document(1,'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'),{...document(),documentId:uuid(1)+'\n'},{...document(),jobId:'mixed'}, {...document(),title:'Not authority'}, {...document(),documentStoreId:f.scope()},transcript(1,uuid(1)),{...transcript(),jobId:'x\n'},{...transcript(),jobId:'x'.repeat(161)},{...document(),kind:'unknown'},getter,kindGetter,new Proxy(document(),{}),Object.assign(Object.create(null),document()),Object.assign(Object.create({inherited:1}),document()),Object.defineProperty(document(),'hidden',{value:true})];
 for(const value of arrays)rejects(()=>f.add(value),'INVALID_REQUEST');
 for(const value of invalid){rejects(()=>f.add([value]),'INVALID_REQUEST');rejects(()=>f.remove(value),'INVALID_REQUEST');}
 assert.equal(invoked,0);assert.deepEqual(f.get(),before);
 const frozen=Object.freeze([Object.freeze(document())]);assert.deepEqual(f.add(frozen).data.materialLinks,[document()]);
});

test('exact scope, CAS, owner and tenant isolation fail closed for both collection mutations',t=>{
 const f=fixture(t),other=fixture(t);f.add([document()]);const before=f.get();
 for(const [op,args] of [['addMaterialLinks',{materialLinks:[document(2)]}],['removeMaterialLink',{materialLink:document()}]]){
  const request={...f.mutation(),scope:f.scope(),...args};
  rejects(()=>f.plans[op](f.c,{...request,expectedRevision:1}),'CONFLICT');
  rejects(()=>f.plans[op](f.c,{...request,scope:'f'.repeat(64)}),'PROVIDER_ERROR');
  for(const scope of [undefined,null,f.scope()+'\n',f.scope().toUpperCase()])rejects(()=>f.plans[op](f.c,{...request,scope}),'INVALID_REQUEST');
  for(const c of [context('other'),context('owner','other')]){
   rejects(()=>f.plans[op](c,request),'PROVIDER_ERROR');
   rejects(()=>f.plans[op](c,{...request,scope:f.store.manualPlanScope(c)}),'NOT_FOUND');
  }
  rejects(()=>other.plans[op](other.c,request),'PROVIDER_ERROR');
 }
 assert.deepEqual(f.get(),before);
});

test('canonical historical receipts replay after reopen without rewriting newer links, including no-op receipts',t=>{
 const f=fixture(t),request={...f.mutation(),scope:f.scope(),materialLinks:[document(),transcript()]};
 const saved=f.plans.addMaterialLinks(f.c,request);
 const reordered={...request,materialLinks:[{documentId:uuid(1),documentStoreId:uuid(1000),kind:'document'},{jobId:'job-1',kind:'transcript',transcriptStoreId:transcript().transcriptStoreId}]};
 assert.deepEqual(f.plans.addMaterialLinks(f.c,reordered),saved);
 const remove={...f.mutation(),scope:f.scope(),materialLink:document()},removed=f.plans.removeMaterialLink(f.c,remove);
 const empty={...f.mutation(),scope:f.scope(),materialLinks:[]},noop=f.plans.addMaterialLinks(f.c,empty);
 f.add([document(3)]);const latest=f.get();f.reopen();
 assert.deepEqual(f.plans.addMaterialLinks(f.c,request),saved);assert.deepEqual(f.plans.removeMaterialLink(f.c,remove),removed);
 assert.deepEqual(f.plans.addMaterialLinks(f.c,empty),noop);assert.deepEqual(f.get(),latest);
 for(const changed of [{materialLinks:[transcript(),document()]},{materialLinks:[document()]},{expectedRevision:2}])rejects(()=>f.plans.addMaterialLinks(f.c,{...request,...changed}),'CONFLICT');
 rejects(()=>f.plans.removeMaterialLink(f.c,{...remove,materialLink:transcript()}),'CONFLICT');
 rejects(()=>f.plans.addMaterialLinks(f.c,{...request,idempotencyKey:remove.idempotencyKey}),'CONFLICT');
 assert.deepEqual(f.get(),latest);
});

test('terminal and trashed plans reject even no-op collection writes; explicit reopen and restore retain every pointer',t=>{
 for(const state of ['completed','cancelled']){
  const f=fixture(t);f.add([document(),transcript()]);const before=f.get();
  f.plans.setState(f.c,{...f.mutation(),state});
  for(const run of [()=>f.add([]),()=>f.add([document()]),()=>f.remove(document(9)),()=>f.remove(document())])rejects(run,'CONFLICT');
  f.plans.reopen(f.c,f.mutation());assert.deepEqual(f.get().data.materialLinks,before.data.materialLinks);
  const removed=f.plans.remove(f.c,f.mutation());
  rejects(()=>f.plans.addMaterialLinks(f.c,{id:f.plan.id,expectedRevision:removed.revision,idempotencyKey:f.key(),scope:f.scope(),materialLinks:[]}),'NOT_FOUND');
  rejects(()=>f.plans.removeMaterialLink(f.c,{id:f.plan.id,expectedRevision:removed.revision,idempotencyKey:f.key(),scope:f.scope(),materialLink:document()}),'NOT_FOUND');
  f.plans.restore(f.c,{id:f.plan.id,expectedRevision:removed.revision,idempotencyKey:f.key()});assert.deepEqual(f.get().data.materialLinks,before.data.materialLinks);
 }
});

test('larger valid rows respect existing byte-limited pagination without hiding later plans',t=>{
 const f=fixture(t),pointers=Array.from({length:100},(_,i)=>transcript(`long-${i}-`+'x'.repeat(145)));
 const expected=[f.plan.id];f.add(pointers);
 for(let i=0;i<12;i++){
  const row=f.plans.create(f.c,{...fields,title:`Large ${i}`,objective:'x'.repeat(8000),notes:'y'.repeat(8000),idempotencyKey:f.key()});expected.push(row.id);
  f.plans.addMaterialLinks(f.c,{id:row.id,expectedRevision:1,idempotencyKey:f.key(),scope:f.scope(),materialLinks:pointers});
 }
 let offset=0,seen=[];do{
  const page=f.plans.list(f.c,{offset,limit:100});assert.ok(Buffer.byteLength(JSON.stringify(page))<=L.pageBytes);assert.ok(page.items.length<13);
  assert.deepEqual(validatePage(page,offset,100),page);seen.push(...page.items.map(x=>x.id));offset=page.nextOffset;
 }while(offset!==null);
 assert.deepEqual(seen.sort(),expected.sort());
});

test('server and client transport allowlists admit only the two exact new collection routes',()=>{
 const server=readFileSync(new URL('../backend/server.mjs',import.meta.url),'utf8');
 const transport=readFileSync(new URL('../visual-harness/bounded-transport.ts',import.meta.url),'utf8');
 assert.match(server,/'manual-plans':new Set\(\[[^\]]*'addMaterialLinks','removeMaterialLink'[^\]]*\]\)/);
 assert.match(transport,/'manual-plans':\[[^\]]*'addMaterialLinks','removeMaterialLink'[^\]]*\]/);
});
