// Original bounded runner, integrated here through the fixed local inventory adapter.
import {readInventory,validateScope} from './inventory-source.mjs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {validateScheduleCadence,nextScheduleOccurrence,previousScheduleOccurrence} from './cadence.mjs';
const KIND='document-inventory-snapshot';
const fail=code=>{throw Object.assign(new Error(code),{code})};
const plain=(v,keys)=>{if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).some(k=>!keys.includes(k)))fail('INVALID_REQUEST')};
const id=v=>{if(typeof v!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(v))fail('INVALID_ID');return v};
const integer=(v,min,max)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail('INVALID_NUMBER');return v};
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const capabilities=Object.freeze({handler:KIND,execution:'synthetic-opt-in-only',research:'unavailable',providers:'unavailable',network:'unavailable',externalEffects:'unavailable'});
export class LocalScheduler {
 constructor({filename,clock=Date.now,syntheticOnly=false,inventoryStorage=null}){
  if((syntheticOnly!==true&&inventoryStorage===null)||typeof filename!=='string'||!filename.endsWith('.scheduler.sqlite'))fail('EXPLICIT_ISOLATED_STORE_REQUIRED');
  this.inventoryStorage=inventoryStorage;this.clock=clock;this.db=new DatabaseSync(filename);this.closed=false;
  const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
  if(tables.length&&!tables.includes('local_scheduler_marker')){this.db.close();fail('FOREIGN_STORE_REFUSED')}
  this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  this.db.exec(`CREATE TABLE IF NOT EXISTS local_scheduler_marker(version INTEGER NOT NULL);`);
  const versions=this.db.prepare('SELECT version FROM local_scheduler_marker').all();
  if(versions.length&&(versions.length!==1||versions[0].version!==1)){this.db.close();fail('SCHEMA_VERSION_REFUSED')}
  if(!versions.length)this.db.exec('INSERT INTO local_scheduler_marker VALUES(1)');
  // Bind browser recovery to this database, not merely a reused localhost port.
  this.db.exec('CREATE TABLE IF NOT EXISTS local_scheduler_recovery_scope(id INTEGER PRIMARY KEY CHECK(id=1), scope TEXT NOT NULL)');
  this.db.prepare('INSERT OR IGNORE INTO local_scheduler_recovery_scope VALUES(1,?)').run(randomUUID());
  this.recoveryScope=this.db.prepare('SELECT scope FROM local_scheduler_recovery_scope WHERE id=1').get().scope;
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(this.recoveryScope)){this.db.close();fail('RECOVERY_SCOPE_REFUSED')}
  this.db.exec(`CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, command_key TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, definition TEXT NOT NULL, state TEXT NOT NULL, next_due INTEGER);
  CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,due INTEGER NOT NULL,state TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,ready INTEGER NOT NULL,token TEXT,deadline INTEGER,error TEXT, UNIQUE(schedule_id,due));
  CREATE TABLE IF NOT EXISTS results(run_id TEXT PRIMARY KEY,body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS attempts(run_id TEXT NOT NULL,attempt INTEGER NOT NULL,token TEXT NOT NULL,status TEXT NOT NULL,started INTEGER NOT NULL,ended INTEGER, PRIMARY KEY(run_id,attempt));`);
 }
 now(){return integer(this.clock(),0,4102444799999)}
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const out=fn();this.db.exec('COMMIT');return out}catch(e){this.db.exec('ROLLBACK');throw e}}
 create(input){
  plain(input,['id','idempotencyKey','handler','cadence','documents','maxAttempts','timeoutMs','retryMs','misfirePolicy','graceMs',...(this.inventoryStorage?['scope']:[])]);
  const scheduleId=id(input.id),key=id(input.idempotencyKey);
  if(input.handler!==KIND)fail('HANDLER_UNAVAILABLE');
  if(this.inventoryStorage&&Object.hasOwn(input,'documents'))fail('INVALID_REQUEST');
  const scope=this.inventoryStorage?validateScope(input.scope):null;
  if(this.inventoryStorage)input={...input,documents:[]};
  if(!Array.isArray(input.documents)||input.documents.length>1000)fail('INVALID_DOCUMENTS');
  const documents=input.documents.map(d=>{plain(d,['id','title','bytes']);id(d.id);if(typeof d.title!=='string'||Buffer.byteLength(d.title)>512)fail('INVALID_TITLE');integer(d.bytes,0,1000000000);return {id:d.id,title:d.title,bytes:d.bytes}}).sort((a,b)=>a.id.localeCompare(b.id));
  if(new Set(documents.map(d=>d.id)).size!==documents.length)fail('DUPLICATE_DOCUMENT');
  const definition={...(scope?{scope}:{}),handler:KIND,cadence:validateScheduleCadence(input.cadence),documents,maxAttempts:integer(input.maxAttempts??3,1,10),timeoutMs:integer(input.timeoutMs??1000,1,60000),retryMs:integer(input.retryMs??100,1,60000),misfirePolicy:input.misfirePolicy??'coalesce',graceMs:integer(input.graceMs??60000,0,86400000)};
  if(!['coalesce','skip'].includes(definition.misfirePolicy))fail('INVALID_MISFIRE');
  const fingerprint=digest({id:scheduleId,...definition});
  return this.tx(()=>{
   const previous=this.db.prepare('SELECT * FROM schedules WHERE command_key=?').get(key);
   if(previous){if(previous.fingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT');return this.schedule(previous.id)}
   if(this.db.prepare('SELECT count(*) n FROM schedules').get().n>=100)fail('SCHEDULE_QUOTA');
   // Explicit creation only. Once dates in the past are admitted as a misfire.
   const next=definition.cadence.kind==='once'?definition.cadence.at:nextScheduleOccurrence(definition.cadence,new Date(this.now()).toISOString(),true);
   this.db.prepare('INSERT INTO schedules VALUES(?,?,?,?,?,?)').run(scheduleId,key,fingerprint,JSON.stringify(definition),'active',next?Date.parse(next):null);
   this.finishSchedule(scheduleId);return this.schedule(scheduleId);
  });
 }
 schedule(scheduleId){const s=this.db.prepare('SELECT * FROM schedules WHERE id=?').get(id(scheduleId));if(!s)fail('NOT_FOUND');return {id:s.id,state:s.state,nextDue:s.next_due,definition:JSON.parse(s.definition)}}
 list(){return this.db.prepare('SELECT id FROM schedules ORDER BY id').all().map(s=>this.schedule(s.id))}
 runs(){return this.db.prepare('SELECT * FROM runs ORDER BY due,id').all()}
 result(runId){const r=this.db.prepare('SELECT body FROM results WHERE run_id=?').get(id(runId));return r?JSON.parse(r.body):null}
 state(scheduleId,state){id(scheduleId);if(!['active','paused','cancelled'].includes(state))fail('INVALID_STATE');return this.tx(()=>{
  const s=this.schedule(scheduleId);if(['cancelled','completed'].includes(s.state)&&s.state!==state)fail('TERMINAL_SCHEDULE');
  this.db.prepare('UPDATE schedules SET state=? WHERE id=?').run(state,scheduleId);
  if(state==='cancelled'){
   this.db.prepare("UPDATE attempts SET status='cancelled',ended=? WHERE run_id IN (SELECT id FROM runs WHERE schedule_id=? AND state='running') AND status='running'").run(this.now(),scheduleId);
   this.db.prepare("UPDATE runs SET state='cancelled',token=NULL,deadline=NULL WHERE schedule_id=? AND state IN ('queued','retry','running')").run(scheduleId);
  }if(state==='active')this.finishSchedule(scheduleId);return this.schedule(scheduleId);
 })}
 dispatch(){return this.tx(()=>{
  const now=this.now();let added=0,blocked=null;
  for(const s of this.db.prepare("SELECT * FROM schedules WHERE state='active' AND next_due<=? ORDER BY next_due,id LIMIT 100").all(now)){
   if(this.db.prepare('SELECT count(*) n FROM runs').get().n>=10000){blocked='run_quota';break}
   const d=JSON.parse(s.definition),late=now-s.next_due>d.graceMs;
   const due=d.misfirePolicy==='coalesce'?Math.max(s.next_due,Date.parse(previousScheduleOccurrence(d.cadence,new Date(now).toISOString())??new Date(s.next_due).toISOString())):s.next_due;
   this.db.prepare('INSERT OR IGNORE INTO runs(id,schedule_id,due,state,ready) VALUES(?,?,?,?,?)').run(randomUUID(),s.id,due,late&&d.misfirePolicy==='skip'?'skipped':'queued',now);added++;
   const next=nextScheduleOccurrence(d.cadence,new Date(now).toISOString());
   this.db.prepare('UPDATE schedules SET next_due=? WHERE id=?').run(next?Date.parse(next):null,s.id);
   this.finishSchedule(s.id);
  }return {admitted:added,blocked};
 })}
 recover(){return this.tx(()=>{for(const run of this.db.prepare("SELECT * FROM runs WHERE state='running' AND deadline<=?").all(this.now()))this.failInside(run,'timeout');})}
 failInside(run,reason){
  const d=this.schedule(run.schedule_id).definition,now=this.now(),state=run.attempt>=d.maxAttempts?'failed':'retry';
  this.db.prepare('UPDATE attempts SET status=?,ended=? WHERE run_id=? AND attempt=?').run(reason,now,run.id,run.attempt);
  this.db.prepare('UPDATE runs SET state=?,ready=?,token=NULL,deadline=NULL,error=? WHERE id=?').run(state,now+d.retryMs,reason,run.id);
  if(state==='failed')this.finishSchedule(run.schedule_id);
 }
 finishSchedule(scheduleId){
  const pending=this.db.prepare("SELECT count(*) n FROM runs WHERE schedule_id=? AND state IN ('queued','retry','running')").get(scheduleId).n;
  if(!pending)this.db.prepare("UPDATE schedules SET state='completed' WHERE id=? AND state='active' AND next_due IS NULL").run(scheduleId);
 }
 claim(){this.recover();return this.tx(()=>{
  const run=this.db.prepare("SELECT r.* FROM runs r JOIN schedules s ON s.id=r.schedule_id WHERE r.state IN ('queued','retry') AND r.ready<=? AND s.state='active' ORDER BY r.due,r.id LIMIT 1").get(this.now());
  if(!run)return null;const token=randomUUID(),attempt=run.attempt+1,deadline=this.now()+this.schedule(run.schedule_id).definition.timeoutMs;
  this.db.prepare("UPDATE runs SET state='running',attempt=?,token=?,deadline=? WHERE id=?").run(attempt,token,deadline,run.id);
  this.db.prepare("INSERT INTO attempts VALUES(?,?,?,'running',?,NULL)").run(run.id,attempt,token,this.now());
  return {...run,state:'running',attempt,token,deadline};
 })}
 execute(claim){
  // No plugin registration or caller-supplied executable code. The only side effect
  // is a result row in this transaction, atomically committed with completion.
  id(claim.id);id(claim.token);
  return this.tx(()=>{
   const run=this.db.prepare('SELECT * FROM runs WHERE id=?').get(claim.id);
   if(!run||run.state!=='running'||run.token!==claim.token)fail('STALE_CLAIM');
   if(this.now()>=run.deadline){this.failInside(run,'timeout');return {status:'timeout'}}
   const s=this.schedule(run.schedule_id);if(s.state!=='active')fail('SCHEDULE_NOT_ACTIVE');
   const documents=this.inventoryStorage?readInventory(this.inventoryStorage,s.definition.scope):s.definition.documents;
   const body={kind:KIND,synthetic:!this.inventoryStorage,...(this.inventoryStorage?{scope:s.definition.scope,capturedAt:new Date(this.now()).toISOString(),description:'Local document metadata inventory, not AI research generation'}:{}),scheduledAt:new Date(run.due).toISOString(),count:documents.length,totalBytes:documents.reduce((n,d)=>n+d.bytes,0),documents,sha256:digest(documents)};
   if(this.now()>=run.deadline){this.failInside(run,'timeout');return {status:'timeout'}}
   this.db.prepare('INSERT INTO results VALUES(?,?)').run(run.id,JSON.stringify(body));
   this.db.prepare("UPDATE runs SET state='completed',token=NULL,deadline=NULL,error=NULL WHERE id=?").run(run.id);
   this.db.prepare("UPDATE attempts SET status='completed',ended=? WHERE run_id=? AND attempt=?").run(this.now(),run.id,run.attempt);
   this.finishSchedule(run.schedule_id);return {status:'completed',result:body};
  });
 }
 tick(){const admission=this.dispatch();let count=0,claim;while(count<100&&(claim=this.claim())){this.execute(claim);count++}return {processed:count,admission}}
 async runBounded({durationMs=100,intervalMs=10,signal}={}){
  integer(durationMs,1,5000);integer(intervalMs,1,1000);
  const end=Date.now()+durationMs;let ticks=0,blocked=null;
  while(!signal?.aborted&&Date.now()<end){const outcome=this.tick();blocked=outcome.admission.blocked??blocked;ticks++;await new Promise(resolve=>setTimeout(resolve,Math.min(intervalMs,Math.max(1,end-Date.now()))))}
  return {ticks,blocked,stopped:signal?.aborted?'cancelled':'bounded-deadline'};
 }
 close(){if(!this.closed){this.db.close();this.closed=true}}
}
