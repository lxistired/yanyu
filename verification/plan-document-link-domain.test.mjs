// Real SQLite domain, production client and pending session. No server, HTTP, browser or network.
import './plan-session-link-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const prepared=process.env.PLAN_DOCUMENT_PREPARED_RUNTIME;
const backend=name=>prepared?pathToFileURL(join(prepared,'server',name+'.mjs')).href:new URL('../backend/source/server/'+name+'.ts',import.meta.url).href;
const {DomainStore}=await import(backend('workspace-store'));
const {ManualPlanDomain}=await import(backend('manual-plan-domain'));
const {WorkspaceDomain}=await import(backend('workspace-domain'));
const {ManualPlanClient,captureCommand,validateRecord}=await import('../candidate/src/components/manual-plan-client.ts');
const {ManualPlanSession}=await import('../candidate/src/components/manual-plan-session.ts');
const ctx=(owner='owner',tenant='tenant')=>({principal:{tenantId:tenant,subjectId:owner,collectionIds:[]},requestId:'document-link-test',signal:new AbortController().signal});
const fields={title:'Synthetic local document plan',objective:'Own authored objective',notes:'Keep authored notes exactly\n不作为 ID 容器',targetDate:'2026-12-31'};
const documentStoreId='aaaaaaaa-aaaa-1aaa-7aaa-aaaaaaaaaaaa';
const documentId='12345678-1234-1234-1234-123456789abc';
const alternateId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const link=(overrides={})=>({kind:'document',documentStoreId,documentId,...overrides});
const transcript=(overrides={})=>({kind:'transcript',transcriptStoreId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',jobId:'separate-transcript',...overrides});
const rejects=(action,code)=>assert.throws(action,cause=>cause.code===code);

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'bounded-plan-document-'));
 let store,plans,workspace;
 const open=()=>{store=new DomainStore(root);plans=new ManualPlanDomain(store);workspace=new WorkspaceDomain(store);};open();
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 let serial=0;const key=()=>`document-command-${++serial}`,c=ctx();
 const create=(kind,id,data,context=c)=>workspace.create(context,{kind,id,data,idempotencyKey:key()});
 const w=create('workspace','w',{name:'Own ordinary workspace'}),s=create('session','s',{title:'Ordinary session',workspaceId:w.id});
 create('message','m',{sessionId:s.id,role:'user',content:'Message must stay unchanged'});
 const plan=plans.create(c,{...fields,idempotencyKey:key()});
 const scope=()=>store.manualPlanScope(c);
 const get=()=>plans.get(c,{id:plan.id,scope:scope()});
 const mutation=(overrides={})=>({id:plan.id,expectedRevision:get().revision,idempotencyKey:key(),...overrides});
 const command=(documentLink=link(),overrides={})=>({...mutation(),scope:scope(),documentLink,...overrides});
 const sessionTarget=()=>({workspaceId:w.id,sessionId:s.id,workspaceRevision:w.revision,sessionRevision:s.revision});
 const linkSession=target=>plans.setSessionLink(c,{...mutation(),scope:scope(),sessionLink:target===undefined?sessionTarget():target});
 const linkMaterial=target=>plans.setMaterialLink(c,{...mutation(),scope:scope(),materialLink:target===undefined?transcript():target});
 return {root,get store(){return store;},get plans(){return plans;},get workspace(){return workspace;},c,key,w,s,plan,create,scope,get,mutation,command,sessionTarget,linkSession,linkMaterial,
  targets:()=>store.read(c,tx=>['workspace','session','message'].map(kind=>tx.list(kind,true))),
  reopen(){store.close();open();}};
}

