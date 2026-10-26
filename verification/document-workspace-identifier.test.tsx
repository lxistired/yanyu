import React from 'react';
import {webcrypto} from 'node:crypto';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {LocalDocuments} from '../candidate/src/components/LocalDocuments';
import {workspaceIdentifier} from '../candidate/src/components/workspace-identifier';
import {relationshipIdentifier} from '../backend/relationship-identifier.mjs';
import {newUploadRecord,retainUploadRecord,readUploadRecords,verifyUploadReceipt} from '../candidate/src/components/document-upload-journal';
const scope='10000000-0000-4000-8000-000000000001',folder='20000000-0000-4000-8000-000000000002',documentId='30000000-0000-4000-8000-000000000003';
beforeEach(()=>{localStorage.clear();vi.stubGlobal('crypto',webcrypto)});afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear()});
it('frontend and backend keep exactly the same bounded legacy/domain union',()=>{
 for(const [values,valid] of [[['a','_','-','_workspace','-workspace','__proto__','a.b:c','a'.repeat(160),'_'+'a'.repeat(99)],true],[['',null,[],{},1,'a'.repeat(161),'_'+'a'.repeat(100),'_.','-a:b','a/b','a b','中','a\n','a\r','a\u2028','a\u2029','a\0'],false]] as const)for(const value of values){expect(workspaceIdentifier(value)).toBe(valid);expect(relationshipIdentifier(value)).toBe(valid)}
});
it.each(['_workspace','-workspace','_'+'a'.repeat(99)])('preserves pending upload and exact receipt for %s',async workspaceId=>{
 const file=new File(['synthetic'],'synthetic.txt');Object.defineProperty(file,'arrayBuffer',{value:async()=>new TextEncoder().encode('synthetic').buffer});
 const record=await newUploadRecord(scope,file,workspaceId,folder);retainUploadRecord(localStorage,record);expect(readUploadRecords(localStorage,scope)).toEqual([record]);
 const receipt={operationId:record.operationId,documentId,name:record.name,format:record.format,bytes:record.bytes,sha256:record.sha256,workspaceId,folderId:folder,createdAt:record.createdAt};
 expect(()=>verifyUploadReceipt(record,receipt)).not.toThrow();expect(()=>verifyUploadReceipt(record,{...receipt,workspaceId:'other'})).toThrow();expect(()=>verifyUploadReceipt(record,{...receipt,sha256:'0'.repeat(64)})).toThrow();
});
it.each(['_workspace','-workspace'])('UI accepts created folder reply for selected %s with mocked fetch',async workspaceId=>{
 const json=(body:unknown)=>Promise.resolve(new Response(JSON.stringify(body)));vi.stubGlobal('fetch',vi.fn((input:unknown)=>{const path=String(input);if(path==='/api/documents/choices')return json({uploadScope:scope,workspaces:[{id:workspaceId,name:'Synthetic workspace'}],folders:[]});if(path==='/api/documents/folders')return json({folder:{id:folder,name:'Synthetic folder',workspaceId}});if(path.startsWith('/api/documents?'))return json({storeScope:scope,documents:[],total:0,offset:0,limit:10});throw Error(path)}));
 render(<LocalDocuments/>);await screen.findByText('没有匹配的文档。上传文件，或调整筛选条件。');fireEvent.change(screen.getByLabelText('工作区'),{target:{value:workspaceId}});fireEvent.change(screen.getByLabelText('新文件夹名称'),{target:{value:'Synthetic folder'}});fireEvent.submit(screen.getByLabelText('新文件夹名称').closest('form')!);await screen.findByText('本地文件夹已创建');expect((screen.getByLabelText('本地文件夹') as HTMLSelectElement).value).toBe(folder);
});
