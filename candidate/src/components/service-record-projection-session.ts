import { readerCanonical } from '../../shared/reader-reference';
import {
  createServiceReportsClient, requireServiceProjectionImport, ServiceReportsClientError,
  type ServiceReportsActor, type ServiceReportsClient, type ServiceProjectionPreview,
  type ServiceProjectionImport, type ServiceProjectionResult, type ServiceSourceChoicesPage,
  type ServiceSourceSelection,
} from '../adapters/service-reports';
const equal=(a:unknown,b:unknown)=>readerCanonical(a)===readerCanonical(b);
const freeze=<T,>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const error=(code:'FORBIDDEN'|'CONFLICT'|'PENDING'|'INVALID_REQUEST'|'INVALID_RESPONSE'|'CANCELLED'):never=>{throw new ServiceReportsClientError(code);};
type Pending = Readonly<{ command: ServiceProjectionImport; preview: ServiceProjectionPreview; actor: ServiceReportsActor }>;
export type ProjectionState = Readonly<{
  preview: ServiceProjectionPreview|null; page: ServiceSourceChoicesPage|null; selection: ServiceSourceSelection|null;
  status: ServiceProjectionImport['status']|''; reason:string; busy:boolean; problem:string; result:string; pending:Pending|null;
}>;
const initial=():ProjectionState=>({preview:null,page:null,selection:null,status:'',reason:'',busy:false,problem:'',result:'',pending:null});
/** Host-owned in-memory recovery, separate from ordinary write and generic report commands.
 * Abort withdraws presentation; it never claims a submitted write was rolled back. */
