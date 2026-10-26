// @vitest-environment node
// Real composed synthetic SQLite + real client/session/boundedTransport over bounded stdio IPC.
// Only response loss is simulated. This is not HTTP, React rendering or browser acceptance.
import {it,expect} from 'vitest';
import {spawn} from 'node:child_process';
import {mkdtempSync,lstatSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ServiceRecordProjectionSession} from '../candidate/src/components/service-record-projection-session';
import {boundedTransport} from '../visual-harness/bounded-transport';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';

it('converges real v2 metadata-zero selection and response-lost correction through actual bounded client/session',async()=>{
 const root=mkdtempSync(join(tmpdir(),'projection-convergence-')),stat=lstatSync(root,{bigint:true});
 const script=String.raw`
 import assert from 'node:assert/strict';
 import {execFileSync} from 'node:child_process';
 import {mkdirSync,lstatSync,readdirSync} from 'node:fs';
 import {join} from 'node:path';
 import {pathToFileURL} from 'node:url';
 import {Readable} from 'node:stream';
 import {createInterface} from 'node:readline';
 import {DatabaseSync} from 'node:sqlite';
 const [backend,root,capability]=process.argv.slice(1);
 const st=lstatSync(root,{bigint:true});assert(st.isDirectory()&&!st.isSymbolicLink());assert.equal(st.dev+':'+st.ino,capability);assert.equal(readdirSync(root).length,0);
 let app,lines,closed=false,outputBytes=0,requestCount=0;
 const close=()=>{if(!closed){closed=true;app?.close()}};
 const emit=value=>{const text=JSON.stringify(value)+'\n';outputBytes+=Buffer.byteLength(text);assert(outputBytes<=4*1024*1024);process.stdout.write(text)};
 const deadline=setTimeout(()=>{close();process.exit(124)},75000);
 process.on('SIGTERM',()=>{close();process.exit(143)});
 try{
  const prepared=join(root,'prepared'),storage=join(root,'storage');mkdirSync(prepared);mkdirSync(storage);
  const ps=lstatSync(prepared,{bigint:true}),build=join(prepared,'runtime');
  assert.equal(execFileSync(process.execPath,[join(backend,'prepare-backend.mjs'),'--owned-root',prepared,ps.dev+':'+ps.ino],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024}).trim(),build);
  const {compose}=await import(pathToFileURL(join(backend,'composition.mjs'))),{researchDocuments}=await import(pathToFileURL(join(backend,'research-documents.mjs')));
  let documents;
  app=await compose(build,storage,{createLocalSources(authority){documents=researchDocuments(storage,{get:(kind,id)=>authority.workspace.get(authority.context(),{kind,id}),list:()=>[]});return {resource:documents,port:documents.createReportSourcePort(authority)}}});
  const req=Readable.from([Buffer.from('Public-safe synthetic projection convergence text. No private material.')]);req.method='POST';req.url='/api/documents/upload?name=Projection-convergence.txt';req.headers={'content-type':'application/octet-stream'};
  let uploaded,calls=0;await documents.handle(req,(status,body)=>{calls++;assert(status>=200&&status<300);uploaded=body.document},(status,code)=>assert.fail('Synthetic upload '+status+' '+code),()=>assert.fail('No binary response'));assert.equal(calls,1);assert.equal(uploaded.revision,0);
  const ctx=()=>app.context();let record=app.organization.create(ctx(),{kind:'service-record',id:'convergence-record',idempotencyKey:'convergence-create-record',data:{organizationId:'synthetic-org',contactId:null,activity:'meeting',occurredAt:'2026-10-05T12:00:00.000Z',summary:'Synthetic convergence ordinary record',notes:'No private information'}});
  emit({id:0,result:{sourceId:record.id,documentId:uploaded.id,metadataRevision:uploaded.revision}});
  lines=createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of lines){
   assert(Buffer.byteLength(line)<=65536);assert(++requestCount<=32);const message=JSON.parse(line);assert(Number.isSafeInteger(message.id));let result;
   try{
    if(message.route==='fixture-close'){emit({id:message.id,result:null});break}
    if(message.route==='fixture-update')result=record=app.organization.update(ctx(),{kind:'service-record',id:record.id,expectedRevision:record.revision,idempotencyKey:'convergence-correct-record',patch:{summary:'Corrected synthetic convergence ordinary record'}});
    else if(message.route==='fixture-stats'){const db=new DatabaseSync(join(storage,'data','service-reports.sqlite'),{readOnly:true});try{result={activities:Number(db.prepare("SELECT count(*) AS n FROM service_rows WHERE kind='activity'").get().n),versions:Number(db.prepare("SELECT count(*) AS n FROM service_rows WHERE kind='activity-version'").get().n),receipts:Number(db.prepare('SELECT count(*) AS n FROM service_receipts').get().n)}}finally{db.close()}}
    else if(message.route==='/api/service-reports/scope')result=app.reports.scope(ctx());
    else if(message.route==='/api/service-reports/sourceChoices')result=app.sourceChoices(ctx(),message.input);
    else if(message.route==='/api/service-reports/inspectSource')result=await app.inspectSource(ctx(),message.input);
    else if(message.route==='/api/service-reports/previewServiceRecord')result=app.bridge.previewServiceRecord(ctx(),message.input);
    else if(message.route==='/api/service-reports/importServiceRecord')result=await app.bridge.importServiceRecord(ctx(),message.input);
    else throw Error('Unexpected fixture route');
    // Exact server publication projection: run checker, strip it, serialize actual DTO.
    if(result&&typeof result.checkPublication==='function'){const {checkPublication,...payload}=result;checkPublication();result=payload}
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
 let session:ServiceRecordProjectionSession|undefined,completed=false;
 try{
  const fixture=await ready;expect(fixture.metadataRevision).toBe(0);
  const imports:{command:any;result:any}[]=[];let loseCorrection=false;
  const transport:typeof globalThis.fetch=async(url,init)=>{
   expect(init?.method).toBe('POST');expect(init?.credentials).toBe('same-origin');expect(init?.redirect).toBe('error');expect(init?.cache).toBe('no-store');
   const route=String(url);expect(route).toMatch(/^\/api\/service-reports\/(scope|sourceChoices|inspectSource|previewServiceRecord|importServiceRecord)$/);
   const input=JSON.parse(String(init?.body)),result=await rpc(route,input);
   if(route.endsWith('/importServiceRecord')){imports.push({command:structuredClone(input),result:structuredClone(result)});if(loseCorrection){loseCorrection=false;throw Error('Simulated response loss AFTER actual committed correction')}}
   return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
  };
  const actor={binding:'a'.repeat(64),epoch:1};session=new ServiceRecordProjectionSession(actor,()=>actor,boundedTransport(new OrdinaryRequestLifetime(),transport));session.setView(true,1);
  await session.preview(fixture.sourceId);expect(session.state.preview?.source.revision).toBe(1);await session.choices();const row=session.state.page!.items.find(x=>x.documentId.endsWith(':'+fixture.documentId))!;expect(row.metadataRevision).toBe(0);
  await session.select(row.documentId);expect(session.state.selection?.sourceKind).toBe('local-document');if(session.state.selection?.sourceKind==='local-document')expect(session.state.selection.locator.metadataRevision).toBe(0);
  session.setDraft('reported-completed','');await session.submit();expect(session.state.pending).toBeNull();expect(imports).toHaveLength(1);const created=imports[0].result.activity;expect(created.revision).toBe(1);
  await rpc('fixture-update');await session.preview(fixture.sourceId);expect(session.state.preview?.source.revision).toBe(2);expect(session.state.preview?.existing?.id).toBe(created.id);await session.choices();await session.select(row.documentId);
  expect(session.state.selection?.pin).toEqual(imports[0].command.sourcePin);session.setDraft('reported-completed','Explicit convergence correction');loseCorrection=true;await session.submit();
  const retained=session.state.pending!;expect(retained).not.toBeNull();expect(retained.command.expectedProjection).toEqual({id:created.id,revision:1});expect(retained.command.reason).toBe('Explicit convergence correction');expect(imports).toHaveLength(2);expect(imports[1].result.activity.revision).toBe(2);const counts=await rpc('fixture-stats');
  session.setView(false,2);session.setView(true,3);expect(session.state.pending).toBe(retained);await session.retry();expect(imports).toHaveLength(3);expect(imports[2].command).toEqual(imports[1].command);expect(imports[2].result.unchanged).toBe(true);expect(imports[2].result.activity).toEqual(imports[1].result.activity);expect(imports[2].result.activity.id).toBe(created.id);expect(await rpc('fixture-stats')).toEqual(counts);expect(session.state.pending).toBeNull();expect(session.state.result).toContain(created.id);completed=true;
 }finally{
  session?.dispose();let shutdownError:unknown=null;
  try{if(child.exitCode===null&&!fatal)await rpc('fixture-close')}catch(error){shutdownError=error}child.stdin.end();
  const timer=setTimeout(()=>child.kill('SIGKILL'),2000);const status=await exited;clearTimeout(timer);
  const remaining=pending.size;for(const entry of pending.values())clearTimeout(entry.timer);pending.clear();rmSync(root,{recursive:true,force:true});
  if(completed){expect(shutdownError).toBeNull();expect(fatal).toBeNull();expect(status).toEqual({code:0,signal:null});expect(remaining).toBe(0);expect(buffer).toBe('')}

 }
},90000);
