import type {IntegrationCapability} from '../candidate/shared/integration-capabilities';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {populatedFixture} from './populated-fixture';
const syntheticIntegrations = [{id:'demo-local',label:'本地合成文本模型 · 未配置',kind:'model.text',implemented:true,configured:false,available:false,reason:'unconfigured'}] satisfies IntegrationCapability[];
export function syntheticTransport(lifetime: OrdinaryRequestLifetime, capabilityDelayMs = 0): typeof fetch {
// Synthetic-only transport. There is deliberately no fallback to native fetch.
return async(input,init)=>lifetime.guard(async()=>{
 const path=typeof input==='string'?input:input instanceof URL?input.href:input.url;
 if(path==='/api/integrations' && capabilityDelayMs>0) await new Promise(resolve=>setTimeout(resolve,Math.min(5000,capabilityDelayMs)));
 const body=init?.body?JSON.parse(String(init.body)):{};
 let value:unknown;let status=200;
 if(!path.startsWith('/api/')) {value={error:{code:'UNAVAILABLE',message:'非合成地址已阻止',retryable:false}};status=503;}
 else if(path==='/api/integrations')value=syntheticIntegrations;
 else {value=populatedFixture(path,body);if(value===undefined && path.startsWith('/api/automation/list'))value=[];if(value===undefined){value={error:{code:'UNAVAILABLE',message:'合成测试：该服务不可用',retryable:false}};status=503;}}
 return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
},init?.signal??undefined);
}
