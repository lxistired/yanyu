import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {InventoryRecovery, recoveryKey, matchesInventoryCommand} from '../visual-harness/inventory-recovery.mjs';
import {inventoryScheduler} from '../backend/inventory-scheduler.mjs';
const scope = '33333333-3333-4333-8333-333333333333', other = '44444444-4444-4444-8444-444444444444';
const id = '11111111-1111-4111-8111-111111111111';
const draft = () => ({kind: 'once', delay: '15', time: '09:00', timezone: 'UTC', weekdays: [1], workspace: '', folder: ''});
const command = () => ({id, idempotencyKey: id, handler: 'document-inventory-snapshot', scope: {workspaceId: null, folderId: null}, cadence: {kind: 'once', at: '2026-10-17T12:00:15.000Z', timezone: 'UTC'}});
const saved = c => ({id: c.id, state: 'active', definition: {handler: c.handler, scope: c.scope, cadence: c.cadence}});
function memory() {const map = new Map(); return {map, getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,v), removeItem: k => map.delete(k)};}
function fixture() {const storage = memory(), journal = new InventoryRecovery(storage, scope, draft()); return {storage, journal};}
test('empty read is side-effect free and incomplete inputs survive a fresh instance', () => {
 const {storage,journal} = fixture(); assert.equal(storage.map.size,0);
 const incomplete = {...draft(),kind:'weekly',delay:'',time:'',timezone:'Not/Finished',weekdays:[],workspace:'missing-workspace'};
 journal.edit(incomplete); const reloaded=new InventoryRecovery(storage,scope,draft());
 assert.equal(reloaded.restored,true); assert.deepEqual(reloaded.snapshot(),{draft:incomplete,pending:null});
});
test('scope is database-specific and another namespace never restores the old draft', () => {
 const {storage,journal}=fixture(); journal.edit({...draft(),delay:'37'});
 assert.equal(new InventoryRecovery(storage,other,draft()).snapshot().draft.delay,'15');
 assert.notEqual(recoveryKey(scope),recoveryKey(other)); assert.throws(()=>recoveryKey('localhost'));
});
test('write-ahead command survives reload byte-for-byte and is always treated as uncertain', () => {
 const {storage,journal}=fixture(), original=command(); journal.begin(original);
 assert.equal(journal.snapshot().pending.uncertain,false);
 const pending=new InventoryRecovery(storage,scope,draft()).snapshot().pending;
 assert.deepEqual(pending.command,original); assert.equal(pending.uncertain,true);
 assert.deepEqual(journal.begin({...original,id:other,idempotencyKey:other}).pending.command,original);
 assert.throws(()=>journal.edit({...draft(),delay:'60'}),/先确认/); assert.throws(()=>journal.discard(draft()),/不能直接清除/);
});
test('no new command can be exposed when the write-ahead write fails', () => {
 const {storage,journal}=fixture(); storage.setItem=()=>{throw Error('quota');};
 assert.throws(()=>journal.begin(command()),/quota/); assert.equal(journal.snapshot().pending,null);
});
test('silent storage write loss is detected before dispatch', () => {
 const {storage,journal}=fixture(); storage.setItem=()=>{};
 assert.throws(()=>journal.begin(command()),/未保留/); assert.equal(journal.snapshot().pending,null);
});
test('first definite rejection unlocks a draft, uncertain or restored outcomes cannot be discarded', () => {
 const {storage,journal}=fixture(); journal.begin(command()); journal.rejectFirst(); assert.equal(journal.snapshot().pending,null);
 journal.begin(command()); journal.markUncertain(); journal.rejectFirst(); assert(journal.snapshot().pending);
 const fresh=new InventoryRecovery(storage,scope,draft()); fresh.rejectFirst(); assert(fresh.snapshot().pending);
});
test('exact acknowledged command clears pending; a successful read does not alter input preferences', () => {
 const {storage,journal}=fixture(); journal.edit({...draft(),delay:'27'}); journal.begin(command()); journal.confirm(saved(command()));
 const reload=new InventoryRecovery(storage,scope,draft()); assert.equal(reload.snapshot().pending,null); assert.equal(reload.snapshot().draft.delay,'27');
});
test('wrong id, scope, cadence, state or handler cannot acknowledge a pending operation', () => {
 const {journal}=fixture(); journal.begin(command()); const s=saved(command());
 for(const invalid of [{...s,id:other},{...s,state:'unknown'},{...s,definition:{...s.definition,handler:'other'}},{...s,definition:{...s.definition,scope:{workspaceId:'other',folderId:null}}},{...s,definition:{...s.definition,cadence:{...s.definition.cadence,at:'2026-10-17T12:01:00.000Z'}}},null]) {
  assert.equal(matchesInventoryCommand(invalid,command()),false); assert.throws(()=>journal.confirm(invalid),/不一致/); assert(journal.snapshot().pending);
 }
});
test('failed acknowledgement cleanup retains retryable operation', () => {
 const {storage,journal}=fixture(); journal.begin(command()); storage.setItem=()=>{throw Error('disk full');};
 assert.throws(()=>journal.confirm(saved(command())),/disk full/); assert(journal.snapshot().pending);
 assert(new InventoryRecovery(storage,scope,draft()).snapshot().pending);
});
test('explicit discard clears an unsubmitted draft but does not touch another scope', () => {
 const {storage,journal}=fixture(); journal.edit({...draft(),delay:'27'}); storage.setItem(recoveryKey(other),'unrelated'); journal.discard(draft());
 assert.equal(storage.getItem(recoveryKey(scope)),null); assert.equal(storage.getItem(recoveryKey(other)),'unrelated');
});
test('malformed, oversized, future-version, mismatched-scope and extra-field entries remain untouched', () => {
 const envelope={version:1,scope,draft:draft(),pending:null};
 for(const raw of ['{broken',' '.repeat(16385),JSON.stringify({...envelope,version:2}),JSON.stringify({...envelope,scope:other}),JSON.stringify({...envelope,token:'not allowed'}),JSON.stringify({...envelope,draft:{...draft(),weekdays:[1,1]}})]) {
  const storage=memory();storage.setItem(recoveryKey(scope),raw);assert.throws(()=>new InventoryRecovery(storage,scope,draft()));assert.equal(storage.getItem(recoveryKey(scope)),raw);
 }
});
test('invalid and unexpected commands are rejected without recording them', () => {
 const {journal}=fixture();
 for(const c of [{...command(),idempotencyKey:other},{...command(),token:'not allowed'},{...command(),scope:{workspaceId:null,folderId:'bad'}},{...command(),cadence:{kind:'once',at:'tomorrow',timezone:'UTC'}}]) assert.throws(()=>journal.begin(c));
 assert.equal(journal.snapshot().pending,null);
});
test('snapshots and input objects cannot mutate the retained command', () => {
 const {journal}=fixture(),c=command();journal.begin(c);c.cadence.at='changed';const snapshot=journal.snapshot();snapshot.pending.command.scope.workspaceId='other';assert.deepEqual(journal.snapshot().pending.command,command());
});
function backend(t) {const directory=mkdtempSync(join(tmpdir(),'yanyu-recovery-test-'));let adapter=inventoryScheduler(directory);t.after(()=>{adapter.close();rmSync(directory,{recursive:true,force:true});});return {directory,get adapter(){return adapter;},restart(){adapter.close();adapter=inventoryScheduler(directory);}};}
async function invoke(adapter,method,path,body,header) {
 const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.method=method;req.url='/api/local-scheduler/'+path;req.headers={...(body===undefined?{}:{'content-type':'application/json'}),...(header===undefined?{}:{'x-yanyu-recovery-scope':header})};
 let result;assert.equal(await adapter.handle(req,(status,value)=>result={status,value},(status,code,message)=>result={status,value:{error:{code,message}}}),true);return result;
}
test('database recovery scope survives process-style reopen and differs between stores', async t => {
 const a=backend(t),b=backend(t),first=(await invoke(a.adapter,'GET','capabilities')).value.recoveryScope;
 assert.notEqual(first,b.adapter.engine.recoveryScope);a.restart();assert.equal(a.adapter.engine.recoveryScope,first);
});
test('mismatched scope rejects a create without a schedule and exact scope permits idempotent replay', async t => {
 const f=backend(t),bound=f.adapter.engine.recoveryScope;
 assert.equal((await invoke(f.adapter,'POST','schedules',command(),other)).status,409);assert.equal(f.adapter.engine.list().length,0);
 assert.equal((await invoke(f.adapter,'POST','schedules',command(),bound)).status,200);assert.equal((await invoke(f.adapter,'POST','schedules',command(),bound)).status,200);assert.equal(f.adapter.engine.list().length,1);
});
test('journal plus SQLite lost-response/reopen/replay yields exactly one schedule', async t => {
 const f=backend(t),store=memory(),bound=f.adapter.engine.recoveryScope,j=new InventoryRecovery(store,bound,draft());
 j.begin(command());const first=await invoke(f.adapter,'POST','schedules',j.snapshot().pending.command,bound);assert.equal(first.status,200);
 f.restart();const reloaded=new InventoryRecovery(store,bound,draft());const replay=await invoke(f.adapter,'POST','schedules',reloaded.snapshot().pending.command,bound);reloaded.confirm(replay.value);
 assert.equal(f.adapter.engine.list().length,1);assert.equal(reloaded.snapshot().pending,null);
});
test('legacy clients remain supported and stale scoped state changes cannot mutate plans', async t => {
 const f=backend(t);assert.equal((await invoke(f.adapter,'POST','schedules',command())).status,200);
 assert.equal((await invoke(f.adapter,'POST','state',{id,state:'cancelled'},other)).status,409);assert.equal(f.adapter.engine.list()[0].state,'active');
});
test('retained display fields must match the exact pending request', () => {
 const {storage,journal}=fixture();journal.begin(command());const raw=JSON.parse(storage.getItem(recoveryKey(scope)));
 for(const patch of [{workspace:'other'},{kind:'daily'},{timezone:'Asia/Shanghai'},{delay:''}]) {
  const bad=JSON.stringify({...raw,draft:{...raw.draft,...patch}});storage.setItem(recoveryKey(scope),bad);
  assert.throws(()=>new InventoryRecovery(storage,scope,draft()));assert.equal(storage.getItem(recoveryKey(scope)),bad);
 }
});
test('read-only reconciliation with a stale database scope cannot disclose or acknowledge another store', async t => {
 const f=backend(t);await invoke(f.adapter,'POST','schedules',command());
 const result=await invoke(f.adapter,'GET','schedules',undefined,other);
 assert.equal(result.status,409);assert.equal(result.value.error.code,'RECOVERY_SCOPE_CONFLICT');assert(!JSON.stringify(result).includes(id));
});
