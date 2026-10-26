// Fresh synthetic fixtures only. Retains temporary evidence; never deletes user data.
import assert from 'node:assert/strict';
import {fork,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {request as httpRequest} from 'node:http';
import {stripTypeScriptTypes} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Readable} from 'node:stream';
import {inventoryScheduler,INVENTORY_ROUTES} from './inventory-scheduler.mjs';
import {researchDocuments} from './research-documents.mjs';
import {LocalScheduler} from '../scheduler/runner.mjs';
import {readInventory,validateScope} from '../scheduler/inventory-source.mjs';

const here=import.meta.dirname;
const base=Date.parse('2026-10-15T12:00:00.000Z');
const hash=value=>createHash('sha256').update(value).digest('hex');
const snapshotHash=value=>hash(JSON.stringify(value));
const root=mkdtempSync(join(tmpdir(),'yanyu-inventory-contract-'));
const evidence=join(here,'../inventory-evidence/TEST_RESULT.json');
mkdirSync(dirname(evidence),{recursive:true});
const checks=[],failures=[],fixtures=[],pids=[];
const workspaces=new Map([['synthetic-a',{id:'synthetic-a',data:{name:'合成工作区 A'}}],['synthetic-b',{id:'synthetic-b',data:{name:'Synthetic workspace B'}}]]);
const workspace={get(kind,id){const item=workspaces.get(id);if(!item)throw Object.assign(Error('Missing synthetic workspace'),{code:'NOT_FOUND'});return item},list(){return [...workspaces.values()]}};
const command=(id='inventory-once',extra={})=>({id,idempotencyKey:'create-'+id,handler:'document-inventory-snapshot',scope:{workspaceId:null,folderId:null},cadence:{kind:'once',at:new Date(base).toISOString(),timezone:'UTC'},...extra});

function fixture(label,{documents=true}={}){
 const storage=mkdtempSync(join(root,label+'-'));let now=base-1000;
 const documentsApp=documents?researchDocuments(storage,workspace):null;
 const app=inventoryScheduler(storage);app.engine.clock=()=>now;
 const value={storage,app,documents:documentsApp,set(value){now=value},close(){app.close();documentsApp?.close()}};
 fixtures.push(value);return value;
}
async function request(target,method,url,data,headers={}){
 const bytes=Buffer.isBuffer(data)?data:Buffer.from(data===undefined?'':JSON.stringify(data));
 const req=Readable.from([bytes]);req.method=method;req.url=url;
 req.headers={'content-type':Buffer.isBuffer(data)?'application/octet-stream':'application/json',...headers};
 let result,calls=0;const record=value=>{result=value;calls++};
 const handled=await target.handle(req,(status,body)=>record({status,body}),(status,code,message)=>record({status,body:{error:{code,message}}}));
 if(!handled){assert.equal(calls,0);return {handled:false}}
 assert.equal(calls,1,`${method} ${url} must respond exactly once`);return result;
}
async function expect(target,method,path,data,status=200,headers={}){
 const result=await request(target,method,path,data,headers);assert.equal(result.status,status,`${method} ${path}: ${JSON.stringify(result)}`);return result.body;
}
const api='/api/local-scheduler';
const create=(f,input)=>expect(f.app,'POST',api+'/schedules',input);
const state=(f,id,state,status=200)=>expect(f.app,'POST',api+'/state',{id,state},status);
async function folder(f,name,workspaceId){return (await expect(f.documents,'POST','/api/documents/folders',{name,workspaceId},201)).folder}
async function upload(f,name,bytes,association={}){return (await expect(f.documents,'POST','/api/documents/upload?'+new URLSearchParams({name,...association}),bytes,201)).document}
async function metadata(f,doc,extra){return (await expect(f.documents,'PUT','/api/documents/'+doc.id+'/metadata',{name:doc.name,workspaceId:doc.workspaceId,folderId:doc.folderId,revision:doc.revision,...extra})).document}
function readDb(storage,filename,fn){const db=new DatabaseSync(join(storage,filename),{readOnly:true});try{return fn(db)}finally{db.close()}}
function documentState(f){return readDb(f.storage,'research-documents.sqlite',db=>JSON.stringify({documents:db.prepare('SELECT * FROM research_documents ORDER BY id').all(),folders:db.prepare('SELECT * FROM document_folders ORDER BY id').all()}))}
function counts(f){return readDb(f.storage,'inventory.scheduler.sqlite',db=>Object.fromEntries(['schedules','runs','results','attempts'].map(name=>[name,db.prepare('SELECT count(*) n FROM '+name).get().n])))}
async function check(name,fn){try{await fn();checks.push(name);console.log('PASS '+name)}catch(error){failures.push({name,message:error.message,stack:error.stack});console.error('FAIL '+name+'\n'+error.stack)}}

await check('exact six-route manifest, local-only capabilities, and unrelated-route pass-through',async()=>{
 const f=fixture('route-manifest');
 assert.deepEqual(INVENTORY_ROUTES,[`GET ${api}/capabilities`,`GET ${api}/schedules`,`POST ${api}/schedules`,`POST ${api}/state`,`GET ${api}/runs`,`GET ${api}/result`]);
 const cap=await expect(f.app,'GET',api+'/capabilities');
 assert.equal(cap.handler,'document-inventory-snapshot');assert.equal(cap.execution,'local-app-process-only');
 for(const key of ['research','providers','network','externalEffects'])assert.equal(cap[key],'unavailable');
 assert.deepEqual(cap.limits,{schedules:100,runs:10000,documents:250,tickMs:1000});
 assert.equal(cap.lastError,null);assert.equal(cap.admission,null);
 assert.deepEqual(await expect(f.app,'GET',api+'/schedules'),[]);assert.deepEqual(await expect(f.app,'GET',api+'/runs'),[]);
 assert.deepEqual(await request(f.app,'GET','/api/documents'),{handled:false});
});