test('legacy omitted documentLink stays compatible; only the dedicated command can add or clear it',t=>{
 const f=fixture(t);
 for(const name of ['documentLink','materialLink','sessionLink'])assert.equal(Object.hasOwn(f.plan.data,name),false);
 assert.deepEqual(validateRecord(f.plan).data,f.plan.data);
 f.reopen();assert.deepEqual(f.get().data,f.plan.data);
 for(const documentLink of [null,link()]){
  rejects(()=>f.plans.create(f.c,{...fields,idempotencyKey:f.key(),documentLink}),'INVALID_REQUEST');
  rejects(()=>f.plans.update(f.c,{...f.mutation(),patch:{documentLink}}),'INVALID_REQUEST');
  rejects(()=>f.plans.update(f.c,{...f.mutation(),patch:{notes:'Smuggled with valid field',documentLink}}),'INVALID_REQUEST');
  assert.throws(()=>captureCommand('create',f.key(),{...fields,documentLink}));
  assert.throws(()=>captureCommand('update',f.key(),{id:f.plan.id,expectedRevision:1,patch:{...fields,documentLink}}));
 }
 rejects(()=>f.plans.setDocumentLink(f.c,{...f.command(),notes:'Cannot smuggle an authored patch'}),'INVALID_REQUEST');
 rejects(()=>f.plans.setDocumentLink(f.c,{...f.command(),materialLink:transcript()}),'INVALID_REQUEST');
 rejects(()=>f.plans.setDocumentLink(f.c,{...f.command(),sessionLink:f.sessionTarget()}),'INVALID_REQUEST');
 rejects(()=>f.plans.setMaterialLink(f.c,{...f.mutation(),scope:f.scope(),materialLink:transcript(),documentLink:link()}),'INVALID_REQUEST');
 rejects(()=>f.plans.setSessionLink(f.c,{...f.mutation(),scope:f.scope(),sessionLink:f.sessionTarget(),documentLink:link()}),'INVALID_REQUEST');
 const clear=f.plans.setDocumentLink(f.c,f.command(null));
 assert.equal(clear.revision,1);assert.equal(Object.hasOwn(clear.data,'documentLink'),false);
 assert.deepEqual(f.get().data,f.plan.data);
});

function malformedLinks(scope){
 const invalidUuid=[undefined,null,1,'','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','../document','https://example.invalid/document',documentId.toUpperCase(),documentId+'\n',' '+documentId,documentId+' ',documentId+'\0','１２３４５６７８-1234-1234-1234-123456789abc',scope];
 return [undefined,{},[],false,'document',link({kind:'transcript'}),link({kind:'DOCUMENT'}),
  ...invalidUuid.map(documentStoreId=>link({documentStoreId})),...invalidUuid.map(documentId=>link({documentId})),
  ...['preview','revision','documentRevision','title','url','href','downloadUrl','owner','tenant','scope','workspaceId','sessionId','text','html'].map(key=>link({[key]:'not persisted'}))];
}

test('backend, command capture and DTO reject malformed, extra, preview, revision and URL fields exactly',t=>{
 const f=fixture(t),before=f.get();
 for(const target of malformedLinks(f.scope())){
  rejects(()=>f.plans.setDocumentLink(f.c,f.command(link(),{documentLink:target})),'INVALID_REQUEST');
  assert.throws(()=>captureCommand('setDocumentLink',f.key(),{id:f.plan.id,expectedRevision:1,scope:f.scope(),documentLink:target}));
  assert.throws(()=>validateRecord({...f.plan,data:{...f.plan.data,documentLink:target}}));
 }
 assert.throws(()=>validateRecord({...f.plan,data:{...f.plan.data,unknown:'not admitted'}}));
 for(const scope of [undefined,null,documentStoreId,f.scope()+'\n',f.scope().toUpperCase(),'a'.repeat(63)]){
  rejects(()=>f.plans.setDocumentLink(f.c,f.command(link(),{scope})),'INVALID_REQUEST');
  assert.throws(()=>captureCommand('setDocumentLink',f.key(),{id:f.plan.id,expectedRevision:1,scope,documentLink:link()}));
 }
 assert.deepEqual(f.get(),before);
});

