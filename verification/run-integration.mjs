// Offline verification runner. Uses installed local dependencies and synthetic fixtures only.
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const root=join(import.meta.dirname,'..'),out=join(root,'integration-evidence');mkdirSync(out,{recursive:true});
for(const dir of ['citation-evidence','document-management-evidence','pdf-annotations-evidence','pdf-reader-evidence','resume-evidence'])mkdirSync(join(root,dir),{recursive:true});
const stages=[
 ['typecheck',['node_modules/typescript/bin/tsc','-p','tsconfig.json']],
 ['frontend',['node_modules/vitest/vitest.mjs','run','--config','verification/vitest.config.ts']],
 ['build',['node_modules/vite/bin/vite.js','build']],
 ['citations',['backend/test-document-citations.mjs']],
 ['citation-recovery',['backend/test-citation-recovery.mjs']],
 ['citation-concurrency',['backend/test-citation-concurrency.mjs']],
 ['citations-http',['backend/test-citations-http.mjs']],
 ['jp-synthetic',['backend/test-jp-private-provider.mjs']],
 ['http',['backend/test-http.mjs']],
 ['documents',['backend/test-documents.mjs']],
 ['document-download',['backend/test-document-download.mjs']],
 ['document-download-http',['backend/test-document-download-http.mjs']],
 ['upload-recovery',['backend/test-upload-recovery.mjs']],
 ['upload-recovery-http',['backend/test-upload-recovery-http.mjs']],
 ['document-management',['backend/test-document-management.mjs']],
 ['document-audit',['document-audit/audit.mjs']],
 ['document-parser-audit',['document-audit/parser-audit.mjs']],
 ['pdf-parser-audit',['pdf-reader-evidence/parser-audit.mjs']],
 ['pdf-annotations',['backend/test-pdf-annotations.mjs']],
 ['pdf-reader',['backend/test-pdf-reader.mjs']],
 ['pdf-reader-limits',['backend/test-pdf-reader-limits.mjs']],
 ['inventory-recovery',['--test','verification/test-inventory-recovery.mjs']],
 ['inventory',['backend/test-inventory-scheduler.mjs']],
 ['scheduler',['scheduler/test-runner.mjs']],
 ['transcript-library',['backend/test-transcription-library.mjs']],
 ['transcript-management',['backend/test-transcript-management.mjs']],
 ['transcript-history',['backend/test-transcript-history.mjs']],
 ['transcript-relationships',['backend/test-transcript-relationships.mjs']],
 ['report-export',['backend/test-report-export.mjs']],
 ['report-recovery',['backend/test-report-recovery.mjs']],
 ['persistence',['backend/test-persistence.mjs']],
 ['resume-integrity',['test_resume_integrity.py']],
 ['resume-lifecycle',['test_resume_lifecycle.mjs']],
];
// Do not inherit provider/model credentials or selected data paths into checks.
const env={PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',TZ:'UTC'};
const results=[];
for(const [name,args]of stages){
 const executable=name==='resume-integrity'?'python3':process.execPath;
 const start=Date.now(),result=spawnSync(executable,args,{cwd:root,env,encoding:'utf8',timeout:180000,maxBuffer:20*1024*1024});
 writeFileSync(join(out,name+'.log'),(result.stdout??'')+(result.stderr??'')+(result.error?'\n'+result.error.message:''));
 results.push({name,command:[name==='resume-integrity'?'python3':'node',...args],passed:result.status===0,exitCode:result.status,signal:result.signal,durationMs:Date.now()-start});
 console.log(`${result.status===0?'PASS':'FAIL'} ${name}`);
 writeFileSync(join(out,'SUITE_RESULTS.json'),JSON.stringify({passed:results.every(r=>r.passed),complete:results.length===stages.length,runtime:process.version,dependencyMode:'Verification uses installed local node_modules only; dependency preparation is recorded separately',transport:'Frontend JSDOM/mocked fetch plus real SQLite and selected real loopback HTTP; no device/browser or model claims',results},null,2)+'\n');
}
if(results.some(result=>!result.passed))process.exitCode=1;
