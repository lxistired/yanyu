import {parseManualInventoryExecuteRequest,type ManualInventoryExecuteRequest} from '../../shared/manual-inventory-protocol';
export type ManualInventoryJournalRecord=Readonly<{envelope:ManualInventoryExecuteRequest;requestDigest:string}>;
export interface ManualInventoryJournal {read(owner:string,automation:string):ManualInventoryJournalRecord|null;save(record:ManualInventoryJournalRecord):void;remove(record:ManualInventoryJournalRecord):void;}
const prefix='yanyu.manual-inventory.v1:';
function key(owner:string,automation:string){if(!/^[a-f0-9]{64}$/.test(owner)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(automation))throw Error('恢复身份无效');return prefix+owner+':'+automation;}
function decode(raw:string):ManualInventoryJournalRecord{
 if(raw.length>8192||new TextEncoder().encode(raw).length>8192)throw Error('恢复记录超出限制');
 const value=JSON.parse(raw),envelope=parseManualInventoryExecuteRequest(value?.envelope);
 if(!value||Object.keys(value).sort().join(',')!=='envelope,requestDigest'||!envelope||typeof value.requestDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.requestDigest))throw Error('恢复记录无法验证；请先查看历史，勿新建重复运行');
 return Object.freeze({envelope,requestDigest:value.requestDigest});
}
/** Same-tab sessionStorage only. No document rows, names, result payloads or instructions. */
export function createManualInventoryJournal(storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>):ManualInventoryJournal{return {
 read(owner,automation){const raw=storage.getItem(key(owner,automation));if(raw===null)return null;const record=decode(raw);if(record.envelope.identityScope!==owner||record.envelope.automationStoreScope!==automation)throw Error('恢复记录身份不匹配');return record;},
 save(record){const name=key(record.envelope.identityScope,record.envelope.automationStoreScope),raw=JSON.stringify(record),checked=decode(raw),existing=storage.getItem(name);if(existing!==null&&existing!==raw)throw Error('仍有原操作需要核对');if(checked.envelope.operationId!==record.envelope.operationId)throw Error('恢复记录无效');storage.setItem(name,raw);if(storage.getItem(name)!==raw)throw Error('恢复记录未可靠保存，本次未发送');},
 remove(record){const name=key(record.envelope.identityScope,record.envelope.automationStoreScope),raw=storage.getItem(name);if(raw!==JSON.stringify(record))throw Error('恢复记录已变化，未清除');storage.removeItem(name);if(storage.getItem(name)!==null)throw Error('恢复记录未清除');},
};}
export const browserManualInventoryJournal:ManualInventoryJournal={
 read:(o,a)=>createManualInventoryJournal(window.sessionStorage).read(o,a),
 save:r=>createManualInventoryJournal(window.sessionStorage).save(r),
 remove:r=>createManualInventoryJournal(window.sessionStorage).remove(r),
};
