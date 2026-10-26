// Current sources or explicitly prepared runtime, real temporary SQLite, synthetic data only.
// No browser, listener, network, provider, message execution or durable feature writes.
import './plan-session-link-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {copyFileSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const prepared=process.env.PLAN_LINKED_SESSION_PREPARED_RUNTIME;
const backend=name=>prepared?pathToFileURL(join(prepared,'server',name+'.mjs')).href:new URL('../backend/source/server/'+name+'.ts',import.meta.url).href;
const {DomainStore}=await import(backend('workspace-store'));
const {ManualPlanDomain}=await import(backend('manual-plan-domain'));
const {WorkspaceDomain}=await import(backend('workspace-domain'));
const {bindRequestAuthority}=await import(backend('request-authority'));
const {AdapterError}=await import(prepared?pathToFileURL(join(prepared,'shared/contracts.mjs')).href:new URL('../backend/source/shared/contracts.ts',import.meta.url).href);
const {MANUAL_PLAN_LIMITS:L}=await import('../candidate/shared/manual-plans.ts');
const context=(subjectId='owner',tenantId='tenant')=>({principal:{tenantId,subjectId,collectionIds:[]},requestId:'linked-session-test',signal:new AbortController().signal});
const fields={title:'Synthetic saved plan',objective:'Local manual records only',notes:'Keep authored notes unchanged',targetDate:'2026-12-31'};
const rejects=(run,code)=>assert.throws(run,cause=>cause.code===code);
function fixture(t,{link=true}={}){
 const root=mkdtempSync(join(tmpdir(),'plan-linked-session-'));let store,plans,workspace;
 const open=()=>{store=new DomainStore(root);plans=new ManualPlanDomain(store);workspace=new WorkspaceDomain(store);};open();
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const c=context();let serial=0;const key=()=>`linked-session-${++serial}`;
 const create=(kind,id,data,ctx=c)=>workspace.create(ctx,{kind,id,data,idempotencyKey:key()});
 const w=create('workspace','w',{name:'Duplicate workspace'}),w2=create('workspace','w2',{name:'Duplicate workspace'});
 const s=create('session','s',{title:'Duplicate session',workspaceId:w.id,mode:'deep',model:'Saved preference, no execution'});
 const s2=create('session','s2',{title:'Duplicate session',workspaceId:w.id}),s3=create('session','s3',{title:'Duplicate session',workspaceId:w2.id});
 let plan=plans.create(c,{...fields,idempotencyKey:key()});
 const scope=()=>store.manualPlanScope(c),get=()=>plans.get(c,{id:plan.id,scope:scope()});
 const target={workspaceId:w.id,sessionId:s.id,workspaceRevision:w.revision,sessionRevision:s.revision};
 const mutation=()=>({id:plan.id,expectedRevision:get().revision,idempotencyKey:key()});
 if(link)plan=plans.setSessionLink(c,{...mutation(),scope:scope(),sessionLink:target});
 const request=(extra={})=>({id:plan.id,expectedRevision:get().revision,scope:scope(),sessionLink:{scope:scope(),...target},...extra});
 const message=(id,content=`Target manual ${id}`,sessionId=s.id,role='user')=>create('message',id,{sessionId,role,content});
 const seed=rows=>store.write(c,key(),{fixture:'legacy-message-rows'},tx=>{for(const [id,data] of rows)tx.create('message',data,id);return null;});
 const hashes=()=>Object.fromEntries(readdirSync(root,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()&&!entry.name.endsWith('.lock')).map(entry=>{const path=join(entry.parentPath,entry.name);return [path.slice(root.length),createHash('sha256').update(readFileSync(path)).digest('hex')];}));
 return {root,c,w,w2,s,s2,s3,plan,key,scope,get,target,mutation,request,create,message,seed,hashes,
  get store(){return store;},get plans(){return plans;},get workspace(){return workspace;},reopen(){store.close();open();}};
}

