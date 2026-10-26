import React from 'react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {render,screen,cleanup,act} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {ServiceRecordProjectionPanel} from '../candidate/src/components/OrganizationManager';
import {serviceRecordBridgeApi} from '../candidate/src/adapters/organization';
vi.mock('../candidate/src/adapters/organization',()=>({organizationApi:{},serviceRecordBridgeApi:{preview:vi.fn(),import:vi.fn()}}));
const projection={source:{id:'source-1',revision:1,sha256:'a'.repeat(64),recordJson:'{}'},customerPin:{organizationId:'org-1',contactId:null,organizationRevision:1,contactRevision:null},projection:{customer:{organizationId:'org-1',contactId:null},kind:'call',occurredAt:'2026-10-03T00:00:00.000Z',summary:'Synthetic fact'},existing:null,token:'token',syntheticSourcePin:{documentId:'synthetic-doc',revisionId:'v1'},warning:'手动登记，未验证'};
beforeEach(()=>{vi.mocked(serviceRecordBridgeApi.preview).mockResolvedValue(projection as any);vi.mocked(serviceRecordBridgeApi.import).mockResolvedValue({activity:{id:'activity-1',revision:1}} as any)});
afterEach(()=>{cleanup();vi.resetAllMocks();vi.restoreAllMocks()});
async function preview(){const user=userEvent.setup();render(<ServiceRecordProjectionPanel mode={{mode:'legacy-synthetic'}} sourceId="source-1"/>);await user.click(screen.getByRole('button',{name:'预览计入月报'}));await screen.findByText('确认来源投影');return user}
async function choices(user:ReturnType<typeof userEvent.setup>){await user.selectOptions(screen.getByLabelText('投影活动状态'),'reported-completed');await user.selectOptions(screen.getByLabelText('投影文档来源'),'synthetic')}
it('does not read or write until explicit preview and never supplies defaults',async()=>{render(<ServiceRecordProjectionPanel mode={{mode:'legacy-synthetic'}} sourceId="source-1"/>);expect(serviceRecordBridgeApi.preview).not.toHaveBeenCalled();expect(serviceRecordBridgeApi.import).not.toHaveBeenCalled();await userEvent.click(screen.getByRole('button',{name:'预览计入月报'}));await screen.findByText('确认来源投影');expect((screen.getByLabelText('投影活动状态') as HTMLSelectElement).value).toBe('');expect((screen.getByLabelText('投影文档来源') as HTMLSelectElement).value).toBe('');expect((screen.getByRole('button',{name:'确认计入月报活动'}) as HTMLButtonElement).disabled).toBe(true)});
it('requires both explicit choices and submits exact preview token',async()=>{const user=await preview();await user.selectOptions(screen.getByLabelText('投影活动状态'),'planned');expect((screen.getByRole('button',{name:'确认计入月报活动'}) as HTMLButtonElement).disabled).toBe(true);await choices(user);await user.click(screen.getByRole('button',{name:'确认计入月报活动'}));expect(serviceRecordBridgeApi.import).toHaveBeenCalledWith({sourceId:'source-1',token:'token',status:'reported-completed',sourcePin:projection.syntheticSourcePin,reason:''},expect.any(AbortSignal));await screen.findByText(/已保存月报活动/)});
it('confirmed discard clears preview and choices without importing',async()=>{vi.spyOn(window,'confirm').mockReturnValue(true);const user=await preview();await choices(user);await user.click(screen.getByRole('button',{name:'取消预览'}));expect(screen.queryByText('确认来源投影')).toBeNull();expect(serviceRecordBridgeApi.import).not.toHaveBeenCalled();await user.click(screen.getByRole('button',{name:'预览计入月报'}));await screen.findByText('确认来源投影');expect((screen.getByLabelText('投影活动状态') as HTMLSelectElement).value).toBe('')});
it('source correction requires a reason and retains explicit choices',async()=>{vi.mocked(serviceRecordBridgeApi.preview).mockResolvedValue({...projection,source:{...projection.source,revision:2},existing:{id:'activity-1',revision:1,sourceRevision:1,archivedAt:null}} as any);const user=await preview();await choices(user);expect((screen.getByRole('button',{name:'确认更正原活动'}) as HTMLButtonElement).disabled).toBe(true);await user.type(screen.getByLabelText('投影更正原因'),'Correction');await user.click(screen.getByRole('button',{name:'确认更正原活动'}));expect(serviceRecordBridgeApi.import).toHaveBeenCalledWith(expect.objectContaining({reason:'Correction'}),expect.any(AbortSignal))});
it('archived projection cannot be imported',async()=>{vi.mocked(serviceRecordBridgeApi.preview).mockResolvedValue({...projection,existing:{id:'activity-1',revision:2,sourceRevision:1,archivedAt:'2026-10-15'}} as any);const user=await preview();await choices(user);expect((screen.getByRole('button',{name:'确认计入月报活动'}) as HTMLButtonElement).disabled).toBe(true);expect(serviceRecordBridgeApi.import).not.toHaveBeenCalled()});
it('repeat clicking while write is pending submits once and late result after confirmed close is ignored',async()=>{vi.spyOn(window,'confirm').mockReturnValue(true);let resolve!:(v:any)=>void;vi.mocked(serviceRecordBridgeApi.import).mockImplementation(()=>new Promise(r=>resolve=r));const user=await preview();await choices(user);await user.dblClick(screen.getByRole('button',{name:'确认计入月报活动'}));expect(serviceRecordBridgeApi.import).toHaveBeenCalledTimes(1);await user.click(screen.getByRole('button',{name:'取消预览'}));await act(async()=>resolve({activity:{id:'late',revision:1}}));expect(screen.queryByText(/late/)).toBeNull()});
it('reports duplicate success without claiming another record',async()=>{vi.mocked(serviceRecordBridgeApi.import).mockResolvedValue({activity:{id:'activity-1',revision:1},unchanged:true} as any);const user=await preview();await choices(user);await user.click(screen.getByRole('button',{name:'确认计入月报活动'}));await screen.findByText(/已存在，未重复计入/)});
it('uncertain failure advises safe re-preview and keeps inputs for review',async()=>{vi.mocked(serviceRecordBridgeApi.import).mockRejectedValue(new Error('Offline'));const user=await preview();await choices(user);await user.click(screen.getByRole('button',{name:'确认计入月报活动'}));await screen.findByRole('alert');expect(screen.getByRole('alert').textContent).toContain('重新预览');expect((screen.getByLabelText('投影活动状态') as HTMLSelectElement).value).toBe('reported-completed')});

