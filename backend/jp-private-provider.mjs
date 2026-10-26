import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

// No native/private snapshot identity is distributed in this public candidate.
export const TABLES=Object.freeze({
 balancesheet:['ticker','company','fy_label','period_end','freq','total_assets','total_liab','total_equity','cash','debt','net_cash','inventory','receivables','net_ppe'],
 cashflow:['ticker','company','fy_label','period_end','freq','ocf','capex','fcf','cfi','cff','dep_amor','dividends'],
 consensus:['company','ticker','currency','n_analysts','close_snapshot','pe','rev_year_1','rev_year_2','rev_yoy_year_1','rev_yoy_year_2','eps_year_1','eps_year_2','foot_flag'],
 quarterly_is:['ticker','company','fy_label','period_end','freq','revenue','op','op_margin','net_income','eps','source','foot_flag'],
 timeseries:['ticker','company','freq','period','ending_date','type','metric','value']
});
export const NOTICE='Synthetic/local read-only adapter contract. No real private dataset is distributed or configurable by environment in this public build. Actuals and estimates remain distinct; no current or verified financial values.';
const error=(code)=>Object.assign(Error(code),{code});
const q=s=>'"'+s+'"';
export function openProvider({path,sha256,issuers,expectedSha256=undefined}){
 let db;try{
  if(!path||!sha256||sha256!==expectedSha256||!/^[a-f0-9]{64}$/.test(sha256))throw error('CONFIG_REJECTED');
  const resolved=realpathSync(path);if(!statSync(resolved).isFile())throw error('CONFIG_REJECTED');
  if(createHash('sha256').update(readFileSync(resolved)).digest('hex')!==sha256)throw error('SNAPSHOT_MISMATCH');
  const uri=pathToFileURL(resolved);uri.search='mode=ro&immutable=1';
  db=new DatabaseSync(uri.href,{readOnly:true,allowExtension:false});
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
  for(const [table,columns] of Object.entries(TABLES)){
   if(db.prepare("SELECT type FROM sqlite_schema WHERE name=?").get(table)?.type!=='table')throw error('SCHEMA_MISMATCH');
   const schema=db.prepare(`PRAGMA table_info(${q(table)})`).all();
   if(JSON.stringify(schema.map(x=>[x.name,x.type]))!==JSON.stringify(columns.map(x=>[x,'TEXT'])))throw error('SCHEMA_MISMATCH');
  }
  const definitions=issuers.map(x=>Object.freeze({...x}));
  const lookup=new Map(definitions.flatMap(x=>[x.id,x.nativeTicker,x.name,...(x.aliases||[])].map(k=>[k.toLowerCase(),x])));
  const resolveIssuer=id=>{if(typeof id!=='string'||id.length>100||!lookup.has(id.toLowerCase()))throw error('UNKNOWN_ISSUER');return lookup.get(id.toLowerCase());};
  const snapshot={id:`sha256:${sha256}`,classification:'historical-private-snapshot',notice:NOTICE};
  const coverage=definitions.map(issuer=>({id:issuer.id,name:issuer.name,canonicalTicker:issuer.canonicalTicker,tables:Object.fromEntries(Object.keys(TABLES).map(table=>[table,db.prepare(`SELECT count(*) AS count FROM ${q(table)} WHERE ticker = ? COLLATE NOCASE`).get(issuer.nativeTicker).count]))}));
  const rows=({issuer,table,offset=0,limit=50,snapshotId})=>{
   if(snapshotId!==snapshot.id)throw error('PIN_MISMATCH');
   if(!Object.hasOwn(TABLES,table))throw error('TABLE_REJECTED');
   const company=resolveIssuer(issuer);
   if(!Number.isSafeInteger(offset)||offset<0||offset>10000000||!Number.isSafeInteger(limit)||limit<1||limit>100)throw error('PAGINATION_REJECTED');
   const columns=TABLES[table];
   const found=db.prepare(`SELECT rowid AS _rowid,${columns.map(q).join(',')} FROM ${q(table)} WHERE ticker = ? COLLATE NOCASE ORDER BY rowid LIMIT ? OFFSET ?`).all(company.nativeTicker,limit+1,offset);
   const more=found.length>limit;
   return {snapshot,issuer:company.id,table,offset,limit,nextOffset:more?offset+limit:null,items:found.slice(0,limit).map(({_rowid,...values})=>({values,provenance:{snapshot:snapshot.id,table,rowid:_rowid},recordKind:table==='consensus'?'consensus-estimate':table==='timeseries'?(values.type==='actual'?'actual':values.type==='consensus'?'consensus-estimate':'unclassified-source-type'):'reported-financials'}))};
  };
  return {companies:()=>({snapshot,companies:coverage}),schema:()=>({snapshot,tables:Object.entries(TABLES).map(([name,columns])=>({name,columns:columns.map(name=>({name,type:'TEXT'})),recordKind:name==='consensus'?'consensus-estimate':name==='timeseries'?'source-type-preserved':'reported-financials'}))}),rows,close:()=>db.close()};
 }catch(e){db?.close();throw error(['CONFIG_REJECTED','SNAPSHOT_MISMATCH','SCHEMA_MISMATCH'].includes(e.code)?e.code:'PROVIDER_UNAVAILABLE');}
}

