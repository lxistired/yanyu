import statusCss from '../candidate/src/components/local-transcription.css?raw';
import {useState} from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {StagedStatusFilter, type FilterGroup, type FilterSelection} from '../candidate/src/components/staged-status-filter/StagedStatusFilter';
import {LocalTranscription} from '../candidate/src/components/LocalTranscription';
import {LocalRecentMaterials} from '../candidate/src/components/LocalRecentMaterials';
import {fixtureStoreHeaders, fixtureStoreUrl} from './transcription-store-fixture';

const groups: readonly FilterGroup<'status', string>[] = [{id:'status', label:'Status', choices:[{value:'ready',label:'Ready'},{value:'failed',label:'Failed'}]}];
type Selection = FilterSelection<'status', string>;
function Harness({initial = [], presentation = 'trailing-check', commit = vi.fn(), hold = false}: {initial?: string[]; presentation?: 'trailing-check' | 'default'; commit?: (value: Selection) => boolean | void; hold?: boolean}) {
  const [value, setValue] = useState<Selection>({status:initial});
  const [open, setOpen] = useState(true);
  return <div className="local-transcription"><StagedStatusFilter groups={groups} value={value} open={open}
    optionPresentation={presentation === 'default' ? undefined : presentation}
    onCommit={next => {if(commit(next) === false)return false; setValue(next);}}
    onOpenChange={next => {if(!hold)setOpen(next);}}/></div>;
}
function input(name: string) {return screen.getByRole('checkbox',{name}) as HTMLInputElement;}
function assertOption(name: string, checked: boolean) {
  const control=input(name), row=control.parentElement!;
  expect(control.checked).toBe(checked);
  expect(screen.getByLabelText(name, {exact:true})).toBe(control);
  expect(control.type).toBe('checkbox');
  expect(control.tabIndex).toBe(0);
  expect(control.hasAttribute('hidden')).toBe(false);
  expect(control.hasAttribute('aria-hidden')).toBe(false);
  expect(row.tagName).toBe('LABEL');
  expect([...row.children].map(el=>el.tagName.toUpperCase())).toEqual(checked?['INPUT','SPAN','SVG']:['INPUT','SPAN']);
  expect(row.children[1].textContent).toBe(name);
  expect(row.children[1].className).toBe('staged-status-filter__text');
  const check=row.querySelector('.staged-status-filter__check');
  expect(Boolean(check)).toBe(checked);
  if(check) {expect(check).toBe(row.lastElementChild);expect(check.getAttribute('aria-hidden')).toBe('true');expect(check.textContent).toBe('');expect(check.getAttribute('focusable')).toBe('false');expect(check.querySelector('path')).toBeTruthy();}
}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();history.replaceState(null,'','/');});

it('shows only All checked initially; one and multiple draft choices own trailing decorative marks',()=>{
  render(<Harness/>);
  expect(screen.getAllByRole('checkbox')).toHaveLength(3);
  assertOption('All',true);assertOption('Ready',false);assertOption('Failed',false);
  fireEvent.click(input('Ready'));assertOption('All',false);assertOption('Ready',true);assertOption('Failed',false);
  fireEvent.click(input('Failed'));assertOption('All',false);assertOption('Ready',true);assertOption('Failed',true);
  fireEvent.click(input('Ready'));assertOption('Ready',false);assertOption('Failed',true);
  fireEvent.click(input('All'));assertOption('All',true);assertOption('Ready',false);assertOption('Failed',false);
  expect(screen.getByLabelText('0 selected filters')).toBeTruthy();
});

it('retains default native input-plus-text DOM with no variant class or decorative mark',()=>{
  const {container}=render(<Harness presentation="default" initial={['ready']}/>);
  expect(container.querySelector('[class*=staged-status-filter]')).toBeNull();
  for(const name of ['All','Ready','Failed']) {
    const row=input(name).parentElement!;
    expect(row.childNodes).toHaveLength(2);expect(row.firstElementChild).toBe(input(name));
    expect(row.lastChild?.nodeType).toBe(Node.TEXT_NODE);expect(row.lastChild?.textContent).toBe(name);
  }
  expect(input('Ready').checked).toBe(true);
});

