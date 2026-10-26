import React from 'react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {OrganizationManager} from '../candidate/src/components/OrganizationManager';
import {AutomationManager} from '../candidate/src/components/AutomationManager';
import {organizationApi} from '../candidate/src/adapters/organization';
import {automationApi} from '../candidate/src/adapters/automation';

vi.mock('../candidate/src/components/ServiceReportsEntry', () => ({ServiceReportsEntry: () => null}));
beforeEach(() => {
  vi.spyOn(organizationApi, 'list').mockResolvedValue({items:[],nextOffset:null} as never);
  for (const method of ['listSkills','listDataSources','listSchedules','listRuns','listNotifications'] as const) vi.spyOn(automationApi, method).mockResolvedValue([]);
});
afterEach(() => {cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
for (const manager of ['organization','automation'] as const) {
  it.each(['network','malformed-2xx','structured-409'] as const)(`${manager}: %s unknown result retains same idempotency key on same-content retry`, async failure => {
    const dispatched: Record<string,unknown>[] = [];
    vi.stubGlobal('fetch',vi.fn(async (_url: string, init: RequestInit) => {
      dispatched.push(JSON.parse(String(init.body)));
      if(failure === 'network') throw new TypeError('synthetic lost receipt');
      return new Response(failure === 'malformed-2xx' ? '{' : JSON.stringify({error:{code:'CONFLICT',message:'synthetic conflict',retryable:false}}),{status:failure === 'malformed-2xx' ? 200 : 409});
    }));
    render(manager === 'organization' ? <OrganizationManager/> : <AutomationManager definitionsOnly/>);
    if(manager === 'automation') fireEvent.click(screen.getByRole('button',{name:'技能',exact:true}));
    const createLabel = manager === 'organization' ? '新建机构' : '新建技能';
    await waitFor(() => expect((screen.getByRole('button',{name:createLabel}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button',{name:createLabel}));
    const field = screen.getByLabelText(manager === 'organization' ? '机构名称 *' : '技能名称');
    fireEvent.change(field,{target:{value:'Synthetic same request'}});
    const form = field.closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => expect(dispatched).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByText(/请求结果尚未确认|提交结果未确认/).length).toBeGreaterThan(0));
    const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.submit(form);
    await waitFor(() => expect(dispatched).toHaveLength(2));
    expect(dispatched[0].idempotencyKey).toBeTruthy();
    expect(dispatched[1]).toEqual(dispatched[0]);
  });
}
