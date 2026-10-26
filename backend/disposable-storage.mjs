import { mkdtempSync, lstatSync, readdirSync, rmSync, writeFileSync, readFileSync, statSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireFence } from './worker-fence.mjs';
const identity = st => `${st.dev}:${st.ino}`;
export const retiredMarker = '.disposable-retired.json';
const inspect = path => { const st=lstatSync(path,{bigint:true});if(st.isSymbolicLink())throw Error('Symlink ownership rejected');return st; };

// Called only after the shared owner lock is acquired. Even a pre-existing waiter
// sees the same retained inode and then this marker before opening any data store.
export function assertStorageNotRetired(root,owner){
 const marker=join(root,retiredMarker);let before;
 try{before=lstatSync(marker,{bigint:true})}catch(error){if(error.code==='ENOENT')return;throw error;}
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>4096n)throw Error('Invalid disposable retirement marker');
 let record,fd;
 try{
  fd=openSync(marker,constants.O_RDONLY|constants.O_NOFOLLOW);
  const opened=fstatSync(fd,{bigint:true});
  if(!opened.isFile()||opened.nlink!==1n||identity(opened)!==identity(before)||opened.size>4096n)throw Error('Retirement marker changed');
  record=JSON.parse(readFileSync(fd,'utf8'));
 }catch{throw Error('Invalid disposable retirement marker');}
 finally{if(fd!==undefined)closeSync(fd);}
 const st=statSync(root,{bigint:true});
 if(record.version!==1||record.state!=='retired-disposable'||record.rootIdentity!==identity(st)||record.ownerIdentity!==owner.identity)throw Error('Disposable retirement identity mismatch');
 throw Error('Disposable storage has been retired');
}

// Only this function can mint a cleanup capability. No caller-supplied storage path.
export function createDisposableStorage() {
 const root=mkdtempSync(join(tmpdir(),'yanyu-demo-'));
 const rootId=identity(inspect(root)); let ownerId, finished;
 const ownerPath=join(root,'local-transcription-owner.lock');
 const sameRoot=()=>{const st=inspect(root);if(!st.isDirectory()||identity(st)!==rootId)throw Error('Storage identity changed');};
 function pinFence(){sameRoot();const st=inspect(ownerPath);if(!st.isFile()||st.nlink!==1n)throw Error('Invalid owner fence');const next=identity(st);if(ownerId&&ownerId!==next)throw Error('Owner fence changed');ownerId=next;}
 async function cleanup(receipt,{timeoutMs=1000}={}) {
  if(finished)return finished;
  finished=(async()=>{
   const result={storage:root,payloadRemoved:false,rootRemoved:false,fencesRetained:true,retired:false,payloadEntriesRemoved:[],status:'retained-unconfirmed',reason:null};
   const held=[];
   try{
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw Error('Invalid cleanup budget');
    if(!receipt?.directExitConfirmed||receipt.group!=='absent'||!ownerId)throw Error('Lifecycle or pinned-fence evidence missing');
    const deadline=performance.now()+timeoutMs;
    sameRoot();
    const take=async(path,expected)=>{
     while(performance.now()<deadline){
      const remaining=Math.max(1,Math.min(5000,Math.floor(deadline-performance.now())));
      const guard=acquireFence(path,{busyOkay:true,expectedIdentity:expected,timeoutMs:remaining});
      if(guard){held.push(guard);if(performance.now()>=deadline)throw Error('Fence acquisition overdue');return;}
      await new Promise(resolve=>setTimeout(resolve,Math.min(10,Math.max(1,deadline-performance.now()))));
     }
     throw Error('Writer fence busy or deadline expired');
    };
    await take(ownerPath,ownerId);
    const leaseDir=join(root,'local-transcription-leases'),leaseSt=inspect(leaseDir);
    if(!leaseSt.isDirectory())throw Error('Invalid lease directory');
    for(const name of readdirSync(leaseDir)){
     if(!/^[a-f0-9-]+\.lock$/.test(name))throw Error('Unknown lease entry');
     const path=join(leaseDir,name),st=inspect(path);if(!st.isFile()||st.nlink!==1n)throw Error('Invalid lease entry');
     await take(path,identity(st));
    }
    sameRoot();pinFence();
    const payload=readdirSync(root).filter(name=>!['local-transcription-owner.lock','local-transcription-leases',retiredMarker].includes(name));
    // Preflight all top-level payload entries before any mutation; never follow symlinks.
    for(const name of payload)inspect(join(root,name));
    // Stable owner/lease inodes and root remain forever. A waiter acquiring the old
    // inode after release checks this marker while holding the same owner lock.
    writeFileSync(join(root,retiredMarker),JSON.stringify({version:1,state:'retired-disposable',rootIdentity:rootId,ownerIdentity:ownerId})+'\n',{flag:'wx',mode:0o600});
    result.retired=true;result.status='retired-payload-retained';
    for(const name of payload){rmSync(join(root,name),{recursive:true,force:false});result.payloadEntriesRemoved.push(name);result.status='partial-payload-removal-fences-retained';}
    result.payloadRemoved=true;result.status='payload-removed-fences-retained';
   }catch(error){result.reason=error.message;}
   finally{for(const guard of held.reverse())guard.close();}
   return result;
  })();
  return finished;
 }
 return {root,rootIdentity:rootId,pinFence,cleanup};
}
