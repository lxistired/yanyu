/** Only these read-only financial requests may reach the private provider. */
export function isPrivateCompanyRequest(path:string,method:string,body?:BodyInit|null){
 if(method!=='GET'||body!=null)return false;
 if(path==='/api/private-demo/companies'||path==='/api/private-demo/schema')return true;
 if(!/^\/api\/private-demo\/rows\?[^#]*$/.test(path))return false;
 const p=new URLSearchParams(path.split('?')[1]);
 const keys=['issuer','table','offset','limit','snapshotId'];
 return [...p.keys()].length===5&&keys.every(k=>p.getAll(k).length===1)&&[...p.keys()].every(k=>keys.includes(k))&&/^jp-[a-zA-Z0-9]+$/.test(p.get('issuer')!)&&['balancesheet','cashflow','consensus','quarterly_is','timeseries'].includes(p.get('table')!)&&/^(0|[1-9][0-9]*)$/.test(p.get('offset')!)&&Number(p.get('offset'))<=10000000&&p.get('limit')==='25'&&/^sha256:[a-f0-9]{64}$/.test(p.get('snapshotId')!);
}