test('exact linked header and bounded manual pages survive reopen; duplicate titles and other owners never enter result',t=>{
 const f=fixture(t);for(let i=0;i<31;i++)f.message(`target-${String(i).padStart(2,'0')}`,`Saved target content ${i}`,f.s.id,i%2?'assistant':'user');
 f.message('same-title-session','Excluded same-title content',f.s2.id);f.message('other-workspace-session','Excluded other-workspace content',f.s3.id);
 const foreign=context('foreign');f.create('workspace','w',{name:'Duplicate workspace'},foreign);f.create('session','s',{workspaceId:'w',title:'Duplicate session'},foreign);f.create('message','foreign-message',{sessionId:'s',role:'user',content:'Excluded other-owner content'},foreign);
 const plan=f.get(),request=f.request();f.reopen();const before=f.hashes();
 const first=f.plans.linkedSession(f.c,request);
 assert.deepEqual(first.workspace,{id:'w',title:f.w.data.name,revision:1});
 assert.deepEqual(first.session,{id:'s',title:f.s.data.title,revision:1,workspaceId:'w',mode:'deep',model:f.s.data.model});
 assert.equal(first.scope,request.scope);assert.equal(first.planId,request.id);assert.equal(first.planRevision,request.expectedRevision);assert.deepEqual(first.sessionLink,request.sessionLink);
 assert.equal(first.total,31);assert.equal(first.offset,0);assert.equal(first.items.length,25);assert.equal(first.nextOffset,25);
 const last=f.plans.linkedSession(f.c,{...request,offset:first.nextOffset,limit:10});assert.equal(last.offset,25);assert.equal(last.items.length,6);assert.equal(last.nextOffset,null);
 assert.deepEqual([...first.items,...last.items].map(row=>row.data.content),Array.from({length:31},(_,i)=>`Saved target content ${i}`));
 assert.deepEqual(f.get(),plan);assert.deepEqual(f.hashes(),before,'reads must not write entities, receipts, schema or file bytes');
 const beyond=f.plans.linkedSession(f.c,{...request,offset:40});assert.equal(beyond.total,31);assert.deepEqual(beyond.items,[]);assert.equal(beyond.nextOffset,null);
});

test('legacy absent sequence ordering exactly matches ordinary list and does not rewrite old records',t=>{
 const f=fixture(t);f.message('sequenced-first');
 f.seed([['legacy-z',{sessionId:'s',role:'system',content:'Legacy Z'}],['legacy-a',{sessionId:'s',role:'user',content:'Legacy A'}]]);
 f.message('sequenced-second');
 const expected=f.workspace.list(f.c,{kind:'message',sessionId:'s',limit:100}).items;
 const before=f.hashes(),actual=f.plans.linkedSession(f.c,f.request({limit:100})).items;
 assert.deepEqual(actual,expected);assert.ok(actual.slice(0,2).every(row=>row.data.sequence===undefined));assert.ok(actual.slice(2).every(row=>Number.isSafeInteger(row.data.sequence)));
 assert.deepEqual(f.hashes(),before);
});

test('pages read current manual content, excluding deleted messages and returning changed totals rather than frozen snapshots',t=>{
 const f=fixture(t),one=f.message('one'),two=f.message('two'),request=f.request({limit:1});
 assert.equal(f.plans.linkedSession(f.c,request).total,2);
 f.workspace.update(f.c,{kind:'message',id:one.id,expectedRevision:one.revision,patch:{content:'Currently edited manual record'},idempotencyKey:f.key()});
 f.workspace.remove(f.c,{kind:'message',id:two.id,expectedRevision:two.revision,idempotencyKey:f.key()});f.message('three');
 const refreshed=f.plans.linkedSession(f.c,request);assert.equal(refreshed.items[0].data.content,'Currently edited manual record');assert.equal(refreshed.items[0].revision,2);assert.equal(refreshed.total,2);
 const next=f.plans.linkedSession(f.c,{...request,offset:1});assert.equal(next.items[0].id,'three');assert.equal(next.nextOffset,null);assert.equal(f.get().revision,request.expectedRevision);
});

test('each request checks exact active plan revision and saved link; absent/null/cleared links never authorize opening',t=>{
 const f=fixture(t,{link:false}),legacy=f.request();rejects(()=>f.plans.linkedSession(f.c,legacy),'CONFLICT');
 const linked=f.plans.setSessionLink(f.c,{...f.mutation(),scope:f.scope(),sessionLink:f.target}),request={...legacy,expectedRevision:linked.revision};
 for(const field of ['workspaceId','sessionId','workspaceRevision','sessionRevision']){
  const value=field==='workspaceId'?'w2':field==='sessionId'?'s2':2;
  rejects(()=>f.plans.linkedSession(f.c,{...request,sessionLink:{...request.sessionLink,[field]:value}}),'CONFLICT');
 }
 rejects(()=>f.plans.linkedSession(f.c,{...request,expectedRevision:1}),'CONFLICT');
 const changed=f.plans.update(f.c,{...f.mutation(),patch:{notes:'Changed authored note'}});rejects(()=>f.plans.linkedSession(f.c,request),'CONFLICT');
 const fresh={...request,expectedRevision:changed.revision};assert.equal(f.plans.linkedSession(f.c,fresh).planRevision,changed.revision);
 f.plans.setSessionLink(f.c,{...f.mutation(),scope:f.scope(),sessionLink:null});rejects(()=>f.plans.linkedSession(f.c,f.request()),'CONFLICT');
});

