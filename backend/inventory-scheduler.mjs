import {join} from 'node:path';
import {LocalScheduler} from '../scheduler/runner.mjs';
import {schedulerRoutes} from '../scheduler/routes.mjs';
export const INVENTORY_ROUTES=Object.freeze(['GET /api/local-scheduler/capabilities','GET /api/local-scheduler/schedules','POST /api/local-scheduler/schedules','POST /api/local-scheduler/state','GET /api/local-scheduler/runs','GET /api/local-scheduler/result']);
export function inventoryScheduler(storage){
 const engine=new LocalScheduler({filename:join(storage,'inventory.scheduler.sqlite'),inventoryStorage:storage});
 const routes=schedulerRoutes(engine);let timer=null,lastError=null,admission=null;
 const tick=()=>{try{admission=engine.tick().admission;lastError=null}catch{lastError='Local inventory unavailable; bounded claim recovery will retry'}};
 return {engine,start(){if(!timer){tick();timer=setInterval(tick,1000)}},close(){if(timer)clearInterval(timer);timer=null;engine.close()},async handle(req,send,fail){
 if(!req.url.startsWith('/api/local-scheduler'))return false;
 try{
  const url=new URL(req.url,'http://local'),key=req.method+' '+url.pathname;
  if(req.url.includes('#')||req.url.split('?')[0]!==url.pathname){fail(404,'NOT_FOUND','Noncanonical inventory route');return true}
  if(!INVENTORY_ROUTES.includes(key)){fail(404,'NOT_FOUND','Unknown inventory scheduler route');return true}
  if(req.headers['x-yanyu-recovery-scope']!==undefined&&req.headers['x-yanyu-recovery-scope']!==engine.recoveryScope){fail(409,'RECOVERY_SCOPE_CONFLICT','Local inventory database changed; reopen the page before submitting');return true}
  let input={};
  if(req.method==='GET'){
   const keys=[...url.searchParams.keys()];if(keys.some(k=>k!=='id')||keys.length>1||(url.pathname.endsWith('/result')?keys.join()!=='id':keys.length!==0))throw Error('INVALID_REQUEST');
   if(keys.length)input={id:url.searchParams.get('id')};
  }else{
   if(url.search||req.headers['content-encoding']||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))throw Error('INVALID_REQUEST');
   const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>8192){fail(413,'INVALID_REQUEST','Body exceeds 8192 bytes');return true}parts.push(part)}
   input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
  }
  if(key==='GET /api/local-scheduler/capabilities')send(200,{handler:'document-inventory-snapshot',execution:'local-app-process-only',research:'unavailable',providers:'unavailable',network:'unavailable',externalEffects:'unavailable',scope:'Active local documents only; null workspace/folder means all',recoveryScope:engine.recoveryScope,limits:{schedules:100,runs:10000,documents:250,tickMs:1000},admission,lastError});
  else send(200,routes[key.replace('/api/','/')](input));
 }catch(e){const code=e.code||'INVALID_REQUEST';const status=code==='NOT_FOUND'?404:code.includes('QUOTA')?429:code.includes('CONFLICT')||code==='TERMINAL_SCHEDULE'?409:400;fail(status,code,status===400?'Invalid or unsupported local inventory request':e.message)}
 return true;
 }};
}
