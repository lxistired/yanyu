// @vitest-environment node
import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
it('actual synthetic SQLite domains use runtime clock by default and preserve explicit deterministic clock',()=>{
 const output=execFileSync(process.execPath,[fileURLToPath(new URL('../backend/test-service-report-clock.mjs',import.meta.url))],{encoding:'utf8',timeout:60000});
 expect(output).toContain('PASS wall-clock:');
 expect(output).toContain('PASS explicit-clock:');
 console.log(output);
},70000);
