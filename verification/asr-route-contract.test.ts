import {it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {boundedTransport} from '../visual-harness/bounded-transport';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
const id='12345678-abcd-4abc-8abc-123456789abc';
// Small fail-closed source scanner, not eval: unknown dynamic route syntax fails CI.
function splitTop(text:string,separator:string){let quote='',escape=false,depth=0,start=0;const parts:string[]=[];for(let i=0;i<text.length;i++){const c=text[i];if(quote){if(escape)escape=false;else if(c==='\\')escape=true;else if(c===quote)quote='';continue}if("'\"`".includes(c)){quote=c;continue}if('({['.includes(c))depth++;if(')}]'.includes(c))depth--;if(c===separator&&depth===0){parts.push(text.slice(start,i));start=i+1}}parts.push(text.slice(start));return parts}
function calls(source:string){const found:string[]=[];for(const match of source.matchAll(/\b(?:fetch|scopedFetch|request)\s*\(/g)){let depth=1,quote='',escape=false,end=match.index!+match[0].length;const start=end;for(;end<source.length;end++){const c=source[end];if(quote){if(escape)escape=false;else if(c==='\\')escape=true;else if(c===quote)quote='';continue}if("'\"`".includes(c))quote=c;else if(c==='(')depth++;else if(c===')'&&!--depth)break}expect(depth).toBe(0);found.push(source.slice(start,end))}return found}
// Admit only the reviewed aliases; do not treat arbitrary callable names as transport.
function verifyAliases(source:string,path:string){
 if(/\bscopedFetch\s*\(/.test(source)){
  expect(source,path).toMatch(/import\s*\{(?:TranscriptionStoreBoundary,\s*)?useTranscriptionStore\}\s*from\s*['"]\.\/TranscriptionStoreBoundary['"]/);
  expect(source,path).toMatch(/\bstore\s*=\s*useTranscriptionStore\(\)/);
  const bindings=[...source.matchAll(/\bscopedFetch\s*=(?!=)\s*([^;,\n]+)/g)];
  expect(bindings.length,path).toBeGreaterThan(0);
  for(const binding of bindings)expect(binding[1].trim(),path).toBe('store.fetch');
 }
 if(/\brequest\s*\(/.test(source)){
  expect(path).toBe('candidate/src/components/TranscriptRelationships.tsx');
  expect(source).toContain("import type {StoreFetch} from './transcription-store-session'");
  expect(source).toContain('async function choices(signal: AbortSignal | undefined, request: StoreFetch): Promise<Choices> {');
  expect([...source.matchAll(/\brequest\s*\(/g)]).toHaveLength(1);
  expect(source).toContain("await request('/api/local-asr/relationships', {signal})");
  expect(source).not.toMatch(/\brequest\s*=(?!=)/);
 }
}
function expand(expression:string,source:string):string[]{const value=expression.trim();if(/^(['"])[^]*\1$/.test(value))return [value.slice(1,-1)];if(value==='id'||value==='pending.operationId'||/^encodeURIComponent\((?:id|job\.id)\)$/.test(value))return [id];if(value==='revision')return ['7'];if(value==='action'){const union=/action:\s*((?:'[^']+'\s*\|\s*)*'[^']+')/.exec(source);if(!union)throw Error('Missing action union');return [...union[1].matchAll(/'([^']+)'/g)].map(m=>m[1])}if(value==='base'){const base=/const base=([^;]+);/.exec(source);if(!base)throw Error('Missing route base');return expand(base[1],source)}if(value.startsWith('new URLSearchParams('))return ['q=synthetic&scope=active&limit=10&offset=0&jobId='+id];
 if(value.startsWith('`')&&value.endsWith('`')){let outputs=[''],pos=1;while(pos<value.length-1){const start=value.indexOf('${',pos);if(start<0)return outputs.map(p=>p+value.slice(pos,-1));outputs=outputs.map(p=>p+value.slice(pos,start));let end=start+2,depth=1,quote='',escape=false;for(;end<value.length;end++){const c=value[end];if(quote){if(escape)escape=false;else if(c==='\\')escape=true;else if(c===quote)quote='';continue}if("'\"`".includes(c))quote=c;else if(c==='{')depth++;else if(c==='}'&&!--depth)break}if(depth)throw Error('Unclosed route interpolation');const choices=expand(value.slice(start+2,end),source);outputs=outputs.flatMap(p=>choices.map(c=>p+c));pos=end+1}return outputs}
 const parts=splitTop(value,'+');if(parts.length>1)return parts.reduce<string[]>((out,part)=>out.flatMap(a=>expand(part,source).map(b=>a+b)),['']);throw Error('Unrecognized declared ASR route syntax: '+value)}
it('every declared local-ASR UI fetch is admitted by the exact bounded transport contract',async()=>{
 const pins=[...JSON.parse(readFileSync('BUILD_INPUTS.json','utf8')).pins, {dest:'candidate/src/components/FailedTranscriptionRetry.tsx'}] as {dest:string}[];const native=vi.fn(async()=>new Response('{}')),transport=boundedTransport(new OrdinaryRequestLifetime(),native);const operations=new Set<string>();let count=0;
 for(const pin of pins){const path=pin.dest.replace(/^bounded\//,'');if(!path.endsWith('.tsx'))continue;const source=readFileSync(path,'utf8');if(!source.includes('/api/local-asr/'))continue;verifyAliases(source,path);
 for(const call of calls(source)){const args=splitTop(call,',');const routes=expand(args[0],source);const method=/method\s*:\s*['"]([A-Z]+)['"]/.exec(args.slice(1).join(','))?.[1]??'GET';for(const route of routes){expect(route.startsWith('/api/local-asr/'),path).toBe(true);native.mockClear();const response=await transport(route,{method});expect(response.status,`${path}: ${method} ${route}`).toBe(200);expect(native,`${path}: ${method} ${route}`).toHaveBeenCalledOnce();operations.add(method+' '+route.split('?')[0].replace(id,':id'));count++}}
 }
 // Two reviewed .ts discovery transports are checked explicitly, not generalized aliases.
 const session=readFileSync('candidate/src/components/transcription-store-session.ts','utf8');
 const external=readFileSync('candidate/src/components/external-transcription-source.ts','utf8');
 expect(session).toContain("this.transport('/api/local-asr/identity', {method: 'GET'");
 expect(external).toContain("fetch('/api/local-asr/identity',{method:'GET'");
 expect(session).not.toContain("'/api/local-asr/jobs?limit=1'");
 expect(external).toContain('headers:{[STORE_HEADER]:expected}');
 expect(external).toContain('this.assertActive(expected)');
 native.mockClear();expect((await transport('/api/local-asr/identity',{method:'GET'})).status).toBe(200);expect(native).toHaveBeenCalledOnce();operations.add('GET /api/local-asr/identity');
 expect(count).toBeGreaterThanOrEqual(16);
 expect([...operations].sort()).toEqual(['GET /api/local-asr/identity','GET /api/local-asr/jobs/:id/retry','POST /api/local-asr/jobs/:id/retry','GET /api/local-asr/jobs','GET /api/local-asr/jobs/:id/history','GET /api/local-asr/jobs/:id/history/7','GET /api/local-asr/jobs/:id/transcript','GET /api/local-asr/relationships','POST /api/local-asr/jobs/:id/cancel','POST /api/local-asr/jobs/:id/export','POST /api/local-asr/jobs/:id/relationship','POST /api/local-asr/jobs/:id/rename','POST /api/local-asr/jobs/:id/restore','POST /api/local-asr/jobs/:id/resume','POST /api/local-asr/jobs/:id/transcript','POST /api/local-asr/jobs/:id/transcript-restore','POST /api/local-asr/jobs/:id/trash','POST /api/local-asr/transcribe','GET /api/local-asr/transcribe'].sort());
});
