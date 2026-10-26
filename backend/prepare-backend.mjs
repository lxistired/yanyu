import {stripTypeScriptTypes} from 'node:module';
import {init,parse} from 'es-module-lexer';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,lstatSync,readdirSync} from 'node:fs';
import {resolve,dirname,join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
await init;
const here=import.meta.dirname, pins=JSON.parse(readFileSync(join(here,'SOURCE_PINS.json'))).files;
const admitted=['server/workspace-domain.ts','server/workspace-store.ts','server/request-authority.ts','server/sqlite.ts','server/database-path.ts','server/catalog-search-corpora.ts','shared/contracts.ts','shared/catalog-search.ts','server/organization-domain.ts','server/service-report-domain.ts','server/service-report-store.ts','server/service-report-month.ts','server/service-report-render.ts','shared/service-reports.ts','shared/reader-reference.ts','server/automation-domain.ts','server/manual-plan-domain.ts','shared/manual-plans.ts','shared/organization-command-outcome.ts','shared/automation-command-outcome.ts','shared/workspace-command-outcome.ts','shared/manual-inventory-protocol.ts','server/manual-inventory-domain.ts'];
assert.deepEqual(pins.map(p=>p.path),admitted);
const args=process.argv.slice(2);
if(args.length!==0&&(args.length!==3||args[0]!=='--owned-root'))throw Error('Invalid preparation arguments');
const externallyOwned=args.length!==0;
const temp=externallyOwned?resolve(args[1]):mkdtempSync(join(tmpdir(),'yanyu-integrated-runtime-'));
if(externallyOwned){const st=lstatSync(temp,{bigint:true});if(!st.isDirectory()||st.isSymbolicLink()||`${st.dev}:${st.ino}`!==args[2]||readdirSync(temp).length!==0)throw Error('Preparation root capability mismatch');}
const build=join(temp,'runtime'),frontier=[];
try{for(const pin of pins){
 const text=readFileSync(join(here,'source',pin.path),'utf8');assert.equal(createHash('sha256').update(text).digest('hex'),pin.sha256);
 const output=stripTypeScriptTypes(text,{mode:'transform'}),[imports]=parse(output),edges=[];
 for(const item of imports){assert.equal(item.d,-1);const spec=item.n;assert(spec);if(spec.startsWith('.')){const target=relative(here,resolve(here,dirname(pin.path),spec))+'.ts';assert(admitted.includes(target),`Blocked import ${target}`);}else assert(['node:sqlite','node:crypto','node:async_hooks','node:path','node:fs','node:util'].includes(spec),`Blocked external ${spec}`);edges.push(spec);}
 assert(!/\brequire\s*\(/.test(output));const dest=join(build,pin.path.replace(/\.ts$/,'.mjs'));mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,output.replace(/(from\s+['"])(\.[^'"]+)(['"])/g,'$1$2.mjs$3'));frontier.push({...pin,runtimeImports:edges});
}writeFileSync(join(here,'BACKEND_FRONTIER.json'),JSON.stringify(frontier,null,2));console.log(build);}catch(e){if(!externallyOwned)rmSync(temp,{recursive:true,force:true});throw e;}