await check('snapshot reads current name hashes folder workspace revision and active membership only at execution',async()=>{
 const f=fixture('read-at-execution');
 const a=await folder(f,'Original folder A','synthetic-a'),b=await folder(f,'合成资料 B','synthetic-b');
 const contents=Buffer.from('SYNTHETIC_CONTENT_MUST_NOT_APPEAR_78e9 🌿\r\n');
 let moved=await upload(f,'before.txt',contents,{workspaceId:'synthetic-a',folderId:a.id});
 const removed=await upload(f,'will-be-trashed.txt',Buffer.from('TRASH_CONTENT_MARKER_6d1'),{workspaceId:'synthetic-a',folderId:a.id});
 const other=await upload(f,'other.md',Buffer.from('Synthetic second active source'),{workspaceId:'synthetic-b',folderId:b.id});
 const input=command('all');await create(f,input);
 await create(f,command('workspace-b',{scope:{workspaceId:'synthetic-b',folderId:null}}));
 await create(f,command('folder-b',{scope:{workspaceId:null,folderId:b.id}}));
 await create(f,command('empty-a',{scope:{workspaceId:'synthetic-a',folderId:a.id}}));
 assert.equal(f.app.engine.runs().length,0);assert.deepEqual(f.app.engine.schedule('all').definition.documents,[]);
 f.set(base);assert.equal(f.app.engine.dispatch().admitted,4);const reserved=f.app.engine.claim();assert(reserved);
 moved=await metadata(f,moved,{name:'执行时名称 🌿 <b>literal</b>.txt',workspaceId:'synthetic-b',folderId:b.id});
 await expect(f.documents,'PUT','/api/documents/'+removed.id+'/trash',{revision:removed.revision});
 const late=await upload(f,'created-after-schedule.txt',Buffer.from('LATE_CONTENT_MARKER_bab'));
 const db=new DatabaseSync(join(f.storage,'research-documents.sqlite'));try{db.prepare('UPDATE document_folders SET name=? WHERE id=?').run('执行时文件夹 B',b.id)}finally{db.close()}
 const before=documentState(f);assert.equal(f.app.engine.execute(reserved).status,'completed');assert.equal(f.app.engine.tick().processed,3);assert.equal(documentState(f),before);
 const bySchedule=new Map(f.app.engine.runs().map(run=>[run.schedule_id,run]));
 const result=f.app.engine.result(bySchedule.get('all').id);
 assert.equal(result.synthetic,false);assert.equal(result.kind,'document-inventory-snapshot');assert.equal(result.count,3);
 assert.equal(result.capturedAt,new Date(base).toISOString());assert.equal(result.scheduledAt,new Date(base).toISOString());
 assert.deepEqual(result.scope,{workspaceId:null,folderId:null});assert.match(result.description,/metadata inventory/);
 assert.deepEqual(result.documents.map(d=>d.id),[moved.id,other.id,late.id].sort());
 const row=result.documents.find(d=>d.id===moved.id);
 assert.deepEqual(Object.keys(row).sort(),['bytes','folderId','folderName','id','name','revision','sha256','textSha256','workspaceId'].sort());
 assert.deepEqual(row,{id:moved.id,name:moved.name,bytes:contents.length,sha256:hash(contents),textSha256:hash(contents),workspaceId:'synthetic-b',folderId:b.id,folderName:'执行时文件夹 B',revision:1});
 assert.equal(result.totalBytes,[moved,other,late].reduce((n,d)=>n+d.bytes,0));assert.equal(result.sha256,snapshotHash(result.documents));
 for(const marker of ['SYNTHETIC_CONTENT_MUST_NOT_APPEAR_78e9','TRASH_CONTENT_MARKER_6d1','LATE_CONTENT_MARKER_bab'])assert(!JSON.stringify(result).includes(marker));
 for(const id of ['workspace-b','folder-b'])assert.deepEqual(f.app.engine.result(bySchedule.get(id).id).documents.map(d=>d.id),[moved.id,other.id].sort());
 assert.equal(f.app.engine.result(bySchedule.get('empty-a').id).count,0);
 const persisted=JSON.stringify(result);await metadata(f,moved,{name:'renamed-after-snapshot.txt'});
 assert.equal(JSON.stringify(f.app.engine.result(bySchedule.get('all').id)),persisted);
 assert.deepEqual(await create(f,input),f.app.engine.schedule('all'));
 assert.equal(f.app.engine.tick().processed,0);assert.deepEqual(counts(f),{schedules:4,runs:4,results:4,attempts:4});
});

await check('create replay is stable and conflicting key replay never modifies the schedule',async()=>{
 const f=fixture('idempotency'),input=command();const first=await create(f,input);
 assert.deepEqual(await create(f,input),first);assert.deepEqual(await create(f,{...input,maxAttempts:3,timeoutMs:1000,retryMs:100,misfirePolicy:'coalesce',graceMs:60000}),first);
 for(const extra of [{id:'other-id'},{scope:{workspaceId:'synthetic-a',folderId:null}},{maxAttempts:2},{cadence:{kind:'daily',time:'12:00',timezone:'UTC'}}]){
  const body=await expect(f.app,'POST',api+'/schedules',{...input,...extra},409);assert.equal(body.error.code,'IDEMPOTENCY_CONFLICT');
 }
 assert.deepEqual(f.app.engine.list(),[first]);assert.deepEqual(counts(f),{schedules:1,runs:0,results:0,attempts:0});
});