import {requireServiceActivityInput} from '../candidate/src/adapters/service-reports';
const baseActivity={customer:{organizationId:'org-1',contactId:null},kind:'call',status:'planned',occurredAt:'2026-10-03T00:00:00.000Z',summary:'Synthetic',references:[{pin:{documentId:'synthetic-doc',revisionId:'v1',tenantId:'tenant',collectionId:'collection',sha256:'a'.repeat(64)}}]};
it('report adapter accepts ordinary activities without projection provenance',()=>{expect(requireServiceActivityInput(baseActivity)).toEqual(baseActivity)});
it('report adapter preserves valid projection provenance and rejects malformed identity',()=>{const ordinarySource={id:'source-1',revision:1,sha256:'b'.repeat(64),recordJson:JSON.stringify({id:'source-1',revision:1,kind:'service-record'})};expect(requireServiceActivityInput({...baseActivity,ordinarySource}).ordinarySource).toEqual(ordinarySource);expect(()=>requireServiceActivityInput({...baseActivity,ordinarySource:{...ordinarySource,id:'forged'}})).toThrow()});

import {allowLeavingUnsavedWork} from '../candidate/src/components/unsaved-work';
it('dirty projection Stay preserves selections on cancel and re-preview without another request',async()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const user=await preview();await choices(user);
 await user.click(screen.getByRole('button',{name:'取消预览'}));
 await user.click(screen.getByRole('button',{name:'预览计入月报'}));
 expect(confirm).toHaveBeenCalledTimes(2);
 expect((screen.getByLabelText('投影活动状态') as HTMLSelectElement).value).toBe('reported-completed');
 expect((screen.getByLabelText('投影文档来源') as HTMLSelectElement).value).toBe('synthetic');
 expect(serviceRecordBridgeApi.preview).toHaveBeenCalledTimes(1);expect(serviceRecordBridgeApi.import).not.toHaveBeenCalled();
});
it('projection failed save preserves guard and successful retry clears it',async()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 vi.mocked(serviceRecordBridgeApi.import).mockRejectedValueOnce(new Error('Synthetic offline'));
 const user=await preview();await choices(user);await user.click(screen.getByRole('button',{name:'确认计入月报活动'}));
 await screen.findByRole('alert');expect(allowLeavingUnsavedWork()).toBe(false);
 await user.click(screen.getByRole('button',{name:'确认计入月报活动'}));await screen.findByText(/已保存月报活动/);
 confirm.mockClear();expect(allowLeavingUnsavedWork()).toBe(true);expect(confirm).not.toHaveBeenCalled();
});
it('projection correction reason alone is dirty and explicit re-preview clears only after approval',async()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 vi.mocked(serviceRecordBridgeApi.preview).mockResolvedValue({...projection,source:{...projection.source,revision:2},existing:{id:'activity-1',revision:1,sourceRevision:1,archivedAt:null}} as any);
 const user=await preview();await user.type(screen.getByLabelText('投影更正原因'),'Synthetic correction draft');
 expect(allowLeavingUnsavedWork()).toBe(false);await user.click(screen.getByRole('button',{name:'预览计入月报'}));
 expect((screen.getByLabelText('投影更正原因') as HTMLInputElement).value).toBe('Synthetic correction draft');
 confirm.mockReturnValue(true);await user.click(screen.getByRole('button',{name:'预览计入月报'}));await screen.findByText('确认来源投影');
 expect((screen.getByLabelText('投影更正原因') as HTMLInputElement).value).toBe('');confirm.mockClear();expect(allowLeavingUnsavedWork()).toBe(true);expect(confirm).not.toHaveBeenCalled();
});
it('clean projection preview closes without prompting or submitting',async()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const user=await preview();await user.click(screen.getByRole('button',{name:'取消预览'}));
 expect(confirm).not.toHaveBeenCalled();expect(serviceRecordBridgeApi.import).not.toHaveBeenCalled();expect(allowLeavingUnsavedWork()).toBe(true);
});

it('missing projection context fails closed instead of selecting legacy synthetic mode',()=>{render(<ServiceRecordProjectionPanel sourceId="source-1"/>);expect(screen.getByText(/不会改用合成通道/)).toBeTruthy();expect(serviceRecordBridgeApi.preview).not.toHaveBeenCalled();expect(serviceRecordBridgeApi.import).not.toHaveBeenCalled();});
