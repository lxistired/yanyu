import {expect,it,vi} from 'vitest';
import {boundedTransport} from '../visual-harness/bounded-transport';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
const id='11111111-1111-4111-8111-111111111111';
it.each([
 [`/api/documents/${id}/reader`,'GET'],[`/api/documents/${id}/reader`,'PUT'],['/api/documents','GET'],['/api/documents?q=a%26b&workspaceId=w1&folderId=f1&offset=0&limit=10','GET'],['/api/documents/choices','GET'],['/api/documents/folders','POST'],['/api/documents/upload?name=x.txt&workspaceId=w1&folderId=f1','POST'],[`/api/documents/${id}`,'GET'],[`/api/documents/${id}/download`,'GET'],
])('admits exact document contract %s %s',async(path,method)=>{const native=vi.fn(async()=>new Response('{}'));const transport=boundedTransport(new OrdinaryRequestLifetime(),native);await transport(path,{method});expect(native).toHaveBeenCalledOnce();expect(native.mock.calls[0]).toEqual([path,expect.objectContaining({method,credentials:'same-origin',redirect:'error',cache:'no-store'})]);});
it.each([
 [`/api/documents/${id}/reader`,'POST'],[`/api/documents/${id}/reader?url=x`,'GET'],['/api/documents','POST'],['/api/documents?q=x&q=y','GET'],['/api/documents?url=https://remote','GET'],['/api/documents?%71=x&q=y','GET'],['/api/documents#fragment','GET'],['/api/documents/choices?x=1','GET'],['/api/documents/choices','POST'],['/api/documents/folders','GET'],['/api/documents/upload?name=x&name=y','POST'],['/api/documents/upload?name=x&url=https://remote','POST'],['/api/documents/upload','POST'],['/api/documents/upload?name=x','GET'],[`/api/documents/${id}`,'POST'],[`/api/documents/${id}/download`,'POST'],[`/api/documents/${id}?x=1`,'GET'],[`/api/documents/${id}/download?inline=1`,'GET'],['/api/documents/../../secret','GET'],['https://remote.invalid/api/documents','GET'],['/api/documents/not-a-uuid','GET'],['/api/documents/'+id+'/delete','POST'],
])('rejects route or query widening %s %s',async(path,method)=>{const native=vi.fn(async()=>new Response('{}'));expect((await boundedTransport(new OrdinaryRequestLifetime(),native)(path,{method})).status).toBe(503);expect(native).not.toHaveBeenCalled();});

const noteId='22222222-2222-4222-8222-222222222222';
const annotationBase=`/api/documents/${id}/annotations`;
it.each([[annotationBase,'GET'],[annotationBase,'POST'],[`${annotationBase}/${noteId}`,'PUT']])('admits exact annotation contract %s %s',async(path,method)=>{const native=vi.fn(async()=>new Response('{}'));await boundedTransport(new OrdinaryRequestLifetime(),native)(path,{method});expect(native).toHaveBeenCalledOnce();expect(native.mock.calls[0][1]).toMatchObject({credentials:'same-origin',redirect:'error',cache:'no-store'});});
it.each([[annotationBase,'PUT'],[annotationBase,'DELETE'],[`${annotationBase}/${noteId}`,'GET'],[`${annotationBase}/${noteId}`,'POST'],[`${annotationBase}/${noteId}`,'DELETE'],[`${annotationBase}?x=1`,'GET'],[`${annotationBase}/${noteId}?x=1`,'PUT'],[`${annotationBase}/`,'POST'],[`${annotationBase}/${noteId}/`,'PUT'],[`${annotationBase}/not-a-uuid`,'PUT'],[`${annotationBase}/${noteId}/delete`,'POST'],[`${annotationBase}#fragment`,'GET'],[`https://remote.invalid${annotationBase}`,'POST'],[`//remote.invalid${annotationBase}`,'POST'],[annotationBase.replace(id,'not-a-uuid'),'GET']])('rejects annotation route widening %s %s',async(path,method)=>{const native=vi.fn();expect((await boundedTransport(new OrdinaryRequestLifetime(),native)(path,{method})).status).toBe(503);expect(native).not.toHaveBeenCalled();});