await check('unsupported research providers executable code caller documents and unexpected fields reject atomically',async()=>{
 const f=fixture('unsupported');
 for(const handler of ['research','external-research','email','fetch','document-inventory-snapshot-v2','',null]){
  const body=await expect(f.app,'POST',api+'/schedules',command('bad',{handler}),400);assert.equal(body.error.code,'HANDLER_UNAVAILABLE');
 }
 for(const key of ['documents','provider','credentials','endpoint','url','code','script','handlerSource','network','tenantId','principal','recipients','prompt','dataSourceId','notification'])await expect(f.app,'POST',api+'/schedules',{...command('bad'),[key]:key==='documents'?[]:'synthetic-value'},400);
 for(const value of [null,[],true,42,'schedule',{}])await expect(f.app,'POST',api+'/schedules',value,400);
 assert.deepEqual(counts(f),{schedules:0,runs:0,results:0,attempts:0});
});

await check('scope requires exactly nullable workspace and canonical-shaped folder IDs',async()=>{
 const f=fixture('scope-validation'),good={workspaceId:'synthetic-a',folderId:randomUUID()};assert.deepEqual(validateScope(good),good);
 for(const scope of [null,[],{},true,{workspaceId:null},{folderId:null},{workspaceId:null,folderId:null,extra:1},{workspaceId:42,folderId:null},{workspaceId:'../private',folderId:null},{workspaceId:'a'.repeat(161),folderId:null},{workspaceId:null,folderId:42},{workspaceId:null,folderId:''},{workspaceId:null,folderId:'------------------------------------'},{workspaceId:null,folderId:'a'.repeat(36)}]){
  const body=await expect(f.app,'POST',api+'/schedules',command('bad',{scope}),400);assert.equal(body.error.code,'INVALID_SCOPE');
 }
 assert.equal(f.app.engine.list().length,0);
});

await check('invalid identifiers cadence retry timeout and misfire parameters do not persist',async()=>{
 const f=fixture('parameter-validation');
 for(const extra of [{id:''},{id:'../escape'},{idempotencyKey:''},{idempotencyKey:'x'.repeat(101)},{maxAttempts:0},{maxAttempts:11},{timeoutMs:0},{timeoutMs:60001},{retryMs:0},{retryMs:60001},{graceMs:-1},{graceMs:86400001},{misfirePolicy:'burst'},{cadence:{kind:'cron',expression:'* * * * *',timezone:'UTC'}},{cadence:{kind:'once',at:'2026-02-30T00:00:00Z',timezone:'UTC'}},{cadence:{kind:'once',at:'2026-10-15T12:00:00',timezone:'UTC'}},{cadence:{kind:'daily',time:'24:00',timezone:'UTC'}},{cadence:{kind:'weekly',time:'12:00',timezone:'UTC',weekdays:[1,1]}},{cadence:{kind:'daily',time:'12:00',timezone:'Not/AZone'}}])await expect(f.app,'POST',api+'/schedules',command('bad',extra),400);
 assert.equal(f.app.engine.list().length,0);
});

await check('pause blocks due admission and resume processes overdue once work exactly once',async()=>{
 const f=fixture('pause-resume');await create(f,command());await state(f,'inventory-once','paused');f.set(base+5000);
 assert.equal(f.app.engine.tick().processed,0);assert.equal(f.app.engine.runs().length,0);
 await state(f,'inventory-once','paused');await state(f,'inventory-once','active');assert.equal(f.app.engine.tick().processed,1);
 assert.equal(f.app.engine.schedule('inventory-once').state,'completed');assert.equal(f.app.engine.tick().processed,0);
 await state(f,'inventory-once','active',409);await state(f,'inventory-once','paused',409);
 assert.deepEqual(counts(f),{schedules:1,runs:1,results:1,attempts:1});
});

await check('pause fences execution of an already claimed run and resume retains it',async()=>{
 const f=fixture('claimed-pause');await create(f,command());f.set(base);f.app.engine.dispatch();const claim=f.app.engine.claim();
 await state(f,'inventory-once','paused');assert.throws(()=>f.app.engine.execute(claim),error=>error.code==='SCHEDULE_NOT_ACTIVE');
 assert.equal(f.app.engine.result(claim.id),null);assert.equal(f.app.engine.claim(),null);
 const publicRuns=await expect(f.app,'GET',api+'/runs');assert(!Object.hasOwn(publicRuns[0],'token'));
 await state(f,'inventory-once','active');assert.equal(f.app.engine.execute(claim).status,'completed');
 assert.throws(()=>f.app.engine.execute(claim),error=>error.code==='STALE_CLAIM');assert.equal(counts(f).results,1);
});

