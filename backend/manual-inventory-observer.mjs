// Metadata-only, synchronous observation. The access capability is closure-local
// to researchDocuments; it cannot execute arbitrary SQL or read document content.
import {relationshipIdentifier} from './relationship-identifier.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const uuid=v=>typeof v==='string'&&v.length===36&&UUID.test(v);
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const bytes=v=>Buffer.byteLength(JSON.stringify(v),'utf8');
const synchronous=v=>{if(v&&typeof v.then==='function')throw new TypeError('Synchronous capability required');return v};

export function createManualInventoryObserver(access,authority,protocol){
 const guard=(fn,code='SOURCE_UNAVAILABLE')=>{try{return synchronous(fn())}catch(e){if(e?.manualInventoryObserverError&&code!=='RESULT_ACCESS_UNAVAILABLE')throw e;const error=authority.error(code);Object.defineProperty(error,'manualInventoryObserverError',{value:true});throw error}};
 // Every locally-created error carries a marker only inside this module. No
 // database exception, SQL text, pathname or partial metadata leaves the port.
 const refuse=code=>{const error=authority.error(code);Object.defineProperty(error,'manualInventoryObserverError',{value:true});throw error};
 const owner=ctx=>synchronous(authority.assertCurrent(ctx));
 function inputSelection(input,keys){
  if(!exact(input,keys)||!uuid(input.documentStoreScope))refuse('INVALID_REQUEST');
  const selection=protocol.parseManualInventorySelection(input.selection);
  if(!selection)refuse('INVALID_REQUEST');
  return selection;
 }
 function operation(ctx,input,budget,historical){
  const selection=inputSelection(input,historical?['documentStoreScope','selection','rows']:['documentStoreScope','selection']);
  const scope=input.documentStoreScope;
  const start=synchronous(authority.monotonicNow());
  if(!Number.isFinite(start)||!budget||typeof budget.check!=='function'||typeof budget.charge!=='function')refuse('BUDGET_EXCEEDED');
  let closed=false,passes=0;
  function check(){
   if(closed)refuse(historical?'RESULT_ACCESS_UNAVAILABLE':'SOURCE_UNAVAILABLE');
   const now=synchronous(authority.monotonicNow());
   if(!Number.isFinite(now)||now<start||now-start>5000)refuse('BUDGET_EXCEEDED');
   try{synchronous(budget.check())}catch{refuse('BUDGET_EXCEEDED')}
  }
  function pass(work){
   check();if(++passes>(historical?2:3))refuse('BUDGET_EXCEEDED');
   let charged=0,records=0,associations=0,scalars=0,candidates=0;
   const workspaceCache=new Set(),folderCache=new Map();
   const accounting=Object.freeze({check,charge(n,r=0){
    check();if(!Number.isSafeInteger(n)||n<0||!Number.isSafeInteger(r)||r<0)refuse('BUDGET_EXCEEDED');
    charged+=n;records+=r;
    if(!Number.isSafeInteger(charged)||charged>1048576||records>(historical?752:753))refuse('BUDGET_EXCEEDED');
    try{synchronous(budget.charge(n,r))}catch{refuse('BUDGET_EXCEEDED')}check();
   }});
   const scalar=()=>{check();if(++scalars>16)refuse('BUDGET_EXCEEDED')};
   function live(){check();owner(ctx);const current=synchronous(access.live(scalar));if(current!==scope)refuse('SOURCE_UNAVAILABLE');check()}
   function association(w,f,code='INVALID_METADATA'){
    if(w!==null&&!relationshipIdentifier(w)||f!==null&&!uuid(f))refuse(code);
    if(w!==null&&!workspaceCache.has(w)){
     if(++associations>502)refuse('BUDGET_EXCEEDED');
     check();if(synchronous(authority.workspaceExists(ctx,w,accounting))!==true)refuse(code);check();workspaceCache.add(w);
    }
    if(f!==null){
     if(!folderCache.has(f)){
      if(++associations>502)refuse('BUDGET_EXCEEDED');
      check();const folder=synchronous(access.folder(f));check();accounting.charge(bytes(folder??null),1);
      if(!folder||folder.metadata_valid!==1||folder.id!==f||(folder.workspaceId!==null&&!relationshipIdentifier(folder.workspaceId)))refuse(code);
      folderCache.set(f,folder.workspaceId);
     }
     if(folderCache.get(f)!==w)refuse(code);
    }
   }
   const result=synchronous(access.read(()=>{
    live();association(selection.workspaceId,selection.folderId,'SELECTION_CONFLICT');
    const result=work({check,association,accounting,candidate(){check();if(++candidates>(historical?250:251))refuse('BUDGET_EXCEEDED')}});
    live();check();return result;
   }));
   check();return result;
  }
  return {selection,scope,check,pass,close(){closed=true}};
 }
 function observe(ctx,input,budget){return guard(()=>{
  const op=operation(ctx,input,budget,false);
  function capture(){return op.pass(({check,association,accounting,candidate})=>{
   const rows=[];
   synchronous(access.visit(op.selection,raw=>{
    candidate();if(rows.length===250)refuse('INVENTORY_TOO_LARGE');
    accounting.charge(bytes(raw),1);
    if(raw.metadata_valid!==1)refuse('INVALID_METADATA');
    const {metadata_valid,...value}=raw;
    const row=protocol.validateManualInventoryRow(value);
    if(!row)refuse('INVALID_METADATA');
    association(row.workspaceId,row.folderId);
    if(rows.length&&rows[rows.length-1].id>=row.id)refuse('INVALID_METADATA');
    check();rows.push(row);
   }));
   check();const frozen=Object.freeze(rows);
   const inventoryDigest=synchronous(protocol.sha256Utf8(protocol.canonicalInventorySource(op.scope,op.selection,frozen)));
   if(typeof inventoryDigest!=='string'||!/^[a-f0-9]{64}$/.test(inventoryDigest))refuse('SOURCE_UNAVAILABLE');
   return {rows:frozen,inventoryDigest};
  })}
  const captured=capture();const observedAt=synchronous(authority.now());
  if(typeof observedAt!=='string'||![24,27].includes(observedAt.length)||!Number.isFinite(Date.parse(observedAt))||new Date(observedAt).toISOString()!==observedAt)refuse('SOURCE_UNAVAILABLE');
  return Object.freeze({documentStoreScope:op.scope,selection:op.selection,...captured,observedAt,
   checkCurrent(){return guard(()=>{if(capture().inventoryDigest!==captured.inventoryDigest)refuse('INVENTORY_CHANGED')})},close:op.close});
 })}
 function authorizeHistorical(ctx,input,budget){return guard(()=>{
  const op=operation(ctx,input,budget,true);
  if(!Array.isArray(input.rows)||input.rows.length>250)refuse('RESULT_ACCESS_UNAVAILABLE');
  const rows=[];
  for(const value of input.rows){const row=protocol.validateManualInventoryRow(value);if(!row||rows.length&&rows[rows.length-1].id>=row.id)refuse('RESULT_ACCESS_UNAVAILABLE');rows.push(row)}
  Object.freeze(rows);
  function checkAccess(){return guard(()=>op.pass(({check,association,accounting,candidate})=>{
   for(const row of rows){
    candidate();check();const current=synchronous(access.historical(row.id));check();accounting.charge(bytes(current??null),1);
    if(!current||current.metadata_valid!==1||current.active!==1||current.id!==row.id||current.workspaceId!==row.workspaceId||current.folderId!==row.folderId)refuse('RESULT_ACCESS_UNAVAILABLE');
    if(op.selection.mode!=='all'&&current.workspaceId!==op.selection.workspaceId||op.selection.mode==='folder'&&current.folderId!==op.selection.folderId)refuse('RESULT_ACCESS_UNAVAILABLE');
    association(current.workspaceId,current.folderId);
   }
  }),'RESULT_ACCESS_UNAVAILABLE')}
  checkAccess();return Object.freeze({checkAccess,close:op.close});
 },'RESULT_ACCESS_UNAVAILABLE')}
 return Object.freeze({observe,authorizeHistorical});
}
