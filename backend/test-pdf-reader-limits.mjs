import assert from 'node:assert/strict';
import {boundedRasterProcess} from './pdf-page-reader.mjs';
const cases=[['wall timeout','import time; time.sleep(60)'],['stdout cap','import sys; sys.stdout.buffer.write(b"x"*(17*1024*1024))'],['stderr cap','import sys; sys.stderr.buffer.write(b"x"*(17*1024*1024))'],['memory cap','x=bytearray(600*1024*1024)'],['CPU cap','while True: pass']];
for(const [name,script] of cases){const start=Date.now();await assert.rejects(boundedRasterProcess('/usr/bin/python3',['-c',script],Buffer.alloc(0)),{status:422});assert(Date.now()-start<9000);console.log('PASS',name,'bounded rejection',Date.now()-start+'ms')}
