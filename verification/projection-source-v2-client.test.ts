// @vitest-environment node
import {expect,it,vi} from 'vitest';
import {createServiceReportsClient,requireServiceProjectionImport} from '../candidate/src/adapters/service-reports';
import {actor,scope,preview,command,result,fixtureFetch,json,inspect,item,local,store} from './fixtures/projection-source-v2';
async function harness(){const fetch=vi.fn(fixtureFetch),client=createServiceReportsClient({fetch,getActor:()=>actor});await client.scope();return {fetch,client};}
it('admits opt-in v2 preview and local revision-zero exact selection; preserves old inspect API',async()=>{const h=await harness();expect(await h.client.previewServiceRecord({schema:2,scope,sourceId:'source-1'})).toEqual(preview);expect(await h.client.inspectSourceSelection({documentId:item.documentId,revisionId:item.revisionId})).toEqual(inspect);expect(await h.client.inspectSource({documentId:item.documentId,revisionId:item.revisionId})).toEqual({scope,pin:local});expect(await h.client.importServiceRecord(command)).toEqual(result());h.client.withdraw();});
it.each([
 {...command,schema:1},{...command,extra:true},{...command,sourceId:'source-1\n'},
 {...command,sourceObservation:{...inspect.locator,metadataRevision:-1}},
 {...command,sourceObservation:{...inspect.locator,metadataRevision:'0'}},
 {...command,sourceObservation:{...inspect.locator,documentId:store}},
 {...command,authority:{...command.authority,capabilities:{localDocuments:false,syntheticFixture:true}}},
 {...command,expectedProjection:{id:'activity',revision:0}},
 {...command,sourceObservation:null},{...command,status:'completed'},
])('rejects invalid v2 import before network %#',async(value)=>{const h=await harness(),before=h.fetch.mock.calls.length;await expect(h.client.importServiceRecord(value as any)).rejects.toThrow();expect(h.fetch.mock.calls.length).toBe(before);h.client.withdraw();});
it.each([
 {...preview,schema:1},{...preview,extra:true},{...preview,scope:'2'.repeat(64)},
 {...preview,source:{...preview.source,sha256:'3'.repeat(64)}},
 {...preview,source:{...preview.source,recordJson:'null'}},
 {...preview,authority:{...preview.authority,policyVersion:2}},
 {...preview,missingInputs:['status']},
 {...preview,projection:{...preview.projection,customer:{organizationId:'another',contactId:null}}},
 {...preview,syntheticSourcePin:local},
 {...preview,projection:{...preview.projection,kind:'email'}},
 {...preview,projection:{...preview.projection,summary:'Unbound summary'}},
 {...preview,projection:{...preview.projection,occurredAt:'2026-10-04T00:00:00.000Z'}},
 {...preview,customerPin:{...preview.customerPin,organizationId:'other'},projection:{...preview.projection,customer:{organizationId:'other',contactId:null}}},
])('rejects inconsistent preview without publishing %#',async(value)=>{const h=await harness();h.fetch.mockImplementationOnce(async()=>json(value));await expect(h.client.previewServiceRecord({schema:2,scope,sourceId:'source-1'})).rejects.toThrow();h.client.withdraw();});
it.each([
 {...result(),schema:1},{...result(),unchanged:'false'},{...result(),extra:true},
 {...result(),activity:{...result().activity,archivedAt:'2026-10-22T00:00:00.000Z'}},
 {...result(),activity:{...result().activity,version:{...result().activity.version,value:{...result().activity.version.value,status:'cancelled'}}}},
])('rejects mismatching result boundary %#',async(value)=>{const h=await harness();h.fetch.mockImplementationOnce(async()=>json(value));await expect(h.client.importServiceRecord(command)).rejects.toThrow();h.client.withdraw();});
it('does not mutate caller request and keeps v2 distinct from generic commands',()=>{const before=JSON.stringify(command);expect(requireServiceProjectionImport(command)).toEqual(command);expect(JSON.stringify(command)).toBe(before);});
it('rejects a different activity id even when returned provenance and choices match',async()=>{const h=await harness();h.fetch.mockImplementationOnce(async()=>json(result()));await expect(h.client.importServiceRecord({...command,expectedProjection:{id:'expected-other-activity',revision:1}})).rejects.toThrow();h.client.withdraw();});
