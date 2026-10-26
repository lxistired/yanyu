import {expect,it} from 'vitest';
import {transcriptPage} from '../candidate/src/components/local-research-search';
const scope='11111111-1111-4111-8111-111111111111';
const row={id:'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',title:'Synthetic',filename:'synthetic.wav',status:'completed',created:'legacy date',deleted_at:null,result:null};
const page=(extra:Record<string,unknown>)=>({total:1,offset:0,limit:10,hasMore:false,jobs:[{...row,...extra}]});
it('preserves legacy missing origin fields without inventing unknown assurance',()=>{
 const item=transcriptPage(page({}),0,scope).items[0];
 expect(item).not.toHaveProperty('uploadOrigin');expect(item).not.toHaveProperty('uploadOriginAssurance');expect(item.created).toBe('legacy date');
});
it.each(['unknown','file-selection','recording-draft'])('projects the exact valid %s pair',origin=>{
 const assurance=origin==='unknown'?'unknown':'client-declared';
 expect(transcriptPage(page({uploadOrigin:origin,uploadOriginAssurance:assurance}),0,scope).items[0]).toMatchObject({uploadOrigin:origin,uploadOriginAssurance:assurance});
});
it.each([
 {uploadOrigin:'unknown'}, {uploadOriginAssurance:'unknown'},
 {uploadOrigin:null,uploadOriginAssurance:null}, {uploadOrigin:undefined,uploadOriginAssurance:undefined},
 {uploadOrigin:'unknown',uploadOriginAssurance:'client-declared'},
 {uploadOrigin:'file-selection',uploadOriginAssurance:'unknown'},
 {uploadOrigin:'recording-draft',uploadOriginAssurance:'unknown'},
 {uploadOrigin:'mobile',uploadOriginAssurance:'client-declared'},
 {uploadOrigin:'recording-draft',uploadOriginAssurance:'verified-device'},
 {uploadOrigin:[],uploadOriginAssurance:'unknown'},
])('rejects malformed or inconsistent pair %j for every shared consumer',extra=>{
 expect(()=>transcriptPage(page(extra),0,scope)).toThrow('本地来源响应无效');
});
it('rejects the entire page rather than dropping one invalid row',()=>{
 const data={...page({}),total:2,jobs:[row,{...row,id:'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',uploadOrigin:'unknown',uploadOriginAssurance:'client-declared'}]};
 expect(()=>transcriptPage(data,0,scope)).toThrow();
});