export class ServiceRecordProjectionSession {
  readonly client:ServiceReportsClient;
  private value:ProjectionState=initial();private listeners=new Set<()=>void>();
  private visible=false;private route=-1;private epoch=0;private detached=false;
  private controller:AbortController|null=null;private draftSourceId:string|null=null;
  constructor(private readonly actor:ServiceReportsActor,private readonly getActor:()=>ServiceReportsActor|null,fetch:typeof globalThis.fetch=globalThis.fetch){
    this.actor=freeze({...actor});this.client=createServiceReportsClient({fetch,getActor});
  }
  get state(){return this.value;}
  get available(){try{return !this.detached&&this.visible&&equal(this.getActor(),this.actor);}catch{return false;}}
  subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};
  private set(patch:Partial<ProjectionState>){this.value=freeze({...this.value,...patch});for(const f of this.listeners)f();}
  private check(){if(!this.available)error('FORBIDDEN');}
  unsavedState(){return {dirty:Boolean(this.value.preview&&(this.value.status||this.value.reason||this.value.selection)),pending:this.value.pending!==null};}
  setView(visible:boolean,route:number){
    if(this.visible===visible&&this.route===route)return;
    this.visible=visible;this.route=route;this.epoch++;this.controller?.abort();this.client.invalidateReads();
    this.set({preview:null,page:null,selection:null,busy:false,problem:this.value.pending?'原提交尚未确认。重新进入后可核对完全相同的提交；离开不代表撤销。':'',result:''});
  }
  dispose(){this.detached=true;this.epoch++;this.controller?.abort();this.client.withdraw();this.value=initial();for(const f of this.listeners)f();this.listeners.clear();}
  setDraft(status:ProjectionState['status'],reason:string){this.check();if(this.value.pending||this.value.busy)error('PENDING');if(!['','planned','reported-completed','cancelled'].includes(status)||reason.length>500)error('INVALID_REQUEST');this.set({status,reason});}
  /** Accepted UI discard affects only an unsubmitted draft. Pending writes remain exact. */
  discardUnsubmittedDraft(){
    this.check();if(this.value.pending)return;
    this.epoch++;this.controller?.abort();this.client.invalidateReads();this.draftSourceId=null;
    this.set({preview:null,page:null,selection:null,busy:false,problem:'',result:'',status:'',reason:''});
  }
  cancelPreview(){this.check();if(this.value.pending)error('PENDING');this.epoch++;this.controller?.abort();this.client.invalidateReads();this.set({preview:null,page:null,selection:null,busy:false,problem:'',status:'',reason:''});}
  private async read<T>(work:(signal:AbortSignal)=>Promise<T>,apply:(value:T)=>void){
    this.check();const generation=++this.epoch;this.controller?.abort();this.client.invalidateReads();const controller=new AbortController();this.controller=controller;
    this.set({busy:true,problem:'',result:''});
    try{const value=await work(controller.signal);this.check();if(generation!==this.epoch)error('CANCELLED');apply(value);}
    catch(e){if(generation===this.epoch&&this.available)this.set({problem:`${e instanceof Error?e.message:'无法核对，请保留原操作'}${this.value.pending?' 原提交仍未确认；只能核对同一提交，不能更改选择后重发。':''}`,selection:null});}
    finally{if(generation===this.epoch&&this.available)this.set({busy:false});}
  }
  async preview(sourceId:string,discardDraft=false){
    this.check();if(this.value.pending||this.unsavedState().dirty&&!discardDraft)error('PENDING');const sameDraft=this.draftSourceId===sourceId;this.draftSourceId=sourceId;this.set({preview:null,page:null,selection:null,...(sameDraft?{}:{status:'',reason:''})});
    await this.read(async signal=>{const {scope}=await this.client.scope(signal);return this.client.previewServiceRecord({schema:2,scope,sourceId},signal);},preview=>this.set({preview}));
  }
  async choices(next=false){
    this.check();if(this.value.pending)error('PENDING');const preview=this.value.preview,page=this.value.page;
    if(!preview||next&&!page?.nextOffset)error('INVALID_REQUEST');this.set({selection:null,page:null});
    await this.read(signal=>this.client.sourceChoices({offset:next?page!.nextOffset!:0,limit:10,storeScope:preview!.authority.documentStoreScope},signal),value=>{
      if(value.scope!==preview!.scope||value.storeScope!==preview!.authority.documentStoreScope||!equal(value.capabilities,preview!.authority.capabilities))error('CONFLICT');
      this.set({page:value});
    });
  }
  async select(documentId:string){
    this.check();if(this.value.pending)error('PENDING');const preview=this.value.preview,page=this.value.page;
    if(!preview)error('INVALID_REQUEST');if(!documentId){this.epoch++;this.controller?.abort();this.client.invalidateReads();this.set({selection:null,busy:false});return;}const synthetic=documentId===preview!.syntheticSourcePin.documentId;
    const row=page?.items.find(item=>item.documentId===documentId);if(!synthetic&&!row)error('INVALID_REQUEST');
    this.set({selection:null});if(!documentId)return;
    await this.read(signal=>this.client.inspectSourceSelection({documentId,revisionId:synthetic?preview!.syntheticSourcePin.revisionId:row!.revisionId},signal),selection=>{
      if(selection.scope!==preview!.scope||selection.pin.tenantId!==preview!.syntheticSourcePin.tenantId||selection.pin.collectionId!==preview!.syntheticSourcePin.collectionId)error('CONFLICT');
      if(synthetic){if(selection.sourceKind!=='synthetic'||!equal(selection.pin,preview!.syntheticSourcePin))error('CONFLICT');}
      else if(selection.sourceKind!=='local-document'||selection.locator.storeScope!==preview!.authority.documentStoreScope||selection.locator.metadataRevision!==row!.metadataRevision)error('CONFLICT');
      this.set({selection});
    });
  }
  async submit(){
    this.check();if(this.value.pending||this.value.busy)error('PENDING');const {preview,selection,status,reason}=this.value;
    if(!preview||!selection||!status||preview.existing?.archivedAt)error('INVALID_REQUEST');
    if(preview!.existing&&preview!.existing.sourceRevision!==preview!.source.revision&&!reason.trim())error('INVALID_REQUEST');
    const command=requireServiceProjectionImport({schema:2,scope:preview!.scope,sourceId:preview!.source.id,token:preview!.token,authority:preview!.authority,expectedProjection:preview!.existing?{id:preview!.existing.id,revision:preview!.existing.revision}:null,status,sourcePin:selection!.pin,sourceObservation:selection!.sourceKind==='local-document'?selection!.locator:null,reason:preview!.existing&&preview!.existing.sourceRevision!==preview!.source.revision?reason:''});
    this.set({pending:freeze({command,preview:preview!,actor:this.actor})});await this.sendPending();
  }
  async retry(){this.check();if(!this.value.pending||this.value.busy)error('INVALID_REQUEST');await this.sendPending();}
  private async sendPending(){
    const pending=this.value.pending!;if(!equal(pending.actor,this.actor))error('FORBIDDEN');
    await this.read(async signal=>{
      // A hidden view may have lost client scope. Reacquire it but never rewrite the saved request.
      const authority=await this.client.scope(signal);if(authority.scope!==pending.command.scope)error('FORBIDDEN');
      return this.client.importServiceRecord(pending.command,signal);
    },result=>{
      this.verifyResult(result,pending);
      this.set({pending:null,preview:null,page:null,selection:null,status:'',reason:'',result:`${result.unchanged?'当前活动与原选择一致，未重复计入':'已保存月报活动'} · ${result.activity.id} · 活动版本 ${result.activity.revision}。历史月报未修改。`});
    });
  }
  private verifyResult(result:ServiceProjectionResult,pending:Pending){
    const value=result.activity.version.value,preview=pending.preview;
    if(pending.command.expectedProjection&&result.activity.id!==pending.command.expectedProjection.id)error('INVALID_RESPONSE');
    if(preview.existing&&preview.existing.sourceRevision!==preview.source.revision&&result.activity.version.correction?.reason!==pending.command.reason)error('INVALID_RESPONSE');
    if(result.scope!==pending.command.scope||!equal(value.ordinarySource,preview.source)||!equal(value.customer,preview.projection.customer)||value.kind!==preview.projection.kind||value.occurredAt!==preview.projection.occurredAt||value.summary!==preview.projection.summary||value.status!==pending.command.status||!equal(value.references,[{pin:pending.command.sourcePin}]))error('INVALID_RESPONSE');
  }
}