await check('cancel queued running and future schedules fences claims and remains terminal across replay',async()=>{
 for(const phase of ['future','queued','running']){
  const f=fixture('cancel-'+phase);await create(f,command());let claim;
  if(phase!=='future'){f.set(base);f.app.engine.dispatch();if(phase==='running')claim=f.app.engine.claim()}
  await state(f,'inventory-once','cancelled');await state(f,'inventory-once','cancelled');f.set(base+10000);assert.equal(f.app.engine.tick().processed,0);
  assert.equal(f.app.engine.schedule('inventory-once').state,'cancelled');assert.equal(counts(f).results,0);
  if(claim){assert.throws(()=>f.app.engine.execute(claim),error=>error.code==='STALE_CLAIM');assert.equal(f.app.engine.db.prepare('SELECT status FROM attempts').get().status,'cancelled')}
  if(phase!=='future')assert.equal(f.app.engine.runs()[0].state,'cancelled');
  await state(f,'inventory-once','active',409);await state(f,'inventory-once','paused',409);
  assert.equal((await create(f,command())).state,'cancelled');
 }
});

await check('state and result contracts reject unsupported fields states malformed and missing IDs',async()=>{
 const f=fixture('state-result-errors');await create(f,command());
 for(const data of [null,[],{}, {id:'inventory-once'}, {state:'paused'}, {id:'inventory-once',state:'deleted'}, {id:'inventory-once',state:'paused',extra:true}])await expect(f.app,'POST',api+'/state',data,400);
 assert.equal((await state(f,'missing','paused',404)).error.code,'NOT_FOUND');
 assert.equal(await expect(f.app,'GET',api+'/result?id=missing'),null);
 for(const suffix of ['', '?id=', '?id=../other','?id='+ 'a'.repeat(101)])await expect(f.app,'GET',api+'/result'+suffix,undefined,400);
 assert.equal(f.app.engine.schedule('inventory-once').state,'active');
});

await check('HTTP method path query media encoding JSON UTF-8 and 8192-byte limits are enforced',async()=>{
 const f=fixture('wire-errors');
 for(const path of ['/capabilities','/schedules','/runs','/result'])for(const method of ['PUT','PATCH','DELETE','HEAD','OPTIONS'])await expect(f.app,method,api+path,{},404);
 for(const path of ['/claim','/dispatch','/execute','/start','/stop','/tick','/recover','/register','/schedules/','/schedules/extra','/state/extra','/result/extra','/./schedules','/schedules#ignored','-extra'])for(const method of ['GET','POST'])await expect(f.app,method,api+path,{},404);
 await expect(f.app,'POST',api+'/capabilities',{},404);await expect(f.app,'POST',api+'/runs',{},404);await expect(f.app,'POST',api+'/result',{},404);await expect(f.app,'GET',api+'/state',undefined,404);
 for(const path of ['/capabilities','/schedules','/runs'])for(const query of ['?id=x','?extra=x','?id=x&id=y'])await expect(f.app,'GET',api+path+query,undefined,400);
 for(const query of ['?id=x&id=y','?id=x&extra=y'])await expect(f.app,'GET',api+'/result'+query,undefined,400);
 for(const path of ['/schedules','/state']){
  const data=path==='/schedules'?command('wire'):{id:'missing',state:'paused'};
  for(const headers of [{'content-type':'text/plain'},{'content-type':''},{'content-type':'application/json; charset=latin1'},{'content-encoding':'gzip'}])await expect(f.app,'POST',api+path,data,400,headers);
  await expect(f.app,'POST',api+path+'?id=x',data,400);
  for(const bytes of [Buffer.from('{'),Buffer.from([0xff]),Buffer.alloc(0)])await expect(f.app,'POST',api+path,bytes,400,{'content-type':'application/json'});
  await expect(f.app,'POST',api+path,Buffer.from(' '.repeat(8193)),413,{'content-type':'application/json'});
 }
 await expect(f.app,'POST',api+'/schedules',command('charset'),200,{'content-type':'Application/JSON; charset=UTF-8'});
 assert.equal(f.app.engine.list().length,1);
});

await check('document reader is read-only, bounded to 250 active rows, and does not create missing stores',()=>{
 const f=fixture('source-quota');
 const db=new DatabaseSync(join(f.storage,'research-documents.sqlite'));
 try{const insert=db.prepare('INSERT INTO research_documents(id,name,format,bytes,sha256,text_sha256,created,pages,workspace_id,folder_id,original,text,search_value,text_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');db.exec('BEGIN');for(let n=0;n<251;n++){const bytes=Buffer.from('Synthetic quota '+n);insert.run(randomUUID(),'quota-'+n+'.txt','txt',bytes.length,hash(bytes),hash(bytes),new Date(base).toISOString(),null,null,null,bytes,bytes.toString(),'',bytes.length)}db.exec('COMMIT')}
 finally{db.close()}
 assert.throws(()=>readInventory(f.storage,{workspaceId:null,folderId:null}),error=>error.code==='DOCUMENT_QUOTA');
 const writable=new DatabaseSync(join(f.storage,'research-documents.sqlite'));try{writable.prepare('UPDATE research_documents SET trashed_at=? WHERE id=(SELECT id FROM research_documents LIMIT 1)').run(new Date(base).toISOString())}finally{writable.close()}
 assert.equal(readInventory(f.storage,{workspaceId:null,folderId:null}).length,250);
 assert.equal(readInventory(f.storage,{workspaceId:'no-such-synthetic-scope',folderId:null}).length,0);
 const empty=fixture('missing-source',{documents:false});assert.throws(()=>readInventory(empty.storage,{workspaceId:null,folderId:null}));assert(!existsSync(join(empty.storage,'research-documents.sqlite')));
});