it.each(['metadata','trash','restore'])('admits exact management PUT %s',async op=>{const native=vi.fn(async()=>new Response('{}'));await boundedTransport(new OrdinaryRequestLifetime(),native)(`/api/documents/${id}/${op}`,{method:'PUT'});expect(native).toHaveBeenCalledOnce();});
it.each(['metadata','trash','restore','purge'])('rejects management widening %s',async op=>{for(const [path,method] of [[`/api/documents/${id}/${op}`,'DELETE'],[`/api/documents/${id}/${op}`,'POST'],[`/api/documents/${id}/${op}?x=1`,'PUT'],[`/api/documents/${id}/${op}/`,'PUT'],[`/api/documents/not-a-uuid/${op}`,'PUT']]){const native=vi.fn();expect((await boundedTransport(new OrdinaryRequestLifetime(),native)(path,{method})).status).toBe(503);expect(native).not.toHaveBeenCalled();}});
it('admits explicit active and trash listing query',async()=>{for(const view of ['active','trash']){const native=vi.fn(async()=>new Response('{}'));await boundedTransport(new OrdinaryRequestLifetime(),native)(`/api/documents?view=${view}`);expect(native).toHaveBeenCalledOnce();}});
const citationBase=`/api/documents/${id}/citations`;
it.each([[citationBase,'GET'],[citationBase,'POST'],[`${citationBase}/${noteId}`,'GET']])('admits exact citation contract %s %s',async(path,method)=>{const native=vi.fn(async()=>new Response('{}'));await boundedTransport(new OrdinaryRequestLifetime(),native)(path,{method});expect(native).toHaveBeenCalledOnce();});
it.each([[citationBase,'PUT'],[citationBase,'DELETE'],[`${citationBase}/${noteId}`,'POST'],[`${citationBase}/${noteId}`,'PUT'],[`${citationBase}/${noteId}`,'DELETE'],[`${citationBase}?x=1`,'GET'],[`${citationBase}/`,'POST'],[`${citationBase}/not-a-uuid`,'GET'],[`https://external.invalid${citationBase}`,'POST']])('rejects citation widening %s %s',async(path,method)=>{const native=vi.fn();expect((await boundedTransport(new OrdinaryRequestLifetime(),native)(path,{method})).status).toBe(503);expect(native).not.toHaveBeenCalled();});

const uploadOperation='/api/documents/upload-operations/'+id;
it.each([undefined,'GET'])('admits only an exact upload receipt lookup with method %s',async method=>{
 const native=vi.fn(async()=>new Response('{}')),transport=boundedTransport(new OrdinaryRequestLifetime(),native);
 await transport(uploadOperation,method?{method}:undefined);
 expect(native).toHaveBeenCalledOnce();expect(native.mock.calls[0]).toEqual([uploadOperation,expect.objectContaining({credentials:'same-origin',redirect:'error',cache:'no-store'})]);
});
it.each([
 [uploadOperation,'POST'],[uploadOperation,'DELETE'],[uploadOperation,'PUT'],[uploadOperation,'HEAD'],
 [uploadOperation+'?x=1','GET'],[uploadOperation+'?operationId='+id,'GET'],[uploadOperation+'?','GET'],
 [uploadOperation+'#fragment','GET'],[uploadOperation+'#','GET'],[uploadOperation+'/','GET'],
 ['/api/documents/upload-operations/not-a-uuid','GET'],['/api/documents/upload-operations/------------------------------------','GET'],
 ['https://external.invalid'+uploadOperation,'GET'],['//external.invalid'+uploadOperation,'GET'],
 [uploadOperation.replace(id,'%31'+id.slice(1)),'GET'],[uploadOperation.replace(id,id.replaceAll('-','%2d')),'GET'],
 ['/api/documents/upload-operations%2f'+id,'GET'],[uploadOperation+'%2f..%2fchoices','GET'],
 ['/api/documents/upload-operations/../choices','GET'],['/api/documents/upload-operations/%2e%2e/choices','GET'],
 [uploadOperation+'%3fx=1','GET'],[uploadOperation+'%23fragment','GET'],
])('blocks upload-recovery method or route widening %s %s before network dispatch',async(path,method)=>{
 const native=vi.fn();expect((await boundedTransport(new OrdinaryRequestLifetime(),native)(path,{method})).status).toBe(503);expect(native).not.toHaveBeenCalled();
});
it('preserves the original upload operation and store headers and raw body through the application transport',async()=>{
 const native=vi.fn(async()=>new Response('{}')),transport=boundedTransport(new OrdinaryRequestLifetime(),native);
 const headers={'Content-Type':'application/octet-stream','X-Upload-Operation-Id':id,'X-Upload-Store-Id':noteId},body=new Uint8Array([83,89,78,84,72]);
 await transport('/api/documents/upload?name=transport-synthetic.txt',{method:'POST',headers,body});
 expect(native).toHaveBeenCalledOnce();const init=native.mock.calls[0][1];
 expect(init.headers).toBe(headers);expect(new Headers(init.headers).get('X-Upload-Operation-Id')).toBe(id);expect(new Headers(init.headers).get('X-Upload-Store-Id')).toBe(noteId);
 expect(init.body).toBe(body);expect(init).toMatchObject({method:'POST',credentials:'same-origin',redirect:'error',cache:'no-store'});
});
