import {
 MANUAL_INVENTORY_PROTOCOL, canonicalManualInventoryCommand, canonicalInventorySource,
 parseManualInventoryCapabilities, parseManualInventoryPreview, parseManualInventoryPreviewRequest,
 parseManualInventoryExecuteRequest, parseManualInventoryProof, parseManualInventoryOperationResult,
 parseManualInventoryResultRequest, parseManualInventoryResultPayload, parseManualInventoryHistoryRequest,
 parseManualInventoryHistoryPage, parseManualInventorySelection,
 type ManualInventoryPreviewRequest, type ManualInventoryExecuteRequest, type ManualInventoryResultRequest,
 type ManualInventoryHistoryRequest, type ManualInventoryBinding,
} from '../../shared/manual-inventory-protocol';

/** Dedicated transport: never changes generic definition error or retry semantics. */
export class ManualInventoryError extends Error {
 constructor(public readonly kind:'transport'|'invalid'|'access', message:string){super(message);this.name='ManualInventoryError';}
}
const invalid=()=>new ManualInventoryError('invalid','清单响应无法验证；原操作仍保留，请明确核对。');
export async function manualInventoryDigest(text:string):Promise<string>{
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
 return Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
}
export function inventoryBinding(value:ManualInventoryBinding):ManualInventoryBinding {
 return {identityScope:value.identityScope,automationStoreScope:value.automationStoreScope,documentStoreScope:value.documentStoreScope,
 scheduleId:value.scheduleId,scheduleRevision:value.scheduleRevision,skillId:value.skillId,skillRevision:value.skillRevision,selection:value.selection};
}
const sameBinding=(a:ManualInventoryBinding,b:ManualInventoryBinding)=>JSON.stringify(inventoryBinding(a))===JSON.stringify(inventoryBinding(b));
/** Bounds decoded bytes before JSON materialization; no unbounded response.json/text fallback. */
async function boundedBody(response:Response,limit:number):Promise<unknown>{
 if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??''))throw invalid();
 const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit))throw invalid();
 if(!response.body)throw invalid();
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit)throw invalid();text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}
 catch{throw invalid();}finally{try{await reader.cancel();}catch{/* No retry. */}reader.releaseLock();}
}
export function createManualInventoryApi(transport:typeof fetch=(...args)=>fetch(...args)){
 async function read(path:string,input:unknown,limit:number){
  const body=JSON.stringify(input);if(new TextEncoder().encode(body).length>4096)throw invalid();
  let response:Response;try{response=await transport(`/api/manual-inventory/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body,credentials:'same-origin',redirect:'error',cache:'no-store'});}catch{throw new ManualInventoryError('transport','连接中断，不能据此判断操作是否执行。');}
  // HTTP errors, including 409, are never terminal execution evidence.
  if(!response.ok){try{await response.body?.cancel();}catch{/* Ignore disposal only. */}throw new ManualInventoryError(path==='result'?'access':'transport',path==='result'?'历史清单当前不可访问；已提交记录不变。':'尚未取得可验证回执；请保留原操作并明确核对。');}
  return boundedBody(response,limit);
 }
 return {
  async capabilities(){const v=parseManualInventoryCapabilities(await read('capabilities',{protocol:MANUAL_INVENTORY_PROTOCOL},4096));if(!v)throw invalid();return v;},
  async preview(input:ManualInventoryPreviewRequest){const request=parseManualInventoryPreviewRequest(input);if(!request)throw invalid();const v=parseManualInventoryPreview(await read('preview',request,4096));if(!v||!sameBinding(v,request))throw invalid();return v;},
  async execute(input:ManualInventoryExecuteRequest,requestDigest:string){const request=parseManualInventoryExecuteRequest(input);if(!request)throw invalid();const v=parseManualInventoryProof(await read('execute',request,2048));if(!v||v.operationId!==request.operationId||v.requestDigest!==requestDigest)throw invalid();return v;},
  async operation(input:ManualInventoryExecuteRequest,requestDigest:string){const request=parseManualInventoryExecuteRequest(input);if(!request)throw invalid();const v=parseManualInventoryOperationResult(await read('operation',request,2048));if(!v||v.operationId!==request.operationId||v.requestDigest!==requestDigest)throw invalid();return v;},
  async result(input:ManualInventoryResultRequest){const request=parseManualInventoryResultRequest(input);if(!request)throw invalid();const v=parseManualInventoryResultPayload(await read('result',request,262144));if(!v||v.runId!==request.runId||v.resultId!==request.resultId||v.binding.identityScope!==request.identityScope||v.binding.automationStoreScope!==request.automationStoreScope)throw invalid();
   if(await manualInventoryDigest(canonicalInventorySource(v.binding.documentStoreScope,v.binding.selection,v.documents))!==v.inventoryDigest)throw invalid();return v;},
  async history(input:ManualInventoryHistoryRequest){const request=parseManualInventoryHistoryRequest(input);if(!request)throw invalid();const v=parseManualInventoryHistoryPage(await read('history',request,32768));if(!v||v.identityScope!==request.identityScope||v.automationStoreScope!==request.automationStoreScope||v.items.length>request.limit||v.items.some(i=>request.scheduleId!==null&&i.scheduleId!==request.scheduleId)||v.items.some(i=>request.cursor&&(i.completedAt>request.cursor.completedAt||(i.completedAt===request.cursor.completedAt&&i.runId>=request.cursor.runId))))throw invalid();return v;},
  async choices(documentStoreScope:string){
   let response:Response;try{response=await transport('/api/documents/choices',{credentials:'same-origin',redirect:'error',cache:'no-store'});}catch{throw new ManualInventoryError('transport','当前范围选项不可读取。');}
   if(!response.ok)throw new ManualInventoryError('access','当前范围选项不可读取。');
   const value=await boundedBody(response,1048576) as {uploadScope?:unknown;workspaces?:unknown;folders?:unknown};
   if(!value||value.uploadScope!==documentStoreScope||!Array.isArray(value.workspaces)||!Array.isArray(value.folders)||value.workspaces.length>10000||value.folders.length>10000)throw invalid();
   const label=(v:unknown):v is string=>typeof v==='string'&&v.length<=512&&!!v.trim()&&!/[\u0000-\u001f\u007f]/.test(v);
   const workspaces=value.workspaces.map((w:unknown)=>{const i=w as {id:string;name:string};if(!i||typeof i.id!=='string'||!parseManualInventorySelection({mode:'workspace',workspaceId:i.id,folderId:null})||!label(i.name))throw invalid();return {id:i.id,name:i.name};});
   const folders=value.folders.map((f:unknown)=>{const i=f as {id:string;name:string;workspaceId:string|null};if(!i||!parseManualInventorySelection({mode:'folder',workspaceId:i.workspaceId,folderId:i.id})||!label(i.name))throw invalid();return {id:i.id,name:i.name,workspaceId:i.workspaceId};});
   if(new Set(workspaces.map(w=>w.id)).size!==workspaces.length||new Set(folders.map(f=>f.id)).size!==folders.length)throw invalid();
   return {workspaces,folders};
  },
 };
}
export const manualInventoryApi=createManualInventoryApi();
export type ManualInventoryApi=ReturnType<typeof createManualInventoryApi>;
export {canonicalManualInventoryCommand};
