import {expect,it} from 'vitest';
import {recentDocumentReturn} from '../candidate/src/components/recent-document-return';
// SOURCE-ONLY: authored coverage, not executed in this overlay.
const scope='11111111-1111-4111-8111-111111111111';
it('copies and freezes only the expected store and committed offset, not caller rows or drafts',()=>{
 const input={documentStoreId:scope,offset:10,rows:[{text:'excluded synthetic text'}],draft:'excluded',selection:{id:'excluded'}};
 const copied=recentDocumentReturn(input)!;
 expect(Object.keys(copied).sort()).toEqual(['documentStoreId','offset']);expect(Object.isFrozen(copied)).toBe(true);
 input.offset=20;input.documentStoreId='22222222-2222-4222-8222-222222222222';
 expect(copied).toEqual({documentStoreId:scope,offset:10});
});
it.each([-10,1,251,260,1.5,NaN,Infinity,'10',null,undefined])('rejects malformed offset %s',offset=>{
 expect(recentDocumentReturn({documentStoreId:scope,offset})).toBeNull();
});
it('accepts bounded page-aligned offsets including the recoverable empty end page',()=>{
 for(const offset of [0,10,240,250])expect(recentDocumentReturn({documentStoreId:scope,offset})).toEqual({documentStoreId:scope,offset});
});
it('rejects absent/malformed context or store rather than inventing a scope',()=>{
 for(const value of [null,undefined,[],10,'context',{}, {documentStoreId:scope}, {documentStoreId:scope+'\n',offset:10},{documentStoreId:'invalid',offset:10}])expect(recentDocumentReturn(value)).toBeNull();
});
