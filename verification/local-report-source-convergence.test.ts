// @vitest-environment node
// Integration-only: actual fresh synthetic upload/domain payloads, simulated in-memory transport.
import {it, expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {boundedTransport} from '../visual-harness/bounded-transport';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {createServiceReportsClient} from '../candidate/src/adapters/service-reports';

it('parses actual fresh-upload revision-zero choices and inspection through the real service client', async () => {
  const backend = fileURLToPath(new URL('../backend/', import.meta.url));
  // A dedicated Node subprocess avoids transforming production domain loaders through Vitest.
  // It executes only this bounded fixture, not the author's entire backend test a second time.
  const script = `
    import assert from 'node:assert/strict';
    import {execFileSync} from 'node:child_process';
    import {mkdtempSync,mkdirSync,lstatSync,rmSync} from 'node:fs';
    import {join} from 'node:path';
    import {tmpdir} from 'node:os';
    import {pathToFileURL} from 'node:url';
    import {Readable} from 'node:stream';
    const backend=process.argv[1];
    const {compose}=await import(pathToFileURL(join(backend,'composition.mjs')));
    const {researchDocuments}=await import(pathToFileURL(join(backend,'research-documents.mjs')));
    const root=mkdtempSync(join(tmpdir(),'local-source-convergence-'));
    let app;
    try {
      const prepared=join(root,'prepared'),storage=join(root,'storage');
      mkdirSync(prepared);mkdirSync(storage);
      const stat=lstatSync(prepared,{bigint:true}),build=join(prepared,'runtime');
      assert.equal(execFileSync(process.execPath,[join(backend,'prepare-backend.mjs'),'--owned-root',prepared,stat.dev+':'+stat.ino],{encoding:'utf8',timeout:30000}).trim(),build);
      let documents;
      app=await compose(build,storage,{createLocalSources(authority){
        const workspace={get(kind,id){return authority.workspace.get(authority.context(),{kind,id})},list:()=>[]};
        documents=researchDocuments(storage,workspace);
        return {resource:documents,port:documents.createReportSourcePort(authority)};
      }});
      const req=Readable.from([Buffer.from('Public-safe synthetic convergence text. No private material.')]);
      req.method='POST';req.url='/api/documents/upload?name=Convergence.txt';req.headers={'content-type':'application/octet-stream'};
      let uploaded,calls=0;
      await documents.handle(req,(status,body)=>{calls++;assert(status>=200&&status<300);uploaded=body.document},(status,code,message)=>assert.fail(JSON.stringify({status,code,message})),()=>assert.fail('Unexpected binary response'));
      assert.equal(calls,1);assert.equal(uploaded.revision,0);
      const ctx=app.context(),scope=app.reports.scope(ctx),choices=app.sourceChoices(ctx,{});
      assert.equal(choices.items.length,1);assert.equal(choices.items[0].metadataRevision,0);
      assert(choices.items[0].documentId.endsWith(':'+uploaded.id));
      const observed=await app.inspectSource(ctx,{documentId:choices.items[0].documentId,revisionId:choices.items[0].revisionId});
      observed.checkPublication();
      const {checkPublication,...inspection}=observed;
      assert.equal(inspection.locator.metadataRevision,0);
      assert.equal(inspection.locator.documentId,uploaded.id);
      // Same publication fence/payload projection as the server, with no HTTP listener.
      console.log(JSON.stringify({scope,choices,inspection}));
    } finally {
      try {app?.close()} finally {rmSync(root,{recursive:true,force:true})}
    }
  `;
  const raw = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, backend], {encoding:'utf8',timeout:60000,maxBuffer:1024*1024}));
  const calls: string[] = [];
  const transport: typeof globalThis.fetch = async (url, init) => {
    const route=String(url);calls.push(route);
    expect(init?.method).toBe('POST');expect(init?.credentials).toBe('same-origin');
    const input=JSON.parse(String(init?.body));
    let payload: unknown;
    if(route==='/api/service-reports/scope'){expect(input).toEqual({});payload=raw.scope}
    else if(route==='/api/service-reports/sourceChoices'){expect(input).toEqual({offset:0,limit:10,storeScope:null});payload=raw.choices}
    else if(route==='/api/service-reports/inspectSource'){
      expect(input).toEqual({documentId:raw.choices.items[0].documentId,revisionId:raw.choices.items[0].revisionId});payload=raw.inspection;
    } else throw new Error('Unexpected transport route '+route);
    return new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});
  };
  const client=createServiceReportsClient({fetch:boundedTransport(new OrdinaryRequestLifetime(),transport),getActor:()=>({binding:'a'.repeat(64),epoch:1})});
  try {
    await client.scope();
    const choices=await client.sourceChoices();
    expect(choices).toEqual(raw.choices);expect(choices.items[0].metadataRevision).toBe(0);
    const inspected=await client.inspectSource({documentId:choices.items[0].documentId,revisionId:choices.items[0].revisionId});
    expect(inspected).toEqual({scope:raw.inspection.scope,pin:raw.inspection.pin});expect(inspected.pin.documentId).toBe(choices.items[0].documentId);
    expect(calls).toEqual(['/api/service-reports/scope','/api/service-reports/sourceChoices','/api/service-reports/inspectSource']);
  } finally {client.withdraw()}
},90000);
