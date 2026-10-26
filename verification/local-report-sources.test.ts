// @vitest-environment node
import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
it('uses actual fresh synthetic upload handlers and SQLite report domains for authorized local sources',()=>{
 const output=execFileSync(process.execPath,[fileURLToPath(new URL('../backend/test-local-report-sources.mjs',import.meta.url))],{encoding:'utf8',timeout:90000});
 expect(output).toContain('PASS actual local report source:');expect(output).toContain('PASS local authority:');console.log(output);
},100000);