test('backend rejects proxies, inherited, hidden, symbolic and getter link fields without executing accessors',t=>{
 const f=fixture(t),before=f.get();let invoked=false;
 const getter={kind:'document',documentStoreId,get documentId(){invoked=true;return documentId;}};
 const cases=[getter,new Proxy(link(),{}),Object.assign(Object.create(null),link()),Object.assign(Object.create({inherited:true}),link()),Object.defineProperty(link(),'hidden',{value:'x'}),Object.assign(link(),{[Symbol('extra')]:'x'})];
 for(const target of cases)rejects(()=>f.plans.setDocumentLink(f.c,f.command(target)),'INVALID_REQUEST');
 assert.equal(invoked,false);
 for(const target of cases.filter(x=>x!==cases[1])){
  assert.throws(()=>captureCommand('setDocumentLink',f.key(),{id:f.plan.id,expectedRevision:1,scope:f.scope(),documentLink:target}));
  assert.throws(()=>validateRecord({...f.plan,data:{...f.plan.data,documentLink:target}}));
 }
 assert.equal(invoked,false);assert.deepEqual(f.get(),before);
});

test('canonical lowercase UUID shape accepts all versions and variants without claiming target existence or ownership',t=>{
 const f=fixture(t),targetsBefore=f.targets();
 const uuids=['00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff',documentStoreId,documentId,'12345678-1234-4123-8123-123456789abc'];
 for(let i=0;i<uuids.length;i++){
  const target=link({documentStoreId:uuids[i],documentId:uuids[(i+1)%uuids.length]});
  const captured=captureCommand('setDocumentLink',f.key(),{id:f.plan.id,expectedRevision:f.get().revision,scope:f.scope(),documentLink:target});
  const saved=f.plans.setDocumentLink(f.c,JSON.parse(captured.body));
  assert.deepEqual(saved.data.documentLink,target);assert.deepEqual(validateRecord(saved).data.documentLink,target);
 }
 assert.equal(Object.hasOwn(f.get().data,'sessionLink'),false);assert.equal(Object.hasOwn(f.get().data,'materialLink'),false);
 assert.deepEqual(f.targets(),targetsBefore);
});

test('document, transcript and session links coexist independently through save, replacement, clear and real reopen',t=>{
 const f=fixture(t),targetsBefore=f.targets();
 const doc=f.plans.setDocumentLink(f.c,f.command());
 assert.equal(doc.revision,2);
 const material=f.linkMaterial();assert.deepEqual(material.data.documentLink,link());
 const session=f.linkSession();
 assert.deepEqual(session.data,{...f.plan.data,documentLink:link(),materialLink:transcript(),sessionLink:{scope:f.scope(),...f.sessionTarget()}});
 const storedScope=f.scope();f.reopen();assert.equal(f.scope(),storedScope);assert.deepEqual(f.get().data,session.data);
 const changed=f.plans.setDocumentLink(f.c,f.command(link({documentId:alternateId})));
 assert.deepEqual(changed.data,{...session.data,documentLink:link({documentId:alternateId})});
 const edited=f.plans.update(f.c,{...f.mutation(),patch:{notes:'Explicitly updated authored notes'}});
 assert.deepEqual(edited.data,{...changed.data,notes:'Explicitly updated authored notes'});
 const materialChanged=f.linkMaterial(transcript({jobId:'different-transcript'}));
 assert.deepEqual(materialChanged.data,{...edited.data,materialLink:transcript({jobId:'different-transcript'})});
 const documentCleared=f.plans.setDocumentLink(f.c,f.command(null));
 assert.deepEqual(documentCleared.data,{...materialChanged.data,documentLink:null});
 f.reopen();assert.deepEqual(f.get().data,documentCleared.data);
 assert.deepEqual(validateRecord(f.get()).data,documentCleared.data);
 assert.deepEqual(f.plans.list(f.c).items[0].data,documentCleared.data);
 const documentRestored=f.plans.setDocumentLink(f.c,f.command());
 const materialCleared=f.linkMaterial(null);assert.deepEqual(materialCleared.data,{...documentRestored.data,materialLink:null});
 const sessionCleared=f.linkSession(null);assert.deepEqual(sessionCleared.data,{...materialCleared.data,sessionLink:null});
 f.reopen();assert.deepEqual(f.get().data,sessionCleared.data);assert.deepEqual(f.targets(),targetsBefore);
});

