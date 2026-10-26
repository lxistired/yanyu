// AUTHORED, NOT EXECUTED. Requires separately approved prepared backend runtime.
// All SQL mutations/fault injection below target newly generated temporary fixtures ONLY.
// Observer is explicitly injected: these tests make NO real researchDocuments coverage claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,chmodSync,renameSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const build=process.env.MANUAL_INVENTORY_BUILD;
assert.ok(build&&isAbsolute(build),'Set MANUAL_INVENTORY_BUILD to the separately admitted emitted runtime directory');
const load=p=>import(pathToFileURL(join(resolve(build),p)).href);
const {DomainStore}=await load('server/workspace-store.mjs');
const {ManualInventoryDomain,manualInventoryError}=await load('server/manual-inventory-domain.mjs');
const P=await load('shared/manual-inventory-protocol.mjs');
const hash=s=>createHash('sha256').update(s).digest('hex');
const protocol='manual-inventory-v1',identityScope='a'.repeat(64),documentStoreScope='10000000-0000-4000-8000-000000000001';
const time='2026-10-22T00:00:00.000Z',selection={mode:'all',workspaceId:null,folderId:null};
const principal=Object.freeze({tenantId:'fixture-tenant',subjectId:'fixture-owner',collectionIds:Object.freeze(['fixture-collection'])});
const ctx=()=>({principal,signal:new AbortController().signal,requestId:randomUUID()});
const row=Object.freeze({id:'20000000-0000-4000-8000-000000000001',name:'合成文档.txt',format:'txt',bytes:7,sha256:'b'.repeat(64),textSha256:'c'.repeat(64),createdAt:time,pages:null,workspaceId:null,folderId:null,revision:0});
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'manual-inventory-b-synthetic-'));
 let store=new DomainStore(root);const calls={observe:0,current:0,close:0,access:0,accessCheck:0,probe:0};
 const behavior={unavailable:false,denyAccess:false,finalError:null,rows:[row]};
 const observer={observe(context,input,budget){
  calls.observe++;assert.deepEqual(Object.keys(input).sort(),['documentStoreScope','selection']);
  if(behavior.unavailable)throw manualInventoryError('SOURCE_UNAVAILABLE');budget.check();
  const rows=Object.freeze([...behavior.rows]),inventoryDigest=hash(P.canonicalInventorySource(input.documentStoreScope,input.selection,rows));
  return Object.freeze({documentStoreScope:input.documentStoreScope,selection:input.selection,rows,inventoryDigest,observedAt:time,checkCurrent(){calls.current++;budget.check();if(behavior.finalError)throw manualInventoryError(behavior.finalError);},close(){calls.close++;}});
 },authorizeHistorical(context,input,budget){calls.access++;budget.check();if(behavior.denyAccess)throw manualInventoryError('RESULT_ACCESS_UNAVAILABLE');return {checkAccess(){calls.accessCheck++;budget.check();if(behavior.denyAccess)throw manualInventoryError('RESULT_ACCESS_UNAVAILABLE');},close(){calls.close++;}};}};
 const source={observer,probe(){calls.probe++;if(behavior.unavailable)return {available:false,documentStoreScope:null};return {available:true,documentStoreScope};}};
 const domain=()=>new ManualInventoryDomain(store,{identityScope,assertOwner(c){assert.equal(c.principal,principal);},source,now:()=>time,monotonicNow:()=>1});
 store.write(ctx(),'seed',{fixture:true},tx=>{tx.create('skill',{handler:'local-document-inventory',enabled:true},'skill');tx.create('schedule',{skillId:'skill',enabled:true,state:'active',sourceIds:[]},'schedule');return true;});
 const envelope=(overrides={})=>({protocol,operationId:randomUUID(),identityScope,automationStoreScope:store.manualInventoryIdentity(ctx()),documentStoreScope,scheduleId:'schedule',scheduleRevision:1,skillId:'skill',skillRevision:1,selection,inventoryDigest:hash(P.canonicalInventorySource(documentStoreScope,selection,behavior.rows)),...overrides});
 const counts=()=>({runs:Number(store.db.prepare("SELECT count(*) n FROM entities WHERE kind='schedule-run'").get().n),results:Number(store.db.prepare('SELECT count(*) n FROM manual_inventory_results').get().n),proofs:Number(store.db.prepare('SELECT count(*) n FROM manual_inventory_receipts').get().n)});
 t.after(()=>{try{store.close()}finally{rmSync(root,{recursive:true,force:true});}});
 return {root,get store(){return store;},domain,envelope,calls,behavior,counts,restart(){store.close();store=new DomainStore(root);return domain();}};
}
function faultExec(store,intercept){
 // Test-only fault seam: transpiled TS private fields are ordinary properties.
 const actual=store.db;store.db=new Proxy(actual,{get(target,key){if(key==='exec')return sql=>intercept(sql,()=>target.exec(sql));const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 return ()=>{store.db=actual;};
}
const thrownCode=code=>error=>error?.code===code;
const resultRequest=(request,proof)=>({protocol,identityScope:request.identityScope,automationStoreScope:request.automationStoreScope,runId:proof.runId,resultId:proof.resultId});
const historyRequest=(request,extra={})=>({protocol,identityScope,automationStoreScope:request.automationStoreScope,scheduleId:null,cursor:null,limit:25,...extra});

test('atomic real SQLite success: one immutable artifact, run and proof; metadata is only in artifact',t=>{
 const f=fixture(t),request=f.envelope(),proof=f.domain().execute(ctx(),request);
 assert.ok(P.parseManualInventoryProof(proof));assert.equal(proof.state,'committed');assert.deepEqual(f.counts(),{runs:1,results:1,proofs:1});
 const db=f.store.db,artifact=db.prepare('SELECT * FROM manual_inventory_results').get(),run=db.prepare("SELECT * FROM entities WHERE kind='schedule-run'").get();
 assert.equal(artifact.payload_bytes,Buffer.byteLength(artifact.payload_json));assert.equal(artifact.payload_sha256,hash(artifact.payload_json));assert.ok(P.parseManualInventoryResultPayload(JSON.parse(artifact.payload_json)));
 assert.ok(P.parseManualInventoryRunData(JSON.parse(run.data)));assert.equal(run.revision,1);assert.equal(run.deleted_at,null);
 assert.equal(run.data.includes(row.name),false);assert.equal(JSON.stringify(proof).includes(row.name),false);assert.equal(f.calls.observe,1);assert.equal(f.calls.current,1);assert.equal(f.calls.close,1);
 assert.equal(Number(db.prepare("SELECT count(*) n FROM entities WHERE kind='notification'").get().n),0);
});
test('exact replay and operation after source/definition removal do not observe or prepare',t=>{
 const f=fixture(t),request=f.envelope(),proof=f.domain().execute(ctx(),request),before={...f.calls};
 // Synthetic fixture tampering: simulate deleted definitions independently of observer.
 f.store.db.exec("DELETE FROM entities WHERE kind IN ('schedule','skill')");f.behavior.unavailable=true;
 assert.deepEqual(f.domain().operation(ctx(),request),proof);assert.deepEqual(f.domain().execute(ctx(),request),proof);assert.deepEqual(f.calls,before);
 const restarted=f.restart();assert.deepEqual(restarted.operation(ctx(),request),proof);assert.deepEqual(restarted.execute(ctx(),request),proof);assert.deepEqual(f.calls,before);
 assert.throws(()=>restarted.execute(ctx(),{...request,inventoryDigest:'d'.repeat(64)}),thrownCode('KEY_CONFLICT'));assert.deepEqual(f.counts(),{runs:1,results:1,proofs:1});
});
test('persisted deterministic rejection fences later repaired definition and remains source-free on replay',t=>{
 const f=fixture(t),request=f.envelope({scheduleRevision:2});const proof=f.domain().execute(ctx(),request);
 assert.equal(proof.state,'rejected');assert.equal(proof.code,'DEFINITION_CONFLICT');assert.deepEqual(f.counts(),{runs:0,results:0,proofs:1});assert.equal(f.calls.observe,0);
 f.store.db.exec("UPDATE entities SET revision=2 WHERE kind='schedule'");assert.deepEqual(f.domain().execute(ctx(),request),proof);assert.equal(f.calls.observe,0);
 assert.deepEqual(f.restart().operation(ctx(),request),proof);
});
test('final deterministic refusal rolls back staged run/artifact before persisting rejection',t=>{
 const f=fixture(t),request=f.envelope();f.behavior.finalError='INVENTORY_CHANGED';const proof=f.domain().execute(ctx(),request);
 assert.equal(proof.state,'rejected');assert.equal(proof.code,'INVENTORY_CHANGED');assert.deepEqual(f.counts(),{runs:0,results:0,proofs:1});assert.equal(f.calls.close,1);
});
test('nondeterministic failure and rollback-to-savepoint failure never mint rejection',t=>{
 const f=fixture(t),request=f.envelope();f.behavior.finalError='SOURCE_UNAVAILABLE';assert.throws(()=>f.domain().execute(ctx(),request));assert.deepEqual(f.counts(),{runs:0,results:0,proofs:0});
 f.behavior.finalError='INVENTORY_CHANGED';const restore=faultExec(f.store,(sql,run)=>{if(sql==='ROLLBACK TO inventory_command')throw new Error('synthetic rollback failure');return run();});
 try{assert.throws(()=>f.domain().execute(ctx(),request));}finally{restore();}
 assert.deepEqual(f.counts(),{runs:0,results:0,proofs:0});assert.equal(f.domain().operation(ctx(),request).state,'absent');
});
for(const afterCommit of [false,true])test(`attempted COMMIT throws ${afterCommit?'after durable side effect':'before side effect'}: never negative fallback`,t=>{
 const f=fixture(t),request=f.envelope();let commits=0,negativeRollback=0;
 const restore=faultExec(f.store,(sql,run)=>{if(sql==='ROLLBACK TO inventory_command')negativeRollback++;if(sql==='COMMIT'){commits++;if(afterCommit)run();throw manualInventoryError('INVENTORY_CHANGED');}return run();});
 try{assert.throws(()=>f.domain().execute(ctx(),request));}finally{restore();}
 assert.equal(commits,1);assert.equal(negativeRollback,0);assert.deepEqual(f.counts(),afterCommit?{runs:1,results:1,proofs:1}:{runs:0,results:0,proofs:0});
 const outcome=f.domain().operation(ctx(),request);assert.equal(outcome.state,afterCommit?'committed':'absent');
 assert.equal(Number(f.store.db.prepare("SELECT count(*) n FROM manual_inventory_receipts WHERE state='rejected'").get().n),0);
});
test('rejection COMMIT failure after side effect is uncertain, later exact lookup recovers only actual proof',t=>{
 const f=fixture(t),request=f.envelope({scheduleRevision:99});let commits=0;
 const restore=faultExec(f.store,(sql,run)=>{if(sql==='COMMIT'){commits++;run();throw new Error('synthetic postcommit transport failure');}return run();});
 try{assert.throws(()=>f.domain().execute(ctx(),request));}finally{restore();}
 assert.equal(commits,1);assert.equal(f.domain().operation(ctx(),request).state,'rejected');assert.deepEqual(f.counts(),{runs:0,results:0,proofs:1});
});
test('history and proof remain committed when historical result access fails; publication rechecks access',t=>{
 const f=fixture(t),request=f.envelope(),proof=f.domain().execute(ctx(),request),d=f.domain();
 const held=d.result(ctx(),resultRequest(request,proof));assert.ok(P.parseManualInventoryResultPayload(JSON.parse(held.encoded)));
 f.behavior.denyAccess=true;try{assert.throws(()=>held.publish(),thrownCode('RESULT_ACCESS_UNAVAILABLE'));}finally{held.close();}
 assert.throws(()=>d.result(ctx(),resultRequest(request,proof)),thrownCode('RESULT_ACCESS_UNAVAILABLE'));assert.deepEqual(d.operation(ctx(),request),proof);
 const history=d.history(ctx(),historyRequest(request));assert.equal(history.items.length,1);assert.equal(history.items[0].resultAccess,'not-checked');assert.equal(history.items[0].runId,proof.runId);assert.equal(JSON.stringify(history).includes(row.name),false);
});
test('dedicated history cursor uses equal-time UUID descending and deleted-definition exact history',t=>{
 const f=fixture(t),request=f.envelope();const proofs=Array.from({length:3},()=>f.domain().execute(ctx(),{...request,operationId:randomUUID()}));
 f.store.db.exec("DELETE FROM entities WHERE kind IN ('skill','schedule')");const d=f.domain(),first=d.history(ctx(),historyRequest(request,{scheduleId:'schedule',limit:2}));
 const second=d.history(ctx(),historyRequest(request,{scheduleId:'schedule',cursor:first.nextCursor,limit:2}));
 assert.deepEqual([...first.items,...second.items].map(x=>x.runId),proofs.map(x=>x.runId).sort().reverse());assert.equal(second.nextCursor,null);
 assert.deepEqual(d.history(ctx(),historyRequest(request,{scheduleId:'missing'})).items,[]);
});
test('corrupt bounded persisted proof/payload metadata fail closed without reexecution',t=>{
 const f=fixture(t),request=f.envelope(),proof=f.domain().execute(ctx(),request),calls=f.calls.observe;
 // Synthetic corruption, not a production update API.
 f.store.db.prepare('UPDATE manual_inventory_results SET payload_bytes=1').run();assert.throws(()=>f.domain().result(ctx(),resultRequest(request,proof)),thrownCode('RESULT_ACCESS_UNAVAILABLE'));
 f.store.db.prepare("UPDATE manual_inventory_receipts SET proof_json=CAST(zeroblob(2049) AS TEXT)").run();assert.throws(()=>f.domain().execute(ctx(),request));assert.equal(f.calls.observe,calls);assert.equal(f.counts().runs,1);
});
function legacyWriter(f,family,key){
 const action=tx=>tx.create('workspace',{name:'synthetic quota probe'},key),input={idempotencyKey:key},prepare=()=>({request:input,action});
 if(family==='generic')return f.store.write(ctx(),key,input,action);
 const spec={workspace:['writeWorkspaceCommand','workspace.create'],organization:['writeOrganizationCommand','organization.create'],automation:['writeAutomationDefinitionCommand','automation.createSkill']}[family];
 return f.store[spec[0]](ctx(),key,spec[1],input,prepare,()=>false);
}
for(const family of ['generic','workspace','organization','automation'])test(`${family} writer counts new artifacts in shared global row cap`,t=>{
 const f=fixture(t),request=f.envelope();f.domain().execute(ctx(),request);
 // Fixture SQL creates 9996 synthetic non-sensitive rows: 9999 entities + 1 result = 10000.
 f.store.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<9996)
 INSERT INTO entities SELECT 'fixture-tenant','fixture-owner','workspace','filler-'||x,1,'${time}','${time}',NULL,'{}' FROM n`);
 assert.throws(()=>legacyWriter(f,family,`quota-${family}`),thrownCode('RATE_LIMITED'));
 assert.equal(Number(f.store.db.prepare("SELECT count(*) n FROM entities WHERE id=?").get(`quota-${family}`).n),0);
 assert.throws(()=>f.domain().execute(ctx(),f.envelope()),thrownCode('RATE_LIMITED'));assert.equal(f.counts().proofs,1);
});
test('legacy and manual receipt counts share global command capacity',t=>{
 const f=fixture(t);f.domain().execute(ctx(),f.envelope());
 // One seed legacy + one manual receipt + 49998 fixture legacy rows = 50000.
 f.store.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<49998)
 INSERT INTO commands SELECT 'fixture-tenant','fixture-owner','filler-'||x,'fixture','null' FROM n`);
 assert.throws(()=>legacyWriter(f,'generic','overflow'),thrownCode('RATE_LIMITED'));assert.throws(()=>f.domain().execute(ctx(),f.envelope()),thrownCode('RATE_LIMITED'));assert.equal(f.counts().proofs,1);
});
test('manual per-owner artifact and receipt ceilings never evict existing rows',t=>{
 const f=fixture(t);
 // Bounded synthetic fixture setup supplies 1000 artifact rows; no payload is user-originated.
 f.store.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000)
 INSERT INTO manual_inventory_results SELECT 'fixture-tenant','fixture-owner','fixture-result-'||x,'fixture-run-'||x,'{}','${'a'.repeat(64)}',2 FROM n`);
 assert.throws(()=>f.domain().execute(ctx(),f.envelope()),thrownCode('RATE_LIMITED'));assert.equal(f.counts().results,1000);assert.equal(f.counts().proofs,0);
 f.store.db.exec('DELETE FROM manual_inventory_results');
 f.store.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000)
 INSERT INTO manual_inventory_receipts SELECT 'fixture-tenant','fixture-owner','fixture-op-'||x,'${'a'.repeat(64)}','rejected','{}' FROM n`);
 assert.throws(()=>f.domain().execute(ctx(),f.envelope()),thrownCode('RATE_LIMITED'));assert.equal(f.counts().proofs,5000);assert.equal(f.counts().results,0);
});
test('legacy writers account actual new-family payload bytes, not declared payload_bytes',t=>{
 const f=fixture(t);
 // Deliberate synthetic corruption creates exactly 128 MiB of SQL-generated text;
 // total with ordinary rows already exceeds the ceiling. No giant JS string is allocated.
 f.store.db.prepare('INSERT INTO manual_inventory_results VALUES(?,?,?,?,CAST(zeroblob(?) AS TEXT),?,1)').run(principal.tenantId,principal.subjectId,'fixture-large-result','fixture-large-run',128*1024*1024,'a'.repeat(64));
 for(const family of ['generic','workspace','organization','automation'])assert.throws(()=>legacyWriter(f,family,`bytes-${family}`),thrownCode('RATE_LIMITED'));
 assert.throws(()=>f.domain().execute(ctx(),f.envelope()),thrownCode('RATE_LIMITED'));assert.equal(f.counts().proofs,0);
});
test('additive migration preserves base pragmas and store identity across reopen',t=>{
 const f=fixture(t),scope=f.store.manualInventoryIdentity(ctx()),app=f.store.db.prepare('PRAGMA application_id').get().application_id,version=f.store.db.prepare('PRAGMA user_version').get().user_version;
 f.restart();assert.equal(f.store.manualInventoryIdentity(ctx()),scope);assert.equal(f.store.db.prepare('PRAGMA application_id').get().application_id,app);assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version,version);
});
for(const corruption of ['partial','version','identity','unique','trigger'])test(`conflicting startup feature schema fails closed: ${corruption}`,t=>{
 const root=mkdtempSync(join(tmpdir(),'manual-inventory-b-schema-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const store=new DomainStore(root);store.close();
 const db=new DatabaseSync(join(root,'data/local-workspace.sqlite'));
 try{
  if(corruption==='partial')db.exec('DROP TABLE manual_inventory_receipts');
  if(corruption==='version')db.exec('UPDATE manual_inventory_feature SET version=2');
  if(corruption==='identity')db.exec("UPDATE manual_inventory_feature SET store_scope='bad'");
  if(corruption==='unique')db.exec('DROP TABLE manual_inventory_results;CREATE TABLE manual_inventory_results(tenant TEXT NOT NULL,owner TEXT NOT NULL,result_id TEXT NOT NULL,run_id TEXT NOT NULL,payload_json TEXT NOT NULL,payload_sha256 TEXT NOT NULL,payload_bytes INTEGER NOT NULL,PRIMARY KEY(tenant,owner,result_id)) STRICT;');
  if(corruption==='trigger')db.exec('CREATE TRIGGER synthetic_bad_trigger AFTER INSERT ON manual_inventory_receipts BEGIN DELETE FROM manual_inventory_results; END;');
 }finally{db.close();}
 assert.throws(()=>new DomainStore(root));
});

test('migration from generated legacy-v53-only schema preserves existing rows and old receipt bytes',t=>{
 const root=mkdtempSync(join(tmpdir(),'manual-inventory-b-legacy-'));mkdirSync(join(root,'data'),{mode:0o700});
 const path=join(root,'data/local-workspace.sqlite');let store;
 t.after(()=>{try{store?.close()}finally{rmSync(root,{recursive:true,force:true});}});
 const legacy=new DatabaseSync(path);
 try{
  legacy.exec(`CREATE TABLE entities(tenant TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, data TEXT NOT NULL, PRIMARY KEY(tenant,owner,kind,id)) STRICT;
   CREATE TABLE commands(tenant TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(tenant,owner,key)) STRICT;
   PRAGMA user_version=1;`);
  // Application ID below is the exact baseline DomainStore constant, not a new marker.
  legacy.exec(`PRAGMA application_id=${0x4f524457}`);
  legacy.prepare('INSERT INTO entities VALUES(?,?,?,?,1,?,?,NULL,?)').run(principal.tenantId,principal.subjectId,'workspace','legacy-workspace',time,time,'{"name":"synthetic legacy"}');
  legacy.prepare('INSERT INTO commands VALUES(?,?,?,?,?)').run(principal.tenantId,principal.subjectId,'legacy-command','fixture-fingerprint','{"preserved":true}');
  assert.equal(Number(legacy.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'manual_inventory_%'").get().n),0);
 }finally{legacy.close();chmodSync(path,0o600);}
 store=new DomainStore(root);const scope=store.manualInventoryIdentity(ctx());assert.match(scope,/^[a-f0-9-]{36}$/);
 assert.equal(store.db.prepare('SELECT data FROM entities WHERE id=?').get('legacy-workspace').data,'{"name":"synthetic legacy"}');
 assert.equal(store.db.prepare('SELECT result FROM commands WHERE key=?').get('legacy-command').result,'{"preserved":true}');
 assert.equal(store.db.prepare('PRAGMA application_id').get().application_id,0x4f524457);assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,1);
 assert.equal(Number(store.db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name LIKE 'manual_inventory_%'").get().n),3);
 store.close();store=new DomainStore(root);assert.equal(store.manualInventoryIdentity(ctx()),scope);
});
for(const mutation of ['identity-row','path-inode'])test(`all manual gates fail closed after live automation ${mutation} replacement`,t=>{
 const f=fixture(t),request=f.envelope(),d=f.domain(),proof=d.execute(ctx(),request),before={...f.calls};
 if(mutation==='identity-row')f.store.db.prepare('UPDATE manual_inventory_feature SET store_scope=?').run(randomUUID());
 else {
  // Test-only replacement preserves bytes/UUID but changes the path's inode.
  const path=join(f.root,'data/local-workspace.sqlite');renameSync(path,path+'.replaced');copyFileSync(path+'.replaced',path);chmodSync(path,0o600);
 }
 const {operationId,inventoryDigest,...preview}=request;
 for(const action of [()=>d.capabilities(ctx(),{protocol}),()=>d.preview(ctx(),preview),()=>d.execute(ctx(),request),()=>d.operation(ctx(),request),()=>d.history(ctx(),historyRequest(request)),()=>d.result(ctx(),resultRequest(request,proof))])assert.throws(action);
 assert.deepEqual(f.calls,before);assert.deepEqual(f.counts(),{runs:1,results:1,proofs:1});
});
test('fresh automation instance rejects old envelope rather than recreating old operation',t=>{
 const old=fixture(t),request=old.envelope(),proof=old.domain().execute(ctx(),request),fresh=fixture(t),d=fresh.domain();
 assert.notEqual(fresh.store.manualInventoryIdentity(ctx()),request.automationStoreScope);
 for(const action of [()=>d.execute(ctx(),request),()=>d.operation(ctx(),request),()=>d.history(ctx(),historyRequest(request)),()=>d.result(ctx(),resultRequest(request,proof))])assert.throws(action);
 assert.equal(fresh.calls.observe,0);assert.deepEqual(fresh.counts(),{runs:0,results:0,proofs:0});
});