await check('missing source retries are bounded and failed attempts never leave a partial snapshot',async()=>{
 const f=fixture('bounded-error',{documents:false});await create(f,command('error',{timeoutMs:10,retryMs:1,maxAttempts:2}));f.set(base);
 assert.throws(()=>f.app.engine.tick());const run=f.app.engine.runs()[0];assert.equal(run.state,'running');assert.equal(run.attempt,1);assert.equal(f.app.engine.result(run.id),null);
 f.set(base+10);f.app.engine.recover();assert.equal(f.app.engine.runs()[0].state,'retry');assert.equal(f.app.engine.claim(),null);
 f.set(base+11);assert.throws(()=>f.app.engine.tick());assert.equal(f.app.engine.runs()[0].attempt,2);
 f.set(base+21);assert.equal(f.app.engine.tick().processed,0);assert.equal(f.app.engine.runs()[0].state,'failed');assert.equal(f.app.engine.runs()[0].error,'timeout');
 assert.deepEqual(counts(f),{schedules:1,runs:1,results:0,attempts:2});assert(!existsSync(join(f.storage,'research-documents.sqlite')));
});

await check('source failure is visible through capability status without leaking a local path or stack',async()=>{
 const f=fixture('visible-error',{documents:false});await create(f,command());f.set(base);f.app.start();
 const body=await expect(f.app,'GET',api+'/capabilities');assert.match(body.lastError,/Local inventory unavailable/);assert(!JSON.stringify(body).includes(f.storage));assert(!JSON.stringify(body).includes('stack'));
 f.app.close();
});

await check('source recovery after an interrupted claim reads newly available document metadata once',async()=>{
 const f=fixture('source-recovery',{documents:false});await create(f,command('recover',{timeoutMs:10,retryMs:1}));f.set(base);assert.throws(()=>f.app.engine.tick());
 const docApp=researchDocuments(f.storage,workspace);try{await upload({...f,documents:docApp},'recovered.txt',Buffer.from('Fresh synthetic recovery'))}finally{docApp.close()}
 f.set(base+10);f.app.engine.recover();f.set(base+11);assert.equal(f.app.engine.tick().processed,1);assert.equal(f.app.engine.runs()[0].attempt,2);assert.equal(f.app.engine.result(f.app.engine.runs()[0].id).count,1);
 assert.equal(f.app.engine.tick().processed,0);assert.equal(counts(f).results,1);
});

await check('transaction failure rolls back result and later recovery commits exactly one snapshot',async()=>{
 const f=fixture('atomic-result');await upload(f,'atomic.txt',Buffer.from('Synthetic atomic source'));await create(f,command('atomic',{timeoutMs:10,retryMs:1}));f.set(base);f.app.engine.dispatch();const claim=f.app.engine.claim();
 f.app.engine.db.exec("CREATE TRIGGER synthetic_commit_fault BEFORE UPDATE OF state ON runs WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'Synthetic transaction failure'); END;");
 assert.throws(()=>f.app.engine.execute(claim),/Synthetic transaction failure/);assert.equal(f.app.engine.result(claim.id),null);assert.equal(f.app.engine.runs()[0].state,'running');
 f.app.engine.db.exec('DROP TRIGGER synthetic_commit_fault');f.set(base+10);f.app.engine.recover();f.set(base+11);assert.equal(f.app.engine.tick().processed,1);assert.equal(counts(f).results,1);
});

await check('separate process crash/restart recovers claims and retains one immutable result after commit',async()=>{
 const f=fixture('process-restart');const doc=await upload(f,'persist.txt',Buffer.from('Synthetic process-restart source'));f.app.close();
 const moduleUrl=new URL('../scheduler/runner.mjs',import.meta.url).href;
 const child=(now,code)=>spawnSync(process.execPath,['--input-type=module','-e',`import {LocalScheduler} from ${JSON.stringify(moduleUrl)};const e=new LocalScheduler({filename:${JSON.stringify(join(f.storage,'inventory.scheduler.sqlite'))},inventoryStorage:${JSON.stringify(f.storage)},clock:()=>${now}});${code}`],{encoding:'utf8',timeout:10000});
 const interrupted=child(base,`e.create(${JSON.stringify(command('restart',{timeoutMs:10,retryMs:1}))});e.dispatch();e.claim();process.exit(73)`);assert.equal(interrupted.status,73,interrupted.stderr);
 const recovered=child(base+10,'e.recover();e.close()');assert.equal(recovered.status,0,recovered.stderr);
 const committed=child(base+11,'e.tick();console.log(JSON.stringify({runs:e.runs(),result:e.result(e.runs()[0].id)}));process.exit(74)');assert.equal(committed.status,74,committed.stderr);const first=JSON.parse(committed.stdout);
 assert.equal(first.runs.length,1);assert.equal(first.runs[0].state,'completed');assert.equal(first.runs[0].attempt,2);assert.equal(first.result.documents[0].id,doc.id);
 await metadata(f,doc,{name:'changed-after-commit.txt'});
 const reopened=child(base+10000,`e.tick();console.log(JSON.stringify({runs:e.runs(),result:e.result(e.runs()[0].id),results:e.db.prepare('SELECT count(*) n FROM results').get().n,schedule:e.create(${JSON.stringify(command('restart',{timeoutMs:10,retryMs:1}))})}));e.close()`);assert.equal(reopened.status,0,reopened.stderr);const second=JSON.parse(reopened.stdout);
 assert.deepEqual(second.runs,first.runs);assert.deepEqual(second.result,first.result);assert.equal(second.results,1);assert.equal(second.schedule.state,'completed');
});

