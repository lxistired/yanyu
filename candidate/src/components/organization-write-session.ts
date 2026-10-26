import {isMeetingReminderLeadSeconds} from '../../shared/organization';
import type {OrganizationKind,OrganizationRecord} from '../../shared/organization';
import type {JsonValue} from '../../shared/workspace';
import {organizationApi} from '../adapters/organization';
import {ApiError,trustedOrganizationRejection} from '../adapters/api';
export type OrganizationWriteOperation='create'|'update'|'remove'|'restore';
export type OrganizationEditorRecovery={kind:OrganizationKind;record?:OrganizationRecord;seed?:Record<string,JsonValue>;token:string;draft?:Record<string,JsonValue>;tagText?:string;dirty?:boolean;baseline?:string};
export type OrganizationCommand=Readonly<{operation:OrganizationWriteOperation;body:string;kind:OrganizationKind;id?:string;fingerprint:string;token?:string;message:string;draftVersion?:number}>;
export type OrganizationPending=Readonly<{command:OrganizationCommand;phase:'sending'|'unknown'|'reading'|'readback-failed';uncertain:boolean;conflict?:boolean;ackId?:string;ackRevision?:number;message:string}>;
export type OrganizationRejection={command:OrganizationCommand;message:string;conflict:boolean};
export type OrganizationCompletion={record:OrganizationRecord;command:OrganizationCommand};
const KINDS:OrganizationKind[]=['organization','person','meeting','meeting-registration','crm-contact','service-record','bookmark','reading-record','access-request','share-draft'];
const bytes=(value:string)=>new TextEncoder().encode(value).length;
const fail=():never=>{throw new Error('机构操作数据无法确认');};
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
function jsonClone<T>(value:T,max=65536):T {
 let nodes=0,weight=0;const path=new Set<object>();
 const visit=(item:unknown,depth:number):void=>{if(++nodes>10000||depth>32)fail();if(item===null||typeof item==='boolean')return;if(typeof item==='number'){if(!Number.isFinite(item))fail();return;}if(typeof item==='string'){weight+=bytes(item);if(weight>max)fail();return;}if(typeof item!=='object'||(!Array.isArray(item)&&!plain(item))||path.has(item))return fail();path.add(item);for(const key of Object.keys(item)){const descriptor=Object.getOwnPropertyDescriptor(item,key);if(!descriptor||!('value' in descriptor))fail();weight+=bytes(key);if(weight>max)fail();visit(descriptor!.value,depth+1);}path.delete(item);};
 visit(value,0);const text=JSON.stringify(value);if(bytes(text)>max)fail();return JSON.parse(text) as T;
}
const text=(v:unknown)=>typeof v==='string';
const nullableText=(v:unknown)=>v===null||text(v);
const strings=(v:unknown)=>Array.isArray(v)&&v.length<=200&&v.every(text);
const target=(v:unknown)=>plain(v)&&Object.keys(v).length===3&&['organization','person','meeting','workspace','session','watchlist','ingestion-file','ingestion-version','research-artifact'].includes(String(v.kind))&&text(v.id)&&Number.isSafeInteger(v.revision)&&Number(v.revision)>=1;
const one=(...values:unknown[])=>(v:unknown)=>values.includes(v);
type Check=(v:unknown)=>boolean;
const schemas:Record<OrganizationKind,Record<string,Check>>={
 organization:{name:text,parentId:nullableText,category:one('buy-side','sell-side','company','other'),description:text,website:text,tags:strings,verification:one('unverified')},
 person:{name:text,organizationId:nullableText,role:text,department:text,email:text,biography:text,followed:v=>typeof v==='boolean',tags:strings},
 meeting:{title:text,organizationId:nullableText,series:text,category:one('roadshow','strategy','research','forum','other'),startsAt:text,endsAt:text,timezone:text,location:text,description:text,attendeeIds:strings,state:one('scheduled','cancelled','completed'),providerAvailability:one('unconfigured')},
 'meeting-registration':{meetingId:text,personId:text,state:one('requested','approved-locally','declined','cancelled'),notes:text,localOnly:one(true)},
 'crm-contact':{organizationId:text,personId:nullableText,name:text,stage:one('prospect','active','inactive'),notes:text,tags:strings},
 'service-record':{organizationId:text,contactId:nullableText,activity:one('content-read','meeting','call','email','other'),occurredAt:text,summary:text,notes:text,source:v=>v===null||target(v),provenance:one('user-recorded-local')},
 bookmark:{title:text,target,notes:text,tags:strings},
 'reading-record':{target,readAt:text,progress:v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100,notes:text,provenance:one('user-recorded-local')},
 'access-request':{organizationId:text,requesterPersonId:nullableText,target,purpose:text,state:one('pending','approved-locally','declined','cancelled'),decisionNote:text,localOnly:one(true)},
 'share-draft':{title:text,target,recipientPersonIds:strings,recipientOrganizationIds:strings,state:one('draft','approved-locally','revoked'),notes:text,localOnly:one(true)},
};
/** Validate the complete record DTO before using an acknowledgement as a readback identity. */
export function validateOrganizationRecord(value:unknown,kind:OrganizationKind,id?:string):OrganizationRecord {
 if(!plain(value)||Object.keys(value).sort().join(',')!=='createdAt,data,deletedAt,id,kind,revision,updatedAt'||value.kind!==kind||typeof value.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(value.id)||(id!==undefined&&value.id!==id)||!Number.isSafeInteger(value.revision)||Number(value.revision)<1||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||typeof value.updatedAt!=='string'||!Number.isFinite(Date.parse(value.updatedAt))||!(value.deletedAt===null||typeof value.deletedAt==='string'&&Number.isFinite(Date.parse(value.deletedAt)))||!plain(value.data))return fail();
 const schema=schemas[kind],data=value.data;
 const preference=kind==='meeting'?Object.getOwnPropertyDescriptor(data,'reminderLeadSeconds'):undefined;
 if(preference&&(!preference.enumerable||!('value' in preference)||(preference.value!==null&&!isMeetingReminderLeadSeconds(preference.value))))return fail();
 if(Object.keys(data).length!==Object.keys(schema).length+(preference?1:0)||Object.entries(schema).some(([k,check])=>!Object.hasOwn(data,k)||!check(data[k])))return fail();
 return jsonClone({id:value.id,kind,revision:Number(value.revision),createdAt:value.createdAt,updatedAt:value.updatedAt,deletedAt:value.deletedAt,data:value.data}) as unknown as OrganizationRecord;
}
export function captureOrganizationCommand(operation:OrganizationWriteOperation,input:Record<string,unknown>,options:{token?:string;message:string;draftVersion?:number},idempotencyKey=`org-ui-${crypto.randomUUID()}`):OrganizationCommand {
 if(!['create','update','remove','restore'].includes(operation)||!KINDS.includes(input.kind as OrganizationKind))return fail();
 const allowed=operation==='create'?['kind','data']:operation==='update'?['kind','id','expectedRevision','patch']:['kind','id','expectedRevision'];
 if(Object.keys(input).some(k=>!allowed.includes(k))||allowed.some(k=>!Object.hasOwn(input,k)))return fail();
 const copy=jsonClone(input,32768);
 if(operation!=='create'&&(typeof copy.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(copy.id)||!Number.isSafeInteger(copy.expectedRevision)||Number(copy.expectedRevision)<1))return fail();
 if(typeof idempotencyKey!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(idempotencyKey)||typeof options.message!=='string'||bytes(options.message)>1024||(options.token!==undefined&&(typeof options.token!=='string'||bytes(options.token)>200))||(options.draftVersion!==undefined&&(!Number.isSafeInteger(options.draftVersion)||options.draftVersion<0)))return fail();
 const body=JSON.stringify({...copy,idempotencyKey});if(bytes(body)>32768)return fail();
 return Object.freeze({operation,body,kind:copy.kind as OrganizationKind,...(operation==='create'?{}:{id:String(copy.id)}),fingerprint:JSON.stringify({operation,input:copy}),...options});
}
/** One bounded command, one editor snapshot; no storage, credentials or identity cache. */
export class OrganizationWriteSession {
 private retentionFailure=false;private rejection:OrganizationRejection|null=null;
 private pendingValue:OrganizationPending|null=null;private editorValue:OrganizationEditorRecovery|null=null;private editorVersionValue=0;private completion:OrganizationCompletion|null=null;
 private listeners=new Set<()=>void>();private detached=false;private reads=new Set<AbortController>();private controller:AbortController|null=null;private activePromise:Promise<OrganizationCompletion|null>|null=null;
 constructor(private readonly api=organizationApi,private readonly assertAuthority:()=>void=()=>{}){}
 subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};
 get pending(){return this.pendingValue;}
 get editor(){return this.editorValue?jsonClone(this.editorValue):null;}
 get editorVersion(){return this.editorVersionValue;}
 get draftRetentionIncomplete(){return this.retentionFailure;}
 takeRejection(){this.check();const value=this.rejection;this.rejection=null;return value;}
 takeCompletion(){this.check();const value=this.completion;this.completion=null;return value;}
 get available(){try{this.check();return true;}catch{return false;}}
 private check(){if(this.detached)throw new Error('身份已变化，旧机构操作不可继续');this.assertAuthority();}
 private emit(){for(const f of this.listeners)f();}
 setEditor(editor:OrganizationEditorRecovery|null){this.check();let next:OrganizationEditorRecovery|null;try{next=editor?jsonClone(editor):null;}catch(error){this.retentionFailure=true;throw error;}if(JSON.stringify(next)!==JSON.stringify(this.editorValue))this.editorVersionValue++;this.editorValue=next;this.retentionFailure=false;}
 unsavedState(){return {dirty:this.retentionFailure||Boolean(this.editorValue?.dirty),pending:Boolean(this.pendingValue)};}
 detach(){this.detached=true;this.controller?.abort();for(const c of this.reads)c.abort();this.reads.clear();this.editorValue=null;this.emit();}
 async guard<T>(work:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{this.check();const c=new AbortController();const abort=()=>c.abort();if(signal?.aborted)c.abort();signal?.addEventListener('abort',abort,{once:true});this.reads.add(c);try{this.check();if(c.signal.aborted)throw new Error('请求已取消');const result=await work(c.signal);this.check();if(c.signal.aborted)throw new Error('请求已取消');return result;}finally{signal?.removeEventListener('abort',abort);this.reads.delete(c);}}
 assertCurrent(){this.check();}
 async submit(command:OrganizationCommand):Promise<OrganizationCompletion|null>{
  this.check();
  if(this.pendingValue){if(this.pendingValue.command.fingerprint!==command.fingerprint)throw new Error('请先确认原操作；当前草稿未作为另一项写入发送。');return this.recover();}
  this.pendingValue=Object.freeze({command,phase:'unknown',uncertain:false,message:'准备确认本地操作'});this.emit();return this.recover();
 }
 recover():Promise<OrganizationCompletion|null>{
  this.check();if(this.activePromise)return this.activePromise;
  if(!this.pendingValue)return Promise.resolve(null);
  const captured=this.pendingValue;const controller=new AbortController();this.controller=controller;
  const current=()=>{this.check();if(controller.signal.aborted)throw new Error('机构操作已中止');};
  const update=(phase:OrganizationPending['phase'],message:string,ackId?:string,ackRevision?:number,conflict=false)=>{current();this.pendingValue=Object.freeze({command:captured.command,phase,uncertain:captured.uncertain||phase==='unknown'||phase==='readback-failed',message,conflict,...(ackId?{ackId,ackRevision}:{})});this.emit();};
  const run=async():Promise<OrganizationCompletion|null>=>{
   let ackId=captured.ackId;let acknowledgedRevision=captured.ackRevision??0;
   try{
    current();
    if(!ackId){
     update('sending','正在确认原操作');
     const input=JSON.parse(captured.command.body);current();
     const value=await this.api[captured.command.operation](input,controller.signal);current();
     const ack=validateOrganizationRecord(value,captured.command.kind,captured.command.id);ackId=ack.id;acknowledgedRevision=ack.revision;
    }
    update('reading','原操作已确认，正在读取当前记录',ackId,acknowledgedRevision);current();
    const record=validateOrganizationRecord(await this.api.get({kind:captured.command.kind,id:ackId,includeDeleted:true},controller.signal),captured.command.kind,ackId);current();
    if(record.revision<acknowledgedRevision)throw new Error('当前记录版本无法确认');
    this.pendingValue=null;this.completion={record,command:captured.command};this.emit();return this.completion;
   }catch(error){
    if(this.detached||controller.signal.aborted)return null;
    try{current();}catch{return null;}
    const rejected=!ackId&&trustedOrganizationRejection(error,captured.command.operation,captured.command.body);
    if(rejected){this.pendingValue=null;this.rejection={command:captured.command,message:rejected.message,conflict:rejected.detail.code==='CONFLICT'};this.emit();return null;}
    // Existing unknown commands are never discarded just because a later attempt was not sent.
    const notSent=error instanceof ApiError&&error.outcome==='not-sent'&&!captured.uncertain;
    if(notSent&&!ackId){this.pendingValue=null;this.emit();throw new Error('本次请求未发送，草稿已保留。');}
    update(ackId?'readback-failed':'unknown',ackId?'原操作已确认，但当前记录尚未读取成功。请只重试读取。':'请求结果尚未确认。请重试原操作，不要另建重复记录。',ackId,acknowledgedRevision,error instanceof ApiError&&error.detail.code==='CONFLICT');
    return null;
   }finally{if(this.controller===controller)this.controller=null;}
  };
  const result=run();this.activePromise=result;void result.finally(()=>{if(this.activePromise===result)this.activePromise=null;}).catch(()=>{});return result;
 }
}
