// @vitest-environment node
import {expect,it} from 'vitest';
import {createMonoPcm16WavBuilder} from '../candidate/src/recording/pcm-wav';
import {isOwnedPcmWav} from '../candidate/src/recording/validate-wav';
import type {Draft} from '../candidate/src/recording/recording-draft-store';
it('restored audio must be exact 16k mono PCM16 WAV, not a MIME label or duration claim',async()=>{
 const encoder=createMonoPcm16WavBuilder();encoder.appendPcm16(new Int16Array(128));const {bytes}=encoder.finalize(128);
 const draft={blob:new Blob([bytes],{type:'audio/wav'}),size:bytes.length,mimeType:'audio/wav',durationSeconds:128/16000} as Draft;
 expect(await isOwnedPcmWav(draft)).toBe(true);
 for(const change of [{durationSeconds:1},{mimeType:'audio/webm'},{blob:new Blob([bytes],{type:'audio/webm'})},{size:bytes.length-1}])expect(await isOwnedPcmWav({...draft,...change})).toBe(false);
 for(const at of [0,4,8,12,16,20,22,24,28,32,34,36,40]){const changed=bytes.slice();changed[at]^=1;expect(await isOwnedPcmWav({...draft,blob:new Blob([changed],{type:'audio/wav'})})).toBe(false);}
});
