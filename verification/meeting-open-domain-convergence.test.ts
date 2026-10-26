// @vitest-environment node
// Actual synthetic OrganizationDomain/SQLite DTOs; no HTTP, browser, raw SQL or private material.
import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DomainStore} from '../backend/source/server/workspace-store';
import {OrganizationDomain} from '../backend/source/server/organization-domain';
import {agendaRequest,validateAgendaPage} from '../candidate/src/components/local-meeting-agenda';
import {canonicalMeetingRecord,selectMeetingRecord,meetingOpenSelection} from '../candidate/src/components/meeting-open-selection';
it('actual domain list/get canonical pins agree and a legitimate subsequent revision no longer matches the selected record',()=>{
 const root=mkdtempSync(join(tmpdir(),'meeting-open-contract-'));let store:DomainStore|undefined;
 try{
  store=new DomainStore(root);const domain=new OrganizationDomain(store);
  const context={principal:{tenantId:'synthetic-meeting',subjectId:'owner',collectionIds:['synthetic']},signal:new AbortController().signal,requestId:'meeting-open-contract'};
  const created=domain.create(context,{kind:'meeting',id:'selected-meeting',data:{title:'Synthetic contract meeting',startsAt:'2026-10-22T00:00:00Z',endsAt:'2026-10-22T01:00:00Z',timezone:'UTC'},idempotencyKey:'create-meeting'});
  const request=agendaRequest({from:'',to:'',state:''});const page=validateAgendaPage(domain.list(context,request),request);expect(page.items).toHaveLength(1);
  const selection=selectMeetingRecord(page.items[0],'a'.repeat(64),3);expect(selection).not.toBeNull();expect(meetingOpenSelection(selection)).toEqual(selection);
  const get=domain.get(context,{kind:'meeting',id:created.id,includeDeleted:false});expect(canonicalMeetingRecord(get)).toBe(selection!.recordJson);expect(get.revision).toBe(1);
  domain.update(context,{kind:'meeting',id:created.id,expectedRevision:1,patch:{title:'Explicit synthetic fixture change'},idempotencyKey:'update-meeting'});
  const current=domain.get(context,{kind:'meeting',id:created.id,includeDeleted:false});expect(current.revision).toBe(2);expect(canonicalMeetingRecord(current)).not.toBe(selection!.recordJson);
 }finally{store?.close();rmSync(root,{recursive:true,force:true});}
},15000);
