import {workspaceIdentifier} from './workspace-identifier';
// Local metadata-only recovery journal. File bytes are never placed in browser storage.
export type UploadRecord = {
 version:1; scope:string; operationId:string; name:string; format:'txt'|'md'|'pdf';
 bytes:number; sha256:string; workspaceId:string|null; folderId:string|null; createdAt:string;
};
export type UploadReceipt = Omit<UploadRecord,'version'|'scope'> & {documentId:string};
export const UPLOAD_JOURNAL_PREFIX='yanyu:document-upload:v1:';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash=/^[a-f0-9]{64}$/;
const maxRecords=16;
const fields=['bytes','createdAt','folderId','format','name','operationId','scope','sha256','version','workspaceId'];
const fail:()=>never=()=>{throw Error('上传恢复记录不可用；为避免重复上传，已停止新上传。请保留此浏览器数据并核对本地文档。');};
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:fail();
export const validUploadScope=(scope:unknown):scope is string=>typeof scope==='string'&&uuid.test(scope);
function validText(value:unknown){return typeof value==='string'&&value.length>0&&!/[\u0000-\u001f\u007f]/u.test(value)&&new TextEncoder().encode(value).length<=512;}
function validate(value:unknown,scope:string):UploadRecord{
 const v=object(value);
 if(Object.keys(v).sort().join(',')!==fields.join(',')||v.version!==1||v.scope!==scope||!validUploadScope(scope)||!validUploadScope(v.operationId)||!validText(v.name)||/[\\/]/u.test(v.name as string)||!['txt','md','pdf'].includes(v.format as string)||!Number.isSafeInteger(v.bytes)||(v.bytes as number)<1||(v.bytes as number)>8*1024*1024||typeof v.sha256!=='string'||!hash.test(v.sha256)||!(v.workspaceId===null||workspaceIdentifier(v.workspaceId))||!(v.folderId===null||validUploadScope(v.folderId))||typeof v.createdAt!=='string'||!Number.isFinite(Date.parse(v.createdAt)))fail();
 if((/\.([^.]+)$/.exec(v.name as string)?.[1].toLowerCase())!==v.format)fail();
 return v as unknown as UploadRecord;
}
const key=(record:UploadRecord)=>`${UPLOAD_JOURNAL_PREFIX}${record.scope}:${record.operationId}`;
export function readUploadRecords(storage:Storage,scope:string):UploadRecord[]{
 if(!validUploadScope(scope))fail();
 const prefix=UPLOAD_JOURNAL_PREFIX+scope+':',records:UploadRecord[]=[];
 try{
  for(let i=0;i<storage.length;i++){
   const name=storage.key(i);if(!name?.startsWith(prefix))continue;
   const raw=storage.getItem(name);if(!raw||raw.length>4096)fail();
   const record=validate(JSON.parse(raw),scope);if(key(record)!==name)fail();records.push(record);
   if(records.length>maxRecords)fail();
  }
 }catch{fail()}
 return records.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.operationId.localeCompare(b.operationId));
}
export function retainUploadRecord(storage:Storage,record:UploadRecord){
 validate(record,record.scope);
 const existing=readUploadRecords(storage,record.scope),prior=existing.find(item=>item.operationId===record.operationId);
 if(prior&&JSON.stringify(prior)!==JSON.stringify(record))fail();
 if(!prior&&existing.length>=maxRecords)throw Error('待核对上传已达 16 项，请先核对原操作。');
 try{const raw=JSON.stringify(record);storage.setItem(key(record),raw);if(storage.getItem(key(record))!==raw)fail()}catch{fail()}
}
export function forgetUploadRecord(storage:Storage,record:UploadRecord){
 const prior=readUploadRecords(storage,record.scope).find(item=>item.operationId===record.operationId);
 if(!prior)return;
 if(JSON.stringify(prior)!==JSON.stringify(record))fail();
 try{storage.removeItem(key(record));if(storage.getItem(key(record))!==null)fail()}catch{fail()}
}
async function fileHash(file:File){
 if(!file.size||file.size>8*1024*1024)throw Error('文件必须非空且不超过 8 MiB');
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),n=>n.toString(16).padStart(2,'0')).join('');
}
export async function newUploadRecord(scope:string,file:File,workspaceId:string|null,folderId:string|null):Promise<UploadRecord>{
 const format=/\.([^.]+)$/.exec(file.name)?.[1].toLowerCase() as UploadRecord['format'];
 const record:UploadRecord={version:1,scope,operationId:crypto.randomUUID(),name:file.name,format,bytes:file.size,sha256:await fileHash(file),workspaceId,folderId,createdAt:new Date().toISOString()};
 return validate(record,scope);
}
export async function verifyUploadFile(record:UploadRecord,file:File){
 if(file.name!==record.name||file.size!==record.bytes||await fileHash(file)!==record.sha256)throw Error('请选择原来同名、同内容的文件；新文件不能复用此上传操作。');
}
export function verifyUploadReceipt(record:UploadRecord,value:unknown):UploadReceipt{
 const receipt=object(value);
 const expected=['bytes','createdAt','documentId','folderId','format','name','operationId','sha256','workspaceId'];
 if(Object.keys(receipt).sort().join(',')!==expected.join(',')||!validUploadScope(receipt.documentId)||typeof receipt.createdAt!=='string'||!Number.isFinite(Date.parse(receipt.createdAt)))throw Error('上传回执无效，已保留待确认记录。');
 for(const field of ['operationId','name','format','bytes','sha256','workspaceId','folderId'] as const)if(receipt[field]!==record[field])throw Error('上传回执与原操作不符，已保留待确认记录。');
 return receipt as unknown as UploadReceipt;
}
