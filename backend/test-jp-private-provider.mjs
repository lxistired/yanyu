import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TABLES,ISSUERS,openProvider,privateDemoFromEnvironment,handlePrivateDemo} from './jp-private-provider.mjs';
const root=mkdtempSync(join(tmpdir(),'jp-synthetic-')),path=join(root,'synthetic.db');
const hash=()=>createHash('sha256').update(readFileSync(path)).digest('hex');
let provider;
try{
 const db=new DatabaseSync(path);
 for(const [table,columns]of Object.entries(TABLES)){
  db.exec(`CREATE TABLE ${table} (${columns.map(x=>`"${x}" TEXT`).join(',')})`);
  const insert=db.prepare(`INSERT INTO ${table} VALUES (${columns.map(()=>'?').join(',')})`);
  for(const issuer of ISSUERS)for(let i=0;i<3;i++)insert.run(...columns.map(c=>c==='ticker'?(i%2?issuer.nativeTicker.toUpperCase():issuer.nativeTicker):c==='type'?(i%2?'consensus':'actual'):c==='company'?issuer.name:`synthetic-${c}-${i}`));
 }
 db.exec('CREATE TABLE transcript (ticker TEXT,full_verbatim TEXT);');db.close();
 const sha256=hash();provider=openProvider({path,sha256,expectedSha256:sha256,issuers:ISSUERS});
 assert.equal(privateDemoFromEnvironment({}),null);
 for(const env of [{JP_PRIVATE_DB_PATH:path},{JP_PRIVATE_DEMO:'yes'},{JP_PRIVATE_DEMO:'real-source-not-shipped',JP_PRIVATE_DB_PATH:path,JP_PRIVATE_DB_SHA256:sha256}])assert.throws(()=>privateDemoFromEnvironment(env));
 for(const env of [{JP_PRIVATE_DEMO:''},{JP_PRIVATE_DB_PATH:''},{JP_PRIVATE_DB_SHA256:''},{JP_PRIVATE_UNKNOWN:'not-approved'},{JP_PRIVATE_DEMO:'synthetic',JP_PRIVATE_DB_PATH:path,JP_PRIVATE_DB_SHA256:sha256}])assert.throws(()=>privateDemoFromEnvironment(env),/CONFIG_REJECTED/);
 assert.throws(()=>openProvider({path,sha256,issuers:ISSUERS}),/CONFIG_REJECTED/);
 assert.throws(()=>openProvider({path,sha256:'0'.repeat(64),expectedSha256:'0'.repeat(64),issuers:ISSUERS}),/SNAPSHOT_MISMATCH/);
 const snapshotId=provider.companies().snapshot.id;
 assert.equal(provider.companies().companies.length,5);
 for(const issuer of ISSUERS)for(const table of Object.keys(TABLES)){
  const first=provider.rows({issuer:issuer.id.toLowerCase(),table,snapshotId,limit:2});assert.equal(first.items.length,2);assert.equal(first.nextOffset,2);
  const last=provider.rows({issuer:issuer.name,table,snapshotId,limit:2,offset:2});assert.equal(last.items.length,1);assert.equal(last.nextOffset,null);
  assert(first.items.every(x=>x.values.ticker.toLowerCase()===issuer.nativeTicker.toLowerCase()));
  assert.notEqual(first.items[0].provenance.rowid,last.items[0].provenance.rowid);
  assert.equal(first.items[0].values[table==='timeseries'?'value':table==='consensus'?'eps_year_1':table==='quarterly_is'?'eps':table==='cashflow'?'fcf':'cash'],`synthetic-${table==='timeseries'?'value':table==='consensus'?'eps_year_1':table==='quarterly_is'?'eps':table==='cashflow'?'fcf':'cash'}-0`);
 }
 assert.equal(provider.rows({issuer:'sYnThEtIc 1',table:'timeseries',snapshotId}).items[1].recordKind,'consensus-estimate');
 for(const patch of [{issuer:'unknown'},{table:'transcript'},{table:'summary'},{table:'timeseries;DELETE FROM timeseries'},{snapshotId:'old'},{limit:101},{limit:0},{offset:-1},{offset:1.5}])assert.throws(()=>provider.rows({issuer:'syn001',table:'timeseries',snapshotId,...patch}));
 const audits=[];
 async function request(url,method='GET',active=provider){let result;await handlePrivateDemo(active,{url,method,headers:{}},(status,body)=>result={status,body},(status,code,message)=>result={status,body:{code,message}},x=>audits.push(x));return result;}
 assert.equal((await request('/api/private-demo/companies')).status,200);
 assert.equal((await request('/api/private-demo/schema')).status,200);
 assert.equal((await request('/api/private-demo/companies','GET',null)).status,404);
 for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await request('/api/private-demo/rows',method)).status,405);
 for(const suffix of ['&sql=select+1','&path=/tmp/db','&fields=body','&limit=1&limit=2','&offset=1e2'])assert.equal((await request('/api/private-demo/rows?issuer=syn001&table=timeseries&snapshotId='+encodeURIComponent(snapshotId)+suffix)).status,400);
 for(const target of ['transcript','download','summary','body','full_md','full_verbatim','sellside_report'])assert.equal((await request('/api/private-demo/'+target)).status,404);
 assert.equal(JSON.stringify(audits).includes('synthetic-'),false);assert.equal(JSON.stringify(audits).includes(path),false);
 assert.throws(()=>openProvider({path:join(root,'missing-sensitive-name.db'),sha256,expectedSha256:sha256,issuers:ISSUERS}),e=>e.message==='PROVIDER_UNAVAILABLE');
 assert.equal(hash(),sha256);provider.close();provider=null;
 const ro=new DatabaseSync('file:'+path+'?mode=ro&immutable=1',{readOnly:true});ro.exec('pragma trusted_schema=off;pragma query_only=on');assert.throws(()=>ro.exec('DELETE FROM timeseries'));ro.close();
 const changed=new DatabaseSync(path);changed.exec('ALTER TABLE timeseries ADD COLUMN body TEXT');changed.close();const changedHash=hash();
 assert.throws(()=>openProvider({path,sha256:changedHash,expectedSha256:changedHash,issuers:ISSUERS}),/SCHEMA_MISMATCH/);
 console.log('PASS: synthetic schema, casing, five issuer partitions, raw text, pagination, provenance, pins/hash, denylist, read-only and privacy checks');
}finally{provider?.close();rmSync(root,{recursive:true,force:true});}
