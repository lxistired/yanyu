// Source-only correction regression. NOT EXECUTED. Root GO required.
// Actual route adapter, synthetic in-memory request/response and domain spy only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
const path=process.env.MANUAL_INVENTORY_ROUTES;
assert.ok(path&&isAbsolute(path),'Set MANUAL_INVENTORY_ROUTES to the exact approved corrected route module');
const {manualInventoryRoutes}=await import(pathToFileURL(path).href);
function request(parts,operation='execute'){
 const req=Readable.from(parts);req.url='/api/manual-inventory/'+operation;req.method='POST';req.headers={'content-type':'application/json'};return req;
}
function capture(){const sent=[],failed=[],buffered=[];return {sent,failed,buffered,send:(...args)=>sent.push(args),fail:(...args)=>failed.push(args),raw:(...args)=>buffered.push(args)};}
const malformed=[
 ['invalid lead',Buffer.from([0xff])],
 ['stray continuation',Buffer.from([0x80])],
 ['overlong slash',Buffer.from([0xc0,0xaf])],
 ['truncated sequence',Buffer.from([0xe2,0x82])],
 ['encoded surrogate',Buffer.from([0xed,0xa0,0x80])],
 ['out-of-range code point',Buffer.from([0xf4,0x90,0x80,0x80])],
 ['bad sequence inside JSON string',Buffer.concat([Buffer.from('{"name":"'),Buffer.from([0xff]),Buffer.from('"}')])],
];
test('fatal invalid UTF-8 is INVALID_REQUEST400 before any context/domain call on all six routes',async()=>{
 let contexts=0,domains=0;const domain=Object.fromEntries(['capabilities','preview','execute','operation','result','history'].map(op=>[op,()=>{domains++;return {}}]));
 const adapter=manualInventoryRoutes(domain,()=>{contexts++;return {}});
 for(const operation of Object.keys(domain))for(const [label,bytes] of malformed){
  const output=capture();assert.equal(await adapter.handle(request([bytes],operation),output.send,output.fail,output.raw),true);
  assert.deepEqual(output.failed,[[400,'INVALID_REQUEST','Manual inventory operation unavailable']],`${operation}: ${label}`);
  assert.deepEqual(output.sent,[]);assert.deepEqual(output.buffered,[]);
 }
 assert.equal(contexts,0);assert.equal(domains,0);
});
test('BOM rejection and malformed JSON semantics remain unchanged and pre-context',async()=>{
 let contexts=0,domains=0;const adapter=manualInventoryRoutes({execute(){domains++;return {}}},()=>{contexts++;return {}});
 for(const parts of [[Buffer.from([0xef,0xbb,0xbf]),Buffer.from('{}')],[Buffer.from('{"a":1,"a":2}')],[Buffer.from('{')]]){
  const output=capture();await adapter.handle(request(parts),output.send,output.fail,output.raw);
  assert.deepEqual(output.failed,[[400,'INVALID_REQUEST','Manual inventory operation unavailable']]);assert.deepEqual(output.sent,[]);assert.deepEqual(output.buffered,[]);
 }
 assert.equal(contexts,0);assert.equal(domains,0);
});
test('valid multibyte UTF-8 across request chunks reaches domain unchanged',async()=>{
 let contexts=0;const seen=[];const adapter=manualInventoryRoutes({execute(ctx,input){seen.push(input.name);return {ok:true}}},()=>{contexts++;return {}});
 const body=Buffer.from('{"name":"合成é"}'),output=capture();
 await adapter.handle(request([...body].map(byte=>Buffer.from([byte]))),output.send,output.fail,output.raw);
 assert.equal(contexts,1);assert.deepEqual(seen,['合成é']);assert.deepEqual(output.sent,[[200,{ok:true}]]);assert.deepEqual(output.failed,[]);
});
test('later domain TypeError or typed unavailable error is not reclassified as input failure',async()=>{
 for(const error of [new TypeError('synthetic domain type error'),Object.assign(new Error('synthetic source outage'),{code:'SOURCE_UNAVAILABLE'})]){
  let contexts=0,domains=0;const adapter=manualInventoryRoutes({execute(){domains++;throw error}},()=>{contexts++;return {}}),output=capture();
  await adapter.handle(request([Buffer.from('{}')]),output.send,output.fail,output.raw);
  assert.equal(contexts,1);assert.equal(domains,1);assert.deepEqual(output.failed,[[503,'SOURCE_UNAVAILABLE','Manual inventory operation unavailable']]);assert.deepEqual(output.sent,[]);
 }
});
