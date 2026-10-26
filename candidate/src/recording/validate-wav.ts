import {POLICY,type Draft} from './recording-draft-store';
// Store integrity is format-agnostic. Never relabel an arbitrary restored Blob as PCM WAV.
export async function isOwnedPcmWav(draft:Pick<Draft,'mimeType'|'blob'|'size'|'durationSeconds'>):Promise<boolean> {
 try {
  if(draft.mimeType!=='audio/wav'||draft.blob.type!=='audio/wav'||draft.blob.size!==draft.size||draft.size<46||draft.size>POLICY.maxBytes)return false;
  const bytes=await draft.blob.arrayBuffer();
  if(bytes.byteLength!==draft.size)return false;
  const view=new DataView(bytes),tag=(at:number)=>String.fromCharCode(...new Uint8Array(bytes,at,4));
  const frames=(bytes.byteLength-44)/2;
  return Number.isSafeInteger(frames)&&frames>0&&frames<=16000*POLICY.maxSeconds&&draft.durationSeconds===frames/16000&&
   tag(0)==='RIFF'&&view.getUint32(4,true)===bytes.byteLength-8&&tag(8)==='WAVE'&&tag(12)==='fmt '&&view.getUint32(16,true)===16&&
   view.getUint16(20,true)===1&&view.getUint16(22,true)===1&&view.getUint32(24,true)===16000&&view.getUint32(28,true)===32000&&
   view.getUint16(32,true)===2&&view.getUint16(34,true)===16&&tag(36)==='data'&&view.getUint32(40,true)===bytes.byteLength-44;
 } catch {return false;}
}