export function privateDemoFromEnvironment(env=process.env){
 // Public distribution has no approved native source. Unknown, partial, empty
 // and complete private-provider environment configurations all fail closed.
 if(!Object.keys(env).some(key=>key.startsWith('JP_PRIVATE_')))return null;
 throw error('CONFIG_REJECTED');
}

export async function handlePrivateDemo(provider,req,send,fail,audit=()=>{}){
 if(!req.url.startsWith('/api/private-demo'))return false;
 const reject=(status,code)=>{audit({module:'private-demo',status,code});fail(status,code,'Private demo request rejected');return true;};
 if(!provider)return reject(404,'NOT_FOUND');
 if(req.method!=='GET')return reject(405,'READ_ONLY');
 if(req.headers['content-length']&&req.headers['content-length']!=='0'||req.headers['transfer-encoding'])return reject(400,'INVALID_REQUEST');
 try{
  const url=new URL(req.url,'http://127.0.0.1');let result;
  const accepted=(keys)=>{for(const key of url.searchParams.keys())if(!keys.includes(key)||url.searchParams.getAll(key).length!==1)throw error('INVALID_REQUEST');};
  if(url.pathname==='/api/private-demo/companies'){accepted([]);result=provider.companies();}
  else if(url.pathname==='/api/private-demo/schema'){accepted([]);result=provider.schema();}
  else if(url.pathname==='/api/private-demo/rows'){
   accepted(['issuer','table','offset','limit','snapshotId']);
   const number=(key,fallback)=>{const v=url.searchParams.get(key);if(v===null)return fallback;if(!/^(0|[1-9][0-9]*)$/.test(v))throw error('PAGINATION_REJECTED');return Number(v)};
   result=provider.rows({issuer:url.searchParams.get('issuer'),table:url.searchParams.get('table'),snapshotId:url.searchParams.get('snapshotId'),offset:number('offset',0),limit:number('limit',50)});
  }else return reject(404,'NOT_FOUND');
  audit({module:'private-demo',operation:url.pathname.split('/').at(-1),status:200,count:result.items?.length});send(200,result);return true;
 }catch{return reject(400,'INVALID_REQUEST');}
}
// Entirely fictional identities for in-memory/disposable synthetic tests only.
// Preserve five-issuer partitioning without shipping any private source mapping.
export const ISSUERS=Object.freeze([
 {id:'jp-SYN001',canonicalTicker:'SYN001',nativeTicker:'syn001',name:'Synthetic Company 1',aliases:['Synthetic 1']},
 {id:'jp-SYN002',canonicalTicker:'SYN002',nativeTicker:'syn002',name:'Synthetic Company 2',aliases:['Synthetic 2']},
 {id:'jp-SYN003',canonicalTicker:'SYN003',nativeTicker:'syn003',name:'Synthetic Company 3',aliases:['Synthetic 3']},
 {id:'jp-SYN004',canonicalTicker:'SYN004',nativeTicker:'syn004',name:'Synthetic Company 4',aliases:['Synthetic 4']},
 {id:'jp-SYN005',canonicalTicker:'SYN005',nativeTicker:'syn005',name:'Synthetic Company 5',aliases:['Synthetic 5']}
]);
