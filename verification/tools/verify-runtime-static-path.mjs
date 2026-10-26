// Static-path proof only: no server imports, service startup, HTTP, ASR or media.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'../..');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const server=fs.readFileSync(path.join(root,'backend/server.mjs'),'utf8');
const launch=fs.readFileSync(path.join(root,'backend/launch.mjs'),'utf8');
assert(launch.includes("existsSync(join(here,'../dist/index.html'))"));
const begin=server.indexOf("const dist=join(import.meta.dirname,'../dist'),assets=new Map();");
const end=server.indexOf('try{collect(dist);assets.set(\'/\',assets.get(\'/index.html\'))}',begin);
assert(begin>=0&&end>begin);
assert(server.includes("if(req.method==='GET'&&assets.has(pathname)){const asset=assets.get(pathname);"));
assert(server.includes('return res.end(asset.body)'));
// Execute only the exact server's static path/mime/collector declarations, not backend initialization.
const declarations=server.slice(begin,end).replace('import.meta.dirname',JSON.stringify(path.join(root,'backend')));
const assets=vm.runInNewContext(declarations+"\ncollect(dist);assets.set('/',assets.get('/index.html'));assets;",{
 join:path.join,extname:path.extname,readdirSync:fs.readdirSync,lstatSync:fs.lstatSync,readFileSync:fs.readFileSync,
},{timeout:1000});
const html=assets.get('/');assert(html);assert.equal(hash(html.body),hash(fs.readFileSync(path.join(root,'dist/index.html'))));
const references=[...html.body.toString().matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(m=>m[1]);
assert(references.some(p=>p.endsWith('.js'))&&references.some(p=>p.endsWith('.css')));
for(const p of references)assert(assets.has(p),'Unserved HTML asset: '+p);
const listed=[...assets.entries()].filter(([url])=>url!=='/').map(([url,entry])=>({url,path:'dist'+url,size:entry.body.length,sha256:hash(entry.body),mime:entry.type})).sort((a,b)=>a.path.localeCompare(b.path));
assert.equal(listed.length,4);
console.log(JSON.stringify({ok:true,scope:'Exact unchanged server static collector executed independently; static-path proof only, no HTTP/server/service/browser/ASR execution',serverSha256:hash(server),launchSha256:hash(launch),servedRoot:'dist',rootAliasesIndex:true,htmlReferences:references,assets:listed,notClaimed:['HTTP acceptance','backend startup','functional UI acceptance','actual ASR','browser/device acceptance']},null,2));
