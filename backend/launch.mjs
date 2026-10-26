import { mkdtempSync, mkdirSync, existsSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { startOwnedChild } from './owned-process.mjs';
import { createDisposableStorage } from './disposable-storage.mjs';
const args=process.argv.slice(2),demo=args.includes('--demo');
if(args.some(x=>x!=='--demo'))throw Error('Usage: npm start [-- --demo]. Configure paths with YANYU_DATA_DIR, YANYU_MODEL_DIR, YANYU_PYTHON.');
if(demo&&process.env.YANYU_DATA_DIR)throw Error('--demo refuses YANYU_DATA_DIR: disposable mode must never target existing data');
const here=import.meta.dirname;
if(!existsSync(join(here,'../dist/index.html')))throw Error('Frontend missing: run npm run build first');
const disposable=demo?createDisposableStorage():null;
const root=disposable?.root??resolve(process.env.YANYU_DATA_DIR||join(process.env.XDG_DATA_HOME||join(homedir(),'.local/share'),'yanyu-inventory-schedules'));
mkdirSync(root,{recursive:true,mode:0o700});
// Preparation receives an exact newly minted empty output root, never an arbitrary returned parent path.
const runtimeRoot=mkdtempSync(join(tmpdir(),'yanyu-launch-runtime-'));
const runtimeStat=lstatSync(runtimeRoot,{bigint:true}),runtimeIdentity=`${runtimeStat.dev}:${runtimeStat.ino}`;
const expectedBuild=join(runtimeRoot,'runtime');
let current,preparation,lastStop,startOperation,port=Number(process.env.YANYU_PORT||0),closing=false,failure=null;
if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid YANYU_PORT');
const lines=createInterface({input:process.stdin});
const startupAbort=new AbortController();
let signal;
const signalled=new Promise(resolve=>signal=resolve);
const onSignal=()=>{closing=true;startupAbort.abort();signal();lines.close();process.stdin.pause()};
process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);
const backendEnv={...Object.fromEntries(['JP_PRIVATE_DEMO','JP_PRIVATE_DB_PATH','JP_PRIVATE_DB_SHA256'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]])),PATH:process.env.PATH,...Object.fromEntries(['YANYU_PYTHON','YANYU_MODEL_DIR'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]])),...Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('ASR_')))};
function confirmed(receipt){return receipt?.directExitConfirmed&&receipt.group==='absent';}
async function stop(){
 if(!current)return lastStop;
 const owned=current;lastStop=await owned.stop('launcher-shutdown');
 if(!confirmed(lastStop))throw Error('Backend shutdown unconfirmed; storage retained');
 if(current===owned)current=null;return lastStop;
}
function start(){return startOperation??=(async()=>{
 if(closing)throw Error('Startup interrupted');
 current=await startOwnedChild({command:process.execPath,args:[join(here,'server.mjs'),expectedBuild,root,join(root,'events.jsonl'),String(port)],env:backendEnv,startMs:15000,runMs:null,termMs:1000,killMs:2000,drainMs:250,maxOutputBytes:65536,abortSignal:startupAbort.signal,
  readyMessage(message,pid){
   if(!message||typeof message!=='object'||Object.keys(message).sort().join(',')!=='origin,pid'||message.pid!==pid||typeof message.origin!=='string'||message.origin.length>128||!/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.test(message.origin))return false;
   const parsed=new URL(message.origin);if(Number(parsed.port)>65535)return false;
   return {origin:message.origin,pid};
  }});
 const state=current.snapshot();
 if(!state.ready||closing)throw Error('Backend readiness failed');
 port=Number(new URL(state.readyData.origin).port);
 disposable?.pinFence();
 console.log(`READY ${state.readyData.origin} pid=${state.readyData.pid}`);
 console.log(`DATA ${root} mode=${demo?'disposable-demo':'persistent'}`);
})().finally(()=>{startOperation=null});}
try{
 preparation=await startOwnedChild({command:process.execPath,args:[join(here,'prepare-backend.mjs'),'--owned-root',runtimeRoot,runtimeIdentity],env:{PATH:process.env.PATH,LANG:'C.UTF-8',TZ:'UTC'},startMs:1000,runMs:30000,termMs:1000,killMs:2000,maxOutputBytes:65536,abortSignal:startupAbort.signal});
 const prepared=await preparation.finishWithin(30000);
 if(!confirmed(prepared)||!prepared.started||prepared.exit?.code!==0||!prepared.stdioClosed||prepared.timedOut||prepared.outputLimit||prepared.drainTimedOut||prepared.errors.length||prepared.stdout.trim()!==expectedBuild||closing)throw Error('Preparation failed or unconfirmed; owned runtime retained');
 await start();console.log('Enter restart or quit. Normal mode preserves records after exit.');
 const commands=(async()=>{
  for await(const line of lines){
   if(line.trim()==='quit'){closing=true;break;}
   if(line.trim()==='restart'){await stop();if(!closing)await start();}
  }
  if(!closing)await signalled;
 })();
 await Promise.race([commands,signalled]);
}catch(error){failure=error;process.exitCode=1;}
finally{
 closing=true;startupAbort.abort();lines.close();
 if(startOperation)try{await startOperation}catch(error){failure??=error;process.exitCode=1;}
 try{await stop();}catch(error){failure??=error;process.exitCode=1;}
 if(preparation){const receipt=await preparation.stop('launcher-finally');if(!confirmed(receipt)){failure??=Error('Preparation stop unconfirmed');process.exitCode=1;}}
 // All demo payload removal is owned and fenced. Root/owner/leases are retained tombstones.
 const cleanup=disposable?await disposable.cleanup(lastStop):{storage:root,status:'persistent-storage-untouched',payloadRemoved:false,rootRemoved:false};
 if(demo&&!cleanup.payloadRemoved){
  const count=cleanup.payloadEntriesRemoved?.length??0;
  const message=count>0?`Disposable cleanup incomplete; ${count} payload entries removed; fences retained`
   :cleanup.retired?'Disposable storage retired, but payload removal incomplete; fences retained'
   :'Disposable cleanup not performed; storage retained';
  failure??=Error(message);process.exitCode=1;
 }
 // Safe interim behavior: runtime root is retained, never delete a stdout-derived parent path.
 console.log(JSON.stringify({event:'launcher-cleanup',cleanup,runtime:{root:runtimeRoot,identity:runtimeIdentity,status:'retained-owned-runtime-pending-cleanup-review'},backend:lastStop??null}));
 process.stdin.pause();process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);
 if(failure)console.error(failure.message);
}
