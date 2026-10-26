// Test-only generator. No native source data or application startup bypass.
// Copy into backend/ beside jp-private-provider.mjs in a test candidate.
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TABLES,ISSUERS as syntheticIdentities,openProvider} from './jp-private-provider.mjs';
const ISSUERS=syntheticIdentities.map((x,i)=>({...x,name:`Synthetic Company ${i+1}`,aliases:[]}));
export function createSyntheticJpFixture({rowsPerIssuer=53}={}){
 if(!Number.isSafeInteger(rowsPerIssuer)||rowsPerIssuer<1||rowsPerIssuer>1000)throw Error('Fixture row bound');
 const directory=mkdtempSync(join(tmpdir(),'jp-synthetic-only-')),path=join(directory,'synthetic.db');
 let db,provider;
 try{
  db=new DatabaseSync(path);
  for(const [table,columns] of Object.entries(TABLES)){
   db.exec(`CREATE TABLE ${table} (${columns.map(x=>`"${x}" TEXT`).join(',')})`);
   const insert=db.prepare(`INSERT INTO ${table} VALUES (${columns.map(()=>'?').join(',')})`);
   for(const issuer of ISSUERS)for(let i=0;i<rowsPerIssuer;i++)insert.run(...columns.map(column=>column==='ticker'?(i%2?issuer.nativeTicker.toUpperCase():issuer.nativeTicker):column==='company'?issuer.name:column==='type'?(i%2?'consensus':'actual'):column==='ending_date'?null:column==='value'?'001.200 million JPY':`synthetic-${column}-${i}`));
  }
  db.close();db=null;
  const sha256=createHash('sha256').update(readFileSync(path)).digest('hex');
  provider=openProvider({path,sha256,expectedSha256:sha256,issuers:ISSUERS});
  return {provider,dispose(){provider.close();rmSync(directory,{recursive:true,force:true});}};
 }catch(error){db?.close();provider?.close();rmSync(directory,{recursive:true,force:true});throw error;}
}