await check('two independent connections fence duplicate claims and produce one metadata snapshot',async()=>{
 const f=fixture('two-connections');await create(f,command());f.set(base);f.app.engine.dispatch();
 const second=new LocalScheduler({filename:join(f.storage,'inventory.scheduler.sqlite'),inventoryStorage:f.storage,clock:()=>base});
 try{const claim=f.app.engine.claim();assert(claim);assert.equal(second.claim(),null);assert.equal(second.execute(claim).status,'completed');assert.throws(()=>f.app.engine.execute(claim),error=>error.code==='STALE_CLAIM');assert.equal(counts(f).results,1)}finally{second.close()}
});

await check('100-schedule quota is explicit and idempotent replay still succeeds at the limit',async()=>{
 const f=fixture('schedule-quota');for(let n=0;n<100;n++)await create(f,command('quota-'+n));
 const body=await expect(f.app,'POST',api+'/schedules',command('overflow'),429);assert.equal(body.error.code,'SCHEDULE_QUOTA');
 assert.equal((await create(f,command('quota-0'))).id,'quota-0');assert.equal(f.app.engine.list().length,100);
});

await check('retained run quota reports blocked admission while already queued work can complete',async()=>{
 const f=fixture('run-quota');await create(f,command('queued'));f.set(base);f.app.engine.dispatch();await create(f,command('blocked'));
 f.app.engine.tx(()=>{const insert=f.app.engine.db.prepare("INSERT INTO runs(id,schedule_id,due,state,ready) VALUES(?,?,?,'completed',?)");for(let n=0;n<9999;n++)insert.run('retained-'+n,'queued',n,n)});
 f.app.start();const cap=await expect(f.app,'GET',api+'/capabilities');assert.deepEqual(cap.admission,{admitted:0,blocked:'run_quota'});assert.equal(cap.lastError,null);
 assert.equal(f.app.engine.runs().length,10000);assert.equal(f.app.engine.schedule('blocked').nextDue,base);assert.equal(f.app.engine.schedule('queued').state,'completed');assert.equal(counts(f).results,1);f.app.close();
});

await check('coalesced daily and weekly runs and skipped once misfires stay local and bounded',async()=>{
 const f=fixture('cadences');f.set(base);
 await create(f,command('daily',{cadence:{kind:'daily',time:'12:00',timezone:'UTC'}}));
 await create(f,command('weekly',{cadence:{kind:'weekly',time:'12:00',timezone:'UTC',weekdays:[4]}}));
 await create(f,command('skip',{misfirePolicy:'skip',graceMs:100}));f.set(base+8*86400000+500);
 assert.equal(f.app.engine.tick().processed,2);assert.equal(f.app.engine.runs().length,3);
 const daily=f.app.engine.runs().find(r=>r.schedule_id==='daily'),weekly=f.app.engine.runs().find(r=>r.schedule_id==='weekly'),skip=f.app.engine.runs().find(r=>r.schedule_id==='skip');
 assert.equal(daily.due,base+8*86400000);assert.equal(weekly.due,base+7*86400000);assert.equal(skip.state,'skipped');assert.equal(f.app.engine.result(skip.id),null);
 assert.equal(f.app.engine.tick().processed,0);assert.equal(counts(f).results,2);
});

await check('non-UTC daily and multi-weekday schedules retain immutable definitions through state changes and restart',async()=>{
 const f=fixture('recurring-iana');f.set(Date.parse('2026-10-16T00:00:00Z'));
 const daily=command('iana-daily',{cadence:{kind:'daily',time:'09:30',timezone:'Asia/Shanghai'}});
 const weekly=command('iana-weekly',{cadence:{kind:'weekly',time:'18:45',timezone:'America/New_York',weekdays:[5,0,1]}});
 const createdDaily=await create(f,daily),createdWeekly=await create(f,weekly);
 assert.equal(createdDaily.nextDue,Date.parse('2026-10-16T01:30:00Z'));
 assert.equal(createdWeekly.nextDue,Date.parse('2026-10-16T22:45:00Z'));
 assert.deepEqual(createdWeekly.definition.cadence.weekdays,[0,1,5]);
 assert.deepEqual(await create(f,weekly),createdWeekly);
 await expect(f.app,'POST',api+'/schedules',{...weekly,cadence:{...weekly.cadence,time:'19:45'}},409);
 await expect(f.app,'PATCH',api+'/schedules',{id:weekly.id,cadence:{...weekly.cadence,time:'19:45'}},404);
 await state(f,daily.id,'paused');f.set(Date.parse('2026-10-19T02:00:00Z'));
 assert.equal(f.app.engine.tick().processed,1);
 assert.equal(f.app.engine.runs().find(r=>r.schedule_id===weekly.id).due,Date.parse('2026-10-18T22:45:00Z'));
 assert.equal(f.app.engine.runs().some(r=>r.schedule_id===daily.id),false);
 await state(f,daily.id,'active');assert.equal(f.app.engine.tick().processed,1);
 assert.equal(f.app.engine.runs().find(r=>r.schedule_id===daily.id).due,Date.parse('2026-10-19T01:30:00Z'));
 assert.equal(f.app.engine.schedule(daily.id).nextDue,Date.parse('2026-10-20T01:30:00Z'));
 await state(f,weekly.id,'paused');const before=f.app.engine.list();f.app.close();
 const reopened=inventoryScheduler(f.storage);reopened.engine.clock=()=>Date.parse('2026-10-19T02:00:00Z');
 try{assert.deepEqual(await expect(reopened,'GET',api+'/schedules'),before);assert.deepEqual(await expect(reopened,'POST',api+'/schedules',weekly),before.find(s=>s.id===weekly.id));assert.equal(reopened.engine.tick().processed,0);assert.equal(reopened.engine.runs().length,2)}finally{reopened.close()}
});

