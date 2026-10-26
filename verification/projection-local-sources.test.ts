// @vitest-environment node
import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
it('projects explicit inspected local sources through actual fresh synthetic domains and SQLite',()=>{
 const output=execFileSync(process.execPath,[fileURLToPath(new URL('../backend/test-projection-local-sources.mjs',import.meta.url))],{encoding:'utf8',timeout:90000});
 expect(output).toContain('PASS projection local sources:');console.log(output);
},100000);