it('retains native tab order, Space toggle, label activation, Escape and opener focus in jsdom',async()=>{
  const user=userEvent.setup();render(<Harness/>);
  expect(document.activeElement).toBe(screen.getByRole('dialog'));
  await user.tab();expect(document.activeElement).toBe(input('All'));
  await user.tab();expect(document.activeElement).toBe(input('Ready'));
  await user.keyboard('[Space]');assertOption('Ready',true);
  await user.click(input('Failed').parentElement!);assertOption('Failed',true);
  await user.keyboard('{Escape}');expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button',{name:/Filter/}));
  await user.keyboard('[Enter]');assertOption('All',true);assertOption('Ready',false);assertOption('Failed',false);
});

it('reset edits only the draft, cancel keeps committed state, and confirm reuses the existing callback',()=>{
  const commit=vi.fn();render(<Harness initial={['ready']} commit={commit}/>);
  fireEvent.click(screen.getByText('Reset'));assertOption('All',true);
  expect(commit).not.toHaveBeenCalled();expect(screen.getByLabelText('1 selected filters')).toBeTruthy();
  fireEvent.click(screen.getByText('Cancel'));fireEvent.click(screen.getByRole('button',{name:/Filter/}));
  assertOption('Ready',true);fireEvent.click(input('Failed'));fireEvent.click(screen.getByText('Confirm'));
  expect(commit).toHaveBeenCalledExactlyOnceWith({status:['ready','failed']});
  expect(screen.queryByRole('dialog')).toBeNull();expect(screen.getByLabelText('2 selected filters')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:/Filter/}));assertOption('Ready',true);assertOption('Failed',true);
});

it('pending close keeps native fieldset disabling, draft marks and one-shot confirmation',async()=>{
  const user=userEvent.setup(),commit=vi.fn();render(<Harness commit={commit} hold/>);
  await user.click(input('Ready'));await user.click(screen.getByText('Confirm'));
  const fieldset=input('Ready').closest('fieldset')!;
  expect(fieldset.disabled).toBe(true);expect(input('Ready').matches(':disabled')).toBe(true);
  await user.click(input('Failed').parentElement!);assertOption('Ready',true);assertOption('Failed',false);
  expect((screen.getByText('Reset') as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByText('Confirm') as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByText('Confirm'));expect(commit).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/Close requested/)).toBeTruthy();
});

it('rejected commit retains the editable native inputs and selected-only marks',()=>{
  const commit=vi.fn(()=>false);render(<Harness commit={commit}/>);
  fireEvent.click(input('Ready'));fireEvent.click(screen.getByText('Confirm'));
  expect(screen.getByRole('alert').textContent).toContain('not accepted');
  expect(input('Ready').matches(':disabled')).toBe(false);assertOption('Ready',true);
  fireEvent.click(input('Failed'));assertOption('Failed',true);
  expect(screen.getByLabelText('0 selected filters')).toBeTruthy();
});

it('external committed changes update the badge but not draft marks; cancel keeps the latest value',()=>{
  const change=vi.fn(),commit=vi.fn();
  const props={groups,open:true,onOpenChange:change,onCommit:commit,optionPresentation:'trailing-check' as const};
  const view=render(<StagedStatusFilter {...props} value={{status:['ready']}}/>);
  view.rerender(<StagedStatusFilter {...props} value={{status:['failed']}}/>);
  assertOption('Ready',true);assertOption('Failed',false);
  expect(screen.getByText(/Committed filters changed/)).toBeTruthy();
  fireEvent.click(screen.getByText('Cancel'));expect(commit).not.toHaveBeenCalled();expect(change).toHaveBeenCalledWith(false,'cancel');
  view.rerender(<StagedStatusFilter {...props} open={false} value={{status:['failed']}}/>);
  view.rerender(<StagedStatusFilter {...props} value={{status:['failed']}}/>);
  assertOption('Ready',false);assertOption('Failed',true);
});

