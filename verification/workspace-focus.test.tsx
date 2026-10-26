import {writeUnsavedHistory} from '../candidate/src/components/unsaved-work';
import React from 'react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {WorkspaceManager} from '../candidate/src/components/WorkspaceManager';
import {workspaceApi} from '../candidate/src/adapters/workspace';

vi.mock('../candidate/src/adapters/workspace', () => ({workspaceApi: {list: vi.fn(), update: vi.fn(), get:vi.fn()}}));
const record = (name = 'Original', revision = 1) => ({
  kind: 'workspace', id: 'workspace-focus', revision,
  data: {name, description: '', parentId: null},
  createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', deletedAt: null,
});
const page = (name = 'Original', revision = 1) => ({items: [record(name, revision)], total: 1, nextOffset: null});
let finishReload: () => void;
beforeEach(() => {
  vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Synthetic linked-transcript identity is unavailable'));
  let saved = false;
  vi.mocked(workspaceApi.get).mockImplementation(async()=>record(saved?'Edited':'Original',saved?2:1) as never);
  vi.mocked(workspaceApi.update).mockImplementation(async () => {
    saved = true;
    return record('Edited', 2) as any;
  });
  vi.mocked(workspaceApi.list).mockImplementation(async (request) => {
    if (request.limit === 200)
      return (request.kind === 'workspace' ? page(saved ? 'Edited' : 'Original') : {items: [], total: 0, nextOffset: null}) as any;
    if (!saved) return page() as any;
    return new Promise(resolve => {finishReload = () => resolve(page('Edited', 2) as any);});
  });
});
afterEach(() => {cleanup(); vi.clearAllMocks(); vi.restoreAllMocks();});
async function saveEdit() {
  const user = userEvent.setup();
  render(<><button>Outside</button><WorkspaceManager /></>);
  const trigger = await screen.findByRole('button', {name: '编辑 Original'});
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
  await user.click(trigger);
  const name = screen.getByRole('textbox', {name: '工作区名称'});
  await user.clear(name);
  await user.type(name, 'Edited');
  await user.click(screen.getByRole('button', {name: '保存工作区'}));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(trigger.isConnected).toBe(false));
  return {user, trigger};
}
describe('actual workspace editor reload focus', () => {
  it('keeps Escape cancellation on the original edit trigger without saving', async () => {
    const user = userEvent.setup();
    render(<WorkspaceManager />);
    const trigger = await screen.findByRole('button', {name: '编辑 Original'});
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(workspaceApi.update).not.toHaveBeenCalled();
  });

  it('restores the edited record button after its old DOM row is removed', async () => {
    const {trigger} = await saveEdit();
    await act(async () => finishReload());
    const updated = await screen.findByRole('button', {name: '编辑 Edited'});
    expect(updated).not.toBe(trigger);
    await waitFor(() => expect(document.activeElement).toBe(updated));
  });
  it('does not steal focus chosen elsewhere while reload is pending', async () => {
    const {user} = await saveEdit();
    const outside = screen.getByRole('button', {name: 'Outside'});
    await user.click(outside);
    await act(async () => finishReload());
    await screen.findByRole('button', {name: '编辑 Edited'});
    expect(document.activeElement).toBe(outside);
  });
  it('cancels pending focus on navigation even when focus is left on body', async () => {
    await saveEdit();
    act(()=>prepareOwnedHistory('/?navigation=synthetic'));
    await historyBack();
    await act(async () => finishReload());
    await screen.findByRole('button', {name: '编辑 Edited'});
    expect(document.activeElement).toBe(document.body);
  });
});

it('cancelled dirty-editor close keeps actual workspace draft and focusable controls', async () => {
 const user=userEvent.setup();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 render(<WorkspaceManager/>);const trigger=await screen.findByRole('button',{name:'编辑 Original'});
 await waitFor(()=>expect((trigger as HTMLButtonElement).disabled).toBe(false));await user.click(trigger);
 const input=screen.getByLabelText('工作区名称');await user.clear(input);await user.type(input,'Unsaved');
 await user.keyboard('{Escape}');expect(confirm).toHaveBeenCalled();expect(screen.getByDisplayValue('Unsaved')).toBeTruthy();expect(screen.getByRole('dialog')).toBeTruthy();
 confirm.mockReturnValue(true);await user.click(screen.getByRole('button',{name:'关闭',exact:true}));expect(screen.queryByRole('dialog')).toBeNull();confirm.mockRestore();
});

function prepareOwnedHistory(target:string){const current=location.href;writeUnsavedHistory(target);writeUnsavedHistory(current)}
async function historyBack(){await act(async()=>{history.back();await new Promise(r=>setTimeout(r,65))})}
