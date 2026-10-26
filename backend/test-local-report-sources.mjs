// Actual synthetic TXT/PDF upload handlers + SQLite + prepared production domains. No listener or private material.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {compose} from './composition.mjs';
import {researchDocuments} from './research-documents.mjs';
import {generatedPdf} from './synthetic-reader-pdf.mjs';
const root=mkdtempSync(join(tmpdir(),'local-report-sources-'));
const prepared=join(root,'prepared'),build=join(prepared,'runtime');
const live=[];
const budget=()=>({rows:0,bytes:0,sourceBytes:0,maxRows:6000,maxBytes:24*1024*1024,maxSourceBytes:64*1024*1024});
const rejects=(fn,code)=>assert.rejects(async()=>fn(),e=>e.code===code);
let sequence=0;
async function make(label){
 const storage=join(root,label);mkdirSync(storage);let documents,port,denied=false;
 const app=await compose(build,storage,{createLocalSources(authority){
  const workspace={get(kind,id){if(denied)throw Object.assign(Error('Synthetic denied workspace'),{code:'FORBIDDEN'});return authority.workspace.get(authority.context(),{kind,id})},list:()=>[]};
  documents=researchDocuments(storage,workspace);port=documents.createReportSourcePort(authority);return {resource:documents,port};
 }});live.push(app);return {app,documents,port,storage,deny:value=>{denied=value}};
}
async function request(target,method,url,data){
 const bytes=Buffer.isBuffer(data)?data:Buffer.from(JSON.stringify(data??{}));const req=Readable.from([bytes]);req.method=method;req.url=url;req.headers={'content-type':Buffer.isBuffer(data)?'application/octet-stream':'application/json'};
 let result,count=0;await target.documents.handle(req,(status,body)=>{count++;result={status,body}},(status,code,message)=>{count++;result={status,body:{code,message}}},()=>assert.fail('Unexpected binary download'));
 assert.equal(count,1);assert(result.status>=200&&result.status<300,JSON.stringify(result));return result.body;
}
async function upload(target,name,bytes,workspaceId){return (await request(target,'POST','/api/documents/upload?'+new URLSearchParams({name,...(workspaceId?{workspaceId}:{})}),bytes)).document}
async function change(target,doc,operation,extra={}){return (await request(target,'PUT',`/api/documents/${doc.id}/${operation}`,{revision:doc.revision,...extra})).document}
function choice(target,doc){const result=target.app.sourceChoices(target.app.context(),{});return {result,item:result.items.find(i=>i.documentId.endsWith(':'+doc.id))}}
function mutate(target,fn){const db=new DatabaseSync(join(target.storage,'research-documents.sqlite'));try{fn(db)}finally{db.close()}}
try{
 mkdirSync(prepared);const stat=lstatSync(prepared,{bigint:true});
 assert.equal(execFileSync(process.execPath,[join(import.meta.dirname,'prepare-backend.mjs'),'--owned-root',prepared,`${stat.dev}:${stat.ino}`],{encoding:'utf8',timeout:30000}).trim(),build);
 const t=await make('main'),ctx=t.app.context(),scope=t.app.identity.identityScope,customer={organizationId:'synthetic-org',contactId:null};
 let doc=await upload(t,'Public-safe synthetic.txt',Buffer.from('Synthetic research fixture. No private material.\nLocal text evidence.'));
 const pdf=await upload(t,'Public-safe synthetic.pdf',generatedPdf(1));
 const picked=choice(t,doc);assert(picked.item);assert.equal(picked.result.capabilities.localDocuments,true);assert(!JSON.stringify(picked.result).includes('Local text evidence'));
 const page=t.app.sourceChoices(ctx,{limit:1});assert.equal(page.items.length,1);assert.equal(page.nextOffset,1);
 assert.equal(t.app.sourceChoices(ctx,{offset:1,limit:1,storeScope:page.storeScope}).items.length,1);
 await rejects(()=>t.app.sourceChoices(ctx,{offset:1}), 'CONFLICT');
 await rejects(()=>t.app.sourceChoices(ctx,{limit:26}), 'INVALID_REQUEST');
 const inspected=await t.app.inspectSource(ctx,{documentId:picked.item.documentId,revisionId:picked.item.revisionId});inspected.checkPublication();
 await rejects(()=>t.app.inspectSource(ctx,{documentId:picked.item.documentId+'\n',revisionId:picked.item.revisionId}),'INVALID_REQUEST');
 const pin=inspected.pin;assert.equal(inspected.sourceKind,'local-document');assert.equal(inspected.locator.documentId,doc.id);
 const pdfChoice=choice(t,pdf).item;assert((await t.app.inspectSource(ctx,{documentId:pdfChoice.documentId,revisionId:pdfChoice.revisionId})).pin);
 const cmd=()=>({scope,idempotencyKey:`local-source-${++sequence}`});
 const activityValue={customer,kind:'research-support',status:'reported-completed',occurredAt:'2026-10-05T12:00:00.000Z',summary:'Manually recorded synthetic source usage',references:[{pin}]};
 const activity=(await t.app.reports.createActivity(ctx,{...cmd(),activity:activityValue})).activity;
 const report=(await t.app.reports.createReport(ctx,{...cmd(),customer,month:'2026-10',timeZone:'UTC',supersedes:null})).report;
 const openActivity={from:'activity',pin,referenceIndex:0,activityId:activity.id,expectedRevision:activity.revision,versionId:activity.versionId};
 const openReport={...openActivity,from:'report',reportId:report.id,expectedRevision:report.revision};
 let getterCalls=0;await rejects(()=>t.app.reports.openPinnedSource(ctx,{get from(){getterCalls++;return 'activity'}}),'INVALID_REQUEST');assert.equal(getterCalls,0);
 let opened=await t.app.reports.openPinnedSource(ctx,openActivity);opened.checkPublication();assert.equal(opened.document.body,'Synthetic research fixture. No private material.\nLocal text evidence.');assert.equal(opened.document.mock,false);assert(opened.document.tags.includes('original-hash-at-upload'));
 assert.deepEqual((await t.app.reports.openPinnedSource(ctx,openReport)).pin,pin);
 await rejects(()=>t.app.reports.openPinnedSource(ctx,{...openActivity,referenceIndex:1}),'CONFLICT');
 await rejects(()=>t.app.reports.openPinnedSource(ctx,{...openActivity,expectedRevision:99}),'CONFLICT');
 await rejects(()=>t.app.reports.openPinnedSource(ctx,{...openActivity,pin:{...pin,sha256:'0'.repeat(64)}}),'CONFLICT');
 const originalSnapshot=structuredClone(report.snapshot);
 const exported=await t.app.reports.exportReport(ctx,{reportId:report.id,expectedRevision:report.revision,format:'json'});exported.checkPublication();assert.deepEqual(JSON.parse(exported.content.toString()).snapshot,originalSnapshot);
 doc=await change(t,doc,'metadata',{name:'Renamed local fixture.txt',workspaceId:null,folderId:null});
 assert.throws(()=>opened.checkPublication(),e=>e.code==='CONFLICT');assert.throws(()=>inspected.checkPublication(),e=>e.code==='CONFLICT');assert.throws(()=>exported.checkPublication(),e=>e.code==='CONFLICT');
 assert.deepEqual((await t.app.inspectSource(ctx,{documentId:pin.documentId,revisionId:pin.revisionId})).pin,pin);
 assert.deepEqual((await t.app.reports.getReport(ctx,{id:report.id})).report.snapshot,originalSnapshot);
 const stale=await t.app.reports.openPinnedSource(ctx,openActivity);
 const corrected=(await t.app.reports.correctActivity(ctx,{...cmd(),id:activity.id,expectedRevision:activity.revision,activity:{...activityValue,summary:'Explicit synthetic correction'},reason:'Synthetic test correction'})).activity;
 assert.throws(()=>stale.checkPublication(),e=>e.code==='CONFLICT');
 assert.deepEqual((await t.app.reports.openPinnedSource(ctx,openReport)).pin,pin); // Report deliberately retains original activity version.
 const reportOpen=await t.app.reports.openPinnedSource(ctx,openReport);
 await t.app.reports.archiveReport(ctx,{...cmd(),id:report.id,expectedRevision:report.revision,archived:true});
 assert.throws(()=>reportOpen.checkPublication(),e=>e.code==='CONFLICT');await rejects(()=>t.app.reports.openPinnedSource(ctx,openReport),'CONFLICT');
 const trashGuard=await t.app.reports.openPinnedSource(ctx,{...openActivity,expectedRevision:corrected.revision,versionId:corrected.versionId});
 doc=await change(t,doc,'trash');assert.throws(()=>trashGuard.checkPublication(),e=>e.code==='NOT_FOUND');await rejects(()=>t.app.inspectSource(ctx,{documentId:pin.documentId,revisionId:pin.revisionId}),'NOT_FOUND');
 doc=await change(t,doc,'restore');
 const other=await make('other-store');await rejects(()=>other.app.inspectSource(other.app.context(),{documentId:pin.documentId,revisionId:pin.revisionId}),'CONFLICT');
 const unicodeDoc=await upload(other,'Unicode safe.txt',Buffer.from('a'.repeat(239)+'😀tail'));const unicodeChoice=choice(other,unicodeDoc).item;const unicodeSource=other.port.resolve(other.app.context(),unicodeChoice.documentId,unicodeChoice.revisionId,budget());assert.equal(unicodeSource.document.excerpt.isWellFormed(),true);
 await rejects(()=>t.app.inspectSource({...ctx,principal:{...ctx.principal,subjectId:'different-owner'}},{documentId:pin.documentId,revisionId:pin.revisionId}),'FORBIDDEN');
 await rejects(()=>t.app.inspectSource({...ctx,principal:{...ctx.principal,collectionIds:[]}},{documentId:pin.documentId,revisionId:pin.revisionId}),'FORBIDDEN');
 const controller=new AbortController();controller.abort();await rejects(()=>t.app.inspectSource({...ctx,signal:controller.signal},{documentId:pin.documentId,revisionId:pin.revisionId}),'CANCELLED');
 assert.throws(()=>t.port.resolve(ctx,pin.documentId,pin.revisionId,{...budget(),maxBytes:100}),e=>e.code==='RATE_LIMITED');
 const workspace=t.app.workspace.create(ctx,{kind:'workspace',id:'source-workspace',idempotencyKey:'source-workspace',data:{name:'Synthetic source workspace'}});
 doc=await change(t,doc,'metadata',{name:doc.name,workspaceId:workspace.id,folderId:null});
 const workspaceGuard=t.port.resolve(ctx,pin.documentId,pin.revisionId,budget());t.deny(true);assert.throws(()=>workspaceGuard.check(),e=>e.code==='FORBIDDEN');t.deny(false);
 doc=await change(t,doc,'metadata',{name:doc.name,workspaceId:null,folderId:null});assert.throws(()=>workspaceGuard.check(),e=>e.code==='CONFLICT');
 const missingGuard=t.port.resolve(ctx,pin.documentId,pin.revisionId,budget());
 mutate(t,db=>db.prepare('UPDATE research_documents SET workspace_id=?,revision=revision+1 WHERE id=?').run('missing-workspace',doc.id));
 assert.throws(()=>missingGuard.check(),e=>e.code==='CONFLICT');await rejects(()=>t.app.inspectSource(ctx,{documentId:pin.documentId,revisionId:pin.revisionId}),'CONFLICT');
 mutate(t,db=>db.prepare('UPDATE research_documents SET workspace_id=NULL,revision=revision+1 WHERE id=?').run(doc.id));
 const nowDescriptor=Object.getOwnPropertyDescriptor(performance,'now');const realNow=performance.now.bind(performance);let future=0;
 Object.defineProperty(performance,'now',{configurable:true,value:()=>realNow()+future});
 try{const deadlineGuard=t.port.resolve(ctx,pin.documentId,pin.revisionId,budget());future=30001;assert.throws(()=>deadlineGuard.check(),e=>e.code==='RATE_LIMITED')}finally{if(nowDescriptor)Object.defineProperty(performance,'now',nowDescriptor);else delete performance.now}
 const storeGuard=t.port.resolve(ctx,pin.documentId,pin.revisionId,budget());const storeScope=t.port.storeScope;mutate(t,db=>db.prepare('UPDATE document_upload_identity SET scope=?').run(randomUUID()));assert.throws(()=>storeGuard.check(),e=>e.code==='CONFLICT');mutate(t,db=>db.prepare('UPDATE document_upload_identity SET scope=?').run(storeScope));
 console.log('PASS actual local report source: TXT/PDF upload, choices, exact pin, create/read/open/export, immutable history and publication fences');
 // Deliberate corruption only in this fresh synthetic store, never a user store.
 mutate(t,db=>{db.exec('DROP TRIGGER document_immutable_update');db.prepare('UPDATE research_documents SET text=? WHERE id=?').run('X'.repeat(doc.bytes),doc.id)});
 await rejects(()=>t.app.inspectSource(ctx,{documentId:pin.documentId,revisionId:pin.revisionId}),'CONFLICT');
 mutate(t,db=>db.prepare('UPDATE research_documents SET text_bytes=? WHERE id=?').run(1024*1024+1,doc.id));await rejects(()=>t.app.inspectSource(ctx,{documentId:pin.documentId,revisionId:pin.revisionId}),'CONFLICT');
 const failedStorage=join(root,'failed-compose');mkdirSync(failedStorage);let closes=0;
 await rejects(()=>compose(build,failedStorage,{createLocalSources:()=>({resource:{close(){closes++}},port:{}})}),'INVALID_REQUEST');assert.equal(closes,1);
 const closedGuard=other.port;other.app.close();live.splice(live.indexOf(other.app),1);assert.throws(()=>closedGuard.choices(other.app.context(),{},budget()),e=>e.code==='UNAVAILABLE');
 console.log('PASS local authority: store/owner/collection/abort/budget/association/closed-port/corrupt-text fail closed; original binary verification remains download-only');
}finally{for(const app of live.reverse())app.close();rmSync(root,{recursive:true,force:true})}
