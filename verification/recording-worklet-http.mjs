// Synthetic loopback HTTP only. No browser, microphone, playback, ASR or uploads.
import assert from 'node:assert/strict';
import {fork,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const base=join(import.meta.dirname,'..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const assets=readdirSync(join(base,'dist/assets')).filter(name=>/^pcm-capture-worklet-.*\.js$/.test(name));
assert.equal(assets.length,1);
const asset=readFileSync(join(base,'dist/assets',assets[0]));
assert.equal(hash(asset),hash(readFileSync(join(base,'candidate/src/recording/pcm-capture-worklet.js'))));
const prep=spawnSync(process.execPath,[join(base,'backend/prepare-backend.mjs')],{encoding:'utf8'});assert.equal(prep.status,0,prep.stderr);
const build=prep.stdout.trim(),data=mkdtempSync(join(tmpdir(),'yanyu-recording-static-'));
let child;
try {
 let stderr='';const origin=await new Promise((resolve,reject)=>{
  child=fork(join(base,'backend/server.mjs'),[build,data,join(data,'synthetic-events.jsonl'),'0'],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH}});
  child.stdout.resume();child.stderr.on('data',chunk=>stderr+=chunk);
  const timer=setTimeout(()=>reject(Error('readiness timeout '+stderr)),15000);
  child.once('message',message=>{clearTimeout(timer);resolve(message.origin);});
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',code=>{clearTimeout(timer);reject(Error('early exit '+code+' '+stderr));});
 });
 assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
 const response=await fetch(origin+'/assets/'+assets[0],{signal:AbortSignal.timeout(10000)});
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/javascript/);
 assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(asset));
 console.log(JSON.stringify({status:'passed',scope:'synthetic production-server loopback static GET only',asset:assets[0],sha256:hash(asset),contentType:response.headers.get('content-type'),noBrowserOrMedia:true}));
} finally {
 if(child&&child.exitCode===null)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('shutdown timeout'));},15000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});
 rmSync(data,{recursive:true,force:true});rmSync(join(build,'..'),{recursive:true,force:true});
}
