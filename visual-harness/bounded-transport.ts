import {createdDateBounds} from '../candidate/src/components/transcription-created-date.mjs';
import {isPrivateCompanyRequest} from './private-company-transport';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {syntheticTransport} from './synthetic-transport';
export const durableOperations: Record<string,readonly string[]> = {
 'manual-plans':['get','list','create','update','setState','reopen','remove','restore','sessionChoices','linkedSession','setSessionLink','setMaterialLink','setDocumentLink','addMaterialLinks','removeMaterialLink'],
 automation:['listSkills','getSkill','createSkill','updateSkill','deleteSkill','restoreSkill','listDataSources','getDataSource','createDataSource','updateDataSource','deleteDataSource','restoreDataSource','listSchedules','getSchedule','createSchedule','updateSchedule','setScheduleState','deleteSchedule','restoreSchedule','listRuns','listNotifications'],
 workspace:['list','get','create','update','remove','restore','previewDelete','batchDelete','importWatchlist'],
 organization:['list','get','create','update','remove','restore','serviceStatistics','inspectTarget'],
 'service-reports':['scope','customers','sourceChoices','openActivitySource','openReportSource','listActivities','getActivity','createActivity','correctActivity','archiveActivity','inspectSource','createReport','getReport','archiveReport','listReports','previewServiceRecord','importServiceRecord','exportReport','recoverCommand','cancelCommand'],
};
export const manualInventoryOperations = ['capabilities','preview','execute','operation','result','history'] as const;
export function boundedTransport(lifetime:OrdinaryRequestLifetime,nativeFetch:typeof fetch):typeof fetch {
 const mock=syntheticTransport(lifetime);
 return async(input,init)=>{
  const path=typeof input==='string'?input:input instanceof URL?input.href:input.url;
  const method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
  const match=/^\/api\/(workspace|organization|service-reports|automation|manual-plans)\/([A-Za-z]+)$/.exec(path);
  const initialUploadCheck=method==='GET'&&/^\/api\/local-asr\/transcribe\?operationId=[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(path);
  const retry=/^\/api\/local-asr\/jobs\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/retry$/.exec(path)?.[0]===path&&['GET','POST'].includes(method);
  const cancel=/^\/api\/local-asr\/jobs\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/(cancel|resume)$/.test(path)&&method==='POST';
  const transcript=/^\/api\/local-asr\/jobs\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/(transcript|export)$/.exec(path);
  const history=/^\/api\/local-asr\/jobs\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/(history(?:\/[1-9][0-9]*)?|transcript-restore)$/.exec(path);
  const historyAllowed=!!history&&((history[1].startsWith('history')&&method==='GET')||(history[1]==='transcript-restore'&&method==='POST'));
  const library=/^\/api\/local-asr\/jobs\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/(rename|trash|restore|relationship)$/.test(path)&&method==='POST';
  const listPath=/^\/api\/local-asr\/jobs(?:\?[^#]*)?$/.test(path);
  const listParams=new URLSearchParams(path.includes('?')?path.slice(path.indexOf('?')+1):'');
  // Match the production library's strict status tokens; do not normalize empty/duplicate values.
  const listStatuses=listParams.has('statuses')?listParams.get('statuses')!.split(','):[];
  const listStatusesAllowed=listStatuses.length<=5&&new Set(listStatuses).size===listStatuses.length&&listStatuses.every(value=>['interrupted','processing','completed','cancelled','failed'].includes(value));
  const listDatesAllowed=createdDateBounds(listParams.has('createdFrom')?listParams.get('createdFrom')!:undefined,listParams.has('createdThrough')?listParams.get('createdThrough')!:undefined)!==null;
  const listOriginAllowed=!listParams.has('origin')||['unknown','file-selection','recording-draft'].includes(listParams.get('origin')!);
  const listAllowed=listOriginAllowed&&listPath&&listStatusesAllowed&&listDatesAllowed&&[...listParams.keys()].every(k=>['q','scope','offset','limit','workspaceId','sessionId','jobId','statuses','createdFrom','createdThrough','origin'].includes(k)&&listParams.getAll(k).length===1);
  const documentPath=/^\/api\/documents(?:\?[^#]*)?$/.test(path);
  const documentUpload=/^\/api\/documents\/upload(?:\?[^#]*)?$/.test(path);
  const uploadRecoveryAllowed=/^\/api\/documents\/upload-operations\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(path)&&method==='GET';
  const documentParams=new URLSearchParams(path.split('?')[1]??'');
  const documentKeys=documentUpload?['name','workspaceId','folderId']:['q','workspaceId','folderId','offset','limit','view'];
  const documentQueryAllowed=[...documentParams.keys()].every(k=>documentKeys.includes(k)&&documentParams.getAll(k).length===1);
  const documentDetail=/^\/api\/documents\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\/download)?$/.test(path);
  // Only the identity-bound canonical raster URL emitted by fetchPdfPageImage.
  const pageAllowed=method==='GET'&&/^\/api\/documents\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/page\?page=(?:[1-9]|[1-3][0-9]|40)&scale=(?:75|100|150)&storeScope=[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(path);
  const readerAllowed=/^\/api\/documents\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/reader$/.test(path)&&['GET','PUT'].includes(method);
  const annotations=/^\/api\/documents\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/annotations(?:\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}))?$/.exec(path);
  const annotationsAllowed=!!annotations&&(annotations[1]?method==='PUT':['GET','POST'].includes(method));
  const managementAllowed=/^\/api\/documents\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/(metadata|trash|restore)$/.test(path)&&method==='PUT';
  const citations=/^\/api\/documents\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/citations(?:\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}))?$/.exec(path);
  const citationsAllowed=!!citations&&(method==='GET'||(!citations[1]&&method==='POST'));
  const citationRecoveryAllowed=/^\/api\/documents\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/citation-operations\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.exec(path)?.[0]===path&&method==='GET';
  const documentsAllowed=citationRecoveryAllowed||uploadRecoveryAllowed||citationsAllowed||managementAllowed||annotationsAllowed||readerAllowed||pageAllowed||(documentPath&&documentQueryAllowed&&method==='GET')||(documentUpload&&documentQueryAllowed&&documentParams.has('name')&&method==='POST')||(documentDetail&&method==='GET')||(path==='/api/documents/choices'&&method==='GET')||(path==='/api/documents/folders'&&method==='POST');
  const inventoryParams=new URLSearchParams(path.split('?')[1]??'');
  const inventoryAllowed=(method==='GET'&&/^\/api\/local-scheduler\/(capabilities|schedules|runs)$/.test(path))||(method==='POST'&&/^\/api\/local-scheduler\/(schedules|state)$/.test(path))||(method==='GET'&&!path.includes('#')&&/^\/api\/local-scheduler\/result\?/.test(path)&&[...inventoryParams.keys()].join(',')==='id'&&inventoryParams.getAll('id').length===1);
  const privateCompanyAllowed=!(input instanceof Request && input.body!==null)&&isPrivateCompanyRequest(path,method,init?.body);
  const manualInventoryMatch=/^\/api\/manual-inventory\/([a-z]+)$/.exec(path);
  let manualInventoryAllowed=false;
  if(manualInventoryMatch?.[0]===path && method==='POST' && manualInventoryOperations.some(op=>op===manualInventoryMatch[1]) && !(input instanceof Request && input.body!==null) && typeof init?.body==='string' && new TextEncoder().encode(init.body).byteLength<=4096){
   try{const headers=new Headers(init.headers);manualInventoryAllowed=/^application\/json(?:;\s*charset=utf-8)?$/i.test(headers.get('content-type')??'')&&!headers.has('content-encoding');}catch{/* Malformed headers are not admitted. */}
  }
  const admitted=initialUploadCheck||manualInventoryAllowed||(path==='/api/local-asr/identity'&&method==='GET')||retry||privateCompanyAllowed||inventoryAllowed||documentsAllowed||historyAllowed||(path==='/api/local-asr/relationships'&&method==='GET')||library||!!(transcript&&((transcript[1]==='transcript'&&['GET','POST'].includes(method))||(transcript[1]==='export'&&method==='POST')))||cancel||(listAllowed&&method==='GET')||(path==='/api/local-asr/transcribe'&&method==='POST')||(path==='/api/demo/identity'&&method==='GET')||(match && match[0]===path && method==='POST' && durableOperations[match[1]].includes(match[2]));
  if(admitted) return nativeFetch(input,{...init,credentials:'same-origin',redirect:'error',cache:'no-store'});
  if(path==='/api/integrations')return mock(input,init);
  return new Response(JSON.stringify({error:{code:'UNAVAILABLE',message:'此隔离组合未接入该服务',retryable:false}}),{status:503,headers:{'Content-Type':'application/json'}});
 };
}
