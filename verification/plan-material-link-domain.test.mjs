// Real SQLite domain and transcript records; no listener, provider, audio or network.
import './plan-session-link-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeTranscriptionStoreIdentity} from '../backend/transcription-store-identity.mjs';
import {transcriptManagement} from '../backend/transcript-management.mjs';
import {transcriptRelationships} from '../backend/transcript-relationships.mjs';
const prepared=process.env.PLAN_MATERIAL_PREPARED_RUNTIME;
const backend=name=>prepared?pathToFileURL(join(prepared,'server',name+'.mjs')).href:new URL('../backend/source/server/'+name+'.ts',import.meta.url).href;
const {DomainStore}=await import(backend('workspace-store'));
const {ManualPlanDomain}=await import(backend('manual-plan-domain'));
const {WorkspaceDomain}=await import(backend('workspace-domain'));
const {ManualPlanClient,validateRecord}=await import('../candidate/src/components/manual-plan-client.ts');
const {ManualPlanSession}=await import('../candidate/src/components/manual-plan-session.ts');
const ctx=(owner='owner',tenant='tenant')=>({principal:{tenantId:tenant,subjectId:owner,collectionIds:[]},requestId:'material-link-test',signal:new AbortController().signal});
const fields={title:'Synthetic local plan',objective:'Own authored objective',notes:'Keep authored notes exactly\n不作为 ID 容器',targetDate:'2026-12-31'};
const storeId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const jobId='12345678-1234-1234-1234-123456789abc';
const link=(overrides={})=>({kind:'transcript',transcriptStoreId:storeId,jobId,...overrides});
const rejects=(action,code)=>assert.throws(action,cause=>cause.code===code);
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'bounded-plan-material-'));
 let store,plans,workspace;
 const open=()=>{store=new DomainStore(root);plans=new ManualPlanDomain(store);workspace=new WorkspaceDomain(store);};open();
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 let serial=0;const key=()=>`material-command-${++serial}`,c=ctx();
 const create=(kind,id,data,context=c)=>workspace.create(context,{kind,id,data,idempotencyKey:key()});
 const w=create('workspace','w',{name:'Own workspace'}),s=create('session','s',{title:'Ordinary session',workspaceId:w.id});
 const message=create('message','m',{sessionId:s.id,role:'user',content:'Message must stay unchanged'});
 const plan=plans.create(c,{...fields,idempotencyKey:key()});
 const scope=()=>store.manualPlanScope(c);
 const get=()=>plans.get(c,{id:plan.id,scope:scope()});
 const command=(materialLink=link(),overrides={})=>({id:plan.id,expectedRevision:get().revision,idempotencyKey:key(),scope:scope(),materialLink,...overrides});
 return {root,get store(){return store;},get plans(){return plans;},get workspace(){return workspace;},c,key,w,s,message,plan,create,scope,get,command,
  sessionTarget:()=>({workspaceId:w.id,sessionId:s.id,workspaceRevision:w.revision,sessionRevision:s.revision}),
  targets:()=>store.read(c,tx=>['workspace','session','message'].map(kind=>tx.list(kind,true))),
  reopen(){store.close();open();}};
}
function transcriptFixture(t,f){
 const db=new DatabaseSync(join(f.root,'long-transcription.sqlite'));
 t.after(()=>db.close());
 const identity=initializeTranscriptionStoreIdentity(db);
 db.exec('CREATE TABLE transcription_jobs(id TEXT PRIMARY KEY,filename TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL,result TEXT,error TEXT,progress TEXT,deleted_at TEXT)');
 transcriptManagement(db);
 transcriptRelationships(db,{get:(kind,id)=>f.workspace.get(f.c,{kind,id}),list:kind=>f.workspace.list(f.c,{kind}).items});
 const now='2026-10-23T00:00:00.000Z';
 db.prepare('INSERT INTO transcription_jobs VALUES(?,?,?,?,?,?,?,?)').run(jobId,'synthetic-text-only.wav','completed',now,JSON.stringify({text:'Immutable synthetic original'}),null,null,null);
 db.prepare('INSERT INTO transcript_corrections VALUES(?,?,?,?)').run(jobId,1,'Saved correction',now);
 db.prepare('INSERT INTO transcript_versions VALUES(?,?,?,?,?,?)').run(jobId,1,'Saved correction',now,'correction',null);
 // An existing relationship is deliberately unrelated to the plan session link.
 db.prepare('INSERT INTO transcript_relationships VALUES(?,?,?,?)').run(jobId,'different-workspace','different-session',7);
 const snapshot=()=>JSON.stringify({schema:db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),tables:Object.fromEntries(
  ['transcription_store_identity','transcription_jobs','transcript_corrections','transcript_versions','transcript_relationships','transcript_relationship_ops'].map(name=>[name,db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all()]))});
 return {identity,snapshot};
}

