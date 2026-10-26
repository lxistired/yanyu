import React,{Profiler,StrictMode} from 'react';
import {renderToString} from 'react-dom/server';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {hasUnsavedWork,UnsavedWorkScope,useUnsavedWork} from '../candidate/src/components/unsaved-work';
function Marker({dirty}:{dirty:boolean}){useUnsavedWork(dirty);return null;}
function blocked(){const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;}
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('StrictMode scope migration and successful clean commit expose no stale row marker',()=>{
 const first=Symbol('first'),second=Symbol('second');let dirty=true,scope=first;
 const snapshots:{old:boolean;current:boolean;blocked:boolean}[]=[];
 const ui=()=> <StrictMode><Profiler id="scope-check" onRender={()=>snapshots.push({old:hasUnsavedWork(first),current:hasUnsavedWork(scope),blocked:blocked()})}><UnsavedWorkScope value={scope}><Marker dirty={dirty}/></UnsavedWorkScope></Profiler></StrictMode>;
 const view=render(ui());expect(snapshots[0]).toEqual({old:true,current:true,blocked:true});
 scope=second;view.rerender(ui());expect(snapshots.at(-1)).toEqual({old:false,current:true,blocked:true});expect(hasUnsavedWork(first)).toBe(false);
 dirty=false;view.rerender(ui());expect(snapshots.at(-1)).toEqual({old:false,current:false,blocked:false});view.unmount();expect(blocked()).toBe(false);
});
it('cleaning one row never removes another dirty row listener',()=>{
 const first=Symbol('first'),second=Symbol('second');const ui=(dirty:boolean)=><><UnsavedWorkScope value={first}><Marker dirty={dirty}/></UnsavedWorkScope><UnsavedWorkScope value={second}><Marker dirty/></UnsavedWorkScope></>;
 const view=render(ui(true));view.rerender(ui(false));expect(hasUnsavedWork(first)).toBe(false);expect(hasUnsavedWork(second)).toBe(true);expect(blocked()).toBe(true);view.unmount();expect(blocked()).toBe(false);
});
it('server rendering still creates no dirty registration and no unload listener',()=>{
 const scope=Symbol('server');expect(renderToString(<UnsavedWorkScope value={scope}><Marker dirty/></UnsavedWorkScope>)).toBe('');expect(hasUnsavedWork(scope)).toBe(false);expect(blocked()).toBe(false);
});