test('read-only completed/cancelled plans remain readable; a trashed plan is never opened',t=>{
 for(const state of ['completed','cancelled']){
  const f=fixture(t);f.message('one');f.plans.setState(f.c,{...f.mutation(),state});const request=f.request(),before=f.hashes();
  assert.equal(f.plans.linkedSession(f.c,request).items[0].id,'one');assert.deepEqual(f.hashes(),before);assert.equal(f.get().data.state,state);
  f.plans.remove(f.c,{...f.mutation()});rejects(()=>f.plans.linkedSession(f.c,request),'NOT_FOUND');
 }
});

test('target revision, deletion and workspace membership are revalidated on every page without rewriting the saved link',t=>{
 for(const action of ['workspace-revision','session-revision','moved-session','deleted-session','deleted-workspace']){
  const f=fixture(t);f.message('one');const request=f.request(),saved=f.get();
  f.plans.linkedSession(f.c,request);
  if(action==='workspace-revision')f.workspace.update(f.c,{kind:'workspace',id:'w',expectedRevision:1,patch:{name:'Changed'},idempotencyKey:f.key()});
  if(action==='session-revision')f.workspace.update(f.c,{kind:'session',id:'s',expectedRevision:1,patch:{title:'Changed'},idempotencyKey:f.key()});
  if(action==='moved-session')f.workspace.update(f.c,{kind:'session',id:'s',expectedRevision:1,patch:{workspaceId:'w2'},idempotencyKey:f.key()});
  if(action==='deleted-session')f.store.write(f.c,f.key(),{fixture:'legacy-deleted-session'},tx=>tx.softDelete('session','s',1));
  if(action==='deleted-workspace')f.store.write(f.c,f.key(),{fixture:'legacy-deleted-workspace'},tx=>tx.softDelete('workspace','w',1));
  rejects(()=>f.plans.linkedSession(f.c,{...request,offset:1}),action.startsWith('deleted')?'NOT_FOUND':'CONFLICT');assert.deepEqual(f.get(),saved);
 }
});

test('membership mismatch is rejected even when stored target revision tuple matches',t=>{
 const f=fixture(t);const moved=f.workspace.update(f.c,{kind:'session',id:'s',expectedRevision:1,patch:{workspaceId:'w2'},idempotencyKey:f.key()});
 const prior=f.get(),badLink={...prior.data.sessionLink,sessionRevision:moved.revision};
 f.store.write(f.c,f.key(),{fixture:'legacy-mismatched-parent'},tx=>tx.update('manual-research-plan',prior.id,prior.revision,{...prior.data,sessionLink:badLink}));
 rejects(()=>f.plans.linkedSession(f.c,f.request({sessionLink:badLink})),'CONFLICT');
});

test('owner, tenant, link scope and replacement store reject identical IDs; no scope reacquisition fallback',t=>{
 const a=fixture(t),b=fixture(t);a.message('one','Original store content');b.message('one','Replacement store content');
 const request=a.request();assert.notEqual(a.scope(),b.scope());
 // Same persisted ID, link tuple and revision in another real store still have different lineage.
 b.store.write(b.c,b.key(),{fixture:'same-plan'},tx=>{tx.create('manual-research-plan',a.plan.data,a.plan.id);tx.update('manual-research-plan',a.plan.id,1,a.plan.data);return null;});
 rejects(()=>b.plans.linkedSession(b.c,request),'PROVIDER_ERROR');
 rejects(()=>a.plans.linkedSession(a.c,{...request,scope:'f'.repeat(64)}),'PROVIDER_ERROR');
 rejects(()=>a.plans.linkedSession(a.c,{...request,sessionLink:{...request.sessionLink,scope:'f'.repeat(64)}}),'PROVIDER_ERROR');
 for(const c of [context('other-owner'),context('owner','other-tenant')]){
  rejects(()=>a.plans.linkedSession(c,request),'PROVIDER_ERROR');const scope=a.store.manualPlanScope(c);
  rejects(()=>a.plans.linkedSession(c,{...request,scope,sessionLink:{...request.sessionLink,scope}}),'NOT_FOUND');
 }
});