test('legacy plans remain absent-field compatible; authored create/update cannot smuggle either link',t=>{
 const f=fixture(t);
 assert.equal(Object.hasOwn(f.plan.data,'materialLink'),false);
 assert.equal(Object.hasOwn(f.plan.data,'sessionLink'),false);
 assert.deepEqual(f.get().data,f.plan.data);
 assert.equal(Object.hasOwn(validateRecord(f.plan).data,'materialLink'),false);
 assert.throws(()=>validateRecord({...f.plan,data:{...f.plan.data,unrelated:'not admitted'}}));
 assert.throws(()=>validateRecord({...f.plan,data:{...f.plan.data,materialLink:{...link(),extra:true}}}));
 f.reopen();assert.deepEqual(f.get().data,f.plan.data);
 for(const materialLink of [null,link()]){
  rejects(()=>f.plans.create(f.c,{...fields,idempotencyKey:f.key(),materialLink}),'INVALID_REQUEST');
  rejects(()=>f.plans.update(f.c,{id:f.plan.id,expectedRevision:1,idempotencyKey:f.key(),patch:{materialLink}}),'INVALID_REQUEST');
 }
 rejects(()=>f.plans.setMaterialLink(f.c,{...f.command(),notes:'Cannot smuggle authored patch'}),'INVALID_REQUEST');
 rejects(()=>f.plans.setSessionLink(f.c,{id:f.plan.id,expectedRevision:1,idempotencyKey:f.key(),scope:f.scope(),sessionLink:f.sessionTarget(),materialLink:link()}),'INVALID_REQUEST');
 const clear=f.plans.setMaterialLink(f.c,f.command(null));
 assert.equal(clear.revision,1);assert.equal(Object.hasOwn(clear.data,'materialLink'),false);
 assert.deepEqual(f.get().data,f.plan.data);
});

test('save, close/reopen and clear preserve all authored data, session link and real transcript target records',t=>{
 const f=fixture(t),transcript=transcriptFixture(t,f);
 const sessionLinked=f.plans.setSessionLink(f.c,{id:f.plan.id,expectedRevision:1,idempotencyKey:f.key(),scope:f.scope(),sessionLink:f.sessionTarget()});
 const targetBefore=f.targets(),transcriptBefore=transcript.snapshot(),scope=f.scope();
 const command=f.command(link({transcriptStoreId:transcript.identity}));
 const saved=f.plans.setMaterialLink(f.c,command);
 assert.equal(saved.revision,3);assert.deepEqual(saved.data,{...sessionLinked.data,materialLink:command.materialLink});
 f.reopen();assert.equal(f.scope(),scope);assert.deepEqual(f.get().data,saved.data);
 assert.deepEqual(f.plans.list(f.c).items[0].data.materialLink,command.materialLink);
 const cleared=f.plans.setMaterialLink(f.c,f.command(null));
 assert.equal(cleared.revision,4);assert.deepEqual(cleared.data,{...sessionLinked.data,materialLink:null});
 f.reopen();assert.deepEqual(f.get().data,cleared.data);
 assert.deepEqual(f.targets(),targetBefore);assert.equal(transcript.snapshot(),transcriptBefore);
});

