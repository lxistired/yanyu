import {fork,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request as httpRequest} from 'node:http';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const here=import.meta.dirname,prep=spawnSync(process.execPath,[join(here,'prepare-backend.mjs')],{encoding:'utf8'});
assert.equal(prep.status,0,prep.stderr);
const build=prep.stdout.trim(),root=mkdtempSync(join(tmpdir(),'yanyu-report-recovery-')),storage=join(root,'store'),evidence=join(here,'../report-recovery-evidence');
mkdirSync(storage);mkdirSync(evidence,{recursive:true});
let child,origin;const checks=[];
async function start(){await new Promise((resolve,reject)=>{child=fork(join(here,'server.mjs'),[build,storage,join(root,'events.jsonl'),'0'],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,HOME:root,YANYU_PYTHON:'/nonexistent/synthetic-test-python'}});let err='';child.stderr.on('data',b=>err+=b);child.once('message',m=>{origin=m.origin;resolve()});child.once('exit',c=>reject(Error(`Startup ${c}: ${err}`)));child.once('error',reject)})}
async function stop(){if(child?.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM')})}
const request=(op,input,options={})=>fetch(`${origin}/api/service-reports/${op}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),...options});
async function good(op,input){const r=await request(op,input),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body}
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name)}
function lostResponse(op,input){return new Promise((resolve,reject)=>{const req=httpRequest(`${origin}/api/service-reports/${op}`,{method:'POST',headers:{'Content-Type':'application/json'}},res=>{assert.equal(res.statusCode,200);res.destroy();resolve()});req.on('error',reject);req.end(JSON.stringify(input))})}
const changed=command=>{const c=structuredClone(command);if(c.input.activity)c.input.activity.summary+=' altered';else if(c.action==='createReport')c.input.month='2026-11';else c.input.archived=!c.input.archived;return c};
try{
 await start();const identity=await(await fetch(origin+'/api/demo/identity')).json(),scope=identity.identityScope,customer={organizationId:'synthetic-org',contactId:null};
 const activityInput={customer,kind:'other',status:'reported-completed',occurredAt:'2026-10-04T09:00:00.000Z',summary:'Synthetic recovery only',references:[{pin:identity.syntheticSourcePin}]};
 const command=(action,key,input)=>({action,input:{scope,idempotencyKey:key,...input}});
 const activities=()=>good('listActivities',{customer,month:'2026-10',timeZone:'UTC',after:null,includeArchived:true});
 const absent=command('createActivity','absent-command',{activity:activityInput});
 await check('Check absent command is nonterminal and makes no business write',async()=>{const before=await activities();assert.deepEqual(await good('recoverCommand',{command:absent}),{scope,outcome:'absent',receipt:null});assert.deepEqual(await activities(),before)});
 await check('Recovery admits only exact routes, POST, same origin, strict five-action envelope and bounded bytes',async()=>{
  for(const op of ['recoverCommand','cancelCommand']){
   for(const body of [{},{command:absent,extra:1},{command:{...absent,extra:1}},{command:{...absent,action:'exportReport'}},{command:{...absent,action:['createActivity']}},{command:{...absent,input:{...absent.input,extra:1}}},{command:{...absent,input:{...absent.input,scope:'bad'}}}])assert.equal((await request(op,body)).status,400,JSON.stringify(body));
   assert.equal((await request(op,{command:{...absent,input:{...absent.input,scope:'f'.repeat(64)}}})).status,403);
   assert.equal((await request(op,{command:absent},{method:'GET',body:undefined})).status,405);
   assert.equal((await request(op,{command:absent},{headers:{'Content-Type':'application/json',Origin:'https://external.invalid'}})).status,403);
   assert.equal((await request(op,{command:absent},{headers:{'Content-Type':'application/json','Sec-Fetch-Site':'cross-site'}})).status,403);
   assert.equal((await request(op,{command:absent},{headers:{'Content-Type':'text/plain'}})).status,415);
   assert.equal((await request(op,{padding:'x'.repeat(32769)})).status,413);
   for(const suffix of ['?extra=1','/'])assert.equal((await request(op+suffix,{command:absent})).status,404);
  }
  for(const op of ['recoverAll','cancelAll','openReportSource','constructor'])assert.equal((await request(op,{})).status,404);
 });
 await check('Repeated cancel writes one durable tombstone, rejects changed payload and prevents delayed retry',async()=>{
  const results=await Promise.all(Array.from({length:8},()=>good('cancelCommand',{command:absent})));assert(results.every(r=>JSON.stringify(r)===JSON.stringify(results[0])));assert.equal(results[0].outcome,'cancelled');assert.equal(results[0].cancellation.idempotencyKey,absent.input.idempotencyKey);assert.match(results[0].cancellation.fingerprint,/^[a-f0-9]{64}$/);
  assert.deepEqual(await good('recoverCommand',{command:absent}),results[0]);
  assert.equal((await request(absent.action,absent.input)).status,409);
  for(const op of ['recoverCommand','cancelCommand'])assert.equal((await request(op,{command:changed(absent)})).status,409);
  assert.equal((await request(absent.action,changed(absent).input)).status,409);
  await stop();await start();assert.deepEqual(await good('recoverCommand',{command:absent}),results[0]);assert.equal((await request(absent.action,absent.input)).status,409);
 });
 const duplicate=command('createActivity','duplicate-command',{activity:activityInput});let created;
 await check('Eight concurrent identical mutation requests create one activity and one recoverable receipt',async()=>{
  const before=(await activities()).items.length;
  const results=await Promise.all(Array.from({length:8},()=>good(duplicate.action,duplicate.input)));created=results[0].activity;assert(results.every(r=>r.activity.id===created.id));assert.equal((await activities()).items.length,before+1);
  const expected={scope,outcome:'committed',receipt:{target:'activity',id:created.id}};
  assert.deepEqual(await good('recoverCommand',{command:duplicate}),expected);assert.deepEqual(await good('cancelCommand',{command:duplicate}),expected);assert.deepEqual((await good('getActivity',{id:created.id})).activity,created);
 });
 const dropped=command('createActivity','lost-response-command',{activity:{...activityInput,summary:'Response dropped after server commit'}});
 await check('Real HTTP acknowledgement discarded after commit recovers across restart and retry never duplicates',async()=>{
  const before=(await activities()).items.length;await lostResponse(dropped.action,dropped.input);await stop();await start();const recovered=await good('recoverCommand',{command:dropped});assert.equal(recovered.outcome,'committed');assert.equal((await activities()).items.length,before+1);const retry=await good(dropped.action,dropped.input);assert.equal(retry.activity.id,recovered.receipt.id);assert.equal((await activities()).items.length,before+1);
 });
 await check('All five mutation fingerprints recover exact IDs; changed payload conflicts; replay preserves revisions',async()=>{
  let activity=created;
  const run=async(c)=>{const first=await good(c.action,c.input),target=c.action.includes('Report')?'report':'activity',id=first.activity?.id??first.report?.id??first.id;
   assert.deepEqual(await good('recoverCommand',{command:c}),{scope,outcome:'committed',receipt:{target,id}});
   assert.deepEqual(await good('cancelCommand',{command:c}),{scope,outcome:'committed',receipt:{target,id}});
   const second=await good(c.action,c.input);assert.deepEqual(second,first);
   for(const op of ['recoverCommand','cancelCommand'])assert.equal((await request(op,{command:changed(c)})).status,409);
   assert.equal((await request(c.action,changed(c).input)).status,409);return first;
  };
  await run(duplicate);
  activity=(await run(command('correctActivity','correct-command',{id:activity.id,expectedRevision:activity.revision,activity:{...activityInput,summary:'Corrected exactly once'},reason:'Synthetic correction'}))).activity;
  await run(command('archiveActivity','archive-activity-command',{id:activity.id,expectedRevision:activity.revision,archived:true}));
  const report=(await run(command('createReport','create-report-command',{customer,month:'2026-10',timeZone:'Etc/UTC',supersedes:null}))).report;
  await run(command('archiveReport','archive-report-command',{id:report.id,expectedRevision:report.revision,archived:true}));
 });
 await check('Cancellation of all five absent commands requires original payload but no business/source read',async()=>{
  const values=[command('createActivity','cancel-create',{activity:activityInput}),command('correctActivity','cancel-correct',{id:'nonexistent',expectedRevision:1,activity:activityInput,reason:'Synthetic'}),command('archiveActivity','cancel-activity',{id:'nonexistent',expectedRevision:1,archived:true}),command('createReport','cancel-report',{customer,month:'2026-10',timeZone:'Etc/UTC',supersedes:null}),command('archiveReport','cancel-report-archive',{id:'nonexistent',expectedRevision:1,archived:true})];
  for(const c of values){const result=await good('cancelCommand',{command:c});assert.equal(result.outcome,'cancelled');assert.deepEqual(await good('recoverCommand',{command:c}),result);assert.equal((await request(c.action,c.input)).status,409)}
 });
 // Domain-controlled source gate deterministically puts cancellation before the write boundary.
 const load=p=>import(pathToFileURL(join(build,p)));
 const {ServiceReportDomain}=await load('server/service-report-domain.mjs'),{SqliteServiceReportRepository}=await load('server/service-report-store.mjs'),{readerCanonical,readerDocumentIdentity}=await load('shared/reader-reference.mjs'),{createHash}=await import('node:crypto');
 const raceRoot=join(root,'race');mkdirSync(raceRoot);
 let repo=new SqliteServiceReportRepository(raceRoot),blocked=false,release,entered;
 const principal={tenantId:'synthetic-race',subjectId:'owner',collectionIds:['collection']},ctx=()=>({principal,signal:new AbortController().signal,requestId:crypto.randomUUID()});
 const document={id:'doc',revisionId:'v1',tenantId:principal.tenantId,collectionId:'collection',title:'Synthetic',source:'research',author:'Test',date:'2026-10-01',tags:[],excerpt:'Synthetic',body:'Synthetic only',pages:1,mock:true};
 const pin={documentId:'doc',revisionId:'v1',tenantId:principal.tenantId,collectionId:'collection',sha256:createHash('sha256').update(readerCanonical(readerDocumentIdentity(document))).digest('hex')};
 const ownerPort={observeOwner:()=>({check(){}}),observeCustomer:(_ctx,ref)=>({customer:{...ref,organizationRevision:1,contactRevision:null},check(){}})};
 const sourcePort={async resolve(){if(blocked){entered();await new Promise(r=>release=r)}return {document,evidenceClass:'primary-source',authorizationMode:'current-local',check(){}}}};
 let domain=new ServiceReportDomain(repo,ownerPort,sourcePort),raceScope=domain.scope(ctx()).scope;
 const raceCommand={action:'createActivity',input:{scope:raceScope,idempotencyKey:'race-cancel',activity:{...activityInput,customer:{organizationId:'org',contactId:null},references:[{pin}]}}};
 await check('Cancel wins while source validation is in flight; absent check never clears the operation',async()=>{
  blocked=true;const gate=new Promise(r=>entered=r),pending=domain.createActivity(ctx(),raceCommand.input);await gate;
  assert.equal(domain.recoverCommand(ctx(),{command:raceCommand}).outcome,'absent');
  const cancellation=domain.cancelCommand(ctx(),{command:raceCommand});assert.equal(cancellation.outcome,'cancelled');
  blocked=false;release();await assert.rejects(pending,e=>e.code==='CONFLICT');
  const list=await domain.listActivities(ctx(),{customer:raceCommand.input.activity.customer,month:'2026-10',timeZone:'UTC',after:null});assert.equal(list.items.length,0);
  repo.close();repo=new SqliteServiceReportRepository(raceRoot);domain=new ServiceReportDomain(repo,ownerPort,sourcePort);assert.deepEqual(domain.recoverCommand(ctx(),{command:raceCommand}),cancellation);await assert.rejects(domain.createActivity(ctx(),raceCommand.input),e=>e.code==='CONFLICT');
 });
 await check('Mutation wins before cancellation; check/cancel recover original receipt without undo',async()=>{
  const c={...raceCommand,input:{...raceCommand.input,idempotencyKey:'race-commit'}};const result=await domain.createActivity(ctx(),c.input);assert.deepEqual(domain.cancelCommand(ctx(),{command:c}),{scope:raceScope,outcome:'committed',receipt:{target:'activity',id:result.activity.id}});assert.equal((await domain.getActivity(ctx(),{id:result.activity.id})).activity.revision,1);
 });
 await check('Owner revocation prevents metadata recovery and cancellation',async()=>{
  const deniedOwners={...ownerPort,observeOwner(){return {check(){throw Object.assign(Error('Synthetic denied'),{code:'FORBIDDEN'})}}}};
  const denied=new ServiceReportDomain(repo,deniedOwners,sourcePort),c={...raceCommand,input:{...raceCommand.input,idempotencyKey:'denied-cancel'}};
  for(const op of ['recoverCommand','cancelCommand'])assert.throws(()=>denied[op](ctx(),{command:c}),e=>e.code==='FORBIDDEN');assert.equal(domain.recoverCommand(ctx(),{command:c}).outcome,'absent');
  const controller=new AbortController();controller.abort();assert.throws(()=>domain.recoverCommand({...ctx(),signal:controller.signal},{command:c}),e=>e.code==='CANCELLED');
 });
 await check('Revocation at cancellation commit fence rolls back its tombstone',async()=>{
  let checks=0;
  const revokedOwners={...ownerPort,observeOwner(){return {check(){if(++checks===2)throw Object.assign(Error('Synthetic authority revoked at commit'),{code:'FORBIDDEN'})}}}};
  const revoked=new ServiceReportDomain(repo,revokedOwners,sourcePort),c={...raceCommand,input:{...raceCommand.input,idempotencyKey:'revoked-at-commit'}};
  assert.throws(()=>revoked.cancelCommand(ctx(),{command:c}),e=>e.code==='FORBIDDEN');assert.equal(checks,2);assert.equal(domain.recoverCommand(ctx(),{command:c}).outcome,'absent');
 });
 await check('Retained keys are bound to action and owner scope, never another owner receipt',async()=>{
  const original={...raceCommand,input:{...raceCommand.input,idempotencyKey:'race-commit'}};
  const rebound={action:'archiveActivity',input:{scope:raceScope,idempotencyKey:'race-commit',id:'any-id',expectedRevision:1,archived:true}};
  for(const op of ['recoverCommand','cancelCommand'])assert.throws(()=>domain[op](ctx(),{command:rebound}),e=>e.code==='CONFLICT');
  const other={...ctx(),principal:{...principal,subjectId:'other-owner'}};
  assert.throws(()=>domain.recoverCommand(other,{command:original}),e=>e.code==='FORBIDDEN');
  const own={...original,input:{...original.input,scope:domain.scope(other).scope}};
  assert.equal(domain.recoverCommand(other,{command:own}).outcome,'absent');assert.equal(domain.cancelCommand(other,{command:own}).outcome,'cancelled');assert.equal(domain.recoverCommand(ctx(),{command:original}).outcome,'committed');
 });
 repo.close();
 writeFileSync(join(evidence,'BACKEND_RESULT.json'),JSON.stringify({passed:true,checks:checks.length,namedChecks:checks,scope:'Synthetic loopback HTTP and fresh SQLite only; no external services, keys, user databases or audio'},null,2)+'\n');
}finally{await stop()}
