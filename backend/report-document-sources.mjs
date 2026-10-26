// Internal, bounded extracted-text authority. No original BLOB or generic SQL is exposed.
import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const localId=new RegExp(`^local-doc:(${uuid}):(${uuid})(?![\\s\\S])`);
const uuidValue=new RegExp(`^${uuid}(?![\\s\\S])`);
const digest=/^[a-f0-9]{64}$/;
export function reportDocumentSources(access,authority){
 const {principal,collectionId,assertOwner,charge,error}=authority;
 const scope=access.scope;
 if(typeof scope!=='string'||!uuidValue.test(scope))error('CONFLICT','Invalid local document store identity');
 const ownerIdentity=JSON.stringify([principal.tenantId,principal.subjectId,[...principal.collectionIds]]);
 const documentId=id=>`local-doc:${scope}:${id}`;
 const revisionId=row=>`content:${row.sha256}:${row.text_sha256}`;
 function operation(ctx,budget){
  const deadline=performance.now()+30000;
  return ()=>{
   if(ctx.signal.aborted)error('CANCELLED','Local source operation cancelled');
   if(performance.now()>=deadline)error('RATE_LIMITED','Local source operation exceeded deadline');
   assertOwner(ctx);
   if(JSON.stringify([ctx.principal.tenantId,ctx.principal.subjectId,[...ctx.principal.collectionIds]])!==ownerIdentity||!ctx.principal.collectionIds.includes(collectionId))error('FORBIDDEN','Local source owner or collection changed');
   charge(budget,64);
   if(access.closed())error('UNAVAILABLE','Local document source is closed');
   if(access.liveScope()!==scope)error('CONFLICT','Local document store identity changed');
  };
 }
 function header(id,budget,check){
  check();charge(budget,4096);
  const row=access.header(id);
  if(!row||row.trashed_at!==null)error('NOT_FOUND','Active local source not found');
  if(row.id!==id||!uuidValue.test(row.id)||row.metadata_valid!==1||!['txt','md','pdf'].includes(row.format)||!digest.test(row.sha256)||!digest.test(row.text_sha256)||typeof row.name!=='string'||Buffer.byteLength(row.name)>512||!Number.isSafeInteger(row.revision)||row.revision<0||!Number.isSafeInteger(row.text_bytes)||row.text_bytes<0||row.text_bytes>1024*1024||row.actual_text_bytes!==row.text_bytes||!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>8*1024*1024||row.actual_original_bytes!==row.bytes||!Number.isFinite(Date.parse(row.created))||row.pages!==null&&(!Number.isSafeInteger(row.pages)||row.pages<1||row.pages>40))error('CONFLICT','Local source integrity metadata is invalid');
  try{access.validateAssociation(row.workspace_id,row.folder_id)}catch(cause){if(cause.code==='FORBIDDEN'||cause.status===403)error('FORBIDDEN','Local source workspace access denied');error('CONFLICT','Local source association is unavailable')}
  check();return row;
 }
 function identity(row){return JSON.stringify([row.id,row.format,row.bytes,row.sha256,row.text_sha256,row.created,row.pages,row.workspace_id,row.folder_id,row.revision,row.text_bytes,row.actual_text_bytes,row.actual_original_bytes])}
 function resolve(ctx,id,revision,budget){
  const check=operation(ctx,budget);check();
  const match=typeof id==='string'?localId.exec(id):null;
  if(!match)error('INVALID_REQUEST','Invalid local source identity');
  if(match[1]!==scope)error('CONFLICT','Local source belongs to a different document store');
  const row=header(match[2],budget,check);
  if(revision!==revisionId(row))error('CONFLICT','Local source content version changed');
  // Charge and validate actual byte length before retrieving text. Original bytes stay private.
  charge(budget,row.text_bytes,1);check();
  const text=access.text(row.id);
  if(typeof text!=='string'||Buffer.byteLength(text)!==row.text_bytes||sha(Buffer.from(text))!==row.text_sha256)error('CONFLICT','Extracted local source text failed integrity verification');
  const captured=identity(row);
  const verify=()=>{const current=header(row.id,budget,check);if(identity(current)!==captured)error('CONFLICT','Local source changed during report operation')};
  const document={id,revisionId:revision,tenantId:principal.tenantId,collectionId,title:`本地上传文档 · ${row.id}`,source:'research',author:'作者未核实；已核对提取文本，原件哈希为上传记录',date:row.created.slice(0,10),tags:['local-upload','extracted-text-sha256-verified','original-hash-at-upload'],excerpt:text.slice(0,240).replace(/[\uD800-\uDBFF]$/u,''),body:text,pages:row.pages??0,mock:false};
  verify();return {document,evidenceClass:'primary-source',authorizationMode:'current-local',locator:{storeScope:scope,documentId:row.id,metadataRevision:row.revision},check:verify};
 }
 function choices(ctx,input,budget){
  const check=operation(ctx,budget);check();
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['offset','limit','storeScope'].includes(k)))error('INVALID_REQUEST','Unexpected source choices field');
  const offset=input.offset??0,limit=input.limit??10;
  if(!Number.isSafeInteger(offset)||offset<0||offset>250||!Number.isSafeInteger(limit)||limit<1||limit>25)error('INVALID_REQUEST','Invalid source choices page');
  if(input.storeScope!==undefined&&input.storeScope!==null&&input.storeScope!==scope||offset>0&&input.storeScope!==scope)error('CONFLICT','Source choices store changed; reload first page');
  charge(budget,(limit+1)*128,limit+1);
  const ids=access.ids(offset,limit+1);if(ids.some(id=>typeof id!=='string'||!uuidValue.test(id)))error('CONFLICT','Invalid local document identity');const items=[];
  for(const id of ids.slice(0,limit)){
   const row=header(id,budget,check);
   items.push({documentId:documentId(row.id),revisionId:revisionId(row),name:row.name,format:row.format,metadataRevision:row.revision});
  }
  check();return {storeScope:scope,items,nextOffset:ids.length>limit?offset+limit:null};
 }
 return Object.freeze({resolve,choices,storeScope:scope,check(ctx,budget){operation(ctx,budget)()}});
}