test('same document shortcut and repeated clear are true no-ops, preserving all other fields and revision',t=>{
 const f=fixture(t);f.linkMaterial();f.linkSession();
 const saved=f.plans.setDocumentLink(f.c,f.command());
 assert.deepEqual(f.plans.setDocumentLink(f.c,f.command(link())),saved);
 const cleared=f.plans.setDocumentLink(f.c,f.command(null));
 assert.deepEqual(f.plans.setDocumentLink(f.c,f.command(null)),cleared);
 assert.deepEqual(cleared.data,{...saved.data,documentLink:null});
});

test('plan revision, required plan-store scope, owner and tenant authority fail closed before target use',t=>{
 const a=fixture(t),b=fixture(t),before=a.get();
 rejects(()=>a.plans.setDocumentLink(a.c,a.command(link(),{expectedRevision:2})),'CONFLICT');
 rejects(()=>a.plans.setDocumentLink(a.c,a.command(link(),{scope:'f'.repeat(64)})),'PROVIDER_ERROR');
 for(const context of [ctx('other'),ctx('owner','other-tenant')]){
  rejects(()=>a.plans.setDocumentLink(context,a.command()),'PROVIDER_ERROR');
  rejects(()=>a.plans.setDocumentLink(context,a.command(link(),{scope:a.store.manualPlanScope(context)})),'NOT_FOUND');
 }
 for(const extra of [{owner:'other'},{tenant:'other'},{storeScope:a.scope()},{expectedRevision:0},{idempotencyKey:'../escape'},{id:'../escape'}])
  rejects(()=>a.plans.setDocumentLink(a.c,{...a.command(),...extra}),'INVALID_REQUEST');
 b.store.write(b.c,b.key(),{test:'copy-plan'},tx=>tx.create('manual-research-plan',a.plan.data,a.plan.id));
 rejects(()=>b.plans.setDocumentLink(b.c,a.command()),'PROVIDER_ERROR');
 assert.equal(b.plans.get(b.c,{id:a.plan.id}).revision,1);assert.deepEqual(a.get(),before);
});

test('historical idempotent receipts survive reopen without overwriting newer document, material or session state',t=>{
 const f=fixture(t),command=f.command(),saved=f.plans.setDocumentLink(f.c,command);
 assert.deepEqual(f.plans.setDocumentLink(f.c,{...command,documentLink:{documentId,kind:'document',documentStoreId}}),saved);
 f.linkMaterial();f.linkSession();
 f.plans.setDocumentLink(f.c,f.command(link({documentId:alternateId})));
 const cleared=f.plans.setDocumentLink(f.c,f.command(null));f.reopen();
 assert.deepEqual(f.plans.setDocumentLink(f.c,command),saved);
 assert.equal(f.get().revision,cleared.revision);assert.deepEqual(f.get().data,cleared.data);
 for(const change of [{documentLink:null},{documentLink:link({documentId:alternateId})},{documentLink:link({documentStoreId:alternateId})},{expectedRevision:2}])
  rejects(()=>f.plans.setDocumentLink(f.c,{...command,...change}),'CONFLICT');
 rejects(()=>f.plans.setMaterialLink(f.c,{...f.mutation(),expectedRevision:1,idempotencyKey:command.idempotencyKey,scope:f.scope(),materialLink:null}),'CONFLICT');
 rejects(()=>f.plans.setSessionLink(f.c,{...f.mutation(),expectedRevision:1,idempotencyKey:command.idempotencyKey,scope:f.scope(),sessionLink:null}),'CONFLICT');
 assert.equal(f.get().revision,cleared.revision);
});

test('receipt keys are owner/tenant scoped and cannot disclose another principal historical shortcut',t=>{
 const f=fixture(t),command=f.command();f.plans.setDocumentLink(f.c,command);
 for(const context of [ctx('other'),ctx('owner','other-tenant')]){
  const row=f.plans.create(context,{...fields,title:'Other principal own plan',idempotencyKey:f.key()});
  const ownLink=link({documentId:alternateId});
  const saved=f.plans.setDocumentLink(context,{...command,id:row.id,scope:f.store.manualPlanScope(context),documentLink:ownLink});
  assert.equal(saved.id,row.id);assert.deepEqual(saved.data.documentLink,ownLink);
 }
 assert.deepEqual(f.get().data.documentLink,command.documentLink);
});

