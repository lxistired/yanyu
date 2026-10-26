// @vitest-environment node
import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';import {createHash,webcrypto} from 'node:crypto';
import {organizationCommandCanonical,type OrganizationCommandOperation} from '../candidate/shared/organization-command-outcome';
const vectors=JSON.parse(readFileSync('verification/fixtures/organization-canonical-vectors.json','utf8')) as Array<{operation:OrganizationCommandOperation;input:unknown;canonical:string;requestDigest:string}>;
it.each(vectors)('$operation has byte-identical canonical and browser/Node digest vectors',async vector=>{const canonical=organizationCommandCanonical(vector.operation,vector.input);expect(canonical).toBe(vector.canonical);expect(createHash('sha256').update(canonical).digest('hex')).toBe(vector.requestDigest);const digest=await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical));expect(Buffer.from(digest).toString('hex')).toBe(vector.requestDigest);});
