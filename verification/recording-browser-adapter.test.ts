import {afterEach,expect,it,vi} from 'vitest';
import {createBrowserRecordingController} from '../candidate/src/recording/browser-adapter';
afterEach(()=>vi.unstubAllGlobals());
it('adapter is inert until explicit start, requests 16000 and silent graph, cleans fake tracks on dispose',async()=>{
 const track={readyState:'live',getSettings:()=>({channelCount:1}),stop:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn()};
 const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};const gum=vi.fn(async()=>stream);vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:gum}});
 const source={connect:vi.fn(),disconnect:vi.fn()},gain={gain:{value:1},connect:vi.fn(),disconnect:vi.fn()},node={port:{postMessage:vi.fn(),close:vi.fn()},connect:vi.fn(),disconnect:vi.fn()};
 const context={sampleRate:16000,state:'running',audioWorklet:{addModule:vi.fn(async()=>{})},createMediaStreamSource:()=>source,createGain:()=>gain,destination:{},close:vi.fn(async()=>{})};
 const Context=vi.fn(function(){return context;}),Worklet=vi.fn(function(){return node;});vi.stubGlobal('AudioContext',Context);vi.stubGlobal('AudioWorkletNode',Worklet);
 const controller=createBrowserRecordingController();expect(gum).not.toHaveBeenCalled();expect(Context).not.toHaveBeenCalled();await controller.start();expect(gum).toHaveBeenCalledOnce();expect(Context).toHaveBeenCalledWith({sampleRate:16000});expect(context.audioWorklet.addModule.mock.calls[0][0]).toContain('pcm-capture-worklet');expect(Worklet.mock.calls[0][1]).toBe('owned-pcm-capture');expect(gain.gain.value).toBe(0);expect(source.connect).toHaveBeenCalledWith(node);expect(node.connect).toHaveBeenCalledWith(gain);expect(gain.connect).toHaveBeenCalledWith(context.destination);controller.dispose();expect(track.stop).toHaveBeenCalledOnce();expect(context.close).toHaveBeenCalled();
});