await check('daily DST gap skips a nonexistent local time and overlap executes the earlier instant only',async()=>{
 const gap=fixture('recurring-dst-gap');gap.set(Date.parse('2026-03-08T00:00:00Z'));
 const g=await create(gap,command('dst-gap',{cadence:{kind:'daily',time:'02:30',timezone:'America/New_York'}}));
 assert.equal(g.nextDue,Date.parse('2026-03-09T06:30:00Z'));
 gap.set(Date.parse('2026-03-08T07:30:00Z'));assert.equal(gap.app.engine.tick().processed,0);
 gap.set(Date.parse('2026-03-09T06:30:00Z'));assert.equal(gap.app.engine.tick().processed,1);
 const overlap=fixture('recurring-dst-overlap');overlap.set(Date.parse('2026-11-01T00:00:00Z'));
 const o=await create(overlap,command('dst-overlap',{cadence:{kind:'weekly',time:'01:30',timezone:'America/New_York',weekdays:[0]}}));
 assert.equal(o.nextDue,Date.parse('2026-11-01T05:30:00Z'));
 overlap.set(Date.parse('2026-11-01T05:30:00Z'));assert.equal(overlap.app.engine.tick().processed,1);
 overlap.set(Date.parse('2026-11-01T06:30:00Z'));assert.equal(overlap.app.engine.tick().processed,0);
 assert.equal(overlap.app.engine.schedule(o.id).nextDue,Date.parse('2026-11-08T06:30:00Z'));assert.equal(overlap.app.engine.runs().length,1);
});

await check('invalid dates zones weekday sets and wall times reject without admitting or modifying a schedule',async()=>{
 const f=fixture('recurring-invalid');const valid=await create(f,command('unchanged',{cadence:{kind:'weekly',time:'12:00',timezone:'UTC',weekdays:[0,6]}}));
 const invalid=[
  ...['2026-02-29T00:00:00Z','2026-04-31T00:00:00Z','2100-01-01T00:00:00Z','1969-12-31T23:59:59Z','2026-13-01T00:00:00Z','not-a-date'].map(at=>({kind:'once',at,timezone:'UTC'})),
  ...['','Not/AZone','+08:00','../UTC','Asia/Shanghai;evil'].map(timezone=>({kind:'daily',time:'09:00',timezone})),
  ...[[],[7],[-1],[0,0],['1'],[1.5]].map(weekdays=>({kind:'weekly',time:'09:00',timezone:'UTC',weekdays})),
  ...['','9:00','24:00','12:60','09:00:00'].map(time=>({kind:'daily',time,timezone:'UTC'})),
 ];
 for(const cadence of invalid)await expect(f.app,'POST',api+'/schedules',command('bad',{cadence}),400);
 assert.deepEqual(f.app.engine.list(),[valid]);assert.deepEqual(counts(f),{schedules:1,runs:0,results:0,attempts:0});
});

