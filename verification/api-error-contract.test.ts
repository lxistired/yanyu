import {webcrypto} from 'node:crypto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ApiError, api, requestJson} from '../candidate/src/adapters/api';
import {workspaceApi} from '../candidate/src/adapters/workspace';
import {organizationApi, serviceRecordBridgeApi} from '../candidate/src/adapters/organization';
import {automationApi} from '../candidate/src/adapters/automation';

beforeEach(() => vi.stubGlobal('crypto',webcrypto));
afterEach(() => vi.unstubAllGlobals());
// Valid wire requests ensure these tests reach transport/error normalization.
const workspaceCreateInput = () => ({kind:'workspace' as const,data:{name:'Synthetic workspace'},idempotencyKey:'synthetic-workspace-create'});
const workspaceUpdateInput = () => ({kind:'workspace' as const,id:'synthetic-workspace',expectedRevision:1,patch:{name:'Synthetic update'},idempotencyKey:'synthetic-workspace-update'});
const reply = (body: string | null, status = 503) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {status})));
async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(ApiError); return error as ApiError; }
  throw Error('Expected ApiError');
}
describe('ordinary JSON interface error contract', () => {
  it.each(['null', '[]', '{}', '{"error":null}', '{"error":[]}', '{"error":"oops"}', '<html>proxy failure</html>', '', '{'])('normalizes malformed error body %s', async body => {
    reply(body);
    const error = await caught(api.integrations());
    expect(error.detail).toEqual({code:'PROVIDER_ERROR',message:'服务响应无法确认，请检查本地服务',retryable:true});
    expect(error.outcome).toBe('read-failed'); expect(error.httpStatus).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [400,'INVALID_REQUEST',false], [401,'UNAUTHENTICATED',false], [403,'FORBIDDEN',false],
    [404,'NOT_FOUND',false], [408,'PROVIDER_ERROR',true], [409,'CONFLICT',false],
    [410,'NOT_FOUND',false], [422,'INVALID_REQUEST',false], [429,'RATE_LIMITED',true],
    [418,'PROVIDER_ERROR',false], [500,'PROVIDER_ERROR',true], [502,'PROVIDER_ERROR',true], [504,'PROVIDER_ERROR',true],
  ])('maps HTTP %s without inventing an empty result', async (status, code, retryable) => {
    reply(null, status as number);
    expect(await caught(api.integrations())).toMatchObject({detail:{code,retryable},httpStatus:status});
  });
  it('preserves a valid business code and retry hint but never raw text or request IDs', async () => {
    reply(JSON.stringify({error:{code:'CURSOR_EXPIRED',message:'secret@example.invalid token=synthetic-secret',retryable:false,requestId:'synthetic-secret'}}), 409);
    const error = await caught(api.integrations());
    expect(error.detail).toEqual({code:'CURSOR_EXPIRED',message:'列表已改变，请从首页重新读取',retryable:false});
    expect(JSON.stringify(error)).not.toContain('synthetic-secret'); expect(String(error)).not.toContain('@');
  });
  it.each([
    {code:'CONFLICT',message:'x'.repeat(2049),retryable:false},
    {code:'CONFLICT',message:'bad\ntext',retryable:false},
    {code:'CONFLICT',message:'',retryable:false},
    {code:'CONFLICT',message:'wrong retryable',retryable:'yes'},
    {code:'toString',message:'inherited key',retryable:false},
    {code:'UNKNOWN',message:'unknown code',retryable:false},
  ])('rejects malformed business error %#', async error => {
    reply(JSON.stringify({error}), 429);
    expect(await caught(api.integrations())).toMatchObject({detail:{code:'RATE_LIMITED',retryable:true}});
  });
  it('caps error bytes and cancels oversized error consumption', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({start(c) { c.enqueue(new TextEncoder().encode('x'.repeat(16385))); },cancel});
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(stream,{status:503})));
    const error = await caught(api.integrations());
    expect(error.detail.code).toBe('PROVIDER_ERROR'); expect(cancel).toHaveBeenCalledOnce();
    expect(error.message.length).toBeLessThan(100);
  });
  it('handles a rejected error stream without exposing its cause', async () => {
    const stream = new ReadableStream({start(c) {c.error(new Error('synthetic-secret'));}});
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(stream,{status:503})));
    expect(String(await caught(api.integrations()))).not.toContain('synthetic-secret');
  });
  it.each(['null','true','123','"text"','','{','{"error":{"code":"CONFLICT"}}'])('rejects malformed 2xx JSON %s', async body => {
    reply(body,200); expect((await caught(api.integrations())).detail.code).toBe('PROVIDER_ERROR');
  });
  it.each(['[]','[{"id":"example"}]','{"items":[]}'])('preserves an ordinary success envelope %s', async body => {
    reply(body,200); expect(await requestJson('/api/workspace/list')).toEqual(JSON.parse(body));
  });
  it('does not repeat a network-failed mutation or claim it was rejected', async () => {
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('synthetic-secret')));
    const error = await caught(workspaceApi.create(workspaceCreateInput()));
    expect(error).toMatchObject({outcome:'unknown',detail:{code:'PROVIDER_ERROR',retryable:true}});
    expect(error.message).toContain('勿重复提交'); expect(error.message).not.toContain('synthetic-secret');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['null','[]','<html>failure</html>',''])('keeps a malformed 5xx mutation outcome unknown: %s', async body => {
    reply(body);
    expect(await caught(organizationApi.update({kind:'organization'} as never))).toMatchObject({outcome:'unknown',httpStatus:503});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps a mutation outcome unknown even when its 2xx receipt cannot be parsed', async () => {
    reply('{',200);
    expect(await caught(workspaceApi.update(workspaceUpdateInput()))).toMatchObject({outcome:'unknown',httpStatus:200});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves a structured mutation rejection code without claiming no commit', async () => {
    reply(JSON.stringify({error:{code:'CONFLICT',message:'stale revision',retryable:false}}),409);
    expect(await caught(workspaceApi.update(workspaceUpdateInput()))).toMatchObject({outcome:'unknown',detail:{code:'CONFLICT',retryable:false}});
  });
  it('distinguishes an already cancelled unsent mutation', async () => {
    const controller = new AbortController(); controller.abort(); vi.stubGlobal('fetch',vi.fn());
    expect(await caught(workspaceApi.create(workspaceCreateInput(),controller.signal))).toMatchObject({outcome:'not-sent',detail:{code:'CANCELLED',retryable:false}});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not equate cancellation after dispatch with server cancellation', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async () => {controller.abort(); throw controller.signal.reason;}));
    expect(await caught(workspaceApi.create(workspaceCreateInput(),controller.signal))).toMatchObject({outcome:'unknown',detail:{code:'CANCELLED',retryable:false}});
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('preserves normal read cancellation', async () => {
    const controller = new AbortController(); controller.abort(); vi.stubGlobal('fetch',vi.fn());
    await expect(api.integrations(controller.signal)).rejects.toMatchObject({name:'AbortError'}); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    () => workspaceApi.list({kind:'workspace'} as never),
    () => workspaceApi.previewDelete({kind:'workspace'} as never),
    () => organizationApi.list({kind:'organization'} as never),
    () => organizationApi.serviceStatistics({} as never),
    () => serviceRecordBridgeApi.preview('synthetic'),
    () => automationApi.listSchedules(),
    () => automationApi.getSkill({id:'synthetic'}),
  ])('keeps an HTTP POST read read-only %#', async read => {
    reply('null'); expect(await caught(read())).toMatchObject({outcome:'read-failed'});
  });
  it.each([
    () => workspaceApi.importWatchlist({watchlistId:'synthetic-watchlist',items:[{symbol:'SYNTH',market:'US'}],idempotencyKey:'synthetic-watchlist-import'}),
    () => organizationApi.remove({} as never),
    () => serviceRecordBridgeApi.import({} as never),
    () => automationApi.createSchedule({idempotencyKey:'synthetic-key',name:'Synthetic',skillId:'skill',cadence:{kind:'daily',time:'09:00',timezone:'UTC'}}),
    () => automationApi.setScheduleState({idempotencyKey:'synthetic-key',id:'schedule',expectedRevision:1,state:'paused'}),
  ])('marks selected mutations explicitly %#', async write => {
    vi.stubGlobal('crypto',webcrypto);reply('null'); expect(await caught(write())).toMatchObject({outcome:'unknown'});
  });
});

it('definition missing key is rejected before transport rather than reported as an unknown sent write',async()=>{reply('null');expect(await caught(automationApi.createSkill({} as never))).toMatchObject({outcome:'not-sent'});expect(fetch).not.toHaveBeenCalled();});

it.each(['create','update','remove','restore','batchDelete','importWatchlist'] as const)('workspace %s missing key is not-sent with zero fetch',async action=>{
  reply('null');
  const input=action==='create'?{kind:'workspace',data:{name:'Synthetic'}}:action==='batchDelete'?{items:[{kind:'workspace',id:'synthetic',expectedRevision:1}]}:action==='importWatchlist'?{watchlistId:'synthetic',items:[{symbol:'SYNTH'}]}:action==='update'?{kind:'workspace',id:'synthetic',expectedRevision:1,patch:{name:'Synthetic'}}:{kind:'workspace',id:'synthetic',expectedRevision:1};
  expect(await caught(workspaceApi[action](input as never))).toMatchObject({outcome:'not-sent',detail:{code:'INVALID_REQUEST',retryable:false}});
  expect(fetch).not.toHaveBeenCalled();
});
