import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
registerHooks({resolve(s,c,next){if(s.startsWith('.')&&c.parentURL){const u=new URL(s,c.parentURL);for(const ext of ['.ts','.tsx'])if(existsSync(fileURLToPath(u)+ext))return {url:u.href+ext,shortCircuit:true};}return next(s,c);},load(u,c,next){if(/\.tsx?$/.test(u))return {format:'module',source:stripTypeScriptTypes(readFileSync(new URL(u),'utf8'),{mode:'transform'}),shortCircuit:true};return next(u,c);}});
