// @vitest-environment node
// Actual composed synthetic TXT/SQLite + production route publisher, client, session and route gate.
// Bounded stdio and Response are simulated transport. No HTTP listener, browser or scheduler.
import {it,expect} from 'vitest';
import {spawn} from 'node:child_process';
import {mkdtempSync,lstatSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ManualInventorySession} from '../candidate/src/components/manual-inventory-session';
import {createManualInventoryJournal} from '../candidate/src/components/manual-inventory-journal';
import {createManualInventoryApi} from '../candidate/src/adapters/manual-inventory';
import {MANUAL_INVENTORY_PROTOCOL} from '../candidate/shared/manual-inventory-protocol';
import {boundedTransport} from '../visual-harness/bounded-transport';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';

it('converges actual metadata-zero inventory and lost-response recovery without current document access',async()=>{
 const root=mkdtempSync(join(tmpdir(),'manual-inventory-convergence-')),stat=lstatSync(root,{bigint:true});
 const script=String.raw`
 import assert from 'node:assert/strict';
 import {execFileSync} from 'node:child_process';
 import {mkdirSync,lstatSync,readdirSync} from 'node:fs';
 import {join} from 'node:path';
 import {pathToFileURL} from 'node:url';
 import {Readable} from 'node:stream';
 import {createInterface} from 'node:readline';
 const [backend,root,capability]=process.argv.slice(1);
 const st=lstatSync(root,{bigint:true});assert(st.isDirectory()&&!st.isSymbolicLink());assert.equal(st.dev+':'+st.ino,capability);assert.equal(readdirSync(root).length,0);
 let app,lines,closed=false,outputBytes=0,requestCount=0,observations=0;
 const close=()=>{if(!closed){closed=true;app?.close()}};
 const emit=value=>{const text=JSON.stringify(value)+'\n';outputBytes+=Buffer.byteLength(text);assert(outputBytes<=4*1024*1024);process.stdout.write(text)};
 const deadline=setTimeout(()=>{close();process.exit(124)},75000);
 process.on('SIGTERM',()=>{close();process.exit(143)});
 try{
  const prepared=join(root,'prepared'),storage=join(root,'storage');mkdirSync(prepared);mkdirSync(storage);
  const ps=lstatSync(prepared,{bigint:true}),build=join(prepared,'runtime');
  assert.equal(execFileSync(process.execPath,[join(backend,'prepare-backend.mjs'),'--owned-root',prepared,ps.dev+':'+ps.ino],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024}).trim(),build);
  const {compose}=await import(pathToFileURL(join(backend,'composition.mjs'))),{researchDocuments}=await import(pathToFileURL(join(backend,'research-documents.mjs'))),{manualInventoryRoutes}=await import(pathToFileURL(join(backend,'manual-inventory-routes.mjs')));
  let documents;
  app=await compose(build,storage,{createLocalSources(authority){
   documents=researchDocuments(storage,{get:(kind,id)=>authority.workspace.get(authority.context(),{kind,id}),list:()=>[]});
   const actual=documents.createManualInventoryObserverPort(authority.manualInventoryAuthority,authority.manualInventoryProtocol);
   // Count real observations without manufacturing DTOs or replacing authority checks.
   const observer={observe(...args){observations++;return actual.observer.observe(...args)},authorizeHistorical(...args){observations++;return actual.observer.authorizeHistorical(...args)}};
   return {resource:documents,port:documents.createReportSourcePort(authority),manualInventory:{observer,probe:actual.probe}};
  }});
  const req=Readable.from([Buffer.from('Public-safe synthetic manual inventory convergence. No private material.')]);req.method='POST';req.url='/api/documents/upload?name=Inventory-convergence.txt';req.headers={'content-type':'application/octet-stream'};
  let uploaded,calls=0;await documents.handle(req,(status,body)=>{calls++;assert(status>=200&&status<300);uploaded=body.document},(status,code)=>assert.fail('Synthetic upload '+status+' '+code),()=>assert.fail('No binary response'));assert.equal(calls,1);assert.equal(uploaded.revision,0);
  const ctx=()=>app.context();
  const skill=app.automation.createSkill(ctx(),{idempotencyKey:'inventory-convergence-skill',name:'Synthetic inventory',description:'No scheduler activation',enabled:true,handler:'local-document-inventory'});
  const schedule=app.automation.createSchedule(ctx(),{idempotencyKey:'inventory-convergence-schedule',name:'Synthetic manual inventory',skillId:skill.id,sourceIds:[],instructions:'',enabled:true,cadence:{kind:'daily',time:'12:00',timezone:'UTC'}});
  const routes=manualInventoryRoutes(app.manualInventory,ctx);
  emit({id:0,result:{identityScope:app.identity.identityScope,documentId:uploaded.id,metadataRevision:uploaded.revision,scheduleId:schedule.id,scheduleRevision:schedule.revision,skillId:skill.id,skillRevision:skill.revision}});
  lines=createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of lines){
   assert(Buffer.byteLength(line)<=65536);assert(++requestCount<=32);const message=JSON.parse(line);assert(Number.isSafeInteger(message.id));let result;
   try{
    if(message.route==='fixture-close'){emit({id:message.id,result:null});break}
    if(message.route==='fixture-disable-source'){documents.close();result=null}
    else if(message.route==='fixture-stats')result={observations,genericRuns:app.automation.listRuns(ctx(),{}).length,notifications:app.automation.listNotifications(ctx(),{}).length};
    else {
     const request=Readable.from([Buffer.from(message.input.body)]);request.method='POST';request.url=message.route;request.headers={'content-type':'application/json'};
     let replies=0;const reply=(status,body)=>{assert.equal(++replies,1);result={status,body:JSON.stringify(body)}};
     assert.equal(await routes.handle(request,reply,(status,code,message)=>reply(status,{code,message}),buffer=>{assert.equal(++replies,1);result={status:200,body:buffer.toString('utf8')}}),true);assert.equal(replies,1);
    }
    emit({id:message.id,result});
   }catch(error){emit({id:message.id,error:{code:error.code??'FIXTURE_ERROR'}})}
  }
 }finally{clearTimeout(deadline);lines?.close();close()}
 `;
 const child=spawn(process.execPath,['--input-type=module','-e',script,fileURLToPath(new URL('../backend/',import.meta.url)),root,stat.dev+':'+stat.ino],{stdio:['pipe','pipe','pipe']});
 let sequence=0,buffer='',bytes=0,stderr='',fatal:Error|null=null;
 const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 const fail=(error:Error)=>{fatal=error;for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(error)}pending.clear()};
 const awaitMessage=(id:number,timeout=15000)=>new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Bounded fixture deadline '+id))},timeout);pending.set(id,{resolve,reject,timer})});
 const ready=awaitMessage(0,45000);
 child.on('error',fail);const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{child.once('error',()=>resolve({code:null,signal:null}));child.once('exit',(code,signal)=>{if(pending.size)fail(new Error('Fixture exited '+code+' '+stderr));resolve({code,signal})})});
 child.stderr.on('data',chunk=>{stderr+=String(chunk);if(stderr.length>65536){fail(new Error('Fixture stderr bound'));child.kill()}});
 child.stdout.on('data',chunk=>{try{bytes+=chunk.length;if(bytes>4*1024*1024)throw Error('Fixture output bound');buffer+=String(chunk);let at;
  while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line)continue;const message=JSON.parse(line),entry=pending.get(message.id);if(!entry)throw Error('Unexpected fixture reply');pending.delete(message.id);clearTimeout(entry.timer);if(message.error)entry.reject(Object.assign(new Error('Fixture operation failed'),message.error));else entry.resolve(message.result)}
 }catch(error){fail(error as Error);child.kill()}});
 const rpc=(route:string,input:unknown={})=>{if(fatal)return Promise.reject(fatal);const id=++sequence,text=JSON.stringify({id,route,input})+'\n';if(Buffer.byteLength(text)>65536)return Promise.reject(Error('Fixture input bound'));const reply=awaitMessage(id);child.stdin.write(text);return reply};
 let session:ManualInventorySession|undefined,recovered:ManualInventorySession|undefined,completed=false;
 try{
  const fixture=await ready;expect(fixture.metadataRevision).toBe(0);
  const executions:{body:string;reply:any}[]=[];let loseResponse=true;
  const transport:typeof globalThis.fetch=async(url,init)=>{
   expect(init?.method).toBe('POST');expect(init?.credentials).toBe('same-origin');expect(init?.redirect).toBe('error');expect(init?.cache).toBe('no-store');
   const route=String(url);expect(route).toMatch(/^\/api\/manual-inventory\/(capabilities|preview|execute|operation|result|history)$/);
   const reply=await rpc(route,{body:String(init?.body)});
   if(route.endsWith('/execute')){executions.push({body:String(init?.body),reply:JSON.parse(reply.body)});if(loseResponse){loseResponse=false;throw Error('Simulated response loss AFTER real route committed and serialized proof')}}
   return new Response(reply.body,{status:reply.status,headers:{'content-type':'application/json','content-length':String(Buffer.byteLength(reply.body))}});
  };
  const api=createManualInventoryApi(boundedTransport(new OrdinaryRequestLifetime(),transport));
  const storage=new Map<string,string>(),journal=createManualInventoryJournal({getItem:k=>storage.get(k)??null,setItem:(k,v)=>{storage.set(k,v)},removeItem:k=>{storage.delete(k)}});
  session=new ManualInventorySession(fixture.identityScope,()=>{},api,journal,()=> '10000000-0000-4000-8000-000000000001');
  await session.discover();expect(session.capabilities?.manualDocumentInventory.available).toBe(true);
  const caps=session.capabilities!;
  await session.prepare({protocol:MANUAL_INVENTORY_PROTOCOL,identityScope:caps.identityScope,automationStoreScope:caps.automationStoreScope,documentStoreScope:caps.documentStoreScope!,scheduleId:fixture.scheduleId,scheduleRevision:fixture.scheduleRevision,skillId:fixture.skillId,skillRevision:fixture.skillRevision,selection:{mode:'all',workspaceId:null,folderId:null}});
  expect(session.preview?.count).toBe(1);await session.executePreview();
  expect(executions).toHaveLength(1);expect(executions[0].reply.state).toBe('committed');expect(session.proof).toBeNull();expect(session.pending).not.toBeNull();expect(storage.size).toBe(1);
  const original=session.pending!;await session.lookup();expect(session.proof).toEqual(executions[0].reply);
  const proof=session.proof!;if(proof.state!=='committed')throw Error('Expected actual committed proof');
  await session.openResult(proof.runId,proof.resultId);expect(session.result?.documents).toHaveLength(1);expect(session.result?.documents[0]).toMatchObject({id:fixture.documentId,revision:0,format:'txt'});expect(session.result?.inventoryDigest).toBe(original.envelope.inventoryDigest);
  await session.loadHistory();expect(session.history?.items).toHaveLength(1);const history=session.history;
  await rpc('fixture-disable-source');session.detach();
  recovered=new ManualInventorySession(fixture.identityScope,()=>{},api,journal,()=>{throw Error('Recovery must not mint a new operation')});
  await recovered.discover();expect(recovered.capabilities?.manualDocumentInventory.available).toBe(false);expect(recovered.pending).toEqual(original);expect(recovered.proof).toBeNull();
  const before=await rpc('fixture-stats');await recovered.retryOriginal();expect(recovered.proof).toEqual(proof);expect(executions).toHaveLength(2);expect(executions[1].body).toBe(executions[0].body);expect(executions[1].reply).toEqual(proof);expect(await rpc('fixture-stats')).toEqual(before);
  await recovered.lookup();expect(recovered.proof).toEqual(proof);await recovered.loadHistory();expect(recovered.history).toEqual(history);expect(await rpc('fixture-stats')).toEqual(before);
  await recovered.openResult(proof.runId,proof.resultId);expect(recovered.result).toBeNull();expect(recovered.resultError).not.toBe('');expect(recovered.proof).toEqual(proof);expect(recovered.pending).toEqual(original);expect(recovered.history).toEqual(history);expect(storage.size).toBe(1);
  expect(before.genericRuns).toBe(0);expect(before.notifications).toBe(0);completed=true;
 }finally{
  session?.detach();recovered?.detach();let shutdownError:unknown=null;
  try{if(child.exitCode===null&&!fatal)await rpc('fixture-close')}catch(error){shutdownError=error}child.stdin.end();
  const timer=setTimeout(()=>child.kill('SIGKILL'),2000);const status=await exited;clearTimeout(timer);
  const remaining=pending.size;for(const entry of pending.values())clearTimeout(entry.timer);pending.clear();rmSync(root,{recursive:true,force:true});
  if(completed){expect(shutdownError).toBeNull();expect(fatal).toBeNull();expect(status).toEqual({code:0,signal:null});expect(remaining).toBe(0);expect(buffer).toBe('')}
 }
},90000);
