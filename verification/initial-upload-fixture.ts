import {File as NodeFile, Blob as NodeBlob} from 'node:buffer';
import {createHash, webcrypto} from 'node:crypto';
import {beforeEach, vi} from 'vitest';
import {fixtureStoreHeaders} from './transcription-store-fixture';

// jsdom's File has no Blob.arrayBuffer. These inert, in-memory Node implementations
// let the production streaming hash inspect the actual selected bytes.
beforeEach(() => {
  vi.stubGlobal('File', NodeFile);
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('crypto', webcrypto);
});

export const INITIAL_UPLOAD_JOB_ID = '11111111-1111-4111-8111-111111111111';
const requestedRecognizer = {model:'faster-whisper-small',device:'cpu',computeType:'int8',beamSize:5,temperature:0,vadFilter:false,conditionOnPreviousText:false,wordTimestamps:true,cpuThreads:4,numWorkers:1,windowSeconds:30,strideSeconds:29,seedPolicy:'ctranslate2-sha256-source-chunk-v1'};
export async function initialUploadAccepted(init: RequestInit, overrides: Record<string, unknown> = {}, status = 202) {
  const file = init.body as File;
  const headers = new Headers(init.headers);
  const filename = decodeURIComponent(headers.get('X-Audio-Filename') ?? '');
  const extension = filename.split('.').pop()?.toLowerCase();
  const data = {
    operationId:headers.get('X-Upload-Operation-Id'),state:'committed',reconciliationFinal:true,
    id:INITIAL_UPLOAD_JOB_ID,status:'processing',filename,uploadOrigin:headers.get('X-Audio-Origin'),
    receipt:{version:1,sha256:createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex'),byteLength:file.size,
      declaredMime:headers.get('Content-Type'),acceptedFormat:extension === 'm4a' ? 'mov' : extension,language:headers.get('X-Audio-Language'),
      settings:{profile:'local-asr-upload-v1',maxSeconds:7200,maxBytes:268435456,deadlineSeconds:14400,requestedRecognizer:{...requestedRecognizer}}},
    deleted:false,replayed:status === 200,...overrides,
  };
  return {headers:fixtureStoreHeaders(),ok:true,status,json:async()=>data};
}
export function initialUploadUnconfirmed(url: string) {
  return {headers:fixtureStoreHeaders(),ok:true,status:200,json:async()=>({operationId:new URL(url,'http://localhost').searchParams.get('operationId'),state:'unconfirmed',reconciliationFinal:false})};
}
