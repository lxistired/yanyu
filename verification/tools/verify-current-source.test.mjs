import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verify, validateManifest, validPath } from './verify-current-source.mjs';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function fixture(t, body = 'hello') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a.txt'), body);
  const m = { files: [{ path: 'a.txt', sha256: sha(body), size: Buffer.byteLength(body) }] };
  const save = () => fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(m)); save();
  return { root, m, save, run: options => verify({ root, manifest: 'manifest.json', ...options }) };
}
test('matches listed pins without claiming complete inventory', t => { const f = fixture(t);fs.writeFileSync(path.join(f.root, 'unlisted.txt'), 'ignored');const r=f.run();assert.equal(r.ok,true);assert.equal(r.matched.length,1);assert.match(r.claim,/not full-tree inventory/); });
test('separates missing and hash changes', t => { const f=fixture(t);f.m.files.push({path:'missing.txt',sha256:sha('x')});f.save();fs.writeFileSync(path.join(f.root,'a.txt'),'changed');const r=f.run();assert.equal(r.ok,false);assert.equal(r.missing.length,1);assert.equal(r.changed.length,1); });
test('enforces optional size', t => {const f=fixture(t);f.m.files[0].size=0;f.save();assert.equal(f.run().changed.length,1);});
for (const p of ['../outside','/etc/passwd','a/../b','a/./b','a//b','a/','C:/x','a\\b','a\0b','.env','.env.local','.git/config','.codex/sessions/x']) test(`rejects path ${JSON.stringify(p)}`,()=>assert.throws(()=>validPath(p)));
test('rejects malformed shape/hash/size',()=>{for(const m of [null,[],{}, {files:[]},{files:[null]}, {files:[{path:'a',sha256:'f'.repeat(63)}]},{files:[{path:'a',sha256:'F'.repeat(64)}]},{files:[{path:'a',sha256:sha(''),size:-1}]},{files:[{path:'a',sha256:sha(''),size:1.5}]}])assert.throws(()=>validateManifest(m));});
test('rejects duplicate pins within/across domains',t=>{const f=fixture(t);f.m.files.push({...f.m.files[0]});assert.throws(()=>validateManifest(f.m));f.m.files.pop();f.m.build=[{...f.m.files[0]}];assert.throws(()=>validateManifest(f.m));});
test('annotations may overlap but must agree and not duplicate', t=>{const f=fixture(t);f.m.delta=[{...f.m.files[0],status:'added'}];assert.doesNotThrow(()=>validateManifest(f.m));f.m.delta[0].sha256=sha('no');assert.throws(()=>validateManifest(f.m));f.m.delta=[{...f.m.files[0]},{...f.m.files[0]}];assert.throws(()=>validateManifest(f.m));});
test('build/evidence are separately selected, not silently treated as source',t=>{const f=fixture(t);f.m.build=[{path:'dist.js',sha256:sha('build')}];f.m.evidence=[{path:'test.log',sha256:sha('log')}];f.save();assert.equal(f.run().ok,true);const r=f.run({domains:['files','build','evidence']});assert.equal(r.missing.length,2);assert.deepEqual(r.inventoryCounts,{files:1,build:1,evidence:1});});
test('rejects leaf symlink without reading target',t=>{const f=fixture(t);fs.unlinkSync(path.join(f.root,'a.txt'));fs.symlinkSync('/no-read-outside-root',path.join(f.root,'a.txt'));assert.equal(f.run().unsafe.length,1);});
test('rejects ancestor symlink without reading target',t=>{const f=fixture(t);f.m.files=[{path:'link/secret',sha256:sha('x')}];f.save();fs.symlinkSync('/no-read-outside-root',path.join(f.root,'link'));assert.equal(f.run().unsafe.length,1);});
test('rejects manifest symlink',t=>{const f=fixture(t);fs.unlinkSync(path.join(f.root,'manifest.json'));fs.symlinkSync('/no-read-outside-root',path.join(f.root,'manifest.json'));assert.throws(()=>f.run(),/Symlink/);});
test('rejects nonregular leaf',t=>{const f=fixture(t);fs.unlinkSync(path.join(f.root,'a.txt'));fs.mkdirSync(path.join(f.root,'a.txt'));assert.equal(f.run().unsafe.length,1);});
test('detects in-place change during read',t=>{const f=fixture(t);const r=f.run({afterRead:p=>fs.writeFileSync(p,'HELLO')});assert.equal(r.changed.length,1);assert.equal(r.matched.length,0);});
test('detects same-content inode replacement during read',t=>{const f=fixture(t);const r=f.run({afterRead:p=>{fs.renameSync(p,p+'.old');fs.writeFileSync(p,'hello');}});assert.equal(r.changed.length,1);});
test('final recheck catches previously matched file changed by later read',t=>{const f=fixture(t);fs.writeFileSync(path.join(f.root,'b.txt'),'b');f.m.files.push({path:'b.txt',sha256:sha('b')});f.save();const r=f.run({afterRead:p=>{if(p.endsWith('b.txt'))fs.writeFileSync(path.join(f.root,'a.txt'),'HELLO');}});assert.equal(r.changed.length,1);assert.deepEqual(r.matched,['b.txt']);});
test('manifest mutation invalidates result',t=>{const f=fixture(t);const r=f.run({afterRead:()=>fs.appendFileSync(path.join(f.root,'manifest.json'),' ')});assert.equal(r.ok,false);assert.equal(r.changed[0].path,'manifest.json');});
test('bounded oversized file rejects without reading contents',t=>{const f=fixture(t);fs.truncateSync(path.join(f.root,'a.txt'),64*1024*1024+1);assert.equal(f.run().unsafe.length,1);});
test('rejects invalid options',t=>{const f=fixture(t);for(const options of [{root:'.'},{manifest:'../x'},{domains:['bogus']},{domains:[]},{domains:['files','files']},{domains:['build']}])assert.throws(()=>f.run(options));});
test('CLI returns 0 success, 1 mismatch, 2 invalid invocation',t=>{const f=fixture(t);const cli=new URL('./verify-current-source.mjs',import.meta.url).pathname;const args=[cli,'--root',f.root,'--manifest','manifest.json'];assert.equal(spawnSync(process.execPath,args).status,0);fs.writeFileSync(path.join(f.root,'a.txt'),'bad');assert.equal(spawnSync(process.execPath,args).status,1);assert.equal(spawnSync(process.execPath,[cli,'--unknown','x']).status,2);});

