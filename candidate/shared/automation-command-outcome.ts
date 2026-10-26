/** Automation-only persisted rejection contract. A status code alone is never a proof. */
export type AutomationCommandOperation = 'automation.createSkill' | 'automation.updateSkill' | 'automation.deleteSkill' | 'automation.restoreSkill' | 'automation.createDataSource' | 'automation.updateDataSource' | 'automation.deleteDataSource' | 'automation.restoreDataSource' | 'automation.createSchedule' | 'automation.updateSchedule' | 'automation.setScheduleState' | 'automation.deleteSchedule' | 'automation.restoreSchedule';
export type AutomationCommandOutcome = {version:1;state:'rejected';operation:AutomationCommandOperation;idempotencyKey:string;requestDigest:string};
export const AUTOMATION_COMMAND_MAX_BYTES = 40 * 1024;
const operations: readonly string[] = ['automation.createSkill', 'automation.updateSkill', 'automation.deleteSkill', 'automation.restoreSkill', 'automation.createDataSource', 'automation.updateDataSource', 'automation.deleteDataSource', 'automation.restoreDataSource', 'automation.createSchedule', 'automation.updateSchedule', 'automation.setScheduleState', 'automation.deleteSchedule', 'automation.restoreSchedule'];
const exact = (value:unknown, keys:readonly string[]):value is Record<string,unknown> => {
 if(value===null||typeof value!=='object'||Array.isArray(value))return false;
 const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null)return false;
 const descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(value);
 return names.length===keys.length&&names.every(k=>typeof k==='string'&&keys.includes(k)&&descriptors[k]?.enumerable&&'value' in descriptors[k]);
};
export function isAutomationCommandOperation(value:unknown):value is AutomationCommandOperation{return typeof value==='string'&&operations.includes(value)}
export function automationCommandCanonical(operation:AutomationCommandOperation,input:unknown):string{
 if(!isAutomationCommandOperation(operation))throw new TypeError('Invalid automation operation');
 let nodes=0;const seen=new Set<object>();
 const encode=(value:unknown,depth:number):string=>{
  if(depth>16||++nodes>8192)throw new TypeError('Automation command structure limit');
  if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(typeof value!=='object'||value===null||seen.has(value))throw new TypeError('Invalid automation JSON');
  seen.add(value);try{
   const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null&&!(Array.isArray(value)&&proto===Array.prototype))throw new TypeError('Invalid automation object');
   const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);
   if(keys.some(k=>typeof k!=='string'||(!Array.isArray(value)||k!=='length')&&(!descriptors[k]?.enumerable||!('value' in descriptors[k]))))throw new TypeError('Invalid automation property');
   if(Array.isArray(value)){
    if(keys.length!==value.length+1)throw new TypeError('Sparse or extended automation array');
    const parts:string[]=[];for(let i=0;i<value.length;i++){if(!Object.hasOwn(descriptors,String(i)))throw new TypeError('Sparse automation array');parts.push(encode(descriptors[String(i)].value,depth+1));}return '['+parts.join(',')+']';
   }
   return '{'+(keys as string[]).sort().map(k=>JSON.stringify(k)+':'+encode(descriptors[k].value,depth+1)).join(',')+'}';
  }finally{seen.delete(value)}
 };
 const result=encode({family:'automation-definition',protocol:1,operation,input},0);if(new TextEncoder().encode(result).length>AUTOMATION_COMMAND_MAX_BYTES)throw new TypeError('Automation command byte limit');return result;
}
export function parseAutomationCommandOutcome(value:unknown,expected:{operation:AutomationCommandOperation;idempotencyKey:string;requestDigest:string}):AutomationCommandOutcome|null{
 try{if(!exact(value,['version','state','operation','idempotencyKey','requestDigest']))return null;
 if(value.version!==1||value.state!=='rejected'||value.operation!==expected.operation||!isAutomationCommandOperation(value.operation)||value.idempotencyKey!==expected.idempotencyKey||typeof value.idempotencyKey!=='string'||value.idempotencyKey.length<1||value.idempotencyKey.length>100||value.requestDigest!==expected.requestDigest||typeof value.requestDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.requestDigest))return null;
 return Object.freeze({version:1,state:'rejected',operation:value.operation,idempotencyKey:value.idempotencyKey,requestDigest:value.requestDigest});}catch{return null}
}
