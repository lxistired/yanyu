import {readFileSync,readdirSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,dirname,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

// Identity only. A matching draft manifest does not confer publication approval,
// an application license, provenance authenticity or functional acceptance.
export function verifyReleasePins(root,manifestName='RELEASE_DRAFT_MANIFEST.json',{strict=false}={}) {
  root=realpathSync(root);
  const manifestPath=resolve(root,manifestName);
  const inside=p=>p!==root&&!isAbsolute(relative(root,p))&&!relative(root,p).split(sep).includes('..');
  if(!inside(manifestPath)||lstatSync(manifestPath).isSymbolicLink())throw Error('Unsafe manifest path');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  if(manifest.schema!=='yanyu-release-draft-v1'||!Array.isArray(manifest.files))throw Error('Unsupported draft manifest');
  const seen=new Set();let bytes=0;
  for(const row of manifest.files) {
    if(!row||typeof row.path!=='string'||!row.path||row.path.includes('\\')||row.path.split('/').some(x=>!x||x==='.'||x==='..')||isAbsolute(row.path)||seen.has(row.path)||row.path===manifestName)throw Error('Unsafe or duplicate pinned path');
    if(!['source','build','evidence'].includes(row.domain)||!Number.isSafeInteger(row.bytes)||row.bytes<0||!/^[a-f0-9]{64}$/.test(row.sha256))throw Error('Invalid pin metadata');
    let current=root;
    for(const part of row.path.split('/')) {current=resolve(current,part);if(lstatSync(current).isSymbolicLink())throw Error('Symlink in pinned path');}
    if(!inside(current)||!lstatSync(current).isFile())throw Error('Pinned path is not a contained regular file');
    const data=readFileSync(current);
    if(data.length!==row.bytes||createHash('sha256').update(data).digest('hex')!==row.sha256)throw Error('Pin mismatch: '+row.path);
    seen.add(row.path);bytes+=data.length;
  }
  if(strict) {
    const walk=dir=>{for(const entry of readdirSync(dir,{withFileTypes:true})){
      const path=resolve(dir,entry.name),name=relative(root,path).split(sep).join('/');
      if(entry.isSymbolicLink())throw Error('Unlisted symlink: '+name);
      if(entry.isDirectory())walk(path);
      else if(!entry.isFile()||name!==manifestName&&!seen.has(name))throw Error('Unlisted staging entry: '+name);
    }};
    walk(root);
  }
  return {status:'identity-matches-only',draft:true,files:seen.size,bytes,strict,publicationApproved:false};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2);
    if(args.some(x=>x!=='--strict'))throw Error('Usage: node verify-release-pins.mjs [--strict]');
    console.log(JSON.stringify(verifyReleasePins(dirname(fileURLToPath(import.meta.url)),undefined,{strict:args.includes('--strict')})));
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
