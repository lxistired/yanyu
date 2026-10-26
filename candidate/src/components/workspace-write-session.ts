import type {WorkspaceKind,WorkspaceRecord,WorkspaceMutationSummary,ImportWatchlistResult} from '../../shared/workspace-records';
import {workspaceApi} from '../adapters/workspace';
import {ApiError,trustedWorkspaceRejection} from '../adapters/api';
export type WorkspaceWriteOperation='create'|'update'|'remove'|'restore'|'batchDelete'|'importWatchlist';
export type WorkspaceCommand=Readonly<{operation:WorkspaceWriteOperation;body:string;fingerprint:string;draftVersion:number;token:string}>;
type Target=Readonly<{kind:WorkspaceKind;id:string;minimumRevision:number}>;
type Receipt=Readonly<{targets:readonly Target[];createdCount?:number;skipped?:ReadonlyArray<Readonly<ImportWatchlistResult['skipped'][number]>>}>;
export type WorkspacePending=Readonly<{command:WorkspaceCommand;phase:'sending'|'unknown'|'reading'|'readback-failed';uncertain:boolean;receipt?:Receipt;message:string}>;
export type WorkspaceCompletion=Readonly<{id:number;command:WorkspaceCommand;record?:WorkspaceRecord;current:readonly WorkspaceMutationSummary[];createdCount?:number;skipped?:ImportWatchlistResult['skipped']}>;
export interface WorkspaceTransport {write:(operation:WorkspaceWriteOperation,input:Record<string,unknown>,signal:AbortSignal)=>Promise<unknown>;get:(input:{kind:WorkspaceKind;id:string;includeDeleted:true},signal:AbortSignal)=>Promise<unknown>}
const defaultTransport:WorkspaceTransport={write:(operation,input,signal)=>(workspaceApi[operation] as unknown as (v:Record<string,unknown>,s:AbortSignal)=>Promise<unknown>)(input,signal),get:workspaceApi.get};
export const WORKSPACE_BODY_BYTES=32768;
export const WORKSPACE_RESPONSE_BYTES=512*1024;
export const WORKSPACE_READ_CONCURRENCY=4;
// Covers all 1000 maximum valid per-record responses, without retaining their bodies.
export const WORKSPACE_READ_TOTAL_BYTES=1000*WORKSPACE_RESPONSE_BYTES;
const kinds:WorkspaceKind[]=['workspace','session-group','session','message','watchlist','watchlist-item'];
const bytes=(v:string)=>new TextEncoder().encode(v).length;
const invalid=():never=>{throw new Error('工作区数据无法完整核对，恢复信息已保留');};
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const revision=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=1;
const date=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const kind=(v:unknown):v is WorkspaceKind=>kinds.includes(v as WorkspaceKind);
export function boundedWorkspaceClone<T>(value:T,max=1024*1024):T{
 let nodes=0,weight=0;const path=new Set<object>();
 const visit=(v:unknown,depth:number):void=>{if(++nodes>30000||depth>24)invalid();if(v===null||typeof v==='boolean')return;if(typeof v==='number'){if(!Number.isFinite(v))invalid();return;}if(typeof v==='string'){weight+=bytes(v);if(weight>max)invalid();return;}if(typeof v!=='object'||(!Array.isArray(v)&&!plain(v))||path.has(v))return invalid();path.add(v);const names=Reflect.ownKeys(v);if(names.some(key=>typeof key!=='string'||(key!=='length'||!Array.isArray(v))&&(!Object.getOwnPropertyDescriptor(v,key)?.enumerable)))invalid();if(Array.isArray(v)&&names.length!==v.length+1)invalid();for(const key of Object.keys(v)){const d=Object.getOwnPropertyDescriptor(v,key);if(!d||!('value'in d))invalid();weight+=bytes(key);if(weight>max)invalid();visit(d!.value,depth+1);}path.delete(v);};
 visit(value,0);const text=JSON.stringify(value);if(bytes(text)>max)invalid();return JSON.parse(text) as T;
}
const text=(v:unknown,max:number,empty=true)=>typeof v==='string'&&!v.includes('\0')&&bytes(v)<=max&&(empty||v.trim().length>0);
const nullableId=(v:unknown)=>v===null||id(v);
const schemas:Record<WorkspaceKind,Record<string,(v:unknown)=>boolean>>={
 workspace:{name:v=>text(v,480,false),parentId:nullableId,description:v=>text(v,12000)},
 'session-group':{name:v=>text(v,480,false),workspaceId:id,parentId:nullableId},
 session:{title:v=>text(v,720,false),workspaceId:id,groupId:nullableId,pinned:v=>typeof v==='boolean',mode:v=>typeof v==='string'&&['quick','deep','plan','daily'].includes(v),model:v=>text(v,240)},
 message:{sessionId:id,role:v=>typeof v==='string'&&['user','assistant','system'].includes(v),content:v=>text(v,65536,false)},
 watchlist:{name:v=>text(v,480,false),workspaceId:id,description:v=>text(v,12000)},
 'watchlist-item':{watchlistId:id,symbol:v=>typeof v==='string'&&/^[A-Z0-9^][A-Z0-9.^:_/-]{0,39}$/.test(v)&&!v.includes('//')&&!v.includes('://'),market:v=>typeof v==='string'&&/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(v),name:v=>text(v,480),notes:v=>text(v,16000)},
};
export function validateWorkspaceRecord(raw:unknown,expectedKind?:WorkspaceKind,expectedId?:string):WorkspaceRecord{
 const v=boundedWorkspaceClone(raw,WORKSPACE_RESPONSE_BYTES);
 if(!plain(v)||Object.keys(v).sort().join(',')!=='createdAt,data,deletedAt,id,kind,revision,updatedAt'||!kind(v.kind)||!id(v.id)||(expectedKind!==undefined&&v.kind!==expectedKind)||(expectedId!==undefined&&v.id!==expectedId)||!revision(v.revision)||!date(v.createdAt)||!date(v.updatedAt)||(v.deletedAt!==null&&!date(v.deletedAt))||!plain(v.data))return invalid();
 const fields=schemas[v.kind],data=v.data;if(Object.keys(data).some(k=>!Object.hasOwn(fields,k)&&!(v.kind==='message'&&k==='sequence'))||Object.entries(fields).some(([k,check])=>!Object.hasOwn(data,k)||!check(data[k]))||(Object.hasOwn(data,'sequence')&&!revision(data.sequence)))return invalid();
 return v as unknown as WorkspaceRecord;
}
const captures=new WeakSet<WorkspaceCommand>();
export function captureWorkspaceCommand(operation:WorkspaceWriteOperation,input:Record<string,unknown>,draftVersion=0,key=`workspace-ui-${crypto.randomUUID()}`):WorkspaceCommand{
 if(!['create','update','remove','restore','batchDelete','importWatchlist'].includes(operation)||!Number.isSafeInteger(draftVersion)||draftVersion<0||typeof key!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(key))return invalid();
 let copy:Record<string,unknown>;try{copy=boundedWorkspaceClone(input,WORKSPACE_BODY_BYTES);}catch{throw new ApiError({code:'INVALID_REQUEST',message:'内容超过当前本地传输容量，本次未发送；请缩短内容后重试，草稿仍保留。',retryable:false},'not-sent');}
 if(!plain(copy)||Object.hasOwn(copy,'idempotencyKey'))return invalid();const body=JSON.stringify({...copy,idempotencyKey:key});
 if(bytes(body)>WORKSPACE_BODY_BYTES)throw new ApiError({code:'INVALID_REQUEST',message:'内容超过当前本地传输容量，本次未发送；请缩短内容后重试，草稿仍保留。',retryable:false},'not-sent');
 const command=Object.freeze({operation,body,fingerprint:JSON.stringify([operation,copy]),draftVersion,token:key});captures.add(command);return command;
}
function receiptFor(command:WorkspaceCommand,value:unknown):Receipt{
 const result=boundedWorkspaceClone(value,WORKSPACE_RESPONSE_BYTES),input=JSON.parse(command.body) as Record<string,unknown>;const targets:Target[]=[];
 if(command.operation==='batchDelete'){
  if(!Array.isArray(input.items)||input.items.length<1||input.items.length>1000||!Array.isArray(result)||result.length!==input.items.length)return invalid();
  const wanted=new Map<string,number>();for(const v of input.items){if(!plain(v)||!kind(v.kind)||!id(v.id)||!revision(v.expectedRevision)||wanted.has(`${v.kind}:${v.id}`))return invalid();wanted.set(`${v.kind}:${v.id}`,v.expectedRevision);}
  const seen=new Set<string>();for(const row of result){if(!plain(row)||Object.keys(row).sort().join(',')!=='deletedAt,id,kind,revision'||!kind(row.kind)||!id(row.id)||!revision(row.revision)||!date(row.deletedAt))return invalid();const key=`${row.kind}:${row.id}`,minimum=wanted.get(key);if(minimum===undefined||seen.has(key)||row.revision<minimum)return invalid();seen.add(key);targets.push(Object.freeze({kind:row.kind,id:row.id,minimumRevision:row.revision}));}
 }else if(command.operation==='importWatchlist'){
  if(!id(input.watchlistId)||!Array.isArray(input.items)||input.items.length<1||input.items.length>200||!plain(result)||Object.keys(result).sort().join(',')!=='created,skipped'||!Array.isArray(result.created)||!Array.isArray(result.skipped)||result.created.length+result.skipped.length!==input.items.length)return invalid();
  const counts=new Map<string,number>();for(const v of input.items){if(!plain(v)||typeof v.symbol!=='string'||(v.market!==undefined&&typeof v.market!=='string'))return invalid();const pair=JSON.stringify([(v.market??'UNSPECIFIED').toString().trim().toUpperCase(),v.symbol.trim().toUpperCase()]);counts.set(pair,(counts.get(pair)??0)+1);}
  const consume=(market:string,symbol:string)=>{const pair=JSON.stringify([market,symbol]),count=counts.get(pair)??0;if(count<1)invalid();counts.set(pair,count-1);return pair;};
  const pairs=new Map<string,string>(),targetIds=new Map<string,Target>(),createdIds=new Set<string>();
  for(const v of result.created){const row=validateWorkspaceRecord(v,'watchlist-item'),d=row.data as Record<string,unknown>;if(d.watchlistId!==input.watchlistId||row.deletedAt!==null||createdIds.has(row.id))return invalid();const pair=consume(String(d.market),String(d.symbol));if(pairs.has(pair))return invalid();pairs.set(pair,row.id);createdIds.add(row.id);targetIds.set(row.id,Object.freeze({kind:'watchlist-item',id:row.id,minimumRevision:row.revision}));}
  const skipped:ImportWatchlistResult['skipped']=[];for(const v of result.skipped){if(!plain(v)||Object.keys(v).sort().join(',')!=='existingId,market,symbol'||!id(v.existingId)||!schemas['watchlist-item'].symbol(v.symbol)||!schemas['watchlist-item'].market(v.market))return invalid();const pair=consume(String(v.market),String(v.symbol));if(pairs.has(pair)&&pairs.get(pair)!==v.existingId)return invalid();if([...pairs.entries()].some(([p,i])=>i===v.existingId&&p!==pair))return invalid();pairs.set(pair,v.existingId);if(!targetIds.has(v.existingId))targetIds.set(v.existingId,Object.freeze({kind:'watchlist-item',id:v.existingId,minimumRevision:1}));skipped.push({market:String(v.market),symbol:String(v.symbol),existingId:v.existingId});}
  if([...counts.values()].some(n=>n!==0))return invalid();return Object.freeze({targets:Object.freeze([...targetIds.values()]),createdCount:result.created.length,skipped:Object.freeze(skipped.map(v=>Object.freeze(v)))});
 }else{
  if(!kind(input.kind))return invalid();const row=validateWorkspaceRecord(result,input.kind,typeof input.id==='string'?input.id:undefined);if(command.operation!=='create'&&(!revision(input.expectedRevision)||row.revision<input.expectedRevision))return invalid();if(command.operation==='remove'?row.deletedAt===null:row.deletedAt!==null)return invalid();targets.push(Object.freeze({kind:input.kind,id:row.id,minimumRevision:row.revision}));
 }
 return Object.freeze({targets:Object.freeze(targets)});
}
export class WorkspaceWriteSession {
 private pendingValue:WorkspacePending|null=null;private draftValue:Record<string,unknown>|null=null;private version=0;private retentionFailure=false;private detached=false;private listeners=new Set<()=>void>();private controller:AbortController|null=null;private active:Promise<WorkspaceCompletion|null>|null=null;private completion:WorkspaceCompletion|null=null;private completionSerial=0;private rejectionValue:{command:WorkspaceCommand;message:string;conflict:boolean}|null=null;
 constructor(private readonly api:WorkspaceTransport=defaultTransport,private readonly authority:()=>void=()=>{}){}
 get pending(){return this.pendingValue;}get draft(){return this.draftValue?boundedWorkspaceClone(this.draftValue):null;}get draftVersion(){return this.version;}get available(){try{this.check();return true;}catch{return false;}}
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private emit(){for(const listener of this.listeners)listener();}private check(){if(this.detached)throw new Error('身份范围已变化，原工作区操作不可继续');this.authority();}
 setDraft(value:Record<string,unknown>|null){this.check();let next:Record<string,unknown>|null;try{next=value?boundedWorkspaceClone(value):null;}catch(error){this.retentionFailure=true;throw error;}if(JSON.stringify(next)!==JSON.stringify(this.draftValue))this.version++;this.draftValue=next;this.retentionFailure=false;}
 unsavedState(){return {dirty:this.retentionFailure||Boolean(this.draftValue?.dirty),pending:!!this.pendingValue};}
 detach(){this.detached=true;this.controller?.abort();this.draftValue=null;this.emit();}
 takeRejection(){this.check();const value=this.rejectionValue;this.rejectionValue=null;return value;}
 get completionEvent(){return this.completion?{id:this.completion.id,token:this.completion.command.token,draftVersion:this.completion.command.draftVersion}:null;}
 takeCompletion(expectedId:number){this.check();if(this.completion?.id!==expectedId)return null;const v=this.completion;this.completion=null;return v;}
 async submit(command:WorkspaceCommand):Promise<WorkspaceCompletion|null>{this.check();if(this.completion)throw new Error('原操作已确认，请先查看已核对结果；当前新草稿尚未发送。');if(!captures.has(command))throw new Error('工作区命令必须由有界快照创建');if(this.pendingValue){if(this.pendingValue.command.fingerprint!==command.fingerprint)throw new Error('请先核对原操作；修改后的草稿尚未发送，不会另建重复记录。');return this.recover();}this.pendingValue=Object.freeze({command,phase:'unknown',uncertain:false,message:'准备确认工作区操作'});this.emit();return this.recover();}
 recover():Promise<WorkspaceCompletion|null>{
  this.check();if(this.active)return this.active;if(!this.pendingValue)return Promise.resolve(null);const captured=this.pendingValue,c=new AbortController();this.controller=c;
  const current=()=>{this.check();if(c.signal.aborted)throw new Error('工作区操作已取消');};
  const update=(phase:WorkspacePending['phase'],message:string,receipt?:Receipt)=>{current();this.pendingValue=Object.freeze({command:captured.command,phase,uncertain:captured.uncertain||phase==='unknown'||phase==='readback-failed',message,...(receipt?{receipt}:{})});this.emit();};
  const run=async()=>{let receipt=captured.receipt;try{current();if(!receipt){update('sending','正在核对原操作');const result=await this.api.write(captured.command.operation,JSON.parse(captured.command.body),c.signal);current();receipt=receiptFor(captured.command,result);}update('reading','原操作已确认，正在逐项核对当前状态',receipt);
   const summaries:WorkspaceMutationSummary[]=new Array(receipt.targets.length);let next=0,totalBytes=0,record:WorkspaceRecord|undefined,failed=false;let failure:unknown;
   const worker=async()=>{while(!failed){current();const index=next++;if(index>=receipt!.targets.length)return;const target=receipt!.targets[index];try{const raw=await this.api.get({kind:target.kind,id:target.id,includeDeleted:true},c.signal);current();const row=validateWorkspaceRecord(raw,target.kind,target.id);totalBytes+=bytes(JSON.stringify(row));if(totalBytes>WORKSPACE_READ_TOTAL_BYTES||row.revision<target.minimumRevision)invalid();summaries[index]={kind:target.kind,id:row.id,revision:row.revision,deletedAt:row.deletedAt};if(!['batchDelete','importWatchlist'].includes(captured.command.operation))record=row;}catch(error){failed=true;failure=error;}}};
   await Promise.all(Array.from({length:Math.min(WORKSPACE_READ_CONCURRENCY,receipt.targets.length)},worker));current();if(failed)throw failure;if(summaries.some(v=>!v))invalid();
   this.pendingValue=null;this.completion={id:++this.completionSerial,command:captured.command,...(record?{record}:{}),current:summaries,...(receipt.createdCount===undefined?{}:{createdCount:receipt.createdCount,skipped:receipt.skipped!.map(v=>({...v}))})};this.emit();return this.completion;
  }catch(error){if(this.detached||c.signal.aborted)return null;try{current();}catch{return null;}
   const rejected=!receipt&&trustedWorkspaceRejection(error,captured.command.operation,captured.command.body);
   if(rejected){this.pendingValue=null;this.rejectionValue={command:captured.command,message:rejected.message,conflict:rejected.detail.code==='CONFLICT'};this.emit();return null;}
   // A later attempt not sent cannot clear an earlier uncertain command.
   if(!receipt&&!captured.uncertain&&error instanceof ApiError&&error.outcome==='not-sent'){this.pendingValue=null;this.emit();throw error;}
   update(receipt?'readback-failed':'unknown',receipt?'原操作已确认，但当前状态尚未全部核对；请仅重试读取。':'原操作结果尚未确认；请重试原操作，当前新草稿仍保留。',receipt);return null;
  }finally{if(this.controller===c)this.controller=null;}};
  const promise=run();this.active=promise;void promise.finally(()=>{if(this.active===promise)this.active=null;}).catch(()=>{});return promise;
 }
}