test('completed, cancelled and deleted plans reject document save and clear; reopen and restore preserve all links',t=>{
 for(const state of ['completed','cancelled']){
  const f=fixture(t);f.linkMaterial();f.linkSession();const saved=f.plans.setDocumentLink(f.c,f.command());
  const terminal=f.plans.setState(f.c,{...f.mutation(),state});
  for(const target of [null,link(),link({documentId:alternateId})])rejects(()=>f.plans.setDocumentLink(f.c,f.command(target)),'CONFLICT');
  assert.deepEqual(f.get().data,terminal.data);
  const reopened=f.plans.reopen(f.c,f.mutation());assert.deepEqual(reopened.data,saved.data);
  const removed=f.plans.remove(f.c,f.mutation());
  for(const target of [null,link()])rejects(()=>f.plans.setDocumentLink(f.c,{id:f.plan.id,expectedRevision:removed.revision,idempotencyKey:f.key(),scope:f.scope(),documentLink:target}),'NOT_FOUND');
  const restored=f.plans.restore(f.c,{id:f.plan.id,expectedRevision:removed.revision,idempotencyKey:f.key()});
  assert.deepEqual(restored.data,saved.data);
  assert.deepEqual(f.plans.setDocumentLink(f.c,f.command(null)).data,{...saved.data,documentLink:null});
 }
});

test('dedicated server route is admitted without widening authored create or update paths',()=>{
 const source=readFileSync(new URL('../backend/server.mjs',import.meta.url),'utf8');
 assert.match(source,/'manual-plans':new Set\(\[[^\]]*'setDocumentLink'[^\]]*\]\)/);
});

test('capture owns canonical immutable bytes and retains the original plan-store scope',t=>{
 const f=fixture(t),target=link(),input={id:f.plan.id,expectedRevision:1,scope:f.scope(),documentLink:target};
 const command=captureCommand('setDocumentLink','capture-key',input);
 assert.equal(Object.isFrozen(command),true);assert.equal(command.operation,'setDocumentLink');assert.equal(command.id,f.plan.id);assert.equal(command.scope,f.scope());
 const reordered=captureCommand('setDocumentLink','capture-key',{documentLink:{documentId,documentStoreId,kind:'document'},scope:f.scope(),expectedRevision:1,id:f.plan.id});
 assert.deepEqual(command,reordered);
 target.documentId=alternateId;input.scope='f'.repeat(64);
 assert.deepEqual(JSON.parse(command.body),{idempotencyKey:'capture-key',id:f.plan.id,expectedRevision:1,scope:f.scope(),documentLink:link()});
 for(const extra of [{documentRevision:1},{materialLink:transcript()},{sessionLink:f.sessionTarget()},{notes:'not a field carrier'}])
  assert.throws(()=>captureCommand('setDocumentLink',f.key(),{id:f.plan.id,expectedRevision:1,scope:f.scope(),documentLink:link(),...extra}));
});

// Serialize actual production requests/responses across an in-process adapter. No HTTP listener.
function clientFixture(t){
 const f=fixture(t),calls=[];let route=null,afterWrite=null,dropWrite=false,dropRead=false;
 const client=new ManualPlanClient(async(url,init)=>{
  const operation=url.split('/').at(-1),input=JSON.parse(init.body);calls.push({operation,body:init.body});
  if(dropRead&&operation==='get'){dropRead=false;throw Error('Synthetic read reply loss');}
  try{
   const result=(route??f.plans)[operation](f.c,input);
   if(operation==='setDocumentLink'){
    if(afterWrite){route=afterWrite;afterWrite=null;}
    if(dropWrite){dropWrite=false;throw Error('Synthetic write reply loss');}
   }
   return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
  }catch(cause){
   if(!cause.code)throw cause;
   return new Response(JSON.stringify({error:{code:cause.code,message:'Synthetic local fixture failure',retryable:false}}),
    {status:({CONFLICT:409,NOT_FOUND:404,FORBIDDEN:403,INVALID_REQUEST:400})[cause.code]??500,headers:{'content-type':'application/json'}});
  }
 });
 const session=new ManualPlanSession(client,f.key);session.attach();t.after(()=>session.detach());
 return {f,client,session,calls,writes:()=>calls.filter(x=>x.operation==='setDocumentLink'),
  loseWrite(){dropWrite=true;},loseRead(){dropRead=true;},route(other){route=other?.plans??null;},routeAfterWrite(other){afterWrite=other.plans;}};
}

