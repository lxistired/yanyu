import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
registerHooks({
 resolve(specifier,context,next){if(specifier.startsWith('.')&&context.parentURL){const candidate=new URL(specifier,context.parentURL);if(existsSync(fileURLToPath(candidate)+'.ts'))return {url:candidate.href+'.ts',shortCircuit:true};}return next(specifier,context);},
 load(url,context,next){if(url.endsWith('.ts'))return {format:'module',source:stripTypeScriptTypes(readFileSync(new URL(url),'utf8'),{mode:'transform'}),shortCircuit:true};return next(url,context);}
});
