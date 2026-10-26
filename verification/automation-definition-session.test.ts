import {it,expect,vi} from 'vitest';
import {AutomationDefinitionWriteSession,captureAutomationDefinitionCommand} from '../candidate/src/components/automation-definition-write-session';
import {ApiError} from '../candidate/src/adapters/api';
const row={id:'a',kind:'skill',revision:1,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',deletedAt:null,data:{name:'A',description:'',handler:'local-checkpoint',enabled:false},availability:{status:'unavailable',code:'none',detail:'not connected',capabilities:[]}};
const input={name:'A',handler:'local-checkpoint'};
it('keeps immutable original and blocks different input after unknown, retry notsent cannot release',async()=>{
 const createSkill=vi.fn().mockRejectedValueOnce(Error('unknown')).mockRejectedValueOnce(new ApiError({code:'CANCELLED',message:'no',retryable:false},'not-sent')).mockResolvedValue(row);
 const api={createSkill,listSkills:vi.fn().mockResolvedValue([row])};const s=new AutomationDefinitionWriteSession(api as never);const c=captureAutomationDefinitionCommand('createSkill',input,{message:'saved'},'original-key');await s.submit(c);
 await expect(s.submit(captureAutomationDefinitionCommand('createSkill',{...input,name:'B'},{message:'saved'},'new-key'))).rejects.toThrow();expect(createSkill).toHaveBeenCalledTimes(1);await s.recover();expect(s.pending?.phase).toBe('unknown');await s.recover();expect(s.pending).toBeNull();expect(createSkill.mock.calls.every(([x])=>x.idempotencyKey==='original-key')).toBe(true);
});
it('ACK then failed current-read retries only read, deleted current revision +2 accepted',async()=>{
 const current={...row,revision:3,deletedAt:'2026-01-02T00:00:00Z'};const api={createSkill:vi.fn().mockResolvedValue(row),listSkills:vi.fn().mockResolvedValueOnce([]).mockResolvedValue([current])};const s=new AutomationDefinitionWriteSession(api as never);await s.submit(captureAutomationDefinitionCommand('createSkill',input,{message:'saved'}));expect(s.pending?.phase).toBe('readback-failed');const done=await s.recover();expect(done?.record.revision).toBe(3);expect(api.createSkill).toHaveBeenCalledTimes(1);
});
it.each([[row,row],Array.from({length:101},(_,i)=>({...row,id:'x'+i})),[{...row,data:{}}]])('fails closed duplicate, overbudget and invalid DTO',async rows=>{
 const api={createSkill:vi.fn().mockResolvedValue(row),listSkills:vi.fn().mockResolvedValue(rows)};const s=new AutomationDefinitionWriteSession(api as never);await s.submit(captureAutomationDefinitionCommand('createSkill',input,{message:'saved'}));expect(s.pending?.phase).toBe('readback-failed');
});
it('detached session ignores late ACK and cannot be revived',async()=>{let resolve!:(v:unknown)=>void;const api={createSkill:vi.fn(()=>new Promise(r=>resolve=r)),listSkills:vi.fn()};const s=new AutomationDefinitionWriteSession(api as never);const p=s.submit(captureAutomationDefinitionCommand('createSkill',input,{message:'saved'}));s.detach();resolve(row);await p;expect(api.listSkills).not.toHaveBeenCalled();expect(()=>s.recover()).toThrow();});
it('rejects fabricated mutable command and preserves captured immutable body',async()=>{const api={createSkill:vi.fn(),listSkills:vi.fn()};const s=new AutomationDefinitionWriteSession(api as never);const c=captureAutomationDefinitionCommand('createSkill',input,{message:'saved'});await expect(s.submit({...c})).rejects.toThrow('快照');expect(api.createSkill).not.toHaveBeenCalled();expect(Object.isFrozen(c)).toBe(true);});
it('capture rejects metadata override of immutable operation/body/key bindings',()=>{expect(()=>captureAutomationDefinitionCommand('createSkill',input,{message:'saved',operation:'runNow'} as never)).toThrow();expect(()=>captureAutomationDefinitionCommand('createSkill',input,{get message(){return 'saved';}})).toThrow();});