test('real client/session lost ACK retries identical bytes and reads current persisted independent links after reopen',async t=>{
 const a=clientFixture(t),{f,session}=a;f.linkMaterial();f.linkSession();const prior=f.get();await session.open(f.plan.id,()=>true);
 a.loseWrite();await session.mutate('setDocumentLink',undefined,{scope:f.scope(),documentLink:link()});
 assert.equal(session.pending.phase,'uncertain');const command=session.pending.command;assert.equal(Object.isFrozen(command),true);
 assert.equal(f.get().revision,prior.revision+1);f.reopen();await session.retry();
 assert.equal(session.pending,null);assert.deepEqual(session.editor.record.data,{...prior.data,documentLink:link()});
 assert.deepEqual(a.writes().map(x=>x.body),[command.body,command.body]);assert.equal(f.get().revision,prior.revision+1);
 a.loseRead();await session.mutate('setDocumentLink',undefined,{scope:f.scope(),documentLink:null});
 assert.equal(session.pending.phase,'readback');const count=a.writes().length;await session.retry();
 assert.equal(session.pending,null);assert.deepEqual(session.editor.record.data,{...prior.data,documentLink:null});assert.equal(a.writes().length,count);
});

test('lost ACK and replacement store keep the immutable pending command unresolved until the original store returns',async t=>{
 const a=clientFixture(t),b=fixture(t),{f,session}=a;
 b.store.write(b.c,b.key(),{test:'same-plan'},tx=>tx.create('manual-research-plan',f.plan.data,f.plan.id));
 await session.open(f.plan.id,()=>true);a.loseWrite();await session.mutate('setDocumentLink',undefined,{scope:f.scope(),documentLink:link()});
 const pending=session.pending,command=pending.command;a.route(b);await session.retry();
 assert.equal(session.pending,pending);assert.equal(session.pending.phase,'uncertain');assert.equal(session.pending.command,command);
 assert.equal(b.plans.get(b.c,{id:f.plan.id}).revision,1);assert.equal(f.get().revision,2);
 a.route(null);await session.retry();assert.equal(session.pending,null);assert.equal(session.editor.record.storeScope,f.scope());
 assert.equal(session.editor.record.revision,2);assert.deepEqual(a.writes().map(x=>x.body),[command.body,command.body,command.body]);
});

test('acknowledged document save and clear demand original scoped readback, never a same-ID replacement store',async t=>{
 const a=clientFixture(t),b=fixture(t),{f,session}=a;
 b.store.write(b.c,b.key(),{test:'copy-plan'},tx=>tx.create('manual-research-plan',f.plan.data,f.plan.id));
 await session.open(f.plan.id,()=>true);
 for(const documentLink of [link(),null]){
  a.routeAfterWrite(b);await session.mutate('setDocumentLink',undefined,{scope:f.scope(),documentLink});
  assert.equal(session.pending.phase,'readback');assert.ok(session.pending.acknowledgedId);
  const command=session.pending.command,count=a.writes().length;
  assert.equal(command.scope,f.scope());assert.equal(JSON.parse(a.calls.at(-1).body).scope,f.scope());
  await session.retry();assert.equal(session.pending.phase,'readback');assert.equal(a.writes().length,count);
  a.route(null);await session.retry();assert.equal(session.pending,null);assert.equal(a.writes().length,count);
  assert.equal(session.editor.record.storeScope,f.scope());assert.deepEqual(session.editor.record.data.documentLink,documentLink);
 }
 assert.equal(b.plans.get(b.c,{id:f.plan.id}).revision,1);
});