// Exercise the actual application server in a fresh synthetic store, not only its adapter.
await check('actual loopback server mounts exact routes enforces origin/host guards and runs durable snapshots',async()=>{
 const runtime=join(root,'runtime'),storage=join(root,'http-store');mkdirSync(runtime,{recursive:true});mkdirSync(storage);
 const pins=JSON.parse(readFileSync(join(here,'SOURCE_PINS.json'))).files;
 for(const pin of pins){const source=readFileSync(join(here,'source',pin.path),'utf8');assert.equal(hash(source),pin.sha256);const dest=join(runtime,pin.path.replace(/\.ts$/,'.mjs'));mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,stripTypeScriptTypes(source,{mode:'transform'}).replace(/(from\s+['"])(\.[^'"]+)(['"])/g,'$1$2.mjs$3'))}
 let child,origin,port='0';
 const start=()=>new Promise((resolve,reject)=>{let stderr='';child=fork(join(here,'server.mjs'),[runtime,storage,join(storage,'synthetic-http-events.jsonl'),port],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH}});pids.push(child.pid);child.stderr.on('data',data=>stderr+=data);child.stdout.resume();const timer=setTimeout(()=>reject(Error('Server readiness timeout: '+stderr)),15000);child.once('error',error=>{clearTimeout(timer);reject(error)});child.once('exit',()=>{clearTimeout(timer);reject(Error('Server exited before readiness: '+stderr))});child.once('message',message=>{clearTimeout(timer);origin=message.origin;port=new URL(origin).port;resolve()})});
 const stop=async()=>{if(child?.exitCode===null)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server shutdown timeout')),15000);child.once('exit',()=>{clearTimeout(timer);resolve()});child.kill('SIGTERM')})};
 const wire=async(method,path,data,headers={})=>{const response=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:response.status,body:await response.json()}};
 const raw=(path,headers={})=>new Promise((resolve,reject)=>{const req=httpRequest(origin,{path,headers},res=>{let text='';res.on('data',part=>text+=part);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}))});req.on('error',reject);req.end()});
 try{
  await start();assert.equal((await wire('GET',api+'/capabilities')).body.execution,'local-app-process-only');
  for(const [method,path] of [['POST','/claim'],['POST','/dispatch'],['POST','/execute'],['POST','/start'],['POST','/register'],['GET','/schedules/'],['PUT','/schedules']])assert.equal((await wire(method,api+path,method==='GET'?undefined:{})).status,404);
  for(const headers of [{Origin:'https://invalid.example'},{'Sec-Fetch-Site':'cross-site'},{Host:'foreign.invalid'}])assert.equal((await raw(api+'/capabilities',headers)).status,403);
  for(const path of ['/api/local-scheduler/%73chedules','/api/local-scheduler/../local-scheduler/schedules','/api/local-scheduler/./schedules','/api/local-scheduler/schedules#ignored','/api/local-scheduler\\schedules','//api/local-scheduler/schedules'])assert.equal((await raw(path)).status,404);
  assert.equal((await wire('POST',api+'/schedules?x=1',command('wrong-query'))).status,400);
  const uploadResult=await fetch(origin+'/api/documents/upload?name=live-synthetic.txt',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Buffer.from('HTTP_CONTENT_EXCLUDED_e7a')});assert.equal(uploadResult.status,201);const document=(await uploadResult.json()).document;
  const input=command('live-once',{cadence:{kind:'once',at:new Date(Date.now()).toISOString(),timezone:'UTC'}});
  assert.equal((await wire('POST',api+'/schedules',input)).status,200);assert.equal((await wire('POST',api+'/schedules',input)).status,200);
  const future=command('live-state',{cadence:{kind:'once',at:new Date(Date.now()+60000).toISOString(),timezone:'UTC'}});assert.equal((await wire('POST',api+'/schedules',future)).status,200);
  for(const state of ['paused','active','cancelled'])assert.equal((await wire('POST',api+'/state',{id:future.id,state})).body.state,state);
  assert.equal((await wire('POST',api+'/state',{id:future.id,state:'active'})).status,409);
  assert.equal((await wire('GET',api+'/schedules')).body.find(row=>row.id===future.id).state,'cancelled');
  const twelveHours=new Date(Date.now()+12*3600000),time=twelveHours.toISOString().slice(11,16);
  const recurring=[command('live-daily',{cadence:{kind:'daily',time,timezone:'UTC'}}),command('live-weekly',{cadence:{kind:'weekly',time,timezone:'UTC',weekdays:[twelveHours.getUTCDay()]}})];
  for(const item of recurring){
   const created=await wire('POST',api+'/schedules',item);assert.equal(created.status,200);assert.equal(created.body.nextDue,Date.parse(twelveHours.toISOString().slice(0,16)+':00.000Z'));
   assert.deepEqual((await wire('POST',api+'/schedules',item)).body,created.body);
   assert.equal((await wire('POST',api+'/schedules',{...item,cadence:{...item.cadence,time:time==='09:00'?'10:00':'09:00'}})).status,409);
   assert.equal((await wire('POST',api+'/state',{id:item.id,state:'paused'})).body.state,'paused');
   assert.equal((await wire('POST',api+'/state',{id:item.id,state:'active'})).body.state,'active');
  }
  let runs=[];const deadline=Date.now()+8000;
  while(Date.now()<deadline){runs=(await wire('GET',api+'/runs')).body;if(runs.length===1&&runs[0].state==='completed')break;await new Promise(resolve=>setTimeout(resolve,50))}
  assert.equal(runs.length,1);assert.equal(runs[0].state,'completed');assert(!Object.hasOwn(runs[0],'token'));
  const result=(await wire('GET',api+'/result?id='+runs[0].id)).body;assert.equal(result.count,1);assert.equal(result.documents[0].id,document.id);assert.equal(result.documents[0].sha256,document.sha256);assert(!JSON.stringify(result).includes('HTTP_CONTENT_EXCLUDED_e7a'));
  const savedRecurring=(await wire('GET',api+'/schedules')).body.filter(s=>recurring.some(item=>item.id===s.id));
  await stop();await start();assert.notEqual(pids.at(-1),pids.at(-2));
  assert.deepEqual((await wire('GET',api+'/schedules')).body.filter(s=>recurring.some(item=>item.id===s.id)),savedRecurring);
  assert.deepEqual((await wire('GET',api+'/runs')).body,runs);assert.deepEqual((await wire('GET',api+'/result?id='+runs[0].id)).body,result);
  assert.equal((await wire('POST',api+'/schedules',input)).body.state,'completed');
  assert.equal(readDb(storage,'inventory.scheduler.sqlite',db=>db.prepare('SELECT count(*) n FROM results').get().n),1);
 }finally{await stop()}
});

for(const f of fixtures)f.close();
const sources=['backend/test-inventory-scheduler.mjs','backend/inventory-scheduler.mjs','backend/server.mjs','backend/research-documents.mjs','scheduler/runner.mjs','scheduler/inventory-source.mjs','scheduler/routes.mjs','scheduler/cadence.mjs'];
const report={passed:failures.length===0,count:checks.length,failedCount:failures.length,checks,failures,runtime:process.version,checkedAt:new Date().toISOString(),sourceSha256:Object.fromEntries(sources.map(name=>[name,hash(readFileSync(join(here,'..',name)))])),transport:'In-process HTTP handlers, actual loopback HTTP server, real SQLite, deterministic clock and fresh process restarts; no browser',fixtures:'Fresh synthetic UTF-8 documents, workspaces and folders only; no existing application data',retention:'Fresh temporary directories retained; no filesystem deletion or permanent purge',scope:'Read-at-execution metadata, content/trash exclusion, exact routes, validation, lifecycle, error recovery, bounded quotas, atomicity and restart persistence',pids,fixtureRoot:root};
writeFileSync(evidence,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:report.passed,count:report.count,failedCount:report.failedCount,evidence},null,2));
if(failures.length)process.exitCode=1;
