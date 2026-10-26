/** Workspace-only persisted rejection contract. A status code alone is never a proof. */
export type WorkspaceCommandOperation = 'workspace.create' | 'workspace.update' | 'workspace.remove' | 'workspace.restore' | 'workspace.batchDelete' | 'workspace.importWatchlist';
export type WorkspaceCommandOutcome = {version:1;state:'rejected';operation:WorkspaceCommandOperation;idempotencyKey:string;requestDigest:string};
export const WORKSPACE_COMMAND_MAX_BYTES = 1024 * 1024;
/** A fully inspected JSON value exceeded only the canonical byte budget. */
export class WorkspaceCommandByteLimitError extends RangeError {}
const operations: readonly string[] = ['workspace.create', 'workspace.update', 'workspace.remove', 'workspace.restore', 'workspace.batchDelete', 'workspace.importWatchlist'];
const exact = (value:unknown, keys:readonly string[]):value is Record<string,unknown> => {
 if(value===null||typeof value!=='object'||Array.isArray(value))return false;
 const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null)return false;
 const descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(value);
 return names.length===keys.length&&names.every(k=>typeof k==='string'&&keys.includes(k)&&descriptors[k]?.enumerable&&'value' in descriptors[k]);
};
export function isWorkspaceCommandOperation(value:unknown):value is WorkspaceCommandOperation{return typeof value==='string'&&operations.includes(value)}
export function workspaceCommandCanonical(operation:WorkspaceCommandOperation,input:unknown):string{
 if(!isWorkspaceCommandOperation(operation))throw new TypeError('Invalid workspace operation');
 let nodes=0;const seen=new Set<object>();
 const encode=(value:unknown,depth:number):string=>{
  if(depth>16||++nodes>8192)throw new TypeError('Workspace command structure limit');
  if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(typeof value!=='object'||value===null||seen.has(value))throw new TypeError('Invalid workspace JSON');
  seen.add(value);try{
   const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null&&!(Array.isArray(value)&&proto===Array.prototype))throw new TypeError('Invalid workspace object');
   const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);
   if(keys.some(k=>typeof k!=='string'||(!Array.isArray(value)||k!=='length')&&(!descriptors[k]?.enumerable||!('value' in descriptors[k]))))throw new TypeError('Invalid workspace property');
   if(Array.isArray(value)){
    if(keys.length!==value.length+1)throw new TypeError('Sparse or extended workspace array');
    const parts:string[]=[];for(let i=0;i<value.length;i++){if(!Object.hasOwn(descriptors,String(i)))throw new TypeError('Sparse workspace array');parts.push(encode(descriptors[String(i)].value,depth+1));}return '['+parts.join(',')+']';
   }
   return '{'+(keys as string[]).sort().map(k=>JSON.stringify(k)+':'+encode(descriptors[k].value,depth+1)).join(',')+'}';
  }finally{seen.delete(value)}
 };
 const result=encode({family:'workspace',protocol:1,operation,input},0);if(new TextEncoder().encode(result).length>WORKSPACE_COMMAND_MAX_BYTES)throw new WorkspaceCommandByteLimitError('Workspace command byte limit');return result;
}
export function parseWorkspaceCommandOutcome(value:unknown,expected:{operation:WorkspaceCommandOperation;idempotencyKey:string;requestDigest:string}):WorkspaceCommandOutcome|null{
 try{if(!exact(value,['version','state','operation','idempotencyKey','requestDigest']))return null;
 if(value.version!==1||value.state!=='rejected'||value.operation!==expected.operation||!isWorkspaceCommandOperation(value.operation)||value.idempotencyKey!==expected.idempotencyKey||typeof value.idempotencyKey!=='string'||value.idempotencyKey.length<1||value.idempotencyKey.length>100||value.requestDigest!==expected.requestDigest||typeof value.requestDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.requestDigest))return null;
 return Object.freeze({version:1,state:'rejected',operation:value.operation,idempotencyKey:value.idempotencyKey,requestDigest:value.requestDigest});}catch{return null}
}
