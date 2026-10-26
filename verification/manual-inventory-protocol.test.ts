// @vitest-environment node
// Source-authored Vitest suite. Do not execute before root GO.
import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as p from '../candidate/shared/manual-inventory-protocol';
export function manualInventoryProtocolCases(v: {selection:p.ManualInventorySelection;row:p.ManualInventoryRow;executeRequest:p.ManualInventoryExecuteRequest;result:p.ManualInventoryResultPayload;sourceCanonical:string;commandCanonical:string;resultSerialized:string;resultBytes:number;emptySourceCanonical:string}):void {
 const assert=(value:unknown,label:string)=>{if(!value)throw new Error(label);};
 const throws=(fn:()=>unknown)=>{try{fn();return false;}catch{return true;}};
 assert(p.canonicalInventorySource(v.executeRequest.documentStoreScope,v.selection,[v.row])===v.sourceCanonical,'pinned non-ASCII source');
 assert(p.canonicalInventorySource(v.executeRequest.documentStoreScope,{mode:'all',workspaceId:null,folderId:null},[])===v.emptySourceCanonical,'pinned zero rows');
 assert(p.canonicalManualInventoryCommand(v.executeRequest)===v.commandCanonical,'pinned command');
 assert(p.serializeManualInventoryResult(v.result)===v.resultSerialized,'exact result object ordering');
 assert(p.manualInventoryUtf8Bytes(v.resultSerialized)===v.resultBytes,'exact UTF8 overhead');
 assert(p.parseManualInventoryResultPayload(v.result)!==null,'result valid');
 assert(Object.isFrozen(p.parseManualInventorySelection(v.selection)),'defensive freeze');
 for(const bad of [{mode:'all',workspaceId:'workspace',folderId:null},{mode:'all',workspaceId:null,folderId:v.row.id},{mode:'folder',workspaceId:null,folderId:null},{mode:'workspace',workspaceId:'',folderId:null},{mode:'workspace',workspaceId:null},{...v.selection,extra:true}])assert(p.parseManualInventorySelection(bad)===null,'selection exactness');
 for(const bad of [{...v.row,name:'bad\nname'},{...v.row,name:'bad/name'},{...v.row,name:'bad\\name'},{...v.row,name:'\ud800'},{...v.row,name:' '},{...v.row,name:'é'.repeat(257)},{...v.row,revision:-0},{...v.row,bytes:8388609},{...v.row,bytes:NaN},{...v.row,pages:41},{...v.row,format:'txt',pages:1},{...v.row,createdAt:'2026-10-22T00:00:00Z'},{...v.row,id:v.row.id+'\n'},{...v.row,extra:0}])assert(p.validateManualInventoryRow(bad)===null,'row invalid');
 assert(p.validateManualInventoryRow({...v.row,name:'é'.repeat(256),revision:0})!==null,'512 bytes boundary');
 assert(p.validateManualInventoryRow({...v.row,format:'txt',pages:null})!==null,'text null pages');
 const rows=Array.from({length:250},(_,n)=>({...v.row,id:'00000000-0000-4000-8000-'+String(n).padStart(12,'0')}));
 assert(p.sumManualInventoryBytes(rows)===2097152000,'maximum safe sum');
 const hugeRows=rows.map(r=>({...r,name:'\"'.repeat(512)}));
 assert(p.parseManualInventoryResultPayload({...v.result,count:250,totalBytes:2097152000,documents:hugeRows})===null,'escaped full JSON overhead exceeds result cap');
 assert(p.validateManualInventoryRow({...v.row,createdAt:'+010000-01-01T00:00:00.000Z'})!==null,'canonical extended ISO year');
 assert(p.validateManualInventoryRow({...v.row,createdAt:'2026-02-30T00:00:00.000Z'})===null,'normalized invalid date rejected');
 assert(throws(()=>p.sumManualInventoryBytes([...rows,{...rows[249]}])),'251 rejected');
 assert(throws(()=>p.canonicalInventorySource(v.executeRequest.documentStoreScope,v.selection,[v.row,v.row])),'duplicates rejected');
 assert(throws(()=>p.canonicalInventorySource(v.executeRequest.documentStoreScope,v.selection,[rows[1],rows[0]])),'unsorted rejected not reordered');
 assert(p.parseManualInventoryExecuteRequest({...v.executeRequest,scheduleRevision:-0})===null,'positive revision');
 assert(p.parseManualInventoryResultPayload({...v.result,count:0})===null,'count recomputed');
 assert(p.parseManualInventoryResultPayload({...v.result,totalBytes:0})===null,'sum recomputed');
 assert(p.parseManualInventoryResultPayload({...v.result,resultDigest:'d'.repeat(64)})===null,'no self digest');
 const base={protocol:p.MANUAL_INVENTORY_PROTOCOL,operationId:v.executeRequest.operationId,requestDigest:'d'.repeat(64)};
 assert(p.parseManualInventoryProof({...base,state:'rejected',code:'INVALID_METADATA',messageKey:'manual_inventory.invalid_metadata'})!==null,'fixed rejection');
 assert(p.parseManualInventoryProof({...base,state:'rejected',code:'INVALID_METADATA',messageKey:'private data'})===null,'no arbitrary message');
 assert(p.parseManualInventoryProof({...base,state:'rejected',code:'SOURCE_UNAVAILABLE',messageKey:'manual_inventory.source_unavailable'})===null,'no false terminal source refusal');
 assert(p.parseManualInventoryOperationResult({...base,state:'absent'})!==null,'absent not terminal');
 assert(p.parseManualInventoryProof({...base,state:'absent'})===null,'absent not proof');
 let invoked=false;const getter={...v.row};Object.defineProperty(getter,'name',{enumerable:true,get(){invoked=true;return 'secret';}});assert(p.validateManualInventoryRow(getter)===null&&!invoked,'getters rejected without invocation');
 const sparse=new Array(1);assert(throws(()=>p.sumManualInventoryBytes(sparse)),'sparse rejected');
 assert(p.isManualInventoryRun({manualInventory:{protocol:p.MANUAL_INVENTORY_PROTOCOL}}),'malformed new family must be excluded from generic list');
 assert(!p.isManualInventoryRun({manualInventory:{protocol:'other'}}),'old family retained');
}

// Fixed literal vectors are independent inputs, not generated using the implementation.
const fixture = JSON.parse(readFileSync(new URL('./manual-inventory-expected-vectors.json',import.meta.url),'utf8'));
describe('manual inventory pure protocol',()=>{
 it('validates exact schemas, Unicode, bounds, canonical bytes and immutable copies',()=>manualInventoryProtocolCases(fixture));
 it('pins source, command and result SHA256 bytes independently',()=>{
  const hash=(s:string)=>createHash('sha256').update(s,'utf8').digest('hex');
  expect(hash(p.canonicalInventorySource(fixture.executeRequest.documentStoreScope,fixture.selection,[fixture.row]))).toBe(fixture.sourceSha256);
  expect(hash(p.canonicalManualInventoryCommand(fixture.executeRequest))).toBe(fixture.commandSha256);
  expect(hash(p.serializeManualInventoryResult(fixture.result))).toBe(fixture.resultSha256);
 });
});