test('strict request and tuple validation reject accessors, proxies, smuggled options and unbounded pagination',t=>{
 const f=fixture(t),request=f.request(),before=f.hashes();let invoked=0;
 const getter=Object.defineProperty({...request},'scope',{enumerable:true,get(){invoked++;return f.scope();}});
 const tupleGetter=Object.defineProperty({...request.sessionLink},'sessionId',{enumerable:true,get(){invoked++;return 's';}});
 const badRequests=[null,[],Object.assign(Object.create(null),request),new Proxy(request,{}),getter,{...request,sessionLink:tupleGetter},
  {...request,owner:'other'},{...request,idempotencyKey:'must-not-be-a-command'},{...request,includeDeleted:true},{...request,query:'not-admitted'},
  {...request,sessionLink:null},{...request,sessionLink:{...request.sessionLink,title:'not-authority'}},{...request,sessionLink:new Proxy(request.sessionLink,{})},
  {...request,sessionLink:Object.defineProperty({...request.sessionLink},'hidden',{value:1})},
  {...request,sessionLink:{...request.sessionLink,[Symbol('hidden')]:true}}];
 for(const input of badRequests)rejects(()=>f.plans.linkedSession(f.c,input),'INVALID_REQUEST');
 for(const offset of [-1,1.1,L.maxOffset+1,Number.MAX_SAFE_INTEGER,null,undefined,'1'])rejects(()=>f.plans.linkedSession(f.c,{...request,offset}),'INVALID_REQUEST');
 for(const limit of [-1,0,1.1,L.maxLimit+1,null,undefined,'1'])rejects(()=>f.plans.linkedSession(f.c,{...request,limit}),'INVALID_REQUEST');
 for(const field of ['id','expectedRevision','scope','sessionLink']){const input={...request};delete input[field];rejects(()=>f.plans.linkedSession(f.c,input),'INVALID_REQUEST');}
 assert.equal(invoked,0);assert.deepEqual(f.hashes(),before);
});

test('whole-envelope UTF-8 bound includes header and returns truthful continuation without truncating message bodies',t=>{
 const f=fixture(t),content='🙂'.repeat(16384);for(let i=0;i<7;i++)f.message(`large-${i}`,content);
 const request=f.request({limit:100}),all=[];let offset=0,pages=0;
 do{const page=f.plans.linkedSession(f.c,{...request,offset});assert.ok(Buffer.byteLength(JSON.stringify(page),'utf8')<=L.pageBytes);assert.equal(page.total,7);assert.ok(page.items.length>0);assert.equal(page.offset,offset);
  for(const row of page.items){assert.equal(row.data.content,content);all.push(row.id);}assert.equal(page.nextOffset,all.length<7?all.length:null);offset=page.nextOffset;pages++;
 }while(offset!==null);
 assert.ok(pages>1);assert.equal(all.length,7);assert.equal(new Set(all).size,7);
});

test('single oversized encoded message fails closed rather than silently shortening or skipping it',t=>{
 const f=fixture(t);f.message('escaped','\u0001'.repeat(65536));const before=f.hashes();
 rejects(()=>f.plans.linkedSession(f.c,f.request()),'RATE_LIMITED');assert.deepEqual(f.hashes(),before);
});

test('one bounded scan enforces cumulative row and UTF-8 byte budgets before publication',t=>{
 for(const mode of ['rows','bytes']){
  const f=fixture(t),count=mode==='rows'?L.scanRows:260,content=mode==='rows'?'Small manual record':'x'.repeat(65536);
  f.seed(Array.from({length:count},(_,i)=>[`bulk-${i}`,{sessionId:'s',role:'user',content,sequence:i+1}]));
  const original=f.store.readBounded.bind(f.store);let reads=0;
  f.store.readBounded=(ctx,budget,action,...rest)=>{reads++;assert.deepEqual(budget,{maxRows:L.scanRows,maxBytes:L.scanBytes});return original(ctx,budget,action,...rest);};
  const request={id:f.plan.id,expectedRevision:f.plan.revision,scope:f.scope(),sessionLink:f.plan.data.sessionLink};
  rejects(()=>f.plans.linkedSession(f.c,request),'RATE_LIMITED');assert.equal(reads,1);
 }
});

