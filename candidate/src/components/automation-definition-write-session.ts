import type {SkillView,DataSourceView,ScheduleRecord,AutomationWrites} from '../../shared/automation';
import {automationApi} from '../adapters/automation';
import {ApiError,trustedAutomationRejection} from '../adapters/api';
import {isAutomationCommandOperation,automationCommandCanonical} from '../../shared/automation-command-outcome';
export type AutomationDefinitionOperation='createSkill'|'updateSkill'|'deleteSkill'|'restoreSkill'|'createDataSource'|'updateDataSource'|'deleteDataSource'|'restoreDataSource'|'createSchedule'|'updateSchedule'|'setScheduleState'|'deleteSchedule'|'restoreSchedule';
export type AutomationDefinitionKind='skill'|'data-source'|'schedule';
export type AutomationDefinitionRecord=SkillView|DataSourceView|ScheduleRecord;
export type AutomationDefinitionEditor={section:'skills'|'sources'|'schedules';record?:AutomationDefinitionRecord;token:string;draft?:Record<string,unknown>;dirty?:boolean;baseline?:string};
export type AutomationDefinitionCommand=Readonly<{operation:AutomationDefinitionOperation;body:string;kind:AutomationDefinitionKind;id?:string;fingerprint:string;token?:string;message:string;draftVersion?:number}>;
export type AutomationDefinitionPending=Readonly<{command:AutomationDefinitionCommand;phase:'sending'|'unknown'|'reading'|'readback-failed';uncertain:boolean;conflict?:boolean;ackId?:string;ackRevision?:number;message:string}>;
export type AutomationDefinitionRejection={command:AutomationDefinitionCommand;message:string;conflict:boolean};
export type AutomationDefinitionCompletion={record:AutomationDefinitionRecord;command:AutomationDefinitionCommand};
const bytes=(value:string)=>new TextEncoder().encode(value).length;
const fail=():never=>{throw new Error('自动化定义数据无法确认');};
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
function jsonClone<T>(value:T,max=65536):T {
 let nodes=0,weight=0;const path=new Set<object>();
 const visit=(item:unknown,depth:number):void=>{if(++nodes>10000||depth>32)fail();if(item===null||typeof item==='boolean')return;if(typeof item==='number'){if(!Number.isFinite(item))fail();return;}if(typeof item==='string'){weight+=bytes(item);if(weight>max)fail();return;}if(typeof item!=='object'||(!Array.isArray(item)&&!plain(item))||path.has(item))return fail();path.add(item);for(const key of Object.keys(item)){const descriptor=Object.getOwnPropertyDescriptor(item,key);if(!descriptor||!('value' in descriptor))fail();weight+=bytes(key);if(weight>max)fail();visit(descriptor!.value,depth+1);}path.delete(item);};
 visit(value,0);const text=JSON.stringify(value);if(bytes(text)>max)fail();return JSON.parse(text) as T;
}
const str=(v:unknown)=>typeof v==='string';
const limited=(max:number,empty=false)=>(v:unknown)=>typeof v==='string'&&v.length<=max&&(empty||v.trim().length>0);
const ident=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const ids=(max:number)=>(v:unknown)=>Array.isArray(v)&&v.length<=max&&v.every(ident)&&new Set(v).size===v.length;
const list=(v:unknown)=>Array.isArray(v)&&v.length<=50&&v.every(limited(200,true));
const zone=(v:unknown)=>{if(!limited(100)(v))return false;try{new Intl.DateTimeFormat('en',{timeZone:v as string});return true;}catch{return false;}};
const wall=(v:unknown)=>typeof v==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v);
const one=(...values:unknown[])=>(v:unknown)=>values.includes(v);
const date=(v:unknown)=>str(v)&&Number.isFinite(Date.parse(v as string));
const nullableDate=(v:unknown)=>v===null||date(v);
const bool=(v:unknown)=>typeof v==='boolean';
const cadence=(v:unknown)=>plain(v)&&zone(v.timezone)&&(v.kind==='once'?Object.keys(v).sort().join(',')==='at,kind,timezone'&&date(v.at):(v.kind==='daily'?Object.keys(v).sort().join(',')==='kind,time,timezone'&&wall(v.time):v.kind==='weekly'&&Object.keys(v).sort().join(',')==='kind,time,timezone,weekdays'&&wall(v.time)&&Array.isArray(v.weekdays)&&v.weekdays.length>=1&&v.weekdays.length<=7&&new Set(v.weekdays).size===v.weekdays.length&&v.weekdays.every(d=>Number.isInteger(d)&&d>=0&&d<=6)));
const schemas:Record<AutomationDefinitionKind,Record<string,(v:unknown)=>boolean>>={
 'skill':{name:limited(100),description:limited(2000,true),enabled:bool,handler:one('local-notification','local-checkpoint','local-evidence-report','external-research','local-document-inventory')},
 'data-source':{name:limited(100),kind:one('local-workspace','local-archive','web-search','private-drive','vendor-feed'),enabled:bool,collectionIds:ids(50)},
 'schedule':{name:limited(100),skillId:ident,sourceIds:ids(20),instructions:limited(4000,true),cadence,enabled:bool,state:one('active','paused','cancelled','completed'),misfirePolicy:one('coalesce','skip'),graceSeconds:v=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=3600,nextRunAt:nullableDate,lastRunAt:nullableDate},
};
export function validateAutomationDefinitionRecord(value:unknown,kind:AutomationDefinitionKind,id?:string,requireAvailability=false):AutomationDefinitionRecord {
 if(!plain(value)||Object.keys(value).some(k=>!['id','kind','revision','createdAt','updatedAt','deletedAt','data','availability'].includes(k))||value.kind!==kind||typeof value.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(value.id)||(id!==undefined&&value.id!==id)||!Number.isSafeInteger(value.revision)||Number(value.revision)<1||!date(value.createdAt)||!date(value.updatedAt)||!nullableDate(value.deletedAt)||!plain(value.data))return fail();
 const schema=schemas[kind];if(Object.keys(value.data).length!==Object.keys(schema).length||Object.entries(schema).some(([k,check])=>!Object.hasOwn(value.data as object,k)||!check((value.data as Record<string,unknown>)[k])))return fail();
 if(kind==='schedule'){if(Object.hasOwn(value,'availability'))return fail();}
 else if(requireAvailability||Object.hasOwn(value,'availability')){const a=value.availability;if(!plain(a)||Object.keys(a).sort().join(',')!=='capabilities,code,detail,status'||!one('available','unavailable')(a.status)||!str(a.code)||!str(a.detail)||!list(a.capabilities))return fail();}
 return jsonClone(value) as unknown as AutomationDefinitionRecord;
}
const capturedCommands=new WeakSet<AutomationDefinitionCommand>();
export function captureAutomationDefinitionCommand(operation:AutomationDefinitionOperation,input:Record<string,unknown>,options:{token?:string;message:string;draftVersion?:number},idempotencyKey=`auto-ui-${crypto.randomUUID()}`):AutomationDefinitionCommand {
 const family=`automation.${operation}`;if(!isAutomationCommandOperation(family))return fail();
 const copy=jsonClone(input,32768);if(Object.hasOwn(copy,'idempotencyKey'))return fail();
 if(!plain(options)||Object.keys(options).some(k=>!['token','message','draftVersion'].includes(k)||!('value' in Object.getOwnPropertyDescriptor(options,k)!)))return fail();
 const metadata={message:options.message,...(options.token!==undefined?{token:options.token}:{}),...(options.draftVersion!==undefined?{draftVersion:options.draftVersion}:{})};
 if(typeof idempotencyKey!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(idempotencyKey)||typeof options.message!=='string'||bytes(options.message)>1024||(options.token!==undefined&&(typeof options.token!=='string'||bytes(options.token)>200))||(options.draftVersion!==undefined&&(!Number.isSafeInteger(options.draftVersion)||options.draftVersion<0)))return fail();
 const creating=operation.startsWith('create');if(!creating&&(typeof copy.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(copy.id)||!Number.isSafeInteger(copy.expectedRevision)||Number(copy.expectedRevision)<1))return fail();
 const body=JSON.stringify({...copy,idempotencyKey});if(bytes(body)>32768)return fail();automationCommandCanonical(family,JSON.parse(body));
 const kind:AutomationDefinitionKind=operation.endsWith('Skill')?'skill':operation.endsWith('DataSource')?'data-source':'schedule';
 const command=Object.freeze({operation,body,kind,...(creating?{}:{id:String(copy.id)}),fingerprint:JSON.stringify({operation,input:copy}),...metadata});capturedCommands.add(command);return command;
}
/** One bounded command, one editor snapshot; no storage, credentials or identity cache. */
export class AutomationDefinitionWriteSession {
 private retentionFailure=false;private rejection:AutomationDefinitionRejection|null=null;
 private pendingValue:AutomationDefinitionPending|null=null;private editorValue:AutomationDefinitionEditor|null=null;private editorVersionValue=0;private completion:AutomationDefinitionCompletion|null=null;
 private listeners=new Set<()=>void>();private detached=false;private reads=new Set<AbortController>();private controller:AbortController|null=null;private activePromise:Promise<AutomationDefinitionCompletion|null>|null=null;
 constructor(private readonly api=automationApi,private readonly assertAuthority:()=>void=()=>{}){}
 subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};
 get pending(){return this.pendingValue;}
 get editor(){return this.editorValue?jsonClone(this.editorValue):null;}
 get editorVersion(){return this.editorVersionValue;}
 get draftRetentionIncomplete(){return this.retentionFailure;}
 takeRejection(){this.check();const value=this.rejection;this.rejection=null;return value;}
 takeCompletion(){this.check();const value=this.completion;this.completion=null;return value;}
 get available(){try{this.check();return true;}catch{return false;}}
 private check(){if(this.detached)throw new Error('身份已变化，旧自动化定义操作不可继续');this.assertAuthority();}
 private emit(){for(const f of this.listeners)f();}
 setEditor(editor:AutomationDefinitionEditor|null){this.check();let next:AutomationDefinitionEditor|null;try{next=editor?jsonClone(editor):null;}catch(error){this.retentionFailure=true;throw error;}if(JSON.stringify(next)!==JSON.stringify(this.editorValue))this.editorVersionValue++;this.editorValue=next;this.retentionFailure=false;}
 unsavedState(){return {dirty:this.retentionFailure||Boolean(this.editorValue?.dirty),pending:Boolean(this.pendingValue)};}
 detach(){this.detached=true;this.controller?.abort();for(const c of this.reads)c.abort();this.reads.clear();this.editorValue=null;this.emit();}
 async guard<T>(work:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{this.check();const c=new AbortController();const abort=()=>c.abort();if(signal?.aborted)c.abort();signal?.addEventListener('abort',abort,{once:true});this.reads.add(c);try{this.check();if(c.signal.aborted)throw new Error('请求已取消');const result=await work(c.signal);this.check();if(c.signal.aborted)throw new Error('请求已取消');return result;}finally{signal?.removeEventListener('abort',abort);this.reads.delete(c);}}
 assertCurrent(){this.check();}
 async submit(command:AutomationDefinitionCommand):Promise<AutomationDefinitionCompletion|null>{
  this.check();if(!capturedCommands.has(command))throw new Error('自动化定义命令未由有界快照创建');
  if(this.pendingValue){if(this.pendingValue.command.fingerprint!==command.fingerprint)throw new Error('请先确认原操作；当前草稿未作为另一项写入发送。');return this.recover();}
  this.pendingValue=Object.freeze({command,phase:'unknown',uncertain:false,message:'准备确认本地操作'});this.emit();return this.recover();
 }
 recover():Promise<AutomationDefinitionCompletion|null>{
  this.check();if(this.activePromise)return this.activePromise;
  if(!this.pendingValue)return Promise.resolve(null);
  const captured=this.pendingValue;const controller=new AbortController();this.controller=controller;
  const current=()=>{this.check();if(controller.signal.aborted)throw new Error('自动化定义操作已中止');};
  const update=(phase:AutomationDefinitionPending['phase'],message:string,ackId?:string,ackRevision?:number,conflict=false)=>{current();this.pendingValue=Object.freeze({command:captured.command,phase,uncertain:captured.uncertain||phase==='unknown'||phase==='readback-failed',message,conflict,...(ackId?{ackId,ackRevision}:{})});this.emit();};
  const run=async():Promise<AutomationDefinitionCompletion|null>=>{
   let ackId=captured.ackId;let acknowledgedRevision=captured.ackRevision??0;
   try{
    current();
    if(!ackId){
     update('sending','正在确认原操作');
     const input=JSON.parse(captured.command.body);current();
     const value=await (this.api[captured.command.operation] as (input:AutomationWrites[AutomationDefinitionOperation]['input'],signal?:AbortSignal)=>Promise<unknown>)(input,controller.signal);current();
     const ack=validateAutomationDefinitionRecord(value,captured.command.kind,captured.command.id);ackId=ack.id;acknowledgedRevision=ack.revision;
    }
    update('reading','原操作已确认，正在读取当前记录',ackId,acknowledgedRevision);current();
    const action=captured.command.kind==='skill'?'listSkills':captured.command.kind==='data-source'?'listDataSources':'listSchedules';
    const values:unknown=await this.api[action]({includeDeleted:true},controller.signal);current();
    // Existing list endpoints return complete arrays or fail their metadata budget, not pages.
    if(!Array.isArray(values)||values.length>100||bytes(JSON.stringify(values))>4*1024*1024)throw new Error('当前列表无法完整确认');
    const seen=new Set<string>();let found:AutomationDefinitionRecord|undefined;
    for(const value of values){const row=validateAutomationDefinitionRecord(value,captured.command.kind,undefined,true);if(seen.has(row.id))throw new Error('当前列表重复记录');seen.add(row.id);if(row.id===ackId)found=row;}
    if(!found)throw new Error('原操作已确认，但当前记录未在完整列表中找到；保留恢复信息');
    const record=found;current();
    if(record.revision<acknowledgedRevision)throw new Error('当前记录版本无法确认');
    this.pendingValue=null;this.completion={record,command:captured.command};this.emit();return this.completion;
   }catch(error){
    if(this.detached||controller.signal.aborted)return null;
    try{current();}catch{return null;}
    const rejected=!ackId&&trustedAutomationRejection(error,captured.command.operation,captured.command.body);
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
