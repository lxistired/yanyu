// Original upload identity only. This is not proof of valid/decodable audio,
// completed recognition, or pinned model/package identity.
export const uploadSettingsProfile='local-asr-upload-v1';
const exactKeys=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
// This profile describes requested settings, not verified installed model weights.
export const requestedRecognizer={model:'faster-whisper-small',device:'cpu',computeType:'int8',beamSize:5,temperature:0,vadFilter:false,conditionOnPreviousText:false,wordTimestamps:true,cpuThreads:4,numWorkers:1,windowSeconds:30,strideSeconds:29,seedPolicy:'ctranslate2-sha256-source-chunk-v1'};
const formats={'audio/wav':'wav','audio/mpeg':'mp3','audio/mp4':'mov','audio/ogg':'ogg'};
export const validUploadOperationId=value=>typeof value==='string'&&value.length===36&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
// Absent is the legacy protocol, not a fallback for a malformed keyed request.
export function parseUploadOperationId(headers,rawHeaders){
 const keys=Object.keys(headers).filter(key=>key.toLowerCase()==='x-upload-operation-id');
 if(rawHeaders!==undefined&&(!Array.isArray(rawHeaders)||rawHeaders.length%2||!rawHeaders.every(value=>typeof value==='string')))return null;
 const raw=[];for(let i=0;i<(rawHeaders?.length??0);i+=2)if(rawHeaders[i].toLowerCase()==='x-upload-operation-id')raw.push(rawHeaders[i+1]);
 if(!keys.length&&!raw.length)return undefined;
 if(keys.length!==1||raw.length>1)return null;
 const value=headers[keys[0]];
 return validUploadOperationId(value)&&(!raw.length||raw[0]===value)?value:null;
}
export function initializeUploadReceipts(db){
 if(!db.prepare('PRAGMA table_info(transcription_jobs)').all().some(c=>c.name==='original_upload_receipt'))db.exec('ALTER TABLE transcription_jobs ADD COLUMN original_upload_receipt TEXT');
 for(const column of ['original_upload_operation_id','original_upload_operation_filename'])if(!db.prepare('PRAGMA table_info(transcription_jobs)').all().some(c=>c.name===column))db.exec(`ALTER TABLE transcription_jobs ADD COLUMN ${column} TEXT`);
 // NULL legacy keys are deliberately not backfilled or content-deduplicated.
 db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS transcription_upload_operation_unique ON transcription_jobs(original_upload_operation_id);
 CREATE TRIGGER IF NOT EXISTS transcription_upload_operation_immutable BEFORE UPDATE OF original_upload_operation_id,original_upload_operation_filename ON transcription_jobs
 WHEN NEW.original_upload_operation_id IS NOT OLD.original_upload_operation_id OR NEW.original_upload_operation_filename IS NOT OLD.original_upload_operation_filename BEGIN SELECT RAISE(ABORT,'Original upload operation is immutable'); END;`);
 // Legacy rows remain unknown. Neither metadata edits nor resume may replace identity.
 db.exec(`CREATE TRIGGER IF NOT EXISTS transcription_upload_receipt_immutable BEFORE UPDATE OF original_upload_receipt ON transcription_jobs
 WHEN NEW.original_upload_receipt IS NOT OLD.original_upload_receipt BEGIN SELECT RAISE(ABORT,'Original upload receipt is immutable'); END;`);
}
export function uploadReceiptAvailable(raw,language){
 try{
  if(typeof raw!=='string'||raw.length>2048)return false;
  const r=JSON.parse(raw),s=r.settings;
  return exactKeys(r,['version','sha256','byteLength','declaredMime','acceptedFormat','language','settings'])&&exactKeys(s,['profile','maxSeconds','maxBytes','deadlineSeconds','requestedRecognizer'])&&JSON.stringify(s.requestedRecognizer)===JSON.stringify(requestedRecognizer)&&typeof r.version==='number'&&r.version===1&&/^[a-f0-9]{64}$/.test(r.sha256)&&typeof r.sha256==='string'&&Number.isSafeInteger(r.byteLength)&&r.byteLength>=44&&
   typeof r.declaredMime==='string'&&typeof r.acceptedFormat==='string'&&Object.hasOwn(formats,r.declaredMime)&&formats[r.declaredMime]===r.acceptedFormat&&typeof r.language==='string'&&['auto','zh','en'].includes(r.language)&&r.language===language&&
   s?.profile===uploadSettingsProfile&&Number.isInteger(s.maxSeconds)&&s.maxSeconds>=1&&s.maxSeconds<=14400&&
   Number.isInteger(s.maxBytes)&&s.maxBytes>=44&&s.maxBytes<=536870912&&r.byteLength<=s.maxBytes&&
   Number.isInteger(s.deadlineSeconds)&&s.deadlineSeconds>=1&&s.deadlineSeconds<=28800;
 }catch{return false}
}
export function createUploadReceipt({sha256,byteLength,mime,format,language,maxSeconds,maxBytes,deadlineSeconds}){
 const receipt=JSON.stringify({version:1,sha256,byteLength,declaredMime:mime,acceptedFormat:format,language,settings:{profile:uploadSettingsProfile,maxSeconds,maxBytes,deadlineSeconds,requestedRecognizer}});
 if(!uploadReceiptAvailable(receipt,language))throw Error('Invalid original upload receipt');
 return receipt;
}