test('final publication recheck rejects changed plan or target after the bounded message read',t=>{
 for(const change of ['plan','session','workspace']){
  const f=fixture(t);f.message('one');const request=f.request(),original=f.store.readBounded.bind(f.store);let injected=false,reads=0;
  f.store.readBounded=(ctx,budget,action,...rest)=>{reads++;return original(ctx,budget,tx=>action({...tx,list(kind,...args){const rows=tx.list(kind,...args);if(kind==='message'&&!injected){injected=true;
   f.store.write(f.c,f.key(),{fixture:'publication-race'},write=>{const type=change==='plan'?'manual-research-plan':change,id=change==='plan'?f.plan.id:change==='session'?'s':'w',row=write.get(type,id);return write.update(type,id,row.revision,row.data);});
  }return rows;}}),...rest);};
  rejects(()=>f.plans.linkedSession(f.c,request),'CONFLICT');assert.equal(injected,true);assert.equal(reads,1);
 }
});

test('request cancellation and current principal/authority revocation cannot publish previously read messages',t=>{
 const f=fixture(t);f.message('one');const request=f.request();
 const controller=new AbortController(),cancelled={...f.c,signal:controller.signal};controller.abort();assert.throws(()=>f.plans.linkedSession(cancelled,request));
 const c=context();let allowed=true;bindRequestAuthority(c,()=>{if(!allowed)throw new AdapterError('FORBIDDEN','Synthetic revoked request');});
 const original=f.store.readBounded.bind(f.store);
 f.store.readBounded=(ctx,budget,action,...rest)=>original(ctx,budget,tx=>action({...tx,list(kind,...args){const rows=tx.list(kind,...args);if(kind==='message')allowed=false;return rows;}}),...rest);
 assert.throws(()=>f.plans.linkedSession(c,request));
});

test('final owner and persistent store-identity checks reject replacement after the bounded read returns',t=>{
 for(const change of ['owner','store-file']){
  const f=fixture(t),other=change==='store-file'?fixture(t):null;f.message('one');const request=f.request(),original=f.store.readBounded.bind(f.store);let reads=0;
  f.store.readBounded=(ctx,budget,action,...rest)=>{reads++;const result=original(ctx,budget,action,...rest);
   if(change==='owner')ctx.principal={...ctx.principal,subjectId:'replacement-owner'};
   else{const path=join(f.root,'data/local-workspace.sqlite');renameSync(path,path+'.old');copyFileSync(join(other.root,'data/local-workspace.sqlite'),path);}
   return result;
  };
  rejects(()=>f.plans.linkedSession(f.c,request),'PROVIDER_ERROR');assert.equal(reads,1);
 }
});

test('legacy ordinary strings remain exact; no manual-role/model metadata is treated as generated output',t=>{
 const f=fixture(t),w=f.workspace.update(f.c,{kind:'workspace',id:'w',expectedRevision:1,patch:{name:'Legacy\u0001workspace'},idempotencyKey:f.key()}),s=f.workspace.update(f.c,{kind:'session',id:'s',expectedRevision:1,patch:{title:'Legacy\uD800session',model:'Stored label\u0001'},idempotencyKey:f.key()});
 const linked=f.plans.setSessionLink(f.c,{...f.mutation(),scope:f.scope(),sessionLink:{...f.target,workspaceRevision:w.revision,sessionRevision:s.revision}});
 const content='Manual assistant-labelled content\uD800\u0001';f.message('legacy-text',content,'s','assistant');
 const result=f.plans.linkedSession(f.c,f.request({sessionLink:linked.data.sessionLink}));
 assert.equal(result.workspace.title,w.data.name);assert.equal(result.session.title,s.data.title);assert.equal(result.session.model,s.data.model);assert.equal(result.items[0].data.content,content);
});

test('only the single read route is admitted and the shared contract copies stay byte identical',()=>{
 const server=readFileSync(new URL('../backend/server.mjs',import.meta.url),'utf8');
 assert.match(server,/'manual-plans':new Set\(\[[^\]]*'linkedSession'/);
 assert.deepEqual(readFileSync(new URL('../candidate/shared/manual-plans.ts',import.meta.url)),readFileSync(new URL('../backend/source/shared/manual-plans.ts',import.meta.url)));
});
