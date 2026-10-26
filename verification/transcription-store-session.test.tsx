import React from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {STORE_HEADER, readStoreLink, TranscriptionStoreSession} from '../candidate/src/components/transcription-store-session';
import {TranscriptionStoreBoundary} from '../candidate/src/components/TranscriptionStoreBoundary';
import {TranscriptEditor} from '../candidate/src/components/TranscriptEditor';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const reply=(scope:string|null, body:unknown={transcriptionStoreId:scope}, status=200) => ({ok:status<400,status,headers:new Headers(scope ? {[STORE_HEADER]:scope} : {}),json:vi.fn(async()=>body),blob:vi.fn(async()=>new Blob(['synthetic']))}) as unknown as Response;
afterEach(()=>{cleanup();vi.unstubAllGlobals();history.replaceState(null,'','/');});
describe('immutable transcription transport',()=>{
 it('requires explicit discovery then freezes and sends same scope on every endpoint',async()=>{
  const network=vi.fn(async()=>reply(A)); const session=new TranscriptionStoreSession(null,network as typeof fetch);
  await expect(session.fetch('/api/local-asr/jobs')).rejects.toThrow();expect(network).not.toHaveBeenCalled();
  await session.discover();expect(network.mock.calls[0]?.[0]).toBe('/api/local-asr/identity');expect(session.scope).toBe(A);expect(network.mock.calls).toHaveLength(1);
  const paths=['jobs','jobs/x/transcript','jobs/x/history','jobs/x/history/1','jobs/x/export','jobs/x/transcript-restore','jobs/x/rename','jobs/x/trash','jobs/x/restore','relationships','jobs/x/relationship','jobs/x/retry','jobs/x/cancel','jobs/x/resume','transcribe'];
  for(const path of paths){await (await session.fetch('/api/local-asr/'+path,{method:'POST',headers:{'Content-Type':'application/json'}})).json();}
  for(const call of network.mock.calls.slice(1) as unknown as [string,RequestInit][]){expect(new Headers(call[1].headers).get(STORE_HEADER)).toBe(A);expect(call[1].redirect).toBe('error');}
  expect(session.key('same-id')).not.toBe(new TranscriptionStoreSession(B).key('same-id'));
  await expect(session.discover()).rejects.toThrow();
 });
 it.each([null,B,'malformed',A+','+A])('rejects response scope %s before either body and permanently blocks even error responses',async scope=>{
  const response=reply(scope,{},409);const network=vi.fn(async()=>response);const session=new TranscriptionStoreSession(A,network as typeof fetch);
  await expect(session.fetch('/api/local-asr/jobs/x/export')).rejects.toThrow();expect(response.json).not.toHaveBeenCalled();expect(response.blob).not.toHaveBeenCalled();expect(session.scope).toBe(A);
  await expect(session.fetch('/api/local-asr/jobs')).rejects.toThrow();expect(network).toHaveBeenCalledTimes(1);
 });
 it.each(['json','blob'] as const)('rejects delayed %s completion after concurrent terminal mismatch',async method=>{
  let release!:(value:any)=>void;const pending=new Promise(resolve=>{release=resolve;});const good=reply(A);good[method]=vi.fn(()=>pending) as any;
  const network=vi.fn().mockResolvedValueOnce(good).mockResolvedValueOnce(reply(B));const session=new TranscriptionStoreSession(A,network);
  const response=await session.fetch('/api/local-asr/jobs/x/export');const result=response[method]();
  await expect(session.fetch('/api/local-asr/jobs')).rejects.toThrow();release(method==='json'?{}:new Blob(['synthetic']));await expect(result).rejects.toThrow();
 });
 it('serializes discovery without allowing a second unbound response to rebind',async()=>{
  let release!:(value:Response)=>void;const pending=new Promise<Response>(resolve=>{release=resolve;});const network=vi.fn(()=>pending);const session=new TranscriptionStoreSession(null,network as typeof fetch);const first=session.discover();await expect(session.discover()).rejects.toThrow();release(reply(A));await first;expect(session.scope).toBe(A);expect(network).toHaveBeenCalledTimes(1);
 });
 it('consumes dedicated identity metadata only and rejects duplicate URL scope/filter values',async()=>{
  const response=reply(A);const session=new TranscriptionStoreSession(null,vi.fn(async()=>response) as typeof fetch);await session.discover();expect(response.json).toHaveBeenCalledOnce();
  for(const query of [`transcriptStoreId=${A}&transcriptStoreId=${A}`,'transcriptStoreId=bad', 'transcriptStoreId=aaaaaaaa-aaaa-1aaa-7aaa-aaaaaaaaaaaa','transcriptJob=a&transcriptJob=b'])expect(()=>readStoreLink(new URL('https://local.invalid/?'+query))).toThrow();
  expect(readStoreLink(new URL('https://local.invalid/?transcriptJob=old'))).toBe(null);
 });
});
describe('source boundary and retained correction',()=>{
 it('does not mount actionable legacy content until explicit current-source choice',async()=>{
  history.replaceState(null,'','/?transcriptJob=legacy');const network=vi.fn(async()=>reply(A));vi.stubGlobal('fetch',network);
  render(<TranscriptionStoreBoundary><p>Bound child</p></TranscriptionStoreBoundary>);expect(screen.queryByText('Bound child')).toBeNull();expect(network).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('明确选择当前转写来源'));await screen.findByText('Bound child');expect(network).toHaveBeenCalledTimes(1);
 });
 it('preserves dirty same-ID correction on mismatched save, prevents export and does not rebind',async()=>{
  history.replaceState(null,'',`/?transcriptStoreId=${A}&transcriptJob=same`);
  const mismatch=reply(B,{},409);const network=vi.fn().mockResolvedValueOnce(reply(A,{raw:'A raw',corrected:null,revision:0,updated:null})).mockResolvedValue(mismatch);vi.stubGlobal('fetch',network);
  render(<TranscriptionStoreBoundary><TranscriptEditor id="same" raw="A preview"/></TranscriptionStoreBoundary>);
  const textarea=await screen.findByLabelText('校对文本') as HTMLTextAreaElement;fireEvent.change(textarea,{target:{value:'A dirty draft'}});fireEvent.click(screen.getByText('保存校对'));
  await waitFor(()=>{expect(screen.getByText(/本页不会自动切换来源/)).toBeTruthy();expect(textarea.disabled).toBe(false);});expect((screen.getByText('保存校对') as HTMLButtonElement).disabled).toBe(true);expect(textarea.value).toBe('A dirty draft');expect(textarea.disabled).toBe(false);expect(mismatch.json).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('导出原始 TXT'));expect(network).toHaveBeenCalledTimes(2);expect(screen.queryByText('B raw')).toBeNull();
 });
});

it.each([{}, {transcriptionStoreId:B}, null])('rejects inconsistent discovery metadata and never requests records: %j',async data=>{
 const f=vi.fn(async()=>reply(A,data));const s=new TranscriptionStoreSession(null,f as typeof fetch);
 await expect(s.discover()).rejects.toThrow();await expect(s.fetch('/api/local-asr/jobs')).rejects.toThrow();expect(s.blocked).toBe(true);expect(f).toHaveBeenCalledOnce();
});
it('discovery remains serialized until identity JSON completes',async()=>{
 let release!:(value:unknown)=>void;const r=reply(A);r.json=()=>new Promise(resolve=>release=resolve);const f=vi.fn(async()=>r);const s=new TranscriptionStoreSession(null,f as typeof fetch);
 const first=s.discover();await waitFor(()=>expect(release).toBeTruthy());await expect(s.discover()).rejects.toThrow();release({transcriptionStoreId:A});await first;expect(s.scope).toBe(A);expect(f).toHaveBeenCalledOnce();
});