test('dirty or uncertain editor blocks alternative document, material, session and authored mutations without replacing pending bytes',async t=>{
 const a=clientFixture(t),{f,session}=a;f.linkMaterial();f.linkSession();const before=f.get();await session.open(f.plan.id,()=>true);
 session.edit('notes','Unsaved authored notes');await session.mutate('setDocumentLink',undefined,{scope:f.scope(),documentLink:link()});
 assert.equal(a.writes().length,0);assert.equal(session.editor.draft.notes,'Unsaved authored notes');assert.equal(f.get().revision,before.revision);
 session.discard(()=>true);a.loseWrite();await session.mutate('setDocumentLink',undefined,{scope:f.scope(),documentLink:link()});
 assert.equal(session.pending.phase,'uncertain');const pending=session.pending,command=pending.command,calls=a.calls.length;
 await session.mutate('setDocumentLink',undefined,{scope:f.scope(),documentLink:null});
 await session.mutate('setMaterialLink',undefined,{scope:f.scope(),materialLink:null});
 await session.mutate('setSessionLink',undefined,{scope:f.scope(),sessionLink:null});
 await session.mutate('update');session.edit('notes','Cannot replace pending source');
 assert.equal(a.calls.length,calls);assert.equal(session.pending,pending);assert.equal(session.pending.command,command);
 assert.equal(session.editor.draft.notes,fields.notes);assert.deepEqual(f.get().data,{...before.data,documentLink:link()});
 await session.retry();assert.equal(session.pending,null);assert.deepEqual(a.writes().map(x=>x.body),[command.body,command.body]);
});

test('client/session rejects mismatched or missing reviewed scope and terminal or deleted editors before sending',async t=>{
 const a=clientFixture(t),{f,session}=a;await session.open(f.plan.id,()=>true);
 for(const scope of ['f'.repeat(64),undefined])await session.mutate('setDocumentLink',undefined,{scope,documentLink:link()});
 assert.equal(a.writes().length,0);assert.equal(f.get().revision,1);
 const original=session.editor.record;session.editor.record={...original};delete session.editor.record.storeScope;
 await session.mutate('setDocumentLink',undefined,{scope:f.scope(),documentLink:link()});assert.equal(a.writes().length,0);
 session.editor.record=original;
 for(const state of ['completed','cancelled']){
  session.editor.record={...original,data:{...original.data,state}};
  for(const documentLink of [null,link()])await session.mutate('setDocumentLink',undefined,{scope:f.scope(),documentLink});
 }
 session.editor.record={...original,deletedAt:'2026-10-23T00:00:00.000Z'};
 await session.mutate('setDocumentLink',undefined,{scope:f.scope(),documentLink:null});
 assert.equal(a.writes().length,0);assert.equal(f.get().revision,1);
});

test('retry of a historical document ACK reads newer current state instead of installing the old receipt snapshot',async t=>{
 const a=clientFixture(t),{f,session}=a;await session.open(f.plan.id,()=>true);
 a.loseWrite();await session.mutate('setDocumentLink',undefined,{scope:f.scope(),documentLink:link()});
 assert.equal(session.pending.phase,'uncertain');const command=session.pending.command;
 f.linkMaterial();f.linkSession();f.plans.setDocumentLink(f.c,f.command(link({documentId:alternateId})));
 const current=f.plans.update(f.c,{...f.mutation(),patch:{notes:'Newer authored notes remain current'}});
 f.reopen();await session.retry();
 assert.equal(session.pending,null);assert.equal(session.editor.record.revision,current.revision);
 assert.deepEqual(session.editor.record.data,current.data);assert.equal(session.editor.draft.notes,current.data.notes);
 assert.deepEqual(a.writes().map(x=>x.body),[command.body,command.body]);assert.equal(f.get().revision,current.revision);
});
