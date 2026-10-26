import {createHash,randomUUID} from 'node:crypto';
import type {ServerContext} from '../shared/contracts';
import type {JsonValue} from '../shared/workspace';
import {DomainStore} from './workspace-store';
import * as P from '../shared/manual-inventory-protocol';
const protocol=P.MANUAL_INVENTORY_PROTOCOL;
export const manualInventoryError=(code:string):Error & {code:string}=>Object.assign(new Error('Manual inventory operation unavailable'),{code});
const fail=(code:string):never=>{throw manualInventoryError(code)};
const valid=<T>(value:T|null):T=>value??fail('INVALID_REQUEST');
const synchronousCheck=(check:()=>unknown)=>{if(check()!==undefined)fail('SOURCE_UNAVAILABLE');};
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
type Source={observer:P.ManualInventoryObserver<ServerContext>;probe:(ctx:ServerContext)=>{available:boolean;documentStoreScope:string|null}};
type Options={identityScope:string;assertOwner:(ctx:ServerContext)=>void;source:Source|null;now?:()=>string;monotonicNow?:()=>number};
/** Dedicated synchronous manual command. Never dispatches generic automation execution. */
export class ManualInventoryDomain {
  private now:()=>string;private monotonic:()=>number;
  constructor(private store:DomainStore,private options:Options){this.now=options.now??(()=>new Date().toISOString());this.monotonic=options.monotonicNow??(()=>{if(typeof globalThis.performance?.now!=='function')fail('SOURCE_UNAVAILABLE');const value=globalThis.performance.now();if(!Number.isFinite(value))fail('SOURCE_UNAVAILABLE');return value;});}
  private authority(ctx:ServerContext,input?:{identityScope:string;automationStoreScope:string}) {
    this.options.assertOwner(ctx);const scope=this.store.manualInventoryIdentity(ctx);
    if(input&&(input.identityScope!==this.options.identityScope||input.automationStoreScope!==scope))fail('AUTHORITY_UNAVAILABLE');
    return scope;
  }
  private budget(historical=false):P.ManualInventoryBudget {
    const start=this.monotonic();let bytes=0,records=0;
    const check=()=>{const elapsed=this.monotonic()-start;if(elapsed<0||elapsed>5000)fail('BUDGET_EXCEEDED');};
    return {check,charge(n,r=0){check();if(!Number.isSafeInteger(n)||n<0||!Number.isSafeInteger(r)||r<0)fail('BUDGET_EXCEEDED');bytes+=n;records+=r;if(bytes>(historical?2097152:3145728)||records>(historical?1552:2307))fail('BUDGET_EXCEEDED');}};
  }
  private source():Source{return this.options.source??fail('SOURCE_UNAVAILABLE');}
  private eligible(ctx:ServerContext,input:P.ManualInventoryPreviewRequest) {
    const {schedule,skill}=this.store.manualInventoryDefinitions(ctx,input.scheduleId,input.skillId);
    if(!schedule||!skill||schedule.revision!==input.scheduleRevision||skill.revision!==input.skillRevision||schedule.data.skillId!==input.skillId||schedule.data.enabled!==true||skill.data.enabled!==true||schedule.data.state!=='active')fail('DEFINITION_CONFLICT');
    if(skill.data.handler!=='local-document-inventory'||!Array.isArray(schedule.data.sourceIds)||schedule.data.sourceIds.length!==0)fail('UNSUPPORTED_DEFINITION');
  }
  capabilities(ctx:ServerContext,raw:unknown) {
    valid(P.parseManualInventoryCapabilitiesRequest(raw));const automationStoreScope=this.authority(ctx);
    const state=this.options.source?.probe(ctx)??{available:false,documentStoreScope:null};
    const result=valid(P.parseManualInventoryCapabilities({protocol,identityScope:this.options.identityScope,automationStoreScope,documentStoreScope:state.available?state.documentStoreScope:null,manualDocumentInventory:{available:state.available,protocol,maxDocuments:250,maxResultBytes:262144}}));
    this.authority(ctx);return result;
  }
  preview(ctx:ServerContext,raw:unknown) {
    const input=valid(P.parseManualInventoryPreviewRequest(raw));this.authority(ctx,input);this.eligible(ctx,input);
    const budget=this.budget(),observation=this.source().observer.observe(ctx,{documentStoreScope:input.documentStoreScope,selection:input.selection},budget);
    try {
      const result=valid(P.parseManualInventoryPreview({...input,inventoryDigest:observation.inventoryDigest,observedAt:observation.observedAt,count:observation.rows.length,totalBytes:P.sumManualInventoryBytes(observation.rows)}));
      synchronousCheck(()=>observation.checkCurrent());this.eligible(ctx,input);this.authority(ctx,input);budget.check();return result;
    }finally{observation.close();}
  }
  execute(ctx:ServerContext,raw:unknown) {
    const input=valid(P.parseManualInventoryExecuteRequest(raw));this.authority(ctx,input);
    const requestDigest=hash(P.canonicalManualInventoryCommand(input)),budget=this.budget();
    return this.store.writeManualInventoryCommand(ctx,{operationId:input.operationId,requestDigest},{
      decodeProof:value=>valid(P.parseManualInventoryProof(value)),check:()=>{this.authority(ctx,input);budget.check();},
      prepare:()=>{
        this.eligible(ctx,input);const observation=this.source().observer.observe(ctx,{documentStoreScope:input.documentStoreScope,selection:input.selection},budget);
        try {
          if(observation.inventoryDigest!==input.inventoryDigest)fail('INVENTORY_CHANGED');
          const runId=randomUUID(),resultId=randomUUID(),completedAt=this.now();
          const binding={identityScope:input.identityScope,automationStoreScope:input.automationStoreScope,documentStoreScope:input.documentStoreScope,scheduleId:input.scheduleId,scheduleRevision:input.scheduleRevision,skillId:input.skillId,skillRevision:input.skillRevision,selection:input.selection};
          const payloadValue={protocol,resultId,runId,binding,observedAt:observation.observedAt,completedAt,count:observation.rows.length,totalBytes:P.sumManualInventoryBytes(observation.rows),inventoryDigest:input.inventoryDigest,documents:observation.rows};
          if(Buffer.byteLength(JSON.stringify(payloadValue))>262144)fail('RESULT_TOO_LARGE');
          const payload=P.serializeManualInventoryResult(payloadValue);
          const runData=valid(P.parseManualInventoryRunData({scheduleId:input.scheduleId,skillId:input.skillId,trigger:'manual',scheduledAt:completedAt,coalescedFrom:null,retryOf:null,state:'completed',intent:null,attempt:1,lease:null,startedAt:observation.observedAt,finishedAt:completedAt,code:'manual_inventory_saved',detail:null,result:{kind:'local-document-inventory',resultId},manualInventory:{protocol,identityScope:input.identityScope,automationStoreScope:input.automationStoreScope,documentStoreScope:input.documentStoreScope,scheduleRevision:input.scheduleRevision,skillRevision:input.skillRevision,selection:input.selection,inventoryDigest:input.inventoryDigest}}));
          const proof=valid(P.parseManualInventoryProof({protocol,operationId:input.operationId,requestDigest,state:'committed',runId,resultId,committedAt:completedAt}));
          return {proof,resultId,runId,payload,runData:runData as unknown as JsonValue,completedAt,check:()=>{this.eligible(ctx,input);synchronousCheck(()=>observation.checkCurrent());budget.check();},close:()=>observation.close()};
        }catch(cause){observation.close();throw cause;}
      },
      rejection:cause=>{const code=(cause as {code?:P.ManualInventoryRejectionCode})?.code;return code&&P.MANUAL_INVENTORY_REJECTION_CODES.includes(code)?{protocol,operationId:input.operationId,requestDigest,state:'rejected',code,messageKey:P.manualInventoryMessageKey(code)}:null;},
    });
  }
  operation(ctx:ServerContext,raw:unknown) {
    const input=valid(P.parseManualInventoryExecuteRequest(raw));this.authority(ctx,input);
    const requestDigest=hash(P.canonicalManualInventoryCommand(input));
    const proof=this.store.readManualInventoryProof(ctx,input.operationId,requestDigest,value=>valid(P.parseManualInventoryProof(value)));
    this.authority(ctx,input);return proof??{state:'absent',protocol,operationId:input.operationId,requestDigest};
  }
  /** Sensitive bytes remain buffered; routes call publish immediately before headers, then close. */
  result(ctx:ServerContext,raw:unknown) {
    const budget=this.budget(true);const input=valid(P.parseManualInventoryResultRequest(raw));this.authority(ctx,input);budget.check();
    let access:P.ManualInventoryAccessObservation|undefined;
    try {
      const encoded=this.store.readManualInventoryResult(ctx,input.runId,input.resultId);
      const value=valid(P.parseManualInventoryResultPayload(JSON.parse(encoded)));
      if(value.runId!==input.runId||value.resultId!==input.resultId||value.binding.identityScope!==input.identityScope||value.binding.automationStoreScope!==input.automationStoreScope||P.serializeManualInventoryResult(value)!==encoded||hash(P.canonicalInventorySource(value.binding.documentStoreScope,value.binding.selection,value.documents))!==value.inventoryDigest)fail('RESULT_ACCESS_UNAVAILABLE');
      budget.check();
      access=this.source().observer.authorizeHistorical(ctx,{documentStoreScope:value.binding.documentStoreScope,selection:value.binding.selection,rows:value.documents},budget);
      // authorizeHistorical performs the first access pass; only a final publication pass follows.
      const held=access;let closed=false;
      return {encoded,publish:()=>{if(closed)fail('RESULT_ACCESS_UNAVAILABLE');try{synchronousCheck(()=>held.checkAccess());this.authority(ctx,input);budget.check();}catch{fail('RESULT_ACCESS_UNAVAILABLE');}},close:()=>{if(!closed){closed=true;held.close();}}};
    }catch{access?.close();return fail('RESULT_ACCESS_UNAVAILABLE');}
  }
  history(ctx:ServerContext,raw:unknown) {
    const budget=this.budget();const input=valid(P.parseManualInventoryHistoryRequest(raw));this.authority(ctx,input);budget.check();
    const rows=this.store.listManualInventoryHistory(ctx,input) as {runId:string;completedAt:string;data:unknown}[];
    const parsed=rows.map(row=>{const d=valid(P.parseManualInventoryRunData(row.data));if(d.manualInventory.identityScope!==input.identityScope||d.manualInventory.automationStoreScope!==input.automationStoreScope||row.completedAt!==d.finishedAt||(input.scheduleId!==null&&d.scheduleId!==input.scheduleId))fail('HISTORY_UNAVAILABLE');return {runId:row.runId,resultId:d.result.resultId,scheduleId:d.scheduleId,scheduleRevision:d.manualInventory.scheduleRevision,skillId:d.skillId,skillRevision:d.manualInventory.skillRevision,completedAt:d.finishedAt,resultAccess:'not-checked' as const};});
    const items=parsed.slice(0,input.limit),last=items[items.length-1];
    const result=valid(P.parseManualInventoryHistoryPage({protocol,identityScope:input.identityScope,automationStoreScope:input.automationStoreScope,items,nextCursor:parsed.length>input.limit?{completedAt:last.completedAt,runId:last.runId}:null}));this.authority(ctx,input);budget.check();return result;
  }
}
