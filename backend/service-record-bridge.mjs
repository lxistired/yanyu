/** Explicit bounded projection. No third ledger or cross-database writes. Provenance and
 * report activity commit together in the existing immutable report-version transaction. */
export function serviceRecordBridge({store,reportsStore,ServiceReportDomain,owners,sources,scope,pin,hash,error,clock,charge,documentIdentity,observeProjectionAuthority}) {
 const budget=()=>({rows:0,bytes:0,sourceBytes:0,maxRows:6000,maxBytes:24*1024*1024,maxSourceBytes:64*1024*1024});
 const fields=(input,keys)=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k)))error('INVALID_REQUEST','Unexpected projection field')};
 const id=value=>{if(typeof value!=='string'||!(/^[A-Za-z0-9_-]{1,100}(?![\s\S])/).test(value))error('INVALID_REQUEST','Invalid service record ID');return value};
 function read(ctx,sourceId,shared){
  const usage={rows:0,bytes:0};
  if(shared&&(shared.rows>=shared.maxRows||shared.bytes>=shared.maxBytes))error('RATE_LIMITED','Projection read budget exhausted');
  try{return store.readBounded(ctx,{maxRows:shared?shared.maxRows-shared.rows:6000,maxBytes:shared?shared.maxBytes-shared.bytes:24*1024*1024},tx=>{
   const record=tx.get('service-record',id(sourceId));
   const org=tx.get('organization',record.data.organizationId), contact=record.data.contactId===null?null:tx.get('crm-contact',record.data.contactId);
   if(contact&&contact.data.organizationId!==org.id)error('FORBIDDEN','Current customer relationship no longer matches');
   const source={id:record.id,revision:record.revision,sha256:hash(record),recordJson:JSON.stringify(record)};
   if(Buffer.byteLength(source.recordJson)>16000)error('RATE_LIMITED','Service record exceeds projection budget');
   if(!record.data.summary?.trim()||record.data.summary.length>1000)error('INVALID_REQUEST','Report summary must contain 1–1000 characters; edit the ordinary record first');
   const customerPin={organizationId:org.id,contactId:contact?.id??null,organizationRevision:org.revision,contactRevision:contact?.revision??null};
   return {source,customerPin,projection:{customer:{organizationId:org.id,contactId:contact?.id??null},kind:record.data.activity,occurredAt:record.data.occurredAt,summary:record.data.summary}};
  },usage)}finally{if(shared)charge(shared,usage.bytes,usage.rows)}
 }
 function existing(ctx,sourceId,shared){return reportsStore.read(ctx,shared??budget(),tx=>{
  let found=null;
  for(const head of tx.list('activity')){
   const version=tx.get('activity-version',head.data.versionId).data;
   if(version.value.ordinarySource?.id===sourceId){if(found)error('CONFLICT','Multiple projections require manual review');found={id:head.id,revision:head.revision,sourceRevision:version.value.ordinarySource.revision,sourceSha256:version.value.ordinarySource.sha256,archivedAt:head.data.archivedAt,version};}
  }return found;
 });}
 function legacyPreview(ctx,input){fields(input,['sourceId']);const current=read(ctx,input.sourceId),prior=existing(ctx,input.sourceId);return {...current,existing:prior?{id:prior.id,revision:prior.revision,sourceRevision:prior.sourceRevision,archivedAt:prior.archivedAt}:null,token:hash(current),missingInputs:['status','sourcePin'],syntheticSourcePin:pin,warning:'用户手动登记，不证明客户阅读、参会或外部送达。必须自行选择状态和合成来源；本地目标不会被冒充为文档证据。'};}
 async function legacyImport(ctx,input){
  fields(input,['sourceId','token','status','sourcePin','reason']);const current=read(ctx,input.sourceId);
  if(typeof input.token!=='string'||hash(current)!==input.token)error('CONFLICT','Source or customer changed; preview again');
  if(!['planned','reported-completed','cancelled'].includes(input.status)||hash(input.sourcePin??null)!==hash(pin))error('INVALID_REQUEST','Explicit status and exact admitted synthetic source are required');
  const guard=()=>{if(hash(read(ctx,input.sourceId))!==input.token)error('CONFLICT','Source or current customer changed before commit')};
  const guardedOwners={...owners,observeOwner(context,b){const observation=owners.observeOwner(context,b);return {check(){observation.check();guard()}}}};
  const domain=new ServiceReportDomain(reportsStore,guardedOwners,sources,{clock});
  const prior=existing(ctx,input.sourceId);
  if(prior?.archivedAt)error('CONFLICT','Projected activity is archived; restore it explicitly in reports before continuing');
  if(prior&&prior.sourceRevision===current.source.revision){
   if(prior.sourceSha256!==current.source.sha256||prior.version.value.status!==input.status||hash(prior.version.value.references)!==hash([{pin}]))error('CONFLICT','Already projected with different choices; use report correction');
   return {...await domain.getActivity(ctx,{id:prior.id}),unchanged:true};
  }
  const activity={...current.projection,status:input.status,references:[{pin}],ordinarySource:current.source};
  const idempotencyKey='ordinary-'+hash([scope,input.sourceId,current.source.revision]);
  if(prior){
   if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>500)error('INVALID_REQUEST','An explicit correction reason is required');
   return domain.correctActivity(ctx,{scope,idempotencyKey,id:prior.id,expectedRevision:prior.revision,activity,reason:input.reason});
  }
  return domain.createActivity(ctx,{scope,idempotencyKey,activity});
 }

 // V2 is explicitly opt-in. A token is a freshness digest, never an owner credential.
 const exact=(value,keys)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)error('INVALID_REQUEST','Invalid projection object');
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Object.keys(descriptors).sort().join(',')!==[...keys].sort().join(',')||Object.values(descriptors).some(d=>!('value' in d)||d.value===undefined))error('INVALID_REQUEST','Invalid projection fields');
  return value;
 };
 const digest=value=>{if(typeof value!=='string'||!(/^[a-f0-9]{64}(?![\s\S])/).test(value))error('INVALID_REQUEST','Invalid projection digest');return value};
 const string=(value,max)=>{if(typeof value!=='string'||!value.length||value.length>max||/[\x00-\x1f\x7f]/.test(value))error('INVALID_REQUEST','Invalid projection identity');return value};
 const uuid=value=>{if(typeof value!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/).test(value))error('INVALID_REQUEST','Invalid document store identity');return value};
 const nonnegative=value=>{if(!Number.isSafeInteger(value)||value<0)error('INVALID_REQUEST','Invalid source metadata revision');return value};
 const positive=value=>{nonnegative(value);if(value===0)error('INVALID_REQUEST','Invalid projection revision');return value};
 function authorityValue(value){
  exact(value,['documentStoreScope','capabilities','policyVersion']);exact(value.capabilities,['localDocuments','syntheticFixture']);
  if(value.policyVersion!==1||typeof value.capabilities.localDocuments!=='boolean'||value.capabilities.syntheticFixture!==true||(value.documentStoreScope===null)!==!value.capabilities.localDocuments)error('INVALID_REQUEST','Invalid projection authority');
  if(value.documentStoreScope!==null)uuid(value.documentStoreScope);
  return structuredClone(value);
 }
 function selectedPin(value){exact(value,['documentId','revisionId','tenantId','collectionId','sha256']);return {documentId:string(value.documentId,500),revisionId:string(value.revisionId,500),tenantId:string(value.tenantId,100),collectionId:string(value.collectionId,500),sha256:digest(value.sha256)}}
 const syncCheck=check=>{const outcome=check();if(outcome!==undefined){if(outcome&&typeof outcome.then==='function')void Promise.resolve(outcome).catch(()=>{});error('INVALID_REQUEST','Projection authority checks must be synchronous')}};
 function request(ctx){
  const shared=budget(),deadline=performance.now()+30000;
  for(const key of ['maxRows','maxBytes','maxSourceBytes'])Object.defineProperty(shared,key,{value:shared[key],writable:false,configurable:false});
  const check=()=>{if(ctx.signal.aborted)error('CANCELLED','Projection cancelled');if(performance.now()>=deadline)error('RATE_LIMITED','Projection deadline exceeded');if(![shared.rows,shared.bytes,shared.sourceBytes].every(n=>Number.isSafeInteger(n)&&n>=0)||shared.rows>shared.maxRows||shared.bytes>shared.maxBytes||shared.sourceBytes>shared.maxSourceBytes)error('RATE_LIMITED','Projection aggregate budget exceeded')};
  check();const owner=owners.observeOwner(ctx,shared);const authority=observeProjectionAuthority(ctx,shared);
  return {shared,deadline,authority,signal:ctx.signal,check(){check();syncCheck(()=>owner.check());syncCheck(()=>authority.check());check()}};
 }
 async function boundedAwait(state,work){
  state.check();let timer,stop;const controller=new AbortController();
  const stopped=new Promise((_,reject)=>{
   stop=()=>{controller.abort();try{error('CANCELLED','Projection cancelled')}catch(e){reject(e)}};
   state.signal.addEventListener('abort',stop,{once:true});
   timer=setTimeout(()=>{controller.abort();try{error('RATE_LIMITED','Projection deadline exceeded')}catch(e){reject(e)}},Math.max(1,state.deadline-performance.now()));
  });
  try{return await Promise.race([Promise.resolve().then(()=>{state.check();return work(controller.signal)}),stopped])}finally{clearTimeout(timer);state.signal.removeEventListener('abort',stop);state.check()}
 }
 const token=(current,authority)=>hash(['ordinary-projection-v2',scope,authority,current]);
 const brief=prior=>prior?{id:prior.id,revision:prior.revision,sourceRevision:prior.sourceRevision,archivedAt:prior.archivedAt}:null;
 function previewV2(ctx,input){
  exact(input,['schema','scope','sourceId']);if(input.schema!==2)error('INVALID_REQUEST','Unknown projection schema');digest(input.scope);id(input.sourceId);if(input.scope!==scope)error('FORBIDDEN','Projection scope changed');
  const sourceId=input.sourceId,state=request(ctx),current=read(ctx,sourceId,state.shared),prior=existing(ctx,sourceId,state.shared),authority=state.authority.value,captured=token(current,authority);
  const checkPublication=()=>{state.check();if(token(read(ctx,sourceId,state.shared),state.authority.value)!==captured||hash(brief(existing(ctx,sourceId,state.shared)))!==hash(brief(prior)))error('CONFLICT','Projection preview changed');state.check()};
  checkPublication();return {schema:2,scope,authority,...current,existing:brief(prior),token:captured,missingInputs:['status','sourcePin'],syntheticSourcePin:pin,warning:'用户手动登记，不证明客户阅读、参会或外部送达。请明确选择状态和经核对的来源。',checkPublication};
 }
 async function importV2(ctx,raw){
  exact(raw,['schema','scope','sourceId','token','authority','expectedProjection','status','sourcePin','sourceObservation','reason']);
  if(raw.schema!==2)error('INVALID_REQUEST','Unknown projection schema');digest(raw.scope);id(raw.sourceId);digest(raw.token);if(raw.scope!==scope)error('FORBIDDEN','Projection scope changed');
  const authority=authorityValue(raw.authority),chosen=selectedPin(raw.sourcePin);
  if(!['planned','reported-completed','cancelled'].includes(raw.status)||typeof raw.reason!=='string'||raw.reason.length>500)error('INVALID_REQUEST','Explicit status and bounded reason required');
  if(raw.expectedProjection!==null){exact(raw.expectedProjection,['id','revision']);id(raw.expectedProjection.id);positive(raw.expectedProjection.revision)}
  if(raw.sourceObservation!==null){exact(raw.sourceObservation,['storeScope','documentId','metadataRevision']);uuid(raw.sourceObservation.storeScope);uuid(raw.sourceObservation.documentId);nonnegative(raw.sourceObservation.metadataRevision)}
  const input=structuredClone(raw),state=request(ctx),current=read(ctx,input.sourceId,state.shared);
  if(hash(authority)!==hash(state.authority.value)||token(current,state.authority.value)!==input.token)error('CONFLICT','Source, customer or authority changed; preview again');
  if(chosen.tenantId!==ctx.principal.tenantId||!ctx.principal.collectionIds.includes(chosen.collectionId))error('FORBIDDEN','Selected source scope changed');
  const synthetic=hash(chosen)===hash(pin);
  if(synthetic?input.sourceObservation!==null:!input.sourceObservation||!authority.capabilities.localDocuments||input.sourceObservation.storeScope!==authority.documentStoreScope||chosen.documentId!==`local-doc:${input.sourceObservation.storeScope}:${input.sourceObservation.documentId}`)error('INVALID_REQUEST','Explicit inspected source selection required');
  const observed=await boundedAwait(state,signal=>sources.resolve({...ctx,signal},chosen.documentId,chosen.revisionId,state.shared));
  const d=observed.document;
  state.shared.sourceBytes+=Buffer.byteLength(JSON.stringify(d));state.check();
  const actual={documentId:d.id,revisionId:d.revisionId,tenantId:d.tenantId,collectionId:d.collectionId,sha256:hash(documentIdentity(d))};
  if(observed.evidenceClass!=='primary-source'||observed.authorizationMode!=='current-local'||hash(actual)!==hash(chosen)||hash(observed.locator??null)!==hash(input.sourceObservation))error('CONFLICT','Selected source or observation changed; inspect again');
  const guard=()=>{state.check();syncCheck(()=>observed.check());if(token(read(ctx,input.sourceId,state.shared),state.authority.value)!==input.token)error('CONFLICT','Source or current customer changed before publication');state.check()};
  guard();
  const guardedOwners={...owners,observeOwner(context,b){const observation=owners.observeOwner(context,b);return {check(){syncCheck(()=>observation.check());guard()}}}};
  // Post-commit plan: four domain fences, one return guard, and two pairs of publication
  // guards, plus four exact head/version reads. No census or source text resolve occurs
  // after a new commit: the domain caches its one resolved source and customer. Twelve
  // measured full fences and eight bounded version reads conservatively cover that plan.
  let didWrite=false;
  const recordBound=Buffer.byteLength(JSON.stringify({...current.projection,status:input.status,references:[{pin:chosen}],ordinarySource:current.source}))+8192;
  const repository=new Proxy(reportsStore,{get(target,key){if(key==='write')return (context,command,b,action,beforeCommit)=>target.write(context,command,b,tx=>{didWrite=true;return action(tx)},()=>{
   const before={rows:b.rows,bytes:b.bytes,sourceBytes:b.sourceBytes};beforeCommit();
   const reserveRows=12*(b.rows-before.rows)+32,reserveBytes=12*(b.bytes-before.bytes)+8*recordBound+65536,reserveSource=12*(b.sourceBytes-before.sourceBytes);
   state.check();if(b.rows+reserveRows>b.maxRows||b.bytes+reserveBytes>b.maxBytes||b.sourceBytes+reserveSource>b.maxSourceBytes)error('RATE_LIMITED','Projection publication reserve exhausted before commit');
  });const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}});
  const domain=new ServiceReportDomain(repository,guardedOwners,sources,{clock,requestBudget:state.shared,requestDeadline:state.deadline});
  const prior=existing(ctx,input.sourceId,state.shared);guard();
  if(prior?.archivedAt)error('CONFLICT','Projected activity is archived; restore explicitly first');
  const activity={...current.projection,status:input.status,references:[{pin:chosen}],ordinarySource:current.source};
  const idempotencyKey='ordinary-'+hash([scope,input.sourceId,current.source.revision]);
  const same=prior&&prior.sourceRevision===current.source.revision;
  if(same&&(prior.sourceSha256!==current.source.sha256||prior.version.value.status!==input.status||hash(prior.version.value.references)!==hash(activity.references)))error('CONFLICT','Already projected with different choices; use report correction');
  const expected=input.expectedProjection;
  let result;
  if(same&&expected&&expected.id===prior.id&&expected.revision===prior.revision&&input.reason===''){
   // Desired-state no-op, deliberately not represented as an exact receipt acknowledgement.
   result=await domain.getActivity(ctx,{id:prior.id});
  }else if(expected===null){
   if(input.reason!=='')error('INVALID_REQUEST','Initial projection does not accept a correction reason');
   if(prior&&!same)error('CONFLICT','Projection head changed; preview again');
   result=await domain.createActivity(ctx,{scope,idempotencyKey,activity});
  }else{
   if(!input.reason.trim())error('INVALID_REQUEST','An explicit correction reason is required');
   if(!prior||expected.id!==prior.id||(!same&&expected.revision!==prior.revision))error('CONFLICT','Projection head changed; preview again');
   result=await domain.correctActivity(ctx,{scope,idempotencyKey,id:expected.id,expectedRevision:expected.revision,activity,reason:input.reason});
  }
  guard();
  if(result.scope!==scope||hash(result.activity.version.value)!==hash(activity))error('CONFLICT','Projection result no longer matches submission');
  const returned=structuredClone(result.activity);
  const checkPublication=()=>{guard();reportsStore.read(ctx,state.shared,tx=>{const head=tx.get('activity',returned.id),version=tx.get('activity-version',head.data.versionId);if(head.revision!==returned.revision||head.data.versionId!==returned.versionId||head.data.archivedAt!==returned.archivedAt||hash(version.data)!==hash(returned.version))error('CONFLICT','Projected activity changed before publication');return null});guard()};
  checkPublication();return {schema:2,scope,activity:returned,unchanged:!didWrite,checkPublication};
 }
 function previewServiceRecord(ctx,input){return input&&Object.getOwnPropertyDescriptor(input,'schema')?.value===2?previewV2(ctx,input):legacyPreview(ctx,input)}
 async function importServiceRecord(ctx,input){return input&&Object.getOwnPropertyDescriptor(input,'schema')?.value===2?importV2(ctx,input):legacyImport(ctx,input)}
 return {previewServiceRecord,importServiceRecord};
}
