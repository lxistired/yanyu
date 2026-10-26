// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createServiceReportsClient } from '../candidate/src/adapters/service-reports';
const scope = 'a'.repeat(64), store = '11111111-1111-4111-8111-111111111111', doc = '22222222-2222-4222-8222-222222222222';
const item = {documentId:`local-doc:${store}:${doc}`,revisionId:`content:${'b'.repeat(64)}:${'c'.repeat(64)}`,name:'Synthetic uploaded fixture',format:'txt',metadataRevision:0};
const page = {scope,capabilities:{localDocuments:true,syntheticFixture:true},storeScope:store,items:[item],nextOffset:null};
const pin = {documentId:item.documentId,revisionId:item.revisionId,tenantId:'tenant',collectionId:'collection',sha256:'d'.repeat(64)};
const json = (value:unknown) => new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
async function harness(value:unknown) {
 let actor:{binding:string;epoch:number}|null={binding:'e'.repeat(64),epoch:1};
 const fetch=vi.fn(async(url:unknown)=>String(url).endsWith('/scope')?json({scope}):json(value));
 const client=createServiceReportsClient({fetch:fetch as typeof globalThis.fetch,getActor:()=>actor});
 await client.scope();
 return {client,fetch,changeActor:()=>{actor={binding:'f'.repeat(64),epoch:2}}};
}
it('loads new-upload revision-zero local choices through service authority and never /api/files',async()=>{const {client,fetch}=await harness(page);expect(await client.sourceChoices()).toEqual(page);expect(fetch.mock.calls[1][0]).toBe('/api/service-reports/sourceChoices');client.withdraw()});
it('distinguishes unavailable capability from an empty configured library',async()=>{for(const value of [{...page,items:[]},{...page,capabilities:{localDocuments:false,syntheticFixture:true},storeScope:null,items:[]}]){const {client}=await harness(value);expect(await client.sourceChoices()).toEqual(value);client.withdraw()}});
it.each([
 {...page,scope:'f'.repeat(64)},
 {...page,items:[{...item,documentId:`local-doc:33333333-3333-4333-8333-333333333333:${doc}`}]},
 {...page,items:[item,item]},
 {...page,capabilities:{localDocuments:false,syntheticFixture:true}},
 {...page,items:[{...item,format:'exe'}]},
 {...page,items:[{...item,metadataRevision:-1}]},
 {...page,items:[{...item,revisionId:'v1'}]},
 {...page,items:[{...item,extra:'not allowed'}]},
 {...page,nextOffset:1},
 {...page,capabilities:{localDocuments:true,syntheticFixture:false}},
])('fails closed for malformed or cross-scope page %#',async(value)=>{const {client}=await harness(value);await expect(client.sourceChoices()).rejects.toThrow();client.withdraw()});
it('requires continuation store and exact next offset without silent truncation',async()=>{const {client,fetch}=await harness({...page,nextOffset:1});await expect(client.sourceChoices({limit:1})).resolves.toMatchObject({nextOffset:1});const count=fetch.mock.calls.length;await expect(client.sourceChoices({offset:1})).rejects.toThrow();await expect(client.sourceChoices({limit:26})).rejects.toThrow();expect(fetch.mock.calls.length).toBe(count);client.withdraw()});
it('rejects response store swap even at a refreshed first page',async()=>{const {client}=await harness(page);await expect(client.sourceChoices({storeScope:'33333333-3333-4333-8333-333333333333'})).rejects.toThrow();client.withdraw()});
it('validates new-upload revision-zero local inspect locator while preserving exact synthetic response',async()=>{const {client}=await harness({scope,pin,sourceKind:'local-document',locator:{storeScope:store,documentId:doc,metadataRevision:0}});await expect(client.inspectSource({documentId:item.documentId,revisionId:item.revisionId})).resolves.toEqual({scope,pin});client.withdraw();const synthetic={...pin,documentId:'synthetic-doc',revisionId:'v1'};const h=await harness({scope,pin:synthetic});await expect(h.client.inspectSource({documentId:'synthetic-doc',revisionId:'v1'})).resolves.toEqual({scope,pin:synthetic});h.client.withdraw()});
it.each([{scope,pin},{scope,pin,sourceKind:'local-document',locator:{storeScope:store,documentId:'33333333-3333-4333-8333-333333333333',metadataRevision:0}},{scope,pin,sourceKind:'synthetic-fixture',locator:{storeScope:store,documentId:doc,metadataRevision:0}}])('rejects missing or forged local inspect provenance %#',async(value)=>{const {client}=await harness(value);await expect(client.inspectSource({documentId:item.documentId,revisionId:item.revisionId})).rejects.toThrow();client.withdraw()});
it('cancellation and actor replacement never publish delayed choices',async()=>{for(const cancel of [true,false]){const h=await harness(page);let finish!:(r:Response)=>void;h.fetch.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));const abort=new AbortController();const pending=h.client.sourceChoices({},abort.signal);await Promise.resolve();if(cancel)abort.abort();else h.changeActor();finish(json(page));await expect(pending).rejects.toThrow();h.client.withdraw()}});

it.each(['\n','\r'])('rejects terminal control character %j in local identity fields',async(end)=>{
 const h=await harness(page);await expect(h.client.sourceChoices({storeScope:store+end})).rejects.toThrow();h.client.withdraw();
 for(const changed of [{...item,documentId:item.documentId+end},{...item,documentId:`local-doc:${store+end}:${doc}`},{...item,revisionId:item.revisionId+end}]){const x=await harness({...page,items:[changed]});await expect(x.client.sourceChoices()).rejects.toThrow();x.client.withdraw()}
 for(const locator of [{storeScope:store+end,documentId:doc,metadataRevision:0},{storeScope:store,documentId:doc+end,metadataRevision:0}]){const x=await harness({scope,pin,sourceKind:'local-document',locator});await expect(x.client.inspectSource({documentId:item.documentId,revisionId:item.revisionId})).rejects.toThrow();x.client.withdraw()}
});
it('cancels a deferred response body without publishing a partial source page',async()=>{
 const h=await harness(page), cancelled=vi.fn();let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve});
 const body=new ReadableStream<Uint8Array>({pull(){began();return new Promise(()=>{})},cancel:cancelled});
 h.fetch.mockImplementationOnce(async()=>new Response(body,{headers:{'content-type':'application/json'}}));
 const abort=new AbortController(), pending=h.client.sourceChoices({},abort.signal);await started;await Promise.resolve();await Promise.resolve();abort.abort();
 await expect(pending).rejects.toThrow();await Promise.resolve();expect(cancelled).toHaveBeenCalled();h.client.withdraw();
});

it.each([-1,0.5,'0',null])('rejects invalid metadata revision %j in choices and local inspect',async(metadataRevision)=>{
 const h=await harness({...page,items:[{...item,metadataRevision}]});await expect(h.client.sourceChoices()).rejects.toThrow();h.client.withdraw();
 const x=await harness({scope,pin,sourceKind:'local-document',locator:{storeScope:store,documentId:doc,metadataRevision}});await expect(x.client.inspectSource({documentId:item.documentId,revisionId:item.revisionId})).rejects.toThrow();x.client.withdraw();
});
