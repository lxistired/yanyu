/** Bound browser waiting, not server execution. Never retries or settles a journal. */
export const DOCUMENT_UPLOAD_ATTEMPT_TIMEOUT_MS=30_000;
export class DocumentUploadAttemptTimeoutError extends Error {
 constructor(){super('本次等待已超时。现有恢复记录和文件选择已保留；若有待核对的上传，请先核对结果。不会自动重传，停止等待也不代表服务端操作已取消。');}
}

/** One opt-in upload/check/retry attempt, including file preparation, headers and body.
 * Abort is only a local stop signal. An uncooperative transport may finish later;
 * callers must fence every post-await mutation with this controller's ownership.
 */
export function runDocumentUploadAttempt<T>(controller:AbortController,work:()=>Promise<T>):Promise<T>{
 return new Promise<T>((resolve,reject)=>{
  let settled=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const settle=(complete:()=>void)=>{
   if(settled)return;
   settled=true;clearTimeout(timer);controller.signal.removeEventListener('abort',aborted);complete();
  };
  const aborted=()=>settle(()=>reject(new DOMException('Upload attempt stopped','AbortError')));
  controller.signal.addEventListener('abort',aborted,{once:true});
  if(controller.signal.aborted){aborted();return;}
  timer=setTimeout(()=>{
   // Fence late work before promise continuations run. No cancellation-of-commit claim.
   settle(()=>reject(new DocumentUploadAttemptTimeoutError()));controller.abort();
  },DOCUMENT_UPLOAD_ATTEMPT_TIMEOUT_MS);
  try{work().then(value=>settle(()=>resolve(value)),error=>settle(()=>reject(error)));}
  catch(error){settle(()=>reject(error));}
 });
}
