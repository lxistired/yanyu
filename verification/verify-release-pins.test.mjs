import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {verifyReleasePins} from '../verify-release-pins.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
function fixture(fn){const root=mkdtempSync(join(tmpdir(),'yanyu-pin-test-'));try{const row={path:'source.txt',domain:'source',bytes:3,sha256:sha('abc')};writeFileSync(join(root,'source.txt'),'abc');const write=(rows=[row])=>writeFileSync(join(root,'RELEASE_DRAFT_MANIFEST.json'),JSON.stringify({schema:'yanyu-release-draft-v1',files:rows}));write();fn({root,row,write});}finally{rmSync(root,{recursive:true,force:true})}}
test('exact fresh draft verifies without publication claim',()=>fixture(({root})=>{const x=verifyReleasePins(root,undefined,{strict:true});assert.equal(x.files,1);assert.equal(x.publicationApproved,false)}));
test('changed bytes fail',()=>fixture(({root})=>{writeFileSync(join(root,'source.txt'),'abd');assert.throws(()=>verifyReleasePins(root),/Pin mismatch/)}));
test('missing file fails',()=>fixture(({root})=>{rmSync(join(root,'source.txt'));assert.throws(()=>verifyReleasePins(root))}));
test('duplicate pin fails',()=>fixture(({root,row,write})=>{write([row,row]);assert.throws(()=>verifyReleasePins(root),/duplicate/)}));
test('traversal and absolute paths fail',()=>fixture(({root,row,write})=>{for(const path of ['../source.txt','/tmp/source.txt','a//b','a\\b']){write([{...row,path}]);assert.throws(()=>verifyReleasePins(root),/Unsafe/)} }));
test('symlink file and ancestor fail',()=>fixture(({root,row,write})=>{symlinkSync('source.txt',join(root,'alias'));write([{...row,path:'alias'}]);assert.throws(()=>verifyReleasePins(root),/Symlink/);mkdirSync(join(root,'dir'));writeFileSync(join(root,'dir','source.txt'),'abc');symlinkSync('dir',join(root,'linked'));write([{...row,path:'linked/source.txt'}]);assert.throws(()=>verifyReleasePins(root),/Symlink/)}));
test('strict mode rejects any unlisted file',()=>fixture(({root})=>{writeFileSync(join(root,'extra.txt'),'unexpected');assert.throws(()=>verifyReleasePins(root,undefined,{strict:true}),/Unlisted/)}));
test('invalid digest, size and domain fail',()=>fixture(({root,row,write})=>{for(const patch of [{sha256:'bad'},{bytes:-1},{domain:'historical'}]){write([{...row,...patch}]);assert.throws(()=>verifyReleasePins(root),/metadata/)} }));
