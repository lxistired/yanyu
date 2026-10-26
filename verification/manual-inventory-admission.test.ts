// Source-only integration admission regression; no execution before root GO.
import {it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {boundedTransport,manualInventoryOperations} from '../visual-harness/bounded-transport';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {validateAutomationDefinitionRecord,captureAutomationDefinitionCommand} from '../candidate/src/components/automation-definition-write-session';
const headers={'Content-Type':'application/json'};
it('matches exactly the six dedicated server operations, never generic execution',()=>{
 const source=readFileSync(process.cwd()+'/backend/manual-inventory-routes.mjs','utf8');
 const literal=/const operations=new Set\((\[[^\n]+\])\)/.exec(source);expect(literal).not.toBeNull();
 const names=[...literal![1].matchAll(/'([a-z]+)'/g)].map(m=>m[1]);
 expect([...manualInventoryOperations]).toEqual(names);expect(names).toEqual(['capabilities','preview','execute','operation','result','history']);
});
it.each(manualInventoryOperations)('admits only bounded plain JSON POST for manual inventory %s',async(op)=>{
 const native=vi.fn(async()=>new Response('{}'));const t=boundedTransport(new OrdinaryRequestLifetime(),native);const path='/api/manual-inventory/'+op;
 await t(path,{method:'POST',headers,body:'{}'});expect(native).toHaveBeenCalledOnce();expect(native.mock.calls[0][1]).toMatchObject({credentials:'same-origin',redirect:'error',cache:'no-store'});
 for(const method of ['GET','PUT','DELETE','HEAD'])expect((await t(path,{method,headers,body:'{}'})).status).toBe(503);
 for(const suffix of ['?','?x=1','/','/extra','Suffix','\n','\r','#fragment'])expect((await t(path+suffix,{method:'POST',headers,body:'{}'})).status).toBe(503);
 for(const url of ['https://example.invalid'+path,'//example.invalid'+path,path.replace('/manual-inventory/','/manual%2dinventory/')])expect((await t(url,{method:'POST',headers,body:'{}'})).status).toBe(503);
 for(const body of [undefined,new Blob(['{}']),new URLSearchParams({x:'y'}),'x'.repeat(4097),'é'.repeat(2049)])expect((await t(path,{method:'POST',headers,body})).status).toBe(503);
 for(const h of [{},{'Content-Type':'text/plain'},{...headers,'Content-Encoding':'gzip'},{...headers,'Content-Encoding':'identity'}])expect((await t(path,{method:'POST',headers:h,body:'{}'})).status).toBe(503);
 expect(native).toHaveBeenCalledOnce();
 await t(path,{method:'POST',headers,body:'é'.repeat(2048)});expect(native).toHaveBeenCalledTimes(2); // Byte admission only; actual server validates JSON/schema.
});
it('does not inspect or forward Request-body streams and retains generic execution denial',async()=>{
 const native=vi.fn(async()=>new Response('{}'));const t=boundedTransport(new OrdinaryRequestLifetime(),native);
 const req=new Request('http://localhost/api/manual-inventory/execute',{method:'POST',headers,body:'{}'});
 expect((await t(req)).status).toBe(503);expect(req.bodyUsed).toBe(false);
 for(const path of ['/api/manual-inventory/runNow','/api/automation/runNow','/api/automation/execute','/api/manual-inventory/dispatch','/api/local-scheduler/tick'])expect((await t(path,{method:'POST',headers,body:'{}'})).status).toBe(503);
 expect(native).not.toHaveBeenCalled();
});
it('round-trips the exact new skill handler without widening legacy definition validation',()=>{
 const data={name:'Synthetic inventory',description:'Not executable instructions',enabled:true,handler:'local-document-inventory'};
 const record={id:'skill_inventory',kind:'skill',revision:1,createdAt:'2026-10-22T00:00:00.000Z',updatedAt:'2026-10-22T00:00:00.000Z',deletedAt:null,data,availability:{status:'available',code:'available',detail:'Dedicated manual only',capabilities:[]}};
 const command=captureAutomationDefinitionCommand('createSkill',data,{message:'Create definition'},'inventory-definition-test');
 const encoded=JSON.parse(command.body);expect(encoded.handler).toBe('local-document-inventory');expect(encoded.idempotencyKey).toBe('inventory-definition-test');
 const parsed=validateAutomationDefinitionRecord(JSON.parse(JSON.stringify(record)),'skill',record.id,true);expect(parsed).toEqual(record);expect(parsed).not.toBe(record);
 for(const handler of ['local-notification','local-checkpoint','local-evidence-report','external-research'])expect(()=>validateAutomationDefinitionRecord({...record,data:{...data,handler}},'skill',record.id,true)).not.toThrow();
 for(const handler of ['local-document-inventory\n','local-document-inventory-extra','execute','',null])expect(()=>validateAutomationDefinitionRecord({...record,data:{...data,handler}},'skill',record.id,true)).toThrow();
 expect(()=>validateAutomationDefinitionRecord({...record,data:{...data,extra:true}},'skill',record.id,true)).toThrow();
});