test('strict total budget bounds partial reads and skips all remaining pins',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'b.txt'),'world');
  f.m.files.push({path:'b.txt',sha256:sha('world')},{path:'unread-missing.txt',sha256:sha('!')});f.save();
  const cap=fs.statSync(path.join(f.root,'manifest.json')).size+7;
  const visited=[];const r=f.run({byteBudget:cap,afterRead:p=>visited.push(path.basename(p))});
  assert.equal(r.bytesRead,cap);assert.equal(r.ok,false);assert.deepEqual(r.matched,['a.txt']);
  assert.deepEqual(r.budgetSkipped.map(x=>x.path),['b.txt','unread-missing.txt']);
  assert.deepEqual(visited,['a.txt']);assert.equal(r.missing.length,0);assert.equal(r.changed.length,0);assert.equal(r.unsafe.length,0);assert.equal(r.errors.length,0);
});
test('exact total-budget completion succeeds without extra EOF content read',t=>{
  const f=fixture(t);const cap=fs.statSync(path.join(f.root,'manifest.json')).size+5;
  const r=f.run({byteBudget:cap});assert.equal(r.ok,true);assert.equal(r.bytesRead,cap);assert.equal(r.budgetSkipped.length,0);
});
test('budget exhausted by manifest reports each pin inconclusive, not missing',t=>{
  const f=fixture(t);fs.unlinkSync(path.join(f.root,'a.txt'));const cap=fs.statSync(path.join(f.root,'manifest.json')).size;
  const r=f.run({byteBudget:cap});assert.equal(r.ok,false);assert.equal(r.bytesRead,cap);assert.equal(r.budgetSkipped.length,1);assert.equal(r.missing.length,0);
});
test('test-only API budget cannot weaken ceiling or accept invalid limits',t=>{
  const f=fixture(t);for(const byteBudget of [0,-1,1.5,NaN,Infinity,512*1024*1024+1])assert.throws(()=>f.run({byteBudget}));
});
