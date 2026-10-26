import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAX_FILE = 64 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const DOMAINS = ['files', 'build', 'evidence'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function fail(message, code = 'INVALID') { throw Object.assign(new Error(message), { code }); }
export function validPath(p) {
  if (typeof p !== 'string' || !p || p.length > 4096 || /[\\:\x00-\x1f\x7f]/.test(p) || path.posix.isAbsolute(p) || p.split('/').some(x => !x || x === '.' || x === '..')) fail('Noncanonical relative path');
  // Private/configuration stores are never appropriate source-identity inputs.
  if (p.split('/').some(x => ['.git', '.aws', '.ssh', '.codex', '.agents', '.env'].includes(x) || x.startsWith('.env.'))) fail('Private path forbidden');
  return p;
}
export function validateManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m) || !Array.isArray(m.files) || !m.files.length) fail('Manifest requires nonempty files array');
  const all = new Map();
  for (const domain of DOMAINS) {
    if (own(m, domain) && !Array.isArray(m[domain])) fail(`${domain} must be an array`);
    const entries = m[domain] ?? [];
    if (entries.length > 10000) fail('Too many entries');
    for (const e of entries) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) fail('Invalid pin');
      validPath(e.path);
      if (typeof e.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(e.sha256)) fail(`Invalid SHA-256: ${e.path}`);
      if (own(e, 'size') && (!Number.isSafeInteger(e.size) || e.size < 0 || e.size > MAX_FILE)) fail(`Invalid size: ${e.path}`);
      if (all.has(e.path)) fail(`Duplicate pin across inventory domains: ${e.path}`);
      all.set(e.path, e);
    }
  }
  for (const name of ['foundationCores', 'delta']) {
    if (!own(m, name)) continue;
    if (!Array.isArray(m[name]) || m[name].length > 10000) fail(`Invalid ${name}`);
    const seen = new Set();
    for (const e of m[name]) {
      if (!e || typeof e !== 'object') fail(`Invalid ${name} entry`);
      validPath(e.path);
      if (seen.has(e.path)) fail(`Duplicate ${name} annotation`);
      seen.add(e.path);
      const pin = m.files.find(p => p.path === e.path);
      if (!pin || pin.sha256 !== e.sha256) fail(`Inconsistent ${name} annotation: ${e.path}`);
    }
  }
  return m;
}
const identity = s => [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':');
function inspect(absolute, leafFile = true) {
  const parts = absolute.split(path.sep).filter(Boolean);
  let cursor = path.parse(absolute).root;
  const chain = [];
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    const s = fs.lstatSync(cursor, { bigint: true });
    if (s.isSymbolicLink()) fail('Symlink forbidden', 'UNSAFE');
    if (i === parts.length - 1 && leafFile) {
      if (!s.isFile()) fail('Expected regular file', 'UNSAFE');
    } else if (!s.isDirectory()) fail('Expected directory', 'UNSAFE');
    chain.push({ path: cursor, id: identity(s), directory: s.isDirectory(), dev: s.dev, ino: s.ino });
  }
  return chain;
}
function checkChain(chain) {
  for (const old of chain) {
    const s = fs.lstatSync(old.path, { bigint: true });
    if (s.isSymbolicLink() || s.dev !== old.dev || s.ino !== old.ino || (old.directory ? !s.isDirectory() : identity(s) !== old.id)) fail('Identity changed during verification', 'CHANGED');
  }
}
function readStable(absolute, limit, budget, collect = false, afterRead) {
  const chain = inspect(absolute);
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || identity(before) !== chain.at(-1).id) fail('File replaced before read', 'CHANGED');
    if (before.size > BigInt(limit)) fail('File exceeds byte limit', 'UNSAFE');
    checkChain(chain);
    const hash = crypto.createHash('sha256'); const chunks = []; const buf = Buffer.alloc(65536); let total = 0;
    while (BigInt(total) < before.size) {
      const remaining = budget.limit - budget.bytes;
      if (remaining <= 0) fail('Total content-read budget exhausted; identity inconclusive', 'BUDGET');
      const length = Math.min(buf.length, remaining, Number(before.size) - total);
      const n = fs.readSync(fd, buf, 0, length, null); if (!n) break;
      total += n; budget.bytes += n;
      hash.update(buf.subarray(0, n)); if (collect) chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    if (afterRead) afterRead(absolute);
    if (identity(before) !== identity(fs.fstatSync(fd, { bigint: true })) || BigInt(total) !== before.size) fail('File changed during read', 'CHANGED');
    checkChain(chain);
    return { sha256: hash.digest('hex'), size: total, chain, data: collect ? Buffer.concat(chunks) : undefined };
  } finally { fs.closeSync(fd); }
}
export function verify({ root, manifest, domains = ['files'], afterRead, byteBudget = MAX_TOTAL }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('Explicit absolute root required');
  root = path.resolve(root); inspect(root, false); validPath(manifest);
  if (!Array.isArray(domains) || !domains.length || new Set(domains).size !== domains.length || domains.some(d => !DOMAINS.includes(d))) fail('Invalid domain selection');
  if (!Number.isSafeInteger(byteBudget) || byteBudget < 1 || byteBudget > MAX_TOTAL) fail('Invalid byte budget; may only lower the fixed ceiling');
  const budget = { bytes: 0, limit: byteBudget };
  const manifestRead = readStable(path.join(root, manifest), 4 * 1024 * 1024, budget, true);
  const m = validateManifest(JSON.parse(manifestRead.data.toString('utf8')));
  if (domains.some(d => !own(m, d) || !m[d].length)) fail('Selected domain is absent or empty');
  const result = { kind: 'listed-source-identity', manifest, manifestSha256: manifestRead.sha256, domains, inventoryCounts: Object.fromEntries(DOMAINS.map(d => [d, (m[d] ?? []).length])), matched: [], missing: [], changed: [], unsafe: [], errors: [], budgetSkipped: [], claim: 'Only selected manifest entries; not full-tree inventory, atomic snapshot, functional verification, or acceptance.' };
  const checked = [];
  const record = (p, e) => {
    const bucket = e.code === 'BUDGET' ? 'budgetSkipped' : e.code === 'ENOENT' ? 'missing' : e.code === 'CHANGED' ? 'changed' : ['UNSAFE', 'ELOOP', 'ENOTDIR'].includes(e.code) ? 'unsafe' : 'errors';
    if (!result[bucket].some(x => x.path === p)) result[bucket].push({ path: p, reason: e.message });
  };
  let budgetStopped = false;
  for (const domain of domains) for (const entry of m[domain] ?? []) {
    if (budgetStopped || budget.bytes >= budget.limit) {
      budgetStopped = true;
      record(entry.path, Object.assign(new Error('Not read: total content-read budget exhausted; identity inconclusive'), { code: 'BUDGET' }));
      continue;
    }
    try {
      const read = readStable(path.join(root, entry.path), MAX_FILE, budget, false, afterRead);
      if (read.sha256 !== entry.sha256 || (own(entry, 'size') && read.size !== entry.size)) fail('Hash or size mismatch', 'CHANGED');
      checked.push({ path: entry.path, chain: read.chain }); result.matched.push(entry.path);
    } catch (e) { if (e.code === 'BUDGET') budgetStopped = true; record(entry.path, e); }
  }
  for (const item of checked) { try { checkChain(item.chain); } catch (e) { record(item.path, e); result.matched = result.matched.filter(p => p !== item.path); } }
  try { checkChain(manifestRead.chain); } catch (e) { record(manifest, e); }
  result.ok = ['missing', 'changed', 'unsafe', 'errors', 'budgetSkipped'].every(k => !result[k].length);
  result.bytesRead = budget.bytes;
  result.byteBudget = budget.limit;
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2); const options = {};
    if (args.length % 2) fail('Usage: --root ABSOLUTE_ROOT --manifest RELATIVE_JSON [--domains files,build,evidence]');
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]; if (!['--root', '--manifest', '--domains'].includes(key) || own(options, key.slice(2))) fail('Unknown or duplicate argument');
      options[key.slice(2)] = key === '--domains' ? args[i + 1].split(',') : args[i + 1];
    }
    const result = verify(options); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1;
  } catch (e) { console.log(JSON.stringify({ ok: false, error: e.message, kind: 'invalid-or-unreadable-manifest' })); process.exitCode = 2; }
}