test('link validates shape only: missing/different transcript stores and jobs do not assert cross-store existence',t=>{
 const f=fixture(t),before=f.targets();
 const targets=[link({jobId:'missing:transcript.with-valid_id'}),link({transcriptStoreId:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',jobId:'Z'+'.'.repeat(159)})];
 for(const target of targets){const row=f.plans.setMaterialLink(f.c,f.command(target));assert.deepEqual(row.data.materialLink,target);}
 assert.equal(Object.hasOwn(f.get().data,'sessionLink'),false);assert.deepEqual(f.targets(),before);
 const {storeScope,...same}=f.get();assert.deepEqual(f.plans.setMaterialLink(f.c,f.command(same.data.materialLink)),same);
});

test('strict bounded shape rejects malformed, extra, inherited and executable fields without touching persistence',t=>{
 const f=fixture(t),before=f.get();
 const invalidLinks=[undefined,{},[],false,'transcript',
  link({kind:'document'}),link({transcriptStoreId:f.scope()}),link({transcriptStoreId:storeId.toUpperCase()}),link({transcriptStoreId:storeId+'\n'}),
  link({transcriptStoreId:'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa'}),link({transcriptStoreId:'aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa'}),
  link({jobId:''}),link({jobId:'a'.repeat(161)}),link({jobId:'../x'}),link({jobId:'/a'}),link({jobId:'-starts-wrong'}),link({jobId:'a\n'}),link({jobId:'a\0'}),link({jobId:'中文'}),
  link({owner:'other'}),link({scope:f.scope()}),link({workspaceId:'w'}),link({sessionId:'s'}),link({revision:1}),link({title:'Not persisted'}),link({url:'https://example.invalid'})];
 for(const target of invalidLinks)rejects(()=>f.plans.setMaterialLink(f.c,f.command(link(),{materialLink:target})),'INVALID_REQUEST');
 let invoked=false;const getter={kind:'transcript',transcriptStoreId:storeId,get jobId(){invoked=true;return jobId;}};
 rejects(()=>f.plans.setMaterialLink(f.c,f.command(getter)),'INVALID_REQUEST');assert.equal(invoked,false);
 for(const target of [new Proxy(link(),{}),Object.assign(Object.create(null),link()),Object.assign(Object.create({inherited:true}),link()),Object.defineProperty(link(),'hidden',{value:'x'}),Object.assign(link(),{[Symbol('extra')]:'x'})])
  rejects(()=>f.plans.setMaterialLink(f.c,f.command(target)),'INVALID_REQUEST');
 for(const scope of [undefined,null,storeId,f.scope()+'\n',f.scope().toUpperCase(),'a'.repeat(63)])rejects(()=>f.plans.setMaterialLink(f.c,f.command(link(),{scope})),'INVALID_REQUEST');
 assert.deepEqual(f.get(),before);
});

test('revision, plan-scope, owner and tenant authority fail closed, including same IDs in another store',t=>{
 const a=fixture(t),b=fixture(t),before=a.get();
 rejects(()=>a.plans.setMaterialLink(a.c,a.command(link(),{expectedRevision:2})),'CONFLICT');
 rejects(()=>a.plans.setMaterialLink(a.c,a.command(link(),{scope:'f'.repeat(64)})),'PROVIDER_ERROR');
 for(const context of [ctx('other'),ctx('owner','other-tenant')]){
  rejects(()=>a.plans.setMaterialLink(context,a.command()),'PROVIDER_ERROR');
  rejects(()=>a.plans.setMaterialLink(context,a.command(link(),{scope:a.store.manualPlanScope(context)})),'NOT_FOUND');
 }
 for(const extra of [{owner:'other'},{tenant:'other'},{storeScope:a.scope()},{sessionLink:a.sessionTarget()}])rejects(()=>a.plans.setMaterialLink(a.c,{...a.command(),...extra}),'INVALID_REQUEST');
 b.store.write(b.c,b.key(),{test:'copy-plan'},tx=>tx.create('manual-research-plan',a.plan.data,a.plan.id));
 rejects(()=>b.plans.setMaterialLink(b.c,a.command()),'PROVIDER_ERROR');
 assert.equal(b.plans.get(b.c,{id:a.plan.id}).revision,1);assert.deepEqual(a.get(),before);
});

test('idempotency replays canonical historical receipts after reopen but never rewrites newer material or session data',t=>{
 const f=fixture(t),command=f.command(),saved=f.plans.setMaterialLink(f.c,command);
 const reordered={...command,materialLink:{jobId,transcriptStoreId:storeId,kind:'transcript'}};
 assert.deepEqual(f.plans.setMaterialLink(f.c,reordered),saved);
 const sessionLinked=f.plans.setSessionLink(f.c,{id:f.plan.id,expectedRevision:saved.revision,idempotencyKey:f.key(),scope:f.scope(),sessionLink:f.sessionTarget()});
 assert.deepEqual(sessionLinked.data.materialLink,command.materialLink);
 const cleared=f.plans.setMaterialLink(f.c,f.command(null));f.reopen();
 assert.deepEqual(f.plans.setMaterialLink(f.c,command),saved);
 assert.equal(f.get().revision,cleared.revision);assert.equal(f.get().data.materialLink,null);assert.deepEqual(f.get().data.sessionLink,sessionLinked.data.sessionLink);
 for(const change of [{materialLink:null},{materialLink:link({jobId:'other'})},{expectedRevision:2}])rejects(()=>f.plans.setMaterialLink(f.c,{...command,...change}),'CONFLICT');
 rejects(()=>f.plans.setSessionLink(f.c,{id:f.plan.id,expectedRevision:1,idempotencyKey:command.idempotencyKey,scope:f.scope(),sessionLink:null}),'CONFLICT');
 assert.equal(f.get().revision,cleared.revision);
});

test('receipt keys are owner/tenant scoped and cannot disclose another principal historical data',t=>{
 const f=fixture(t),command=f.command();f.plans.setMaterialLink(f.c,command);
 for(const context of [ctx('other'),ctx('owner','other-tenant')]){
  const row=f.plans.create(context,{...fields,title:'Own other principal plan',idempotencyKey:f.key()});
  const ownLink=link({jobId:context.principal.tenantId==='tenant'?'own-other':'own-tenant'});
  const saved=f.plans.setMaterialLink(context,{...command,id:row.id,scope:f.store.manualPlanScope(context),materialLink:ownLink});
  assert.equal(saved.id,row.id);assert.deepEqual(saved.data.materialLink,ownLink);
 }
 assert.deepEqual(f.get().data.materialLink,command.materialLink);
});

test('completed/cancelled/deleted plans reject link and clear; explicit reopen/restore retain the shortcut',t=>{
 for(const state of ['completed','cancelled']){
  const f=fixture(t),saved=f.plans.setMaterialLink(f.c,f.command());
  const terminal=f.plans.setState(f.c,{id:f.plan.id,expectedRevision:saved.revision,idempotencyKey:f.key(),state});
  for(const target of [null,link(),link({jobId:'different'})])rejects(()=>f.plans.setMaterialLink(f.c,f.command(target)),'CONFLICT');
  assert.deepEqual(f.get().data,terminal.data);
  const reopened=f.plans.reopen(f.c,{id:f.plan.id,expectedRevision:terminal.revision,idempotencyKey:f.key()});
  assert.deepEqual(reopened.data.materialLink,saved.data.materialLink);
  const removed=f.plans.remove(f.c,{id:f.plan.id,expectedRevision:reopened.revision,idempotencyKey:f.key()});
  for(const target of [null,link()])rejects(()=>f.plans.setMaterialLink(f.c,{id:f.plan.id,expectedRevision:removed.revision,idempotencyKey:f.key(),scope:f.scope(),materialLink:target}),'NOT_FOUND');
  const restored=f.plans.restore(f.c,{id:f.plan.id,expectedRevision:removed.revision,idempotencyKey:f.key()});
  assert.deepEqual(restored.data.materialLink,saved.data.materialLink);
  assert.equal(f.plans.setMaterialLink(f.c,f.command(null)).data.materialLink,null);
 }
});

test('dedicated route is admitted by the server without widening generic authored mutations',()=>{
 const source=readFileSync(new URL('../backend/server.mjs',import.meta.url),'utf8');
 assert.match(source,/'manual-plans':new Set\(\[[^\]]*'setMaterialLink'[^\]]*\]\)/);
});

// Exercise actual domain writes with the production client and pending session. The
// injected adapter serializes the real request/response but never starts HTTP.
function clientFixture(t){
 const f=fixture(t),calls=[];let route=null,afterWrite=null,dropWrite=false,dropRead=false;
 const client=new ManualPlanClient(async(url,init)=>{
  const operation=url.split('/').at(-1),input=JSON.parse(init.body);calls.push({operation,body:init.body});
  if(dropRead&&operation==='get'){dropRead=false;throw Error('Synthetic read reply loss');}
  try{
   const result=(route??f.plans)[operation](f.c,input);
   if(operation==='setMaterialLink'){
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
 return {f,client,session,calls,writes:()=>calls.filter(x=>x.operation==='setMaterialLink'),
  loseWrite(){dropWrite=true;},loseRead(){dropRead=true;},route(other){route=other?.plans??null;},routeAfterWrite(other){afterWrite=other.plans;}};
}

test('real client/session lost ACK retries the identical captured bytes once and reads current persistence',async t=>{
 const a=clientFixture(t),{f,session}=a;await session.open(f.plan.id,()=>true);
 a.loseWrite();await session.mutate('setMaterialLink',undefined,{scope:f.scope(),materialLink:link()});
 assert.equal(session.pending.phase,'uncertain');const command=session.pending.command;assert.equal(Object.isFrozen(command),true);
 assert.equal(f.get().revision,2);f.reopen();await session.retry();
 assert.equal(session.pending,null);assert.equal(session.editor.record.revision,2);assert.deepEqual(session.editor.record.data.materialLink,link());
 assert.deepEqual(a.writes().map(x=>x.body),[command.body,command.body]);assert.equal(f.get().revision,2);
 a.loseRead();await session.mutate('setMaterialLink',undefined,{scope:f.scope(),materialLink:null});
 assert.equal(session.pending.phase,'readback');const count=a.writes().length;await session.retry();
 assert.equal(session.pending,null);assert.equal(session.editor.record.data.materialLink,null);assert.equal(a.writes().length,count);
});

test('real client/session acknowledged link and clear require original plan-store readback, never a replacement store',async t=>{
 const a=clientFixture(t),b=fixture(t),{f,session}=a;
 b.store.write(b.c,b.key(),{test:'copied-plan'},tx=>tx.create('manual-research-plan',f.plan.data,f.plan.id));
 await session.open(f.plan.id,()=>true);
 for(const materialLink of [link(),null]){
  a.routeAfterWrite(b);await session.mutate('setMaterialLink',undefined,{scope:f.scope(),materialLink});
  assert.equal(session.pending.phase,'readback');assert.ok(session.pending.acknowledgedId);
  const command=session.pending.command,count=a.writes().length;
  assert.equal(command.scope,f.scope());assert.equal(JSON.parse(a.calls.at(-1).body).scope,f.scope());
  await session.retry();assert.equal(session.pending.phase,'readback');assert.equal(a.writes().length,count);
  a.route(null);await session.retry();assert.equal(session.pending,null);assert.equal(a.writes().length,count);
  assert.equal(session.editor.record.storeScope,f.scope());assert.deepEqual(session.editor.record.data.materialLink,materialLink);
 }
 assert.equal(b.plans.get(b.c,{id:f.plan.id}).revision,1);
});

test('real client/session dirty or uncertain state blocks alternate link and authored mutations without replacing pending bytes',async t=>{
 const a=clientFixture(t),{f,session}=a;await session.open(f.plan.id,()=>true);
 session.edit('notes','Unsaved authored notes');
 await session.mutate('setMaterialLink',undefined,{scope:f.scope(),materialLink:link()});
 assert.equal(a.writes().length,0);assert.equal(session.editor.draft.notes,'Unsaved authored notes');assert.equal(f.get().revision,1);
 session.discard(()=>true);a.loseWrite();await session.mutate('setMaterialLink',undefined,{scope:f.scope(),materialLink:link()});
 assert.equal(session.pending.phase,'uncertain');const pending=session.pending,command=pending.command;
 const calls=a.calls.length;
 await session.mutate('setMaterialLink',undefined,{scope:f.scope(),materialLink:null});
 await session.mutate('setSessionLink',undefined,{scope:f.scope(),sessionLink:f.sessionTarget()});
 await session.mutate('update');session.edit('notes','Cannot replace pending source');
 assert.equal(a.calls.length,calls);assert.equal(session.pending,pending);assert.equal(session.pending.command,command);
 assert.equal(session.editor.draft.notes,fields.notes);assert.equal(f.get().revision,2);assert.equal(Object.hasOwn(f.get().data,'sessionLink'),false);
 await session.retry();assert.equal(session.pending,null);assert.deepEqual(a.writes().map(x=>x.body),[command.body,command.body]);
});
