import {createHash} from 'node:crypto';
import {readerCanonical} from '../../candidate/shared/reader-reference';
import type {ServiceProjectionImport,ServiceProjectionPreview,ServiceProjectionResult} from '../../candidate/src/adapters/service-reports';
export const scope='a'.repeat(64), actor={binding:'b'.repeat(64),epoch:1};
export const store='11111111-1111-4111-8111-111111111111',doc='22222222-2222-4222-8222-222222222222';
export const synthetic={documentId:'synthetic-doc',revisionId:'v1',tenantId:'tenant',collectionId:'collection',sha256:'c'.repeat(64)};
export const item={documentId:`local-doc:${store}:${doc}`,revisionId:`content:${'d'.repeat(64)}:${'e'.repeat(64)}`,name:'Synthetic uploaded text',format:'txt' as const,metadataRevision:0};
export const local={...synthetic,documentId:item.documentId,revisionId:item.revisionId,sha256:'f'.repeat(64)};
export const authority={documentStoreScope:store,capabilities:{localDocuments:true,syntheticFixture:true as const},policyVersion:1 as const};
const record={id:'source-1',revision:1,kind:'service-record',data:{organizationId:'org-1',contactId:null,activity:'call',occurredAt:'2026-10-03T00:00:00.000Z',summary:'Synthetic fact'}};
export const preview:ServiceProjectionPreview={schema:2,scope,authority,source:{id:record.id,revision:record.revision,sha256:createHash('sha256').update(readerCanonical(record)).digest('hex'),recordJson:JSON.stringify(record)},customerPin:{organizationId:'org-1',contactId:null,organizationRevision:1,contactRevision:null},projection:{customer:{organizationId:'org-1',contactId:null},kind:'call',occurredAt:'2026-10-03T00:00:00.000Z',summary:'Synthetic fact'},existing:null,token:'1'.repeat(64),missingInputs:['status','sourcePin'],syntheticSourcePin:synthetic,warning:'Synthetic local fixture; not external verification'};
export const page={scope,capabilities:authority.capabilities,storeScope:store,items:[item],nextOffset:null};
export const inspect={scope,pin:local,sourceKind:'local-document',locator:{storeScope:store,documentId:doc,metadataRevision:0}};
export const command:ServiceProjectionImport={schema:2,scope,sourceId:'source-1',token:preview.token,authority,expectedProjection:null,status:'planned',sourcePin:local,sourceObservation:inspect.locator,reason:''};
export function result(input:ServiceProjectionImport=command,p=preview):ServiceProjectionResult{return {schema:2,scope,unchanged:false,activity:{id:'activity-1',revision:1,versionId:'version-1',archivedAt:null,version:{schema:1,activityId:'activity-1',sequence:1,recordedAt:'2026-10-22T00:00:00.000Z',recordedBySubject:'synthetic-subject',customerAtRecord:p.customerPin,value:{...p.projection,status:input.status,references:[{pin:input.sourcePin}],ordinarySource:p.source},provenance:'user-recorded-local',correction:null}}};}
export const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
export async function fixtureFetch(url:RequestInfo|URL,init?:RequestInit):Promise<Response>{
 const route=String(url).split('/').at(-1),input=JSON.parse(String(init?.body??'{}'));
 if(route==='scope')return json({scope});if(route==='previewServiceRecord')return json(preview);if(route==='sourceChoices')return json(page);
 if(route==='inspectSource')return json(input.documentId==='synthetic-doc'?{scope,pin:synthetic}:inspect);
 if(route==='importServiceRecord')return json(result(input));throw Error('Unexpected route');
}
