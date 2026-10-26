import {fixtureStoreHeaders, fixtureStoreUrl} from './transcription-store-fixture';
import {TranscriptionStoreBoundary} from '../candidate/src/components/TranscriptionStoreBoundary';
import React from 'react';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,fireEvent} from '@testing-library/react';
import {allowLeavingUnsavedWork,useUnsavedWork} from '../candidate/src/components/unsaved-work';
import {TranscriptEditor} from '../candidate/src/components/TranscriptEditor';
function Marker({dirty}:{dirty:boolean}) {useUnsavedWork(dirty);return null;}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('clean editors do not prompt; dirty editors can stay or explicitly leave',()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const view=render(<Marker dirty={false}/>);
 expect(allowLeavingUnsavedWork()).toBe(true);expect(confirm).not.toHaveBeenCalled();
 view.rerender(<Marker dirty/>);expect(allowLeavingUnsavedWork()).toBe(false);
 confirm.mockReturnValue(true);expect(allowLeavingUnsavedWork()).toBe(true);
 view.unmount();confirm.mockClear();expect(allowLeavingUnsavedWork()).toBe(true);expect(confirm).not.toHaveBeenCalled();
});
it('protects refresh only while dirty and does not leak markers after cleanup',()=>{
 const view=render(<Marker dirty/>);const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);expect(event.defaultPrevented).toBe(true);
 view.rerender(<Marker dirty={false}/>);const clean=new Event('beforeunload',{cancelable:true});window.dispatchEvent(clean);expect(clean.defaultPrevented).toBe(false);
});
it('saved transcript corrections clear the leave guard; failed save retains it',async()=>{
 let saved={raw:'synthetic source',corrected:null as string|null,revision:0,updated:null};let fail=true;
 vi.stubGlobal('fetch',vi.fn(async(_url:string,options?:RequestInit)=>{if(options?.method==='POST'&&fail)return {headers:fixtureStoreHeaders(),ok:false,json:async()=>({error:{message:'save conflict'}})};if(options?.method==='POST')saved={...saved,corrected:JSON.parse(options.body as string).text,revision:1};return {headers:fixtureStoreHeaders(),ok:true,json:async()=>saved};}));
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);render(<TranscriptionStoreBoundary><TranscriptEditor id="synthetic" raw={saved.raw}/></TranscriptionStoreBoundary>);
 await screen.findByDisplayValue('synthetic source');fireEvent.change(screen.getByLabelText('校对文本'),{target:{value:'synthetic draft'}});
 expect(allowLeavingUnsavedWork()).toBe(false);expect((screen.getByLabelText('校对文本') as HTMLTextAreaElement).value).toBe('synthetic draft');
 fireEvent.click(screen.getByText('保存校对'));await screen.findByText('save conflict');expect(allowLeavingUnsavedWork()).toBe(false);
 fail=false;fireEvent.click(screen.getByText('保存校对'));await screen.findByText('校对文本已保存');confirm.mockClear();expect(allowLeavingUnsavedWork()).toBe(true);expect(confirm).not.toHaveBeenCalled();
});

beforeEach(() => { history.replaceState(null, '', fixtureStoreUrl()); });
