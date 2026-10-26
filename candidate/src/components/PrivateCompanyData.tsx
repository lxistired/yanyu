import {useEffect,useRef,useState} from 'react';
import {privateCompanyData,PrivateDataError,financialTables,type RowPage,type FinancialTable} from '../adapters/private-company-data';
import './private-company-data.css';
const labels:Record<FinancialTable,string>={balancesheet:'资产负债表',cashflow:'现金流量表',consensus:'一致预期 / 预测',quarterly_is:'季度损益表',timeseries:'时间序列'};
const kind=(value:string)=>({actual:'实际值（来源标记）','consensus-estimate':'一致预期 / 估计（非已实现）','reported-financials':'来源披露财务数据','unclassified-source-type':'来源类型未分类'}[value]??'来源类型未分类');
type Catalog=Awaited<ReturnType<typeof privateCompanyData.catalog>>;
/** Mount only on explicit company-route navigation, keyed by route epoch. */
export function PrivateCompanyData(){
 const [catalog,setCatalog]=useState<Catalog|null>(null),[issue,setIssue]=useState(''),[catalogBusy,setCatalogBusy]=useState(true),[reload,setReload]=useState(0);
 const [issuer,setIssuer]=useState(''),[table,setTable]=useState<FinancialTable>('timeseries'),[offset,setOffset]=useState(0),[page,setPage]=useState<RowPage|null>(null),[busy,setBusy]=useState(false),[rowIssue,setRowIssue]=useState(''),[retry,setRetry]=useState(0);
 const generation=useRef(0);
 useEffect(()=>{const abort=new AbortController();setCatalog(null);setIssue('');setCatalogBusy(true);setIssuer('');setPage(null);
 privateCompanyData.catalog(abort.signal).then(value=>{if(!abort.signal.aborted)setCatalog(value)}).catch(error=>{if(!abort.signal.aborted)setIssue(error instanceof PrivateDataError?error.message:'未能读取历史数据，请重试')}).finally(()=>{if(!abort.signal.aborted)setCatalogBusy(false)});return()=>abort.abort();},[reload]);
 const company=catalog?.companies.find(c=>c.id===issuer),schema=catalog?.tables.find(t=>t.name===table);
 useEffect(()=>{const abort=new AbortController(),epoch=++generation.current;setPage(null);setRowIssue('');setBusy(false);
 if(catalog&&company&&schema){setBusy(true);privateCompanyData.rows(catalog.snapshot,company,schema,offset,abort.signal).then(value=>{if(!abort.signal.aborted&&generation.current===epoch)setPage(value)}).catch(()=>{if(!abort.signal.aborted&&generation.current===epoch)setRowIssue('未能读取本页。来源可能已变更，请重试或重新读取目录。')}).finally(()=>{if(!abort.signal.aborted&&generation.current===epoch)setBusy(false)});}
 return()=>abort.abort();},[catalog,company,schema,offset,retry]);
 const changeCompany=(id:string)=>{generation.current++;setPage(null);setRowIssue('');setIssuer(id);setOffset(0)};
 const changeTable=(value:FinancialTable)=>{generation.current++;setPage(null);setRowIssue('');setTable(value);setOffset(0)};
 return <section className="private-company-data" aria-label="私有公司历史数据">
  <header><h2>公司数据 · 私有历史快照</h2><p className="private-data-notice">只读历史资料，不是当前行情。实际值与一致预期 / 预测分别标记；预测未经验证。公开包未分发真实私有来源或接入配置；当前保留只读接口及合成测试，不代表通用私有数据接入。</p></header>
  <p>保留来源原始 TEXT、日期、单位和证券代码大小写，不换算、不补全。空白或缺失日期为未知；未注明的单位为未知。close_snapshot 是合成接口的快照字段，不是实时价格；year_1 / year_2 仅为通用期间标签。</p>
  {catalogBusy&&<p role="status">正在检查历史数据是否可用…</p>}
  {issue&&<div role="status"><p>{issue}</p><button onClick={()=>setReload(x=>x+1)}>重新检查</button></div>}
  {catalog&&<>
   <label>选择公司<select value={issuer} onChange={e=>changeCompany(e.target.value)}><option value="">请选择公司</option>{catalog.companies.map(c=><option key={c.id} value={c.id}>{c.name} · {c.canonicalTicker}</option>)}</select></label>
   {!company&&<p role="status">选择公司后读取财务表；当前尚未读取任何财务行。</p>}
   {company&&<><p>公司标识：{company.id} · 标准证券代码：{company.canonicalTicker}。表格内 ticker 保留来源写法。</p>
    <ul aria-label="表覆盖范围" className="private-data-coverage">{financialTables.map(t=><li key={t}>{labels[t]}：{company.tables[t]} 行</li>)}</ul>
    <label>选择财务表<select value={table} onChange={e=>changeTable(e.target.value as FinancialTable)}>{financialTables.map(t=><option value={t} key={t}>{labels[t]}</option>)}</select></label>
    {schema&&<details><summary>查看字段与原始类型（{schema.columns.length} 列）</summary><dl className="private-data-schema">{schema.columns.map(c=><div key={c.name}><dt>{c.name}</dt><dd>{c.type}</dd></div>)}</dl></details>}
    {table==='consensus'&&<p className="private-data-notice">本表是一致预期 / 估计，不能当作已实现业绩。</p>}
    {busy&&<p role="status">正在读取本页…</p>}
    {rowIssue&&<div role="alert"><p>{rowIssue}</p><button onClick={()=>setRetry(x=>x+1)}>重试本页</button><button onClick={()=>setReload(x=>x+1)}>重新读取目录</button></div>}
    {page&&schema&&<><p role="status">{page.items.length?`第 ${page.offset+1}–${page.offset+page.items.length} 行`:'此表没有数据'} · 每页最多 25 行</p>
     {page.items.length>0&&<div className="private-data-scroll" role="region" aria-label={`${labels[table]}原始数据，可横向滚动`} tabIndex={0}><table><caption>{company.name} · {labels[table]} · 历史原始文本</caption><thead><tr><th scope="col">数据性质</th>{schema.columns.map(c=><th key={c.name} scope="col">{c.name}</th>)}</tr></thead><tbody>{page.items.map(row=><tr key={row.provenance.rowid}><th scope="row">{kind(row.recordKind)}</th>{schema.columns.map(c=><td key={c.name}>{row.values[c.name]===null?<span className="private-data-missing">未提供 / 未知</span>:row.values[c.name]===''?<span className="private-data-missing">空白 / 未知</span>:row.values[c.name]}</td>)}</tr>)}</tbody></table></div>}
     <nav aria-label="财务表分页"><button disabled={busy||offset===0} onClick={()=>{setPage(null);setOffset(Math.max(0,offset-25))}}>上一页</button><button disabled={busy||page.nextOffset===null} onClick={()=>{if(page.nextOffset!==null){setPage(null);setOffset(page.nextOffset)}}}>下一页</button></nav>
    </>}
   </>}
  </>}
 </section>;
}