it('CSS source scopes every new rule and declares the two audited colors plus a visible-focus rule',()=>{
  const css=statusCss;
  const addition=css.slice(css.indexOf('/* Transcription-only opt-in:'));
  const style=document.createElement('style');style.textContent=addition;document.head.append(style);
  try {
    const rules=[...style.sheet!.cssRules] as CSSStyleRule[];
    expect(rules.length).toBe(6);
    for(const rule of rules)for(const selector of rule.selectorText.split(','))expect(selector.trim()).toMatch(/^\.local-transcription \.staged-status-filter--trailing-check/);
    const row=rules.find(r=>r.selectorText.endsWith('> label'))!;
    expect(row.style.getPropertyValue('display')).toBe('flex');expect(row.style.getPropertyValue('color')).toBe('rgb(25, 26, 29)');
    const text=rules.find(r=>r.selectorText.endsWith('.staged-status-filter__text')&&!r.selectorText.includes(':checked'))!;
    expect(text.style.getPropertyValue('flex-grow')).toBe('1');
    const selected=rules.find(r=>r.selectorText.includes('input:checked'))!;
    expect(selected.selectorText).toContain('.staged-status-filter__check');expect(selected.style.getPropertyValue('color')).toBe('rgb(42, 102, 246)');
    const hidden=rules.find(r=>r.selectorText.endsWith('input[type=checkbox]'))!;
    expect(hidden.style.getPropertyValue('position')).toBe('absolute');expect(hidden.style.getPropertyValue('clip-path')).toBe('inset(50%)');
    expect(hidden.style.getPropertyValue('display')).not.toBe('none');expect(hidden.style.getPropertyValue('visibility')).not.toBe('hidden');
    const focus=rules.find(r=>r.selectorText.endsWith('label:focus-within'))!;
    expect(focus.style.getPropertyValue('outline')).toMatch(/^2px solid (?:#2A66F6|rgb\(42, 102, 246\))$/i);
    expect(addition).toContain('color:#191A1D');expect(addition).toContain('color:#2A66F6');
  } finally {style.remove();}
});

it('actual transcription owner opts in while preserving its labels and checked All row',async()=>{
  history.replaceState(null,'',fixtureStoreUrl());
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,headers:fixtureStoreHeaders(),json:async()=>({jobs:[],total:0,hasMore:false,activeJobCount:0,model:{maxSeconds:7200,maxBytes:268435456,chunkSeconds:30,overlapSeconds:1,deadlineSeconds:14400}})})));
  render(<LocalTranscription/>);await screen.findByText('还没有转写记录');
  fireEvent.click(screen.getByRole('button',{name:/状态筛选/}));
  const dialog=screen.getByRole('dialog',{name:'筛选任务状态'});
  expect(dialog.querySelector('fieldset')?.className).toBe('staged-status-filter--trailing-check');
  expect(within(dialog).getAllByRole('checkbox')).toHaveLength(6);
  assertOption('全部状态',true);assertOption('转写完成',false);
});

it('actual recent-materials owner retains native default markup, even beside an opted-in owner',async()=>{
  const scope='11111111-1111-4111-8111-111111111111';
  vi.stubGlobal('fetch',vi.fn(async(input:string)=>{
    const url=new URL(input,'http://localhost');
    const value=url.pathname==='/api/documents/choices'?{uploadScope:scope}:url.pathname==='/api/local-asr/identity'?{transcriptionStoreId:scope}:url.pathname==='/api/documents'?{storeScope:scope,total:0,offset:0,limit:10,documents:[]}:{total:0,offset:0,limit:10,hasMore:false,jobs:[]};
    return new Response(JSON.stringify(value),{headers:{'X-Transcription-Store-Id':scope}});
  }));
  const view=render(<><Harness/><LocalRecentMaterials/></>);
  await screen.findByText('暂无未删除的本地转写记录。');
  fireEvent.click(screen.getByRole('button',{name:/转写状态筛选/}));
  const dialog=screen.getByRole('dialog',{name:'筛选近期转写状态'});
  expect(dialog.querySelector('[class*=staged-status-filter]')).toBeNull();
  const row=within(dialog).getByRole('checkbox',{name:'全部状态'}).parentElement!;
  expect(row.childNodes).toHaveLength(2);expect(row.lastChild?.nodeType).toBe(Node.TEXT_NODE);
  expect(view.container.querySelectorAll('.staged-status-filter--trailing-check')).toHaveLength(1);
});
