import {constants,openSync,closeSync,fstatSync,statfsSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
// Linux local filesystems only. Unknown/network filesystems fail closed.
const localTypes=new Set([0xef53,0x58465342,0x9123683e,0x01021994,0x794c7630]);
export function acquireFence(path,{busyOkay=false,timeoutMs=5000,expectedIdentity}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw Error('Invalid fence timeout');
 if(expectedIdentity!==undefined&&(typeof expectedIdentity!=='string'||!/^\d+:\d+$/.test(expectedIdentity)))throw Error('Invalid fence identity');
 if(process.platform!=='linux'||!localTypes.has(Number(statfsSync(path.substring(0,path.lastIndexOf('/'))).type)))throw Error('Local transcription requires supported Linux local storage');
 let fd;
 try{
  fd=openSync(path,(expectedIdentity===undefined?constants.O_CREAT:0)|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
  const st=fstatSync(fd,{bigint:true});if(!st.isFile()||st.nlink!==1n)throw Error('Invalid fence');
  if(expectedIdentity!==undefined&&`${st.dev}:${st.ino}`!==expectedIdentity)throw Error('Fence identity changed');
  const result=spawnSync('/usr/bin/flock',['-n','3'],{stdio:['ignore','ignore','pipe',fd],timeout:timeoutMs});
  if(result.error||result.signal||result.status!==0){if(busyOkay&&!result.error&&!result.signal&&result.status===1){closeSync(fd);return null}throw Error('Fence unavailable')}
  if(!/lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE/.test(readFileSync(`/proc/self/fdinfo/${fd}`,'utf8')))throw Error('Fence not retained');
  let disposed=false;
  return {fd,identity:`${st.dev}:${st.ino}`,close(){if(!disposed){disposed=true;closeSync(fd)}}};
 }catch(error){if(fd!==undefined)try{closeSync(fd)}catch{}throw Error('Local transcription storage already owned or unavailable',{cause:error})}
}
// Each probe is kernel exclusion evidence, not an elapsed-time or PID assertion.
export async function awaitFenceRelease(path){
 for(;;){const guard=acquireFence(path,{busyOkay:true});if(guard){guard.close();return}await new Promise(resolve=>setTimeout(resolve,25))}
}
