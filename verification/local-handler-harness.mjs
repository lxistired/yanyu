import {readFileSync,mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {DomainStore,workspaceCommandRejection} from '../prepared-runtime/server/workspace-store.mjs';
import {WorkspaceDomain} from '../prepared-runtime/server/workspace-domain.mjs';
import {ManualPlanDomain} from '../prepared-runtime/server/manual-plan-domain.mjs';

// Exact current production callback, not a reimplementation. Only adapter boundaries for
// unrelated documents, transcription, private providers and inventory return no-match.
// Neither node:http nor the production startup/listen/disposal block is loaded or run.
const sourceRoot=process.cwd(); // Run from this candidate root, matching the Vitest configuration.
const source=readFileSync(join(sourceRoot,'backend/server.mjs'),'utf8');
const routeDeclaration=source.slice(source.indexOf('const routes='),source.indexOf('\nconst dist='));
const callbackStart=source.indexOf('const server=createServer(')+'const server=createServer('.length;
const callbackEnd=source.indexOf('\nserver.requestTimeout=')-2;
const callback=source.slice(callbackStart,callbackEnd);
if(!callback.startsWith('async(req,res)=>{')||!callback.endsWith('}'))throw Error('Current handler extraction mismatch');
export const handlerIdentity={sourceRoot,sourceSha256:createHash('sha256').update(source).digest('hex'),callbackSha256:createHash('sha256').update(callback).digest('hex'),routeDeclarationSha256:createHash('sha256').update(routeDeclaration).digest('hex'),mode:'Exact callback and route declaration compiled in-process; no server startup, socket, listener or network'};

export function createLocalHarness(outputDir){
 mkdirSync(outputDir,{recursive:true});
 const storage=mkdtempSync(join(outputDir,'sqlite-'));
 const principal={tenantId:'synthetic-flow-tenant',subjectId:'synthetic-flow-owner',collectionIds:[]};
 const context=()=>({principal,requestId:'synthetic-plan-session-flow',signal:new AbortController().signal});
 let store,app,handler;
 const calls=[],logs=[];
 const open=()=>{
  store=new DomainStore(storage);
  app={context,workspace:new WorkspaceDomain(store),manualPlans:new ManualPlanDomain(store),workspaceCommandRejection};
  const pass={handle:async()=>false};
  handler=new Function('app','port','origin','assets','inventoryRoutes','handlePrivateDemo','privateDemo','inventory','documents','transcription','publishPdfImage','event','Buffer',`${routeDeclaration}\nreturn (${callback});`)(app,12345,'http://127.0.0.1:12345',new Map(),pass,async()=>false,null,pass,pass,pass,()=>{throw Error('Unrelated PDF image route reached')},x=>logs.push(x),Buffer);
 };
 open();
 const fetcher=async(url,init={})=>{
  const path=String(url);
  if(!/^\/api\/(workspace|manual-plans)\/[A-Za-z]+$/.test(path))throw Error('Out-of-scope transport path: '+path);
  const req=Readable.from([Buffer.from(String(init.body??''))]);
  req.url=path;req.method=init.method??'GET';req.headers={host:'127.0.0.1:12345',origin:'http://127.0.0.1:12345',...Object.fromEntries(new Headers(init.headers))};
  let status=0,headers={},body;
  await handler(req,{writeHead(s,h){status=s;headers=h;},end(value){body=value;}});
  if(!status||body===undefined)throw Error('Handler response unfinished');
  const payload=JSON.parse(String(body));
  calls.push({path,method:req.method,input:JSON.parse(String(init.body??'{}')),status,payload});
  return new Response(body,{status,headers});
 };
 const post=async(group,op,input)=>{const response=await fetcher(`/api/${group}/${op}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});const value=await response.json();if(response.status!==200)throw Error('Fixture route failed '+JSON.stringify({op,status:response.status,value}));return value;};
 return {fetcher,post,calls,logs,context,get store(){return store;},get app(){return app;},reopen(){store.close();open();},persist(){writeFileSync(join(outputDir,'route-trace.json'),JSON.stringify({handlerIdentity,calls,logs},null,2)+'\n');},close(){store.close();rmSync(storage,{recursive:true,force:true});}};
}
