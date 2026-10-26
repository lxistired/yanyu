import {validStoreId} from './transcription-store-session';
import { effectiveManualPlanLinks, MANUAL_PLAN_STATES, MANUAL_PLAN_LIMITS as L, type ManualPlanFields, type ManualPlanData, type ManualPlanSourceLink, type ManualPlanRecord, type ManualPlanPage, type ManualPlanState, type ListManualPlans, type ManualPlanMaterialLink, type ManualPlanDocumentLink, type ManualPlanSessionLink, type ManualPlanSessionTarget, type ManualPlanSessionChoicesRequest, type ManualPlanSessionChoices, type ManualPlanLinkedSessionRequest, type ManualPlanLinkedSession, type ManualPlanLinkedSessionMessage } from '../../shared/manual-plans';
export const RAW_LIMIT = 32 * 1024;
const bytes = (v: string) => new TextEncoder().encode(v).length;
const fail = (): never => { throw new Error('手动计划数据无效'); };
function object(v: unknown, keys: readonly string[], required = keys): Record<string, unknown> {
 if (!v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) return fail();
 const ds = Object.getOwnPropertyDescriptors(v);
 if (Reflect.ownKeys(ds).some(k => typeof k !== 'string' || !keys.includes(k) || !ds[k].enumerable || !('value' in ds[k]) || ds[k].value === undefined) || required.some(k => !Object.hasOwn(ds,k))) return fail();
 return v as Record<string,unknown>;
}
export function planText(v: unknown, max: number, required = false): string {
 if (typeof v !== 'string' || bytes(v)>max || (required&&!v.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)) return fail(); return v;
}
export function planDate(v: unknown): string {
 if (typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)) return fail();
 const [y,m,d]=v.split('-').map(Number), leap=y%4===0&&(y%100!==0||y%400===0);
 if(y<1970||y>2100||m<1||m>12||d<1||d>[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][m-1])return fail(); return v;
}
function id(v: unknown): string { if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(v))return fail();return v; }
function int(v:unknown,min:number,max=Number.MAX_SAFE_INTEGER):number { if(!Number.isSafeInteger(v)||Number(v)<min||Number(v)>max)return fail();return Number(v); }
function state(v:unknown):ManualPlanState {if(!MANUAL_PLAN_STATES.includes(v as ManualPlanState))return fail();return v as ManualPlanState;}
function timestamp(v:unknown):string {if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v))return fail();planDate(v.slice(0,10));if(v.slice(11,13)>'23'||v.slice(14,16)>'59'||v.slice(17,19)>'59')return fail();return v;}
export function fields(v:unknown):ManualPlanFields {
 const r=object(v,['title','objective','notes','targetDate']);return {title:planText(r.title,L.titleBytes,true).trim(),objective:planText(r.objective,L.textBytes,true),notes:planText(r.notes,L.textBytes),targetDate:r.targetDate===null?null:planDate(r.targetDate)};
}
// Ordinary workspace titles have a deliberately different legacy text contract.
function displayTitle(v:unknown):string {if(typeof v!=='string'||!v.trim()||bytes(v)>L.titleBytes||v.includes('\0'))return fail();return v;}
function scopeId(v:unknown):string {if(typeof v!=='string'||v.length!==64||! /^[a-f0-9]{64}$/.test(v))return fail();return v;}
function target(v:unknown):ManualPlanSessionTarget {
 const r=object(v,['workspaceId','sessionId','workspaceRevision','sessionRevision']);
 return {workspaceId:id(r.workspaceId),sessionId:id(r.sessionId),workspaceRevision:int(r.workspaceRevision,1),sessionRevision:int(r.sessionRevision,1)};
}
function link(v:unknown):ManualPlanSessionLink|null {
 if(v===null)return null;const r=object(v,['scope','workspaceId','sessionId','workspaceRevision','sessionRevision']);
 return {scope:scopeId(r.scope),...target({workspaceId:r.workspaceId,sessionId:r.sessionId,workspaceRevision:r.workspaceRevision,sessionRevision:r.sessionRevision})};
}
export function materialLink(v:unknown):ManualPlanMaterialLink|null {
 if(v===null)return null;const r=object(v,['kind','transcriptStoreId','jobId']);
 if(r.kind!=='transcript'||!validStoreId(r.transcriptStoreId)||typeof r.jobId!=='string'||r.jobId.length<1||r.jobId.length>160||!/^[A-Za-z0-9]/.test(r.jobId)||/[^A-Za-z0-9_.:-]/.test(r.jobId))return fail();
 return {kind:'transcript',transcriptStoreId:r.transcriptStoreId,jobId:r.jobId};
}
export function documentLink(v:unknown):ManualPlanDocumentLink|null {
 if(v===null)return null;const r=object(v,['kind','documentStoreId','documentId']);
 const uuid=(value:unknown):value is string=>typeof value==='string'&&value.length===36&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
 if(r.kind!=='document'||!uuid(r.documentStoreId)||!uuid(r.documentId))return fail();
 return {kind:'document',documentStoreId:r.documentStoreId,documentId:r.documentId};
}
export function sourceLink(v:unknown):ManualPlanSourceLink {
 const r=object(v,['kind','transcriptStoreId','jobId','documentStoreId','documentId'],['kind']);
 if(r.kind==='transcript')return materialLink(r)!;
 if(r.kind==='document')return documentLink(r)!;
 return fail();
}
/** Dense, ordinary bounded arrays only. Never invoke selection/item accessors. */
export function materialLinks(v:unknown):ManualPlanSourceLink[] {
 if(!Array.isArray(v)||Object.getPrototypeOf(v)!==Array.prototype)return fail();
 const length=Object.getOwnPropertyDescriptor(v,'length')?.value;
 if(!Number.isSafeInteger(length)||length<0||length>L.materialLinks)return fail();
 const ds=Object.getOwnPropertyDescriptors(v as object);if(Reflect.ownKeys(ds).length!==length+1)return fail();
 const result:ManualPlanSourceLink[]=[];
 for(let index=0;index<length;index++){
  const d=ds[String(index)];if(!d||!d.enumerable||!('value' in d))return fail();
  result.push(sourceLink(d.value));
 }
 return result;
}
export function validateRecord(v:unknown, expectedId?:string):ManualPlanRecord {
 const r=object(v,['id','kind','revision','createdAt','updatedAt','deletedAt','data','storeScope'],['id','kind','revision','createdAt','updatedAt','deletedAt','data']),d=object(r.data,['schemaVersion','provenance','state','title','objective','notes','targetDate','sessionLink','materialLink','documentLink','materialLinks'],['schemaVersion','provenance','state','title','objective','notes','targetDate']);
 if(r.kind!=='manual-research-plan'||d.schemaVersion!==1||d.provenance!=='user-authored-local')return fail();
 const key=id(r.id);if(expectedId!==undefined&&key!==expectedId)return fail();
 const f=fields({title:d.title,objective:d.objective,notes:d.notes,targetDate:d.targetDate});if(f.title!==d.title)return fail();
 const data:ManualPlanData={...f,schemaVersion:1,provenance:'user-authored-local',state:state(d.state),...(Object.hasOwn(d,'sessionLink')?{sessionLink:link(d.sessionLink)}:{}),...(Object.hasOwn(d,'materialLink')?{materialLink:materialLink(d.materialLink)}:{}),...(Object.hasOwn(d,'documentLink')?{documentLink:documentLink(d.documentLink)}:{}),...(Object.hasOwn(d,'materialLinks')?{materialLinks:materialLinks(d.materialLinks)}:{})};
 if(effectiveManualPlanLinks(data).length>L.materialLinks)return fail();
 return {id:key,kind:'manual-research-plan',...(Object.hasOwn(r,'storeScope')?{storeScope:scopeId(r.storeScope)}:{}),revision:int(r.revision,1),createdAt:timestamp(r.createdAt),updatedAt:timestamp(r.updatedAt),deletedAt:r.deletedAt===null?null:timestamp(r.deletedAt),data};
}
export function validatePage(v:unknown, offset:number, limit:number):ManualPlanPage {
 const r=object(v,['items','total','offset','nextOffset']);if(!Array.isArray(r.items)||r.items.length>limit||r.offset!==offset)return fail();
 const items=r.items.map(x=>validateRecord(x)),total=int(r.total,0,L.scanRows),next=r.nextOffset===null?null:int(r.nextOffset,0,L.maxOffset);
 if(new Set(items.map(x=>x.id)).size!==items.length||items.length>Math.max(0,total-offset)||next!==(items.length&&offset+items.length<total?offset+items.length:null)||(offset<total&&!items.length))return fail();
 return {items,total,offset,nextOffset:next};
}
export type Operation = 'get'|'list'|'create'|'update'|'setState'|'reopen'|'remove'|'restore'|'sessionChoices'|'linkedSession'|'setSessionLink'|'setMaterialLink'|'setDocumentLink'|'addMaterialLinks'|'removeMaterialLink';
export type WriteOperation = Exclude<Operation,'get'|'list'|'sessionChoices'|'linkedSession'>;
export type CapturedCommand = Readonly<{operation:WriteOperation; body:string; id?:string;scope?:string}>;
export function captureCommand(operation:WriteOperation, key:string, input:ManualPlanFields|{id:string;expectedRevision:number;patch?:ManualPlanFields;state?:ManualPlanState;scope?:string;sessionLink?:ManualPlanSessionTarget|null;materialLink?:ManualPlanSourceLink|null;documentLink?:ManualPlanDocumentLink|null;materialLinks?:ManualPlanSourceLink[]}):CapturedCommand {
 id(key);let payload:Record<string,unknown>,canonical:Record<string,unknown>;
 const scoped=['setSessionLink','setMaterialLink','setDocumentLink','addMaterialLinks','removeMaterialLink'].includes(operation);
 if(operation==='create') {
  const f=fields(input);payload={idempotencyKey:key,...f};canonical={operation:'manual-plans.create',data:{schemaVersion:1,provenance:'user-authored-local',...f,state:'draft'}};
 }else {
  const extra=operation==='update'?['patch']:operation==='setState'?['state']:operation==='setSessionLink'?['scope','sessionLink']:operation==='setMaterialLink'||operation==='removeMaterialLink'?['scope','materialLink']:operation==='setDocumentLink'?['scope','documentLink']:operation==='addMaterialLinks'?['scope','materialLinks']:[];
  if(!['update','setState','reopen','remove','restore',...['setSessionLink','setMaterialLink','setDocumentLink','addMaterialLinks','removeMaterialLink']].includes(operation))return fail();
  const r=object(input,['id','expectedRevision',...extra]),base={id:id(r.id),expectedRevision:int(r.expectedRevision,1)};
  const args=operation==='update'?{patch:fields(r.patch)}:operation==='setState'?{state:state(r.state)}:operation==='setSessionLink'?{scope:scopeId(r.scope),sessionLink:r.sessionLink===null?null:target(r.sessionLink)}:operation==='setMaterialLink'?{scope:scopeId(r.scope),materialLink:materialLink(r.materialLink)}:operation==='setDocumentLink'?{scope:scopeId(r.scope),documentLink:documentLink(r.documentLink)}:operation==='addMaterialLinks'?{scope:scopeId(r.scope),materialLinks:materialLinks(r.materialLinks)}:operation==='removeMaterialLink'?{scope:scopeId(r.scope),materialLink:sourceLink(r.materialLink)}:{};
  payload={idempotencyKey:key,...base,...args};canonical={operation:`manual-plans.${operation}`,...base,...args};
 }
 const body=JSON.stringify(payload);if(bytes(body)>RAW_LIMIT||bytes(JSON.stringify(canonical))>L.commandBytes)return fail();
 return Object.freeze({operation,body,...(operation==='create'?{}:{id:payload.id as string}),...(scoped?{scope:payload.scope as string}:{})});
}
export class PlanRequestError extends Error { constructor(public readonly code:string, public readonly definite:boolean){super(code==='CONFLICT'?'计划已发生变化，草稿已保留。请先读取并核对当前数据，再继续编辑。':'请求失败，草稿已保留。');} }
export class ManualPlanClient {
 constructor(private readonly transport:typeof fetch=fetch,private readonly assertAuthority:()=>void=()=>{}){}
 private async post(operation:Operation, body:string):Promise<unknown>{
  this.assertAuthority();
  if(!['get','list','create','update','setState','reopen','remove','restore','sessionChoices','linkedSession','setSessionLink','setMaterialLink','setDocumentLink','addMaterialLinks','removeMaterialLink'].includes(operation))throw new PlanRequestError('INVALID_REQUEST',true);
  if(bytes(body)>RAW_LIMIT)throw new PlanRequestError('INVALID_REQUEST',true);
  const response=await this.transport(`/api/manual-plans/${operation}`,{method:'POST',body,headers:{'Content-Type':'application/json'},credentials:'same-origin',redirect:'error',cache:'no-store'});
  this.assertAuthority();
  if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))throw new PlanRequestError('INVALID_RESPONSE',false);
  const reader=response.body?.getReader();if(!reader)throw new PlanRequestError('INVALID_RESPONSE',false);
  const chunks:Uint8Array[]=[];let count=0;
  try{while(true){const {done,value}=await reader.read();this.assertAuthority();if(done)break;count+=value.byteLength;if(count>L.pageBytes)throw new Error('响应超过大小限制');chunks.push(value);}}catch{await reader.cancel().catch(()=>{});throw new PlanRequestError('INVALID_RESPONSE',false);}finally{reader.releaseLock();}
  let value:unknown;try{const all=new Uint8Array(count);let at=0;for(const c of chunks){all.set(c,at);at+=c.length;}value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));}catch{throw new PlanRequestError('INVALID_RESPONSE',false);}
  if(!response.ok){let code='FAILED';try{const e=object(value,['error']);const detail=object(e.error,['code','message','retryable'],['code','message']);if(typeof detail.code==='string')code=detail.code;}catch{/* Never surface raw server text. */}
   throw new PlanRequestError(code,[400,403,404,409,413,422].includes(response.status)&&['INVALID_REQUEST','FORBIDDEN','NOT_FOUND','CONFLICT','PAYLOAD_TOO_LARGE'].includes(code));}
  this.assertAuthority();
  return value;
 }
 async get(key:string,scope?:string){const value=await this.post('get',JSON.stringify({id:id(key),includeDeleted:true,...(scope===undefined?{}:{scope:scopeId(scope)})}));this.assertAuthority();const record=validateRecord(value,key);if(scope!==undefined&&record.storeScope!==scope)return fail();return record;}
 async list(request:ListManualPlans){const r=object(request,['offset','limit','query','state','fromDate','toDate','includeDeleted','sort','direction'],[]);const offset=int(r.offset??0,0,L.maxOffset),limit=int(r.limit??L.defaultLimit,1,L.maxLimit);if(r.query!==undefined)planText(r.query,L.queryBytes);if(r.state!==undefined)state(r.state);if(r.fromDate!==undefined)planDate(r.fromDate);if(r.toDate!==undefined)planDate(r.toDate);if(r.fromDate&&r.toDate&&r.fromDate>=r.toDate)return fail();if(r.includeDeleted!==undefined&&typeof r.includeDeleted!=='boolean')return fail();if(r.sort!==undefined&&!['updatedAt','targetDate'].includes(r.sort as string))return fail();if(r.direction!==undefined&&!['asc','desc'].includes(r.direction as string))return fail();const value=await this.post('list',JSON.stringify({...request,offset,limit}));this.assertAuthority();return validatePage(value,offset,limit);}
 async sessionChoices(request:ManualPlanSessionChoicesRequest):Promise<ManualPlanSessionChoices>{
  const r=object(request,['id','expectedRevision','workspaceId','offset','scope'],['id','expectedRevision','workspaceId','scope']);
  const input={id:id(r.id),expectedRevision:int(r.expectedRevision,1),workspaceId:r.workspaceId===null?null:id(r.workspaceId),offset:int(r.offset??0,0,L.maxOffset),scope:scopeId(r.scope)};
  const v=object(await this.post('sessionChoices',JSON.stringify(input)),['scope','planId','planRevision','workspace','items','total','offset','nextOffset','currentLink']);
  this.assertAuthority();const scope=scopeId(v.scope);
  if(v.planId!==input.id||v.planRevision!==input.expectedRevision||input.scope!==undefined&&input.scope!==scope||v.offset!==input.offset)return fail();
  const choice=(raw:unknown)=>{const c=object(raw,['id','title','revision']);return {id:id(c.id),title:displayTitle(c.title),revision:int(c.revision,1)};};
  const workspace=v.workspace===null?null:choice(v.workspace);
  if((workspace?.id??null)!==input.workspaceId||!Array.isArray(v.items)||v.items.length>25)return fail();
  const items=v.items.map(choice),total=int(v.total,0,L.scanRows),offset=input.offset,nextOffset=v.nextOffset===null?null:int(v.nextOffset,0,L.maxOffset);
  if(new Set(items.map(x=>x.id)).size!==items.length||items.length>Math.max(0,total-offset)||nextOffset!==(offset+items.length<total?offset+items.length:null)||offset<total&&!items.length)return fail();
  const current=object(v.currentLink,['status','workspaceTitle','sessionTitle'],['status']);
  if(!['none','available','stale','unavailable'].includes(current.status as string))return fail();
  const named=current.status==='available'||current.status==='stale';
  if(named!==Object.hasOwn(current,'workspaceTitle')||named!==Object.hasOwn(current,'sessionTitle'))return fail();
  const currentLink={status:current.status as ManualPlanSessionChoices['currentLink']['status'],...(named?{workspaceTitle:displayTitle(current.workspaceTitle),sessionTitle:displayTitle(current.sessionTitle)}:{})};
  return {scope,planId:input.id,planRevision:input.expectedRevision,workspace,items,total,offset,nextOffset,currentLink};
 }
 async linkedSession(request:ManualPlanLinkedSessionRequest):Promise<ManualPlanLinkedSession>{
  const r=object(request,['id','expectedRevision','scope','sessionLink','offset','limit'],['id','expectedRevision','scope','sessionLink']);
  const saved=link(r.sessionLink);if(!saved)return fail();
  const input={id:id(r.id),expectedRevision:int(r.expectedRevision,1),scope:scopeId(r.scope),sessionLink:saved,offset:int(r.offset??0,0,L.maxOffset),limit:int(r.limit??L.defaultLimit,1,L.maxLimit)};
  if(saved.scope!==input.scope)return fail();
  const v=object(await this.post('linkedSession',JSON.stringify(input)),['scope','planId','planRevision','sessionLink','workspace','session','items','total','offset','nextOffset']);
  this.assertAuthority();const returnedLink=link(v.sessionLink);
  if(v.scope!==input.scope||v.planId!==input.id||v.planRevision!==input.expectedRevision||JSON.stringify(returnedLink)!==JSON.stringify(saved)||v.offset!==input.offset)return fail();
  const w=object(v.workspace,['id','title','revision']),s=object(v.session,['id','title','revision','workspaceId','mode','model']);
  if(w.id!==saved.workspaceId||w.revision!==saved.workspaceRevision||s.id!==saved.sessionId||s.revision!==saved.sessionRevision||s.workspaceId!==saved.workspaceId||!['quick','deep','plan','daily'].includes(s.mode as string))return fail();
  // These are ordinary saved manual records: preserve their legacy text contract,
  // including non-NUL controls, rather than silently normalizing or truncating.
  const ordinaryText=(value:unknown,max:number,required=false):string=>{if(typeof value!=='string'||bytes(value)>max||value.includes('\0')||required&&!value.trim())return fail();return value;};
  const workspace={id:saved.workspaceId,title:displayTitle(w.title),revision:saved.workspaceRevision};
  const session={id:saved.sessionId,title:displayTitle(s.title),revision:saved.sessionRevision,workspaceId:saved.workspaceId,mode:s.mode as ManualPlanLinkedSession['session']['mode'],model:ordinaryText(s.model,240)};
  if(!Array.isArray(v.items)||v.items.length>input.limit)return fail();
  const items:ManualPlanLinkedSessionMessage[]=v.items.map(raw=>{
   const row=object(raw,['id','kind','revision','createdAt','updatedAt','deletedAt','data']),data=object(row.data,['sessionId','role','content','sequence'],['sessionId','role','content']);
   if(row.kind!=='message'||row.deletedAt!==null||data.sessionId!==saved.sessionId||!['user','assistant','system'].includes(data.role as string))return fail();
   return {id:id(row.id),kind:'message',revision:int(row.revision,1),createdAt:timestamp(row.createdAt),updatedAt:timestamp(row.updatedAt),deletedAt:null,data:{sessionId:saved.sessionId,role:data.role as ManualPlanLinkedSessionMessage['data']['role'],content:ordinaryText(data.content,65536,true),...(Object.hasOwn(data,'sequence')?{sequence:int(data.sequence,1)}:{})}};
  });
  const total=int(v.total,0,L.scanRows),offset=input.offset,nextOffset=v.nextOffset===null?null:int(v.nextOffset,0,L.maxOffset);
  if(new Set(items.map(row=>row.id)).size!==items.length||items.length>Math.max(0,total-offset)||nextOffset!==(items.length&&offset+items.length<total?offset+items.length:null)||offset<total&&!items.length)return fail();
  return {scope:input.scope,planId:input.id,planRevision:input.expectedRevision,sessionLink:saved,workspace,session,items,total,offset,nextOffset};
 }
 async write(command:CapturedCommand){const value=await this.post(command.operation,command.body);this.assertAuthority();return validateRecord(value,command.id);}
}
