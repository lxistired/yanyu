// Fresh synthetic TXT and actual prepared domains/SQLite. No listener, browser, AI or private material.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {serviceRecordBridge} from './service-record-bridge.mjs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {getEventListeners} from 'node:events';
import {compose} from './composition.mjs';
import {researchDocuments} from './research-documents.mjs';
const root=mkdtempSync(join(tmpdir(),'projection-local-sources-')),prepared=join(root,'prepared'),build=join(prepared,'runtime');
const live=[];let sequence=0;
const reject=(action,code)=>assert.rejects(async()=>action(),e=>e.code===code,code);
async function make(label,local=true){
 const storage=join(root,label);mkdirSync(storage);let documents,hook=null,resolves=0,resolver=null,authorityHook=null,clockHook=null,lastBudget;
 const app=await compose(build,storage,{clock:()=>{clockHook?.();return new Date()},...(local?{createLocalSources(authority){
  documents=researchDocuments(storage,{get:(kind,id)=>authority.workspace.get(authority.context(),{kind,id}),list:()=>[]});
  const port=documents.createReportSourcePort(authority);
  return {resource:documents,port:{...port,check(...args){port.check(...args);authorityHook?.()},resolve(...args){resolves++;lastBudget=args[3];const observed=port.resolve(...args);const wrapped={...observed,check(){const result=hook?.({resolves});if(result!==undefined)return result;return observed.check()}};return resolver?resolver(wrapped,args):wrapped}}};
 }}:{} )});live.push(app);return {app,documents,storage,setHook:fn=>{hook=fn},resetResolves:()=>{resolves=0},setResolver:fn=>{resolver=fn},setAuthorityHook:fn=>{authorityHook=fn},setClockHook:fn=>{clockHook=fn},budget:()=>lastBudget};
}
function counts(t){const db=new DatabaseSync(join(t.storage,'data','service-reports.sqlite'),{readOnly:true});try{return {activities:Number(db.prepare("SELECT count(*) AS n FROM service_rows WHERE kind='activity'").get().n),versions:Number(db.prepare("SELECT count(*) AS n FROM service_rows WHERE kind='activity-version'").get().n)}}finally{db.close()}}
function receipts(t){const db=new DatabaseSync(join(t.storage,'data','service-reports.sqlite'),{readOnly:true});try{return Number(db.prepare('SELECT count(*) AS n FROM service_receipts').get().n)}finally{db.close()}}
async function request(t,method,url,data){
 const req=Readable.from([Buffer.isBuffer(data)?data:Buffer.from(JSON.stringify(data??{}))]);req.method=method;req.url=url;req.headers={'content-type':Buffer.isBuffer(data)?'application/octet-stream':'application/json'};
 let response;await t.documents.handle(req,(status,body)=>{response={status,body}},(status,code,message)=>{response={status,body:{code,message}}},()=>assert.fail('No binary download expected'));
 assert(response?.status>=200&&response.status<300,JSON.stringify(response));return response.body;
}
const upload=async(t,name)=> (await request(t,'POST','/api/documents/upload?'+new URLSearchParams({name}),Buffer.from('Synthetic projection source. No private information.\n'))).document;
const change=async(t,doc,op,extra={})=>(await request(t,'PUT',`/api/documents/${doc.id}/${op}`,{revision:doc.revision,...extra})).document;
const source=(t,name)=>t.app.organization.create(t.app.context(),{kind:'service-record',id:name,idempotencyKey:`create-${name}`,data:{organizationId:'synthetic-org',contactId:null,activity:'meeting',occurredAt:'2026-10-05T12:00:00.000Z',summary:'Synthetic ordinary service',notes:'No real materials'}});
const preview=(t,record)=>{const p=t.app.bridge.previewServiceRecord(t.app.context(),{schema:2,scope:t.app.identity.identityScope,sourceId:record.id});p.checkPublication();return p};
async function inspected(t,doc){const choice=t.app.sourceChoices(t.app.context(),{}).items.find(i=>i.documentId.endsWith(':'+doc.id));assert(choice);const result=await t.app.inspectSource(t.app.context(),{documentId:choice.documentId,revisionId:choice.revisionId});result.checkPublication();return result}
const cmd=(p,selection,reason='')=>({schema:2,scope:p.scope,sourceId:p.source.id,token:p.token,authority:p.authority,expectedProjection:p.existing?{id:p.existing.id,revision:p.existing.revision}:null,status:'reported-completed',sourcePin:selection.pin,sourceObservation:selection.locator??null,reason});
const run=async(t,c)=>{const r=await t.app.bridge.importServiceRecord(t.app.context(),c);assert.equal(r.checkPublication(),undefined);assert.deepEqual(Object.keys(r).sort(),['schema','scope','activity','unchanged','checkPublication'].sort());return r};
try{
 mkdirSync(prepared);const st=lstatSync(prepared,{bigint:true});assert.equal(execFileSync(process.execPath,[join(import.meta.dirname,'prepare-backend.mjs'),'--owned-root',prepared,`${st.dev}:${st.ino}`],{encoding:'utf8',timeout:30000}).trim(),build);
 const t=await make('main'),ctx=t.app.context(),scope=t.app.identity.identityScope;
 let doc=await upload(t,'Synthetic source.txt');let selection=await inspected(t,doc);assert.equal(selection.locator.metadataRevision,0);
 let record=source(t,'local-projection');const p=preview(t,record),command=cmd(p,selection);
 assert.equal(p.authority.documentStoreScope,selection.locator.storeScope);assert.equal(p.schema,2);
 const initialCounts=counts(t);const created=await run(t,command);const createdCounts=counts(t);assert.deepEqual(createdCounts,{activities:initialCounts.activities+1,versions:initialCounts.versions+1});assert.equal(created.unchanged,false);assert.deepEqual(created.activity.version.value.references,[{pin:selection.pin}]);
 const retry=await run(t,structuredClone(command));assert.equal(retry.unchanged,true);assert.deepEqual(retry.activity,created.activity);
 const refreshed=preview(t,record);const noOp=await run(t,cmd(refreshed,selection));assert.equal(noOp.unchanged,true);assert.deepEqual(noOp.activity,created.activity);
 await reject(()=>run(t,{...command,reason:'Unrecorded creation reason'}),'INVALID_REQUEST');
 await reject(()=>run(t,{...command,expectedProjection:{id:created.activity.id,revision:77},reason:'Wrong expected head'}),'CONFLICT');
 assert.deepEqual(counts(t),createdCounts);
 const report=(await t.app.reports.createReport(ctx,{scope,idempotencyKey:'projection-report',customer:{organizationId:'synthetic-org',contactId:null},month:'2026-10',timeZone:'UTC',supersedes:null})).report;
 const snapshot=structuredClone(report.snapshot);
 record=t.app.organization.update(ctx,{kind:'service-record',id:record.id,expectedRevision:record.revision,idempotencyKey:'revise-local-projection',patch:{summary:'Revised synthetic ordinary record'}});
 await reject(()=>run(t,command),'CONFLICT');
 const correction=cmd(preview(t,record),selection,'Explicit synthetic correction');
 await reject(()=>run(t,{...correction,reason:''}),'INVALID_REQUEST');
 const corrected=await run(t,correction);assert.equal(corrected.unchanged,false);assert.equal(corrected.activity.id,created.activity.id);assert.equal(corrected.activity.revision,2);
 const correctedCounts=counts(t);assert.deepEqual(correctedCounts,{activities:createdCounts.activities,versions:createdCounts.versions+1});
 const correctedRetry=await run(t,structuredClone(correction));assert.equal(correctedRetry.unchanged,true);assert.deepEqual(correctedRetry.activity,corrected.activity);
 await reject(()=>run(t,{...correction,reason:'Different correction reason'}),'CONFLICT');
 await reject(()=>run(t,{...correction,expectedProjection:{id:corrected.activity.id,revision:99}}),'CONFLICT');
 assert.deepEqual(counts(t),correctedCounts);
 assert.deepEqual((await t.app.reports.getReport(ctx,{id:report.id})).report.snapshot,snapshot);
 const alternate=await upload(t,'Another synthetic source.txt'),otherSelection=await inspected(t,alternate);
 await reject(()=>run(t,cmd(preview(t,record),otherSelection)),'CONFLICT');
 await reject(()=>run(t,{...cmd(preview(t,record),selection),status:'planned'}),'CONFLICT');
 // In-flight metadata changes block publication; new inspection may reuse stable text pin.
 const beforeRename=await t.app.bridge.importServiceRecord(ctx,cmd(preview(t,record),selection));
 doc=await change(t,doc,'metadata',{name:'Renamed synthetic source.txt',workspaceId:null,folderId:null});
 assert.throws(()=>beforeRename.checkPublication(),e=>e.code==='CONFLICT');await reject(()=>run(t,correction),'CONFLICT');
 selection=await inspected(t,doc);assert.deepEqual(selection.pin,command.sourcePin);await run(t,cmd(preview(t,record),selection));
 const beforeTrash=await t.app.bridge.importServiceRecord(ctx,cmd(preview(t,record),selection));
 doc=await change(t,doc,'trash');assert.throws(()=>beforeTrash.checkPublication(),e=>e.code==='NOT_FOUND');await reject(()=>run(t,cmd(preview(t,record),selection)),'NOT_FOUND');
 doc=await change(t,doc,'restore');selection=await inspected(t,doc);await run(t,cmd(preview(t,record),selection));
 // Publication observes the returned post-write head, not the old preview head.
 const headFence=await t.app.bridge.importServiceRecord(ctx,cmd(preview(t,record),selection));
 await t.app.reports.archiveActivity(ctx,{scope,idempotencyKey:'archive-projection',id:corrected.activity.id,expectedRevision:corrected.activity.revision,archived:true});
 assert.throws(()=>headFence.checkPublication(),e=>e.code==='CONFLICT');await reject(()=>run(t,cmd(preview(t,record),selection)),'CONFLICT');
 const fresh=source(t,'validation-source'),freshPreview=preview(t,fresh),valid=cmd(freshPreview,selection);
 await reject(()=>run(t,{...valid,scope:'0'.repeat(64)}),'FORBIDDEN');
 await reject(()=>run(t,{...valid,token:'0'.repeat(64)}),'CONFLICT');
 await reject(()=>run(t,{...valid,sourcePin:{...selection.pin,sha256:'0'.repeat(64)}}),'CONFLICT');
 await reject(()=>run(t,{...valid,sourcePin:{...selection.pin,tenantId:'foreign'}}),'FORBIDDEN');
 await reject(()=>run(t,{...valid,sourcePin:{...selection.pin,collectionId:'foreign'}}),'FORBIDDEN');
 await reject(()=>run(t,{...valid,sourceObservation:{...selection.locator,metadataRevision:-1}}),'INVALID_REQUEST');
 await reject(()=>run(t,{...valid,authority:{...valid.authority,documentStoreScope:'00000000-0000-4000-8000-000000000000'}}),'CONFLICT');
 await reject(()=>run(t,{...valid,sourceObservation:{...selection.locator,storeScope:'00000000-0000-4000-8000-000000000000'}}),'INVALID_REQUEST');
 await reject(()=>run(t,{...valid,unknown:true}),'INVALID_REQUEST');await reject(()=>run(t,{...valid,schema:3}),'INVALID_REQUEST');
 let getterCalls=0;await reject(()=>run(t,{...valid,get reason(){getterCalls++;return ''}}),'INVALID_REQUEST');assert.equal(getterCalls,0);
 const changed=t.app.organization.update(ctx,{kind:'organization',id:'synthetic-org',expectedRevision:1,idempotencyKey:'change-customer',patch:{name:'Updated synthetic customer'}});assert.equal(changed.revision,2);
 await reject(()=>run(t,valid),'CONFLICT');assert.throws(()=>freshPreview.checkPublication(),e=>e.code==='CONFLICT');
 // A fresh real store cannot consume another store's preview or local pin.
 const foreign=await make('foreign');source(foreign,'validation-source');await reject(()=>run(foreign,valid),'CONFLICT');
 // Default synthetic-only compatibility and explicit v2 synthetic choices remain available.
 const synthetic=await make('synthetic-only',false),legacyRecord=source(synthetic,'legacy-record'),legacy=synthetic.app.bridge.previewServiceRecord(synthetic.app.context(),{sourceId:legacyRecord.id});assert(!('schema' in legacy));assert(!('checkPublication' in legacy));
 const legacyCommand={sourceId:legacyRecord.id,token:legacy.token,status:'planned',sourcePin:legacy.syntheticSourcePin};
 const legacyCreated=await synthetic.app.bridge.importServiceRecord(synthetic.app.context(),legacyCommand);assert.equal((await synthetic.app.bridge.importServiceRecord(synthetic.app.context(),legacyCommand)).unchanged,true);
 await reject(()=>synthetic.app.bridge.importServiceRecord(synthetic.app.context(),{...legacyCommand,sourcePin:selection.pin}),'INVALID_REQUEST');
 const v2Record=source(synthetic,'v2-synthetic'),v2Preview=preview(synthetic,v2Record);assert.equal(v2Preview.authority.documentStoreScope,null);assert.equal(v2Preview.authority.capabilities.localDocuments,false);
 const v2Command=cmd(v2Preview,{pin:v2Preview.syntheticSourcePin});const v2Created=await run(synthetic,v2Command);assert.equal(v2Created.unchanged,false);assert.equal((await run(synthetic,v2Command)).unchanged,true);
 assert(legacyCreated.activity.id!==v2Created.activity.id);
 // Concurrent identical first submissions produce one immutable activity/version.
 const racing=source(t,'racing-source'),racingCommand=cmd(preview(t,racing),selection);
 const raceCounts=counts(t);const raced=await Promise.all([run(t,racingCommand),run(t,structuredClone(racingCommand))]);assert.equal(raced[0].activity.id,raced[1].activity.id);assert.equal(raced[0].activity.versionId,raced[1].activity.versionId);assert.equal(raced.filter(r=>!r.unchanged).length,1);assert.deepEqual(counts(t),{activities:raceCounts.activities+1,versions:raceCounts.versions+1});
 // Injected synchronous authority withdrawal before domain commit, no partial projection.
 const revoked=source(t,'revoked-source'),revokedCommand=cmd(preview(t,revoked),selection);t.resetResolves();t.setHook(({resolves})=>{if(resolves>=2)throw Object.assign(Error('Synthetic authority withdrawn'),{code:'FORBIDDEN'})});
 await reject(()=>run(t,revokedCommand),'FORBIDDEN');t.setHook(null);assert.equal(preview(t,revoked).existing,null);
 const asyncRecord=source(t,'async-check-source'),asyncCommand=cmd(preview(t,asyncRecord),selection);t.setHook(()=>Promise.resolve());
 await reject(()=>run(t,asyncCommand),'INVALID_REQUEST');t.setHook(null);assert.equal(preview(t,asyncRecord).existing,null);
 const aborted=new AbortController();aborted.abort();await reject(()=>t.app.bridge.importServiceRecord({...ctx,signal:aborted.signal},asyncCommand),'CANCELLED');assert.equal(preview(t,asyncRecord).existing,null);
 // Fill the SAME request near its limit only after source resolution, immediately
 // before write admission via the trusted clock. Reserve failure must roll back all rows.
 const reserveRecord=source(t,'reserve-source'),reserveCommand=cmd(preview(t,reserveRecord),selection),reserveCounts=counts(t),reserveReceipts=receipts(t);
 let exhausted=false;t.setClockHook(()=>{if(!exhausted){exhausted=true;const b=t.budget();b.bytes=b.maxBytes-128*1024}});
 await assert.rejects(()=>run(t,reserveCommand),e=>e.code==='RATE_LIMITED'&&e.message==='Projection publication reserve exhausted before commit');
 t.setClockHook(null);assert.equal(exhausted,true);assert.deepEqual(counts(t),reserveCounts);assert.equal(receipts(t),reserveReceipts);assert.equal(preview(t,reserveRecord).existing,null);
 // A controlled monotonic clock leaves two real milliseconds at the initial await.
 // The late synthetic resolver is allowed to settle; it cannot publish or commit.
 const slowRecord=source(t,'slow-source'),slowCommand=cmd(preview(t,slowRecord),selection),slowCounts=counts(t),slowReceipts=receipts(t);
 const originalPerformance=Object.getOwnPropertyDescriptor(globalThis,'performance');let instant=1000,authorityChecks=0,lateSettled=false,lateAborted=false;
 Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>instant}});
 t.setAuthorityHook(()=>{if(++authorityChecks===2)instant=30998});
 t.setResolver((observed,args)=>new Promise(resolve=>setTimeout(()=>{lateSettled=true;lateAborted=args[0].signal.aborted;resolve(observed)},25)));
 try{
  const slowController=new AbortController();await reject(()=>t.app.bridge.importServiceRecord({...ctx,signal:slowController.signal},slowCommand),'RATE_LIMITED');assert.equal(getEventListeners(slowController.signal,'abort').length,0);
  await new Promise(resolve=>setTimeout(resolve,35));assert.equal(lateSettled,true);assert.equal(lateAborted,true);
 }finally{t.setResolver(null);t.setAuthorityHook(null);Object.defineProperty(globalThis,'performance',originalPerformance)}
 assert.deepEqual(counts(t),slowCounts);assert.equal(receipts(t),slowReceipts);assert.equal(preview(t,slowRecord).existing,null);
 // Explicit abort during an awaited initial source has the same late-result fence.
 const waiting=new AbortController();let abortSettled=false,abortSignal=false;
 t.setResolver((observed,args)=>new Promise(resolve=>setTimeout(()=>{abortSettled=true;abortSignal=args[0].signal.aborted;resolve(observed)},25)));
 const abortTimer=setTimeout(()=>waiting.abort(),2);
 try{await reject(()=>t.app.bridge.importServiceRecord({...ctx,signal:waiting.signal},slowCommand),'CANCELLED');await new Promise(resolve=>setTimeout(resolve,35));assert.equal(abortSettled,true);assert.equal(abortSignal,true);assert.equal(getEventListeners(waiting.signal,'abort').length,0)}finally{clearTimeout(abortTimer);t.setResolver(null)}
 assert.deepEqual(counts(t),slowCounts);assert.equal(receipts(t),slowReceipts);assert.equal(preview(t,slowRecord).existing,null);
 // Trusted additive domain hook: lowered caps remain immutable, counters are not reset,
 // excessive caps and exhausted/expired shared budgets fail before ordinary work.
 const {ServiceReportDomain}=await import(pathToFileURL(join(build,'server/service-report-domain.mjs')));
 const {chargeServiceRead}=await import(pathToFileURL(join(build,'server/service-report-store.mjs')));
 const low=()=>({rows:0,bytes:0,sourceBytes:0,maxRows:50,maxBytes:1024,maxSourceBytes:1024});
 const ownerPort={observeOwner(_ctx,b){chargeServiceRead(b,32);return {check(){}}}};
 const shared=low(),hookDomain=new ServiceReportDomain({},ownerPort,{}, {requestBudget:shared,requestDeadline:performance.now()+1000});
 hookDomain.scope(ctx);assert.equal(shared.rows,1);hookDomain.scope(ctx);assert.equal(shared.rows,2);assert.equal(shared.maxRows,50);assert.throws(()=>{shared.maxRows=6000},TypeError);for(const key of ['maxRows','maxBytes','maxSourceBytes']){assert.equal(Object.getOwnPropertyDescriptor(shared,key).configurable,false);assert.equal(Object.getOwnPropertyDescriptor(shared,key).writable,false);assert.throws(()=>Object.defineProperty(shared,key,{value:shared[key]+1}),TypeError)}
 assert.throws(()=>new ServiceReportDomain({},ownerPort,{}, {requestBudget:{...low(),rows:-1}}).scope(ctx),e=>e.code==='INVALID_REQUEST');
 assert.throws(()=>new ServiceReportDomain({},ownerPort,{}, {requestBudget:{...low(),maxBytes:25*1024*1024}}).scope(ctx),e=>e.code==='INVALID_REQUEST');
 assert.throws(()=>new ServiceReportDomain({},ownerPort,{}, {requestBudget:{...low(),rows:50}}).scope(ctx),e=>e.code==='RATE_LIMITED');
 assert.throws(()=>new ServiceReportDomain({},ownerPort,{}, {requestBudget:{...low(),sourceBytes:1025}}).scope(ctx),e=>e.code==='RATE_LIMITED');
 assert.throws(()=>new ServiceReportDomain({},ownerPort,{}, {requestDeadline:performance.now()-1}).scope(ctx),e=>e.code==='RATE_LIMITED');
 // Model a bounded, expensive ordinary snapshot. Rechecks must charge the SAME request.
 let meter;const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
 const fakeStore={readBounded(_ctx,_limit,fn,usage){usage.rows+=3100;usage.bytes+=128;return fn({get(kind,key){return kind==='service-record'?{id:key,revision:1,data:{organizationId:'org',contactId:null,summary:'Synthetic',activity:'meeting',occurredAt:'2026-10-05T12:00:00.000Z'}}:{id:key,revision:1}}})}};
 const budgetBridge=serviceRecordBridge({store:fakeStore,reportsStore:{read(_ctx,b,fn){meter=b;return fn({list:()=>[]})}},owners:ownerPort,sources:{},scope,pin:t.app.identity.syntheticSourcePin,hash,error:(code,message)=>{throw Object.assign(Error(message),{code})},charge:chargeServiceRead,observeProjectionAuthority:()=>({value:{documentStoreScope:null,capabilities:{localDocuments:false,syntheticFixture:true},policyVersion:1},check(){}})});
 assert.throws(()=>budgetBridge.previewServiceRecord(ctx,{schema:2,scope,sourceId:'budget-fixture'}),e=>e.code==='RATE_LIMITED');assert(meter.rows>6000);
 assert(readFileSync(join(import.meta.dirname,'server.mjs'),'utf8').includes("input.schema===2&&['previewServiceRecord','importServiceRecord'].includes(m[2])"));
 console.log('PASS projection local sources: actual synthetic TXT/SQLite create, correction, exact receipt retry, no-op, current authorization, publication and legacy compatibility');
}finally{for(const app of live.reverse())app.close();rmSync(root,{recursive:true,force:true})}
