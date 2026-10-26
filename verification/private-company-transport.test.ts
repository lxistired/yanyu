import {it,expect} from 'vitest';
import {isPrivateCompanyRequest as allowed} from '../visual-harness/private-company-transport';
const rows=`/api/private-demo/rows?issuer=jp-SYN0&table=timeseries&offset=0&limit=25&snapshotId=sha256:${'a'.repeat(64)}`;
it('admits only fixed GET catalog and bounded row queries',()=>{for(const url of ['/api/private-demo/companies','/api/private-demo/schema',rows])expect(allowed(url,'GET')).toBe(true)});
it.each(['/api/private-demo/companies?path=secret','/api/private-demo/schema?sql=select','/api/private-demo/download','/api/private-demo/rows',rows+'&table=consensus',rows+'&sql=select',rows.replace('limit=25','limit=1000'),rows.replace('offset=0','offset=-1'),rows.replace('offset=0','offset=10000001'),rows.replace('timeseries','reports'),rows+'#x','https://other.example'+rows])('denies non-admitted request %s',url=>expect(allowed(url,'GET')).toBe(false));
it.each(['POST','PUT','DELETE','PATCH'])('denies writes %s',method=>expect(allowed(rows,method)).toBe(false));
it('denies GET body',()=>expect(allowed(rows,'GET','private')).toBe(false));
