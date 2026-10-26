/** Isolated, same-origin, read-only historical provider. No shared workspace authorization. */
export const financialTables = ['balancesheet','cashflow','consensus','quarterly_is','timeseries'] as const;
export type FinancialTable = typeof financialTables[number];
const allowedColumns:Record<FinancialTable,string[]>={
 balancesheet:['ticker','company','fy_label','period_end','freq','total_assets','total_liab','total_equity','cash','debt','net_cash','inventory','receivables','net_ppe'],
 cashflow:['ticker','company','fy_label','period_end','freq','ocf','capex','fcf','cfi','cff','dep_amor','dividends'],
 consensus:['company','ticker','currency','n_analysts','close_snapshot','pe','rev_year_1','rev_year_2','rev_yoy_year_1','rev_yoy_year_2','eps_year_1','eps_year_2','foot_flag'],
 quarterly_is:['ticker','company','fy_label','period_end','freq','revenue','op','op_margin','net_income','eps','source','foot_flag'],
 timeseries:['ticker','company','freq','period','ending_date','type','metric','value']
};
export interface Snapshot {id:string; classification:'historical-private-snapshot'}
export interface Company {id:string; name:string; canonicalTicker:string; tables:Record<FinancialTable,number>}
export interface TableSchema {name:FinancialTable; columns:{name:string;type:'TEXT'}[];recordKind:string}
export interface FinancialRow {values:Record<string,string|null>; provenance:{snapshot:string;table:FinancialTable;rowid:number};recordKind:string}
export interface RowPage {snapshot:Snapshot;issuer:string;table:FinancialTable;offset:number;limit:number;nextOffset:number|null;items:FinancialRow[]}
export class PrivateDataError extends Error {constructor(public unavailable=false){super(unavailable?'公开包未提供机构私有数据接入；接口保留，来源适配需单独审阅':'未能读取历史数据，请重试')}}
const validSnapshot=(s:Snapshot)=>s?.classification==='historical-private-snapshot' && /^sha256:[a-f0-9]{64}$/.test(s.id);
async function get<T>(path:string,signal:AbortSignal):Promise<T>{
 const response=await fetch(`/api/private-demo/${path}`,{method:'GET',cache:'no-store',credentials:'same-origin',signal});
 if(!response.ok)throw new PrivateDataError(response.status===404);
 return response.json();
}
export const privateCompanyData={
 async catalog(signal:AbortSignal){
  const companies=await get<{snapshot:Snapshot;companies:Company[]}>('companies',signal);
  if(!validSnapshot(companies.snapshot)||!Array.isArray(companies.companies)||companies.companies.length!==5||new Set(companies.companies.map(c=>c.id)).size!==5||companies.companies.some(c=>!/^jp-[A-Za-z0-9]+$/.test(c.id)||typeof c.name!=='string'||typeof c.canonicalTicker!=='string'||financialTables.some(t=>!Number.isSafeInteger(c.tables?.[t])||c.tables[t]<0)))throw new PrivateDataError();
  const schema=await get<{snapshot:Snapshot;tables:TableSchema[]}>('schema',signal);
  if(!validSnapshot(schema.snapshot)||schema.snapshot.id!==companies.snapshot.id||!Array.isArray(schema.tables)||schema.tables.length!==5||new Set(schema.tables.map(t=>t.name)).size!==5||schema.tables.some(t=>!financialTables.includes(t.name)||!Array.isArray(t.columns)||JSON.stringify(t.columns.map(c=>c.name))!==JSON.stringify(allowedColumns[t.name])||t.columns.some(c=>c.type!=='TEXT'||!/^\w+$/.test(c.name))||new Set(t.columns.map(c=>c.name)).size!==t.columns.length))throw new PrivateDataError();
  return {...companies,tables:schema.tables};
 },
 async rows(snapshot:Snapshot,company:Company,table:TableSchema,offset:number,signal:AbortSignal):Promise<RowPage>{
  if(!validSnapshot(snapshot)||!financialTables.includes(table.name)||!Number.isSafeInteger(offset)||offset<0||offset>10000000)throw new PrivateDataError();
  const query=new URLSearchParams({issuer:company.id,table:table.name,offset:String(offset),limit:'25',snapshotId:snapshot.id});
  const page=await get<RowPage>(`rows?${query}`,signal);
  if(!validSnapshot(page.snapshot)||page.snapshot.id!==snapshot.id||page.issuer!==company.id||page.table!==table.name||page.offset!==offset||page.limit!==25||!Array.isArray(page.items)||page.items.length>25||(page.nextOffset!==null&&(page.nextOffset!==offset+25||page.items.length!==25||page.nextOffset>10000000))||page.items.some(row=>row.provenance?.snapshot!==snapshot.id||row.provenance.table!==table.name||!Number.isSafeInteger(row.provenance.rowid)||row.provenance.rowid<1||!row.values||table.columns.some(c=>!Object.hasOwn(row.values,c.name)||(row.values[c.name]!==null&&typeof row.values[c.name]!=='string'))||Object.keys(row.values).some(k=>!table.columns.some(c=>c.name===k))))throw new PrivateDataError();
  return page;
 }
};
