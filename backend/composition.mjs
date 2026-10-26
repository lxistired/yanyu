import {performance} from 'node:perf_hooks';
import {definitionBridge} from './automation-definitions.mjs';
import {serviceRecordBridge} from './service-record-bridge.mjs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {existsSync,writeFileSync} from 'node:fs';
export async function compose(build,storage,{clock,createLocalSources}={}){
 const load=p=>import(pathToFileURL(join(build,p)));
 const {DomainStore,organizationCommandRejection,automationCommandRejection,workspaceCommandRejection}=await load('server/workspace-store.mjs'),{WorkspaceDomain}=await load('server/workspace-domain.mjs'),{OrganizationDomain}=await load('server/organization-domain.mjs');
 const manualProtocol=await load('shared/manual-inventory-protocol.mjs');
 const {ManualInventoryDomain,manualInventoryError}=await load('server/manual-inventory-domain.mjs');
 const {ServiceReportDomain}=await load('server/service-report-domain.mjs'),{SqliteServiceReportRepository,chargeServiceRead}=await load('server/service-report-store.mjs'),{AdapterError}=await load('shared/contracts.mjs'),{readerCanonical,readerDocumentIdentity}=await load('shared/reader-reference.mjs');
 let store,reportsStore,localResource;
 const closeStores=()=>{const failures=[];for(const resource of [localResource,reportsStore,store])try{resource?.close()}catch(error){failures.push(error)}if(failures.length)throw new AggregateError(failures,'Composed store close failed')};
 try{
 store=new DomainStore(storage);reportsStore=new SqliteServiceReportRepository(storage);
 const workspace=new WorkspaceDomain(store),organization=new OrganizationDomain(store);
 const principal=Object.freeze({tenantId:'synthetic-http-tenant',subjectId:'synthetic-http-owner',collectionIds:Object.freeze(['synthetic-collection'])});
 const context=()=>({principal,signal:new AbortController().signal,requestId:crypto.randomUUID()});
 const error=(code,message)=>{throw new AdapterError(code,message)};
 const hash=x=>createHash('sha256').update(readerCanonical(x)).digest('hex');
 const bounded=(ctx,budget,action)=>{const usage={rows:0,bytes:0};try{return store.readBounded(ctx,{maxRows:Math.max(1,Math.min(6000,budget.maxRows-budget.rows)),maxBytes:Math.max(1,Math.min(24*1024*1024,budget.maxBytes-budget.bytes))},action,usage)}finally{chargeServiceRead(budget,usage.bytes,usage.rows)}};
 const owner=ctx=>{if(ctx.signal.aborted)error('CANCELLED','Operation cancelled');if(ctx.principal.tenantId!==principal.tenantId||ctx.principal.subjectId!==principal.subjectId||JSON.stringify(ctx.principal.collectionIds)!==JSON.stringify(principal.collectionIds))error('FORBIDDEN','Synthetic owner changed')};
 const owners={observeOwner(ctx,budget){chargeServiceRead(budget,32);owner(ctx);return {check:()=>owner(ctx)}},observeCustomer(ctx,ref,budget){
  const read=()=>bounded(ctx,budget,tx=>{const org=tx.get('organization',ref.organizationId),contact=ref.contactId===null?null:tx.get('crm-contact',ref.contactId);if(contact&&contact.data.organizationId!==org.id)error('FORBIDDEN','Contact belongs to another organization');return {organizationId:org.id,contactId:contact?.id??null,organizationRevision:org.revision,contactRevision:contact?.revision??null}});
  owner(ctx);const customer=read();return {customer,check(){owner(ctx);if(readerCanonical(read())!==readerCanonical(customer))error('CONFLICT','Customer changed during report operation')}};
 }};
 const document={id:'synthetic-doc',revisionId:'v1',tenantId:principal.tenantId,collectionId:'synthetic-collection',title:'合成来源 · 本地集成验证',source:'research',author:'Synthetic author',date:'2026-10-01',tags:['synthetic'],excerpt:'Synthetic excerpt',body:'Synthetic content only. No provider lookup or external delivery.',pages:1,mock:true};
 const pin={documentId:document.id,revisionId:document.revisionId,tenantId:document.tenantId,collectionId:document.collectionId,sha256:hash(readerDocumentIdentity(document))};
 const initialAutomationScope=store.manualInventoryIdentity(context());
 const manualAuthority=Object.freeze({assertCurrent(ctx){owner(ctx);if(store.manualInventoryIdentity(ctx)!==initialAutomationScope)throw manualInventoryError('AUTHORITY_UNAVAILABLE');},workspaceExists(ctx,id,budget){budget.check();owner(ctx);budget.charge(192,1);const exists=store.manualInventoryWorkspaceExists(ctx,id);budget.check();return exists;},monotonicNow:()=>performance.now(),now:()=>new Date().toISOString(),error:manualInventoryError});
 const manualProtocolPort=Object.freeze({...manualProtocol,sha256Utf8:value=>createHash('sha256').update(value,'utf8').digest('hex')});
 const local=createLocalSources?createLocalSources({workspace,context,principal,collectionId:principal.collectionIds[0],assertOwner:owner,charge:chargeServiceRead,error,manualInventoryAuthority:manualAuthority,manualInventoryProtocol:manualProtocolPort}):null;
 localResource=local?.resource;
 if(local&&(!localResource||typeof localResource.close!=='function'||typeof local.port?.resolve!=='function'||typeof local.port?.choices!=='function'))error('INVALID_REQUEST','Invalid local source factory');
 const sources={async resolve(ctx,id,revision,budget){chargeServiceRead(budget,64);owner(ctx);if(id===document.id&&revision===document.revisionId)return {document:structuredClone(document),evidenceClass:'primary-source',authorizationMode:'current-local',check:()=>owner(ctx)};if(local&&typeof id==='string'&&id.startsWith('local-doc:'))return local.port.resolve(ctx,id,revision,budget);error('NOT_FOUND','Source is not admitted')}};
 const sourceBudget=()=>({rows:0,bytes:0,sourceBytes:0,maxRows:6000,maxBytes:24*1024*1024,maxSourceBytes:64*1024*1024});
 function sourceChoices(ctx,input){owner(ctx);const capabilities={localDocuments:!!local,syntheticFixture:true};if(local)return {scope,capabilities,...local.port.choices(ctx,input,sourceBudget())};if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['offset','limit','storeScope'].includes(k))||input.offset!==undefined&&input.offset!==0||input.storeScope!==undefined&&input.storeScope!==null||input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>25))error('INVALID_REQUEST','Local sources are unavailable');return {scope,capabilities,storeScope:null,items:[],nextOffset:null};}
 async function inspectSource(ctx,input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='documentId,revisionId'||typeof input.documentId!=='string'||typeof input.revisionId!=='string'||input.documentId.length>500||input.revisionId.length>500)error('INVALID_REQUEST','Exact document and revision identities required');
  if(!(input.documentId===document.id&&input.revisionId===document.revisionId)&&!input.documentId.startsWith('local-doc:'))error('INVALID_REQUEST','Source is not admitted');
  const observation=await sources.resolve(ctx,input.documentId,input.revisionId,sourceBudget());
  const d=observation.document;
  if(observation.evidenceClass!=='primary-source'||observation.authorizationMode!=='current-local'||d.id!==input.documentId||d.revisionId!==input.revisionId||d.tenantId!==ctx.principal.tenantId||!ctx.principal.collectionIds.includes(d.collectionId))error('FORBIDDEN','Source authority does not match current scope');
  const selected={documentId:d.id,revisionId:d.revisionId,tenantId:d.tenantId,collectionId:d.collectionId,sha256:hash(readerDocumentIdentity(d))};
  observation.check();return {scope,pin:selected,...(observation.locator?{sourceKind:'local-document',locator:observation.locator}:{}),checkPublication:()=>observation.check()};
 }

 const reports=new ServiceReportDomain(reportsStore,owners,sources,{clock});
 const scope=reports.scope(context()).scope;
 const manualInventory=new ManualInventoryDomain(store,{identityScope:scope,assertOwner:owner,source:local?.manualInventory??null});
 function customers(ctx,input){
  if(Object.keys(input).some(k=>!['after','censusSha256'].includes(k)))error('INVALID_REQUEST','Unexpected customer field');
  if(input.after!==undefined&&input.after!==null&&(typeof input.after!=='string'||!/^[0-9]{1,5}$/.test(input.after)))error('INVALID_REQUEST','Invalid customer cursor');
  const rows=store.readBounded(ctx,{maxRows:6000,maxBytes:24*1024*1024},tx=>({orgs:tx.list('organization'),contacts:tx.list('crm-contact')}));
  const byId=new Map(rows.orgs.map(o=>[o.id,o]));
  const items=rows.orgs.map(o=>({pin:{organizationId:o.id,contactId:null,organizationRevision:o.revision,contactRevision:null},organizationName:o.data.name,contactName:null}));
  for(const c of rows.contacts){const o=byId.get(c.data.organizationId);if(o)items.push({pin:{organizationId:o.id,contactId:c.id,organizationRevision:o.revision,contactRevision:c.revision},organizationName:o.data.name,contactName:c.data.name})}
  items.sort((a,b)=>readerCanonical(a.pin).localeCompare(readerCanonical(b.pin)));const censusSha256=hash(items);
  if(input.censusSha256!==undefined&&input.censusSha256!==censusSha256)error('CONFLICT','Customer census changed');
  const offset=Number(input.after||0);if(offset>items.length)error('INVALID_REQUEST','Invalid customer cursor');const page=items.slice(offset,offset+25);
  if(Buffer.byteLength(JSON.stringify(page))>256*1024)error('RATE_LIMITED','Customer page exceeds byte budget');
  return {scope,items:page,nextAfter:offset+page.length<items.length?String(offset+page.length):null,censusSha256};
 }
 // Only bootstrap a fresh private store. Restart never reseeds deleted user-visible rows.
 const marker=join(storage,'integration-seeded.json');
 if(!existsSync(marker)){
  const ctx=context(),org=organization.create(ctx,{kind:'organization',id:'synthetic-org',idempotencyKey:'integration-seed-org',data:{name:'合成客户 · 本地持久化演示'}});
  for(let n=1;n<=3;n++)await reports.createActivity(ctx,{scope,idempotencyKey:`integration-seed-activity-${n}`,activity:{customer:{organizationId:org.id,contactId:null},kind:'meeting',status:'reported-completed',occurredAt:'2026-10-03T09:15:00.000Z',summary:`合成服务活动 ${n}`,references:[{pin}]}});
  writeFileSync(marker,JSON.stringify({synthetic:true,organizationId:org.id}));
 }
 const {ManualPlanDomain}=await load('server/manual-plan-domain.mjs');
 const manualPlans=new ManualPlanDomain(store);
 const {AutomationDomain}=await load('server/automation-domain.mjs');
 const automation=definitionBridge(new AutomationDomain(store),store,AdapterError);
 function observeProjectionAuthority(ctx,budget){
  owner(ctx);chargeServiceRead(budget,64);local?.port.check(ctx,budget);
  const value={documentStoreScope:local?.port.storeScope??null,capabilities:{localDocuments:!!local,syntheticFixture:true},policyVersion:1};
  return {value,check(){owner(ctx);chargeServiceRead(budget,64);local?.port.check(ctx,budget)}};
 }
 const bridge=serviceRecordBridge({store,reportsStore,ServiceReportDomain,owners,sources,scope,pin,hash,error,clock,charge:chargeServiceRead,documentIdentity:readerDocumentIdentity,observeProjectionAuthority});
 return {manualInventory,workspace,organization,organizationCommandRejection,automationCommandRejection,workspaceCommandRejection,manualPlans,reports,bridge,automation,customers,sourceChoices,inspectSource,context,identity:{identityScope:scope,synthetic:true,syntheticSourcePin:pin},close:closeStores};
 }catch(error){try{closeStores()}catch(rollback){throw new AggregateError([error,rollback],'Composition and rollback failed')}throw error}
}
