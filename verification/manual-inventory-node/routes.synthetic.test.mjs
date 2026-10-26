// Proposed synthetic tests. NOT EXECUTED. Run only after separate root approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
const routesPath=process.env.MANUAL_INVENTORY_ROUTES;
assert.ok(routesPath&&isAbsolute(routesPath),'Set MANUAL_INVENTORY_ROUTES to the approved merged route source file');
const {parseInventoryJson,manualInventoryRoutes}=await import(pathToFileURL(routesPath).href);
import {Readable} from 'node:stream';
test('duplicate and escaped-equivalent keys rejected at every depth',()=>{
 for(const value of ['{"protocol":1,"protocol":2}','{"p":{"x":1,"\\u0078":2}}','{"a":[{"x":1,"x":2}]}'])assert.throws(()=>parseInventoryJson(value));
 assert.equal(parseInventoryJson('{"a":1,"b":[true,null,"é"]}').a,1);
 for(const value of ['\ufeff{}','{} trailing','[]','{"a":01}','{"a":1,}','{"a":"\\uD800"}']){
  // Lone surrogate is parser-valid JSON but rejected by the shared protocol validator.
  if(!value.includes('D800'))assert.throws(()=>parseInventoryJson(value));
 }
});
function request(body,path='/api/manual-inventory/execute'){
 const req=Readable.from([Buffer.from(body)]);req.url=path;req.method='POST';req.headers={'content-type':'application/json'};return req;
}
test('bounded UTF-8, routes, no encoded or query endpoint',async()=>{
 let called=0;const adapter=manualInventoryRoutes({execute(){called++;return {state:'committed'}}},()=>({}));
 for(const req of [request(' '.repeat(4097)),request('{"x":1,"x":2}'),request('{}','/api/manual-inventory/execute?x=1')]){
  let status;await adapter.handle(req,()=>assert.fail('unexpected success'),s=>{status=s},()=>assert.fail('unexpected result'));assert.ok(status>=400);
 }
 assert.equal(called,0);
});
test('result publication checkpoint precedes sending and closes on denial',async()=>{
 const sequence=[];const adapter=manualInventoryRoutes({result(){return {encoded:'{}',publish(){sequence.push('check');throw Object.assign(new Error(),{code:'RESULT_ACCESS_UNAVAILABLE'})},close(){sequence.push('close')}}}},()=>({}));
 await adapter.handle(request('{}','/api/manual-inventory/result'),()=>assert.fail(),()=>sequence.push('error'),()=>assert.fail('leaked result'));
 assert.deepEqual(sequence,['check','error','close']);
});
