import { isUtf8 } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function boundedNumber(value, name, max = 600000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError(`${name} must be 1..${max}`);
}

// Separate exit/stdio-close observation; no process signalling or filesystem actions.
// Exported to permit deterministic held-pipe testing without orphaning a process.
export function watchStdioDrain(child, state, drainMs, onExpired) {
  boundedNumber(drainMs, 'drainMs');
  let timer, enabled = true;
  child.once('exit', () => {
    if (enabled && !state.stdioClosed) timer = setTimeout(() => {
      state.drainTimedOut = true; onExpired();
    }, drainMs);
  });
  child.once('close', () => { state.stdioClosed = true; clearTimeout(timer); });
  return () => { enabled = false; clearTimeout(timer); };
}

// Each instance owns exactly one spawn. Never accepts an existing PID or cleanup path.
export async function startOwnedChild({ command, args = [], cwd, env = {}, readyText, readyMessage,
  startMs = 2000, runMs = 10000, termMs = 250, killMs = 1000, drainMs = 250,
  maxOutputBytes = 65536, abortSignal, processGroup = process.platform === 'linux', scratch = false } = {}) {
  for (const [key, value] of Object.entries({ startMs, ...(runMs === null ? {} : { runMs }), termMs, killMs, drainMs })) boundedNumber(value, key);
  boundedNumber(maxOutputBytes, 'maxOutputBytes', 16777216);
  if (typeof command !== 'string' || !command || !Array.isArray(args) || !args.every(x => typeof x === 'string')) throw new TypeError('command/args required');
  if (readyText !== undefined && (typeof readyText !== 'string' || !readyText || Buffer.byteLength(readyText) > maxOutputBytes)) throw new TypeError('readyText must fit output bound');
  if (readyMessage !== undefined && typeof readyMessage !== 'function') throw new TypeError('Invalid readiness validator');
  if (readyText && readyMessage) throw new TypeError('Only one readiness mode');
  if (scratch) throw new TypeError('Application process ownership never cleans storage');
  if (abortSignal !== undefined && !(abortSignal instanceof AbortSignal)) throw new TypeError('abortSignal must be an AbortSignal');
  if (processGroup && process.platform !== 'linux') throw new TypeError('process groups supported only on Linux');
  const scratchPath = scratch ? await mkdtemp(join(tmpdir(), 'owned-child-synthetic-')) : null;
  const state = { started: false, pid: null, ready: false, readyData: null, exit: null, timedOut: null, reason: null,
    stdioClosed: false, drainTimedOut: false, outputLimit: false, outputBytesSeen: 0, output: '', signals: [],
    directExitConfirmed: false, group: processGroup ? 'unknown' : 'not-tracked',
    descendants: 'not-proven; escaped/detached descendants are outside this receipt',
    cleanup: scratch ? 'pending' : 'not-requested', scratchPath, errors: [] };
  let cancelDrain = () => {};
  let child, stdout = Buffer.alloc(0), output = Buffer.alloc(0), stopping, startTimer, runTimer, settledReady = false;
  const onAbort = () => { void stop('parent-abort'); };
  let finishReady;
  const ready = new Promise(resolve => { finishReady = resolve; });
  function settleReady() { if (!settledReady) { settledReady = true; clearTimeout(startTimer); finishReady(state.ready); } }
  function groupAbsent() {
    if (!processGroup || !child?.pid || !state.started) return state.directExitConfirmed;
    try { process.kill(-child.pid, 0); state.group = 'present'; return false; }
    catch (error) { state.group = error.code === 'ESRCH' ? 'absent' : 'unknown'; return error.code === 'ESRCH'; }
  }
  const exited = () => state.directExitConfirmed && groupAbsent();
  function signal(sig) {
    // Never signal a numeric group after the leader's observed exit: it may be reused.
    if (!child?.pid || !state.started || state.directExitConfirmed || (processGroup && groupAbsent())) return;
    try { processGroup ? process.kill(-child.pid, sig) : child.kill(sig); state.signals.push(sig); }
    catch (error) { if (error.code !== 'ESRCH') state.errors.push(`signal ${sig}: ${error.code}`); }
  }
  async function waitExit(ms) {
    const deadline = performance.now() + ms;
    while (!exited() && performance.now() < deadline) await delay(Math.min(10, Math.max(1, deadline - performance.now())));
    return exited();
  }
  function snapshot() {
    const decoded = output.toString('utf8');
    const encoded = Buffer.from(decoded, 'utf8');
    // Streaming decode omits an incomplete trailing code point at the byte boundary.
    const text = encoded.length > maxOutputBytes
      ? new TextDecoder('utf-8').decode(encoded.subarray(0, maxOutputBytes), { stream: true }) : decoded;
    const stdoutEncoded=Buffer.from(stdout.toString('utf8'),'utf8');
    const stdoutText=new TextDecoder('utf-8').decode(stdoutEncoded.subarray(0,maxOutputBytes),{stream:true});
    return structuredClone({ ...state, output: text, stdout: stdoutText, outputRetainedBytes: output.length,
      outputDecodeReplacement: !isUtf8(output),
      outputTruncated: state.outputBytesSeen > output.length || encoded.length > maxOutputBytes });
  }
  function stop(reason = 'requested') {
    if (stopping) return stopping;
    state.reason ??= reason;
    stopping = (async () => {
      clearTimeout(startTimer); clearTimeout(runTimer); cancelDrain(); abortSignal?.removeEventListener('abort', onAbort); settleReady();
      // Spawn/error arrives asynchronously. Wait within the same bounded termination window.
      const deadline = performance.now() + termMs;
      while (!state.started && !state.directExitConfirmed && performance.now() < deadline) await delay(5);
      signal('SIGTERM');
      if (!await waitExit(termMs)) { signal('SIGKILL'); await waitExit(killMs); }
      if (exited()) {
        if (scratchPath) {
          try { await rm(scratchPath, { recursive: true, force: true }); state.cleanup = 'confirmed'; }
          catch (error) { state.cleanup = 'unconfirmed'; state.errors.push(`cleanup: ${error.code}`); }
        }
      } else if (scratchPath) state.cleanup = 'unconfirmed';
      // Inherited pipes must not keep this caller alive after an unconfirmed receipt.
      child?.stdout?.destroy(); child?.stderr?.destroy(); if (child?.connected) child.disconnect(); child?.unref();
      return snapshot();
    })();
    return stopping;
  }
  try {
    child = spawn(command, args, { cwd, env, detached: processGroup, stdio: readyMessage ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'], shell: false });
    cancelDrain = watchStdioDrain(child, state, drainMs, () => { void stop('stdio-drain-timeout'); });
    child.once('spawn', () => { state.started = true; state.pid = child.pid; if (!readyText && !readyMessage) { state.ready = true; settleReady(); } });
    if (readyMessage) child.on('message', message => {
      if (settledReady) return;
      try {
        const data = readyMessage(message, child.pid);
        if (data === null) return; // Unrelated known lifecycle message.
        if (!data) { void stop('invalid-readiness'); return; }
        state.readyData = data; state.ready = true; settleReady();
      } catch { void stop('invalid-readiness'); }
    });
    child.once('error', error => {
      state.errors.push(`spawn: ${error.code}`);
      // Spawn failure means no owned process existed. Runtime errors are not exit proof.
      if (!state.started) { clearTimeout(runTimer); state.reason ??= 'spawn-failed'; state.directExitConfirmed = true; state.exit = { spawnFailed: true }; settleReady(); }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(runTimer);
      state.exit = { code, signal }; state.directExitConfirmed = true;
      state.reason ??= state.ready ? 'natural-exit' : 'early-exit';
      settleReady();
    });
    const receive = (data, channel) => {
      state.outputBytesSeen += data.length;
      const remaining = maxOutputBytes - output.length;
      if (remaining > 0) { const kept=data.subarray(0,remaining);output=Buffer.concat([output,kept]);if(channel==='stdout')stdout=Buffer.concat([stdout,kept]); }
      if (state.outputBytesSeen > maxOutputBytes) { state.outputLimit = true; void stop('output-limit'); return; }
      if (!settledReady && readyText && output.includes(Buffer.from(readyText))) { state.ready = true; settleReady(); }
    };
    child.stdout.on('data', data=>receive(data,'stdout')); child.stderr.on('data', data=>receive(data,'stderr'));
    startTimer = setTimeout(() => { state.timedOut = 'startup'; void stop('startup-timeout'); }, startMs);
    runTimer = runMs === null ? null : setTimeout(() => { if (state.directExitConfirmed || stopping) return; state.timedOut ??= 'runtime'; void stop('runtime-timeout'); }, runMs);
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();
    await ready;
    if (!state.ready) await stop(state.exit ? 'early-exit' : 'startup-failed');
  } catch (error) {
    state.errors.push(`spawn-sync: ${error.code ?? error.name}`);
    if (!child) { state.directExitConfirmed = true; state.exit = { spawnFailed: true }; }
    await stop('spawn-failed');
  }
  async function finishWithin(ms) {
    boundedNumber(ms, 'completionMs');
    const deadline = performance.now() + ms;
    while (!state.directExitConfirmed && performance.now() < deadline) await delay(10);
    if (!state.directExitConfirmed) { state.timedOut ??= 'completion'; return stop('completion-timeout'); }
    // Natural process exit is not stdio completion. Preserve trailing preparation
    // output until close or a separate bounded drain result; do not destroy early.
    const drainDeadline=performance.now()+drainMs;
    while(!state.stdioClosed&&!stopping&&performance.now()<drainDeadline)await delay(5);
    if(!state.stdioClosed&&!stopping){state.drainTimedOut=true;return stop('stdio-drain-timeout');}
    return stop('completed');
  }
  return { stop, snapshot, finishWithin };
}

// Receipt notification only: callbacks run even for unconfirmed teardown.
// Caller must inspect receipts, not treat notification as cleanup permission.
// Caller controls final exit, preserving its existing signal policy. No global handler on import.
export function installInterruptAdapter(owners, onReceipt = () => {}, emitter = process) {
  let pending;
  const handler = signal => {
    pending ??= Promise.all([...owners].map(owner => owner.stop(`parent-${signal}`))).then(receipts => onReceipt(signal, receipts));
    return pending;
  };
  const onTerm = () => { void handler('SIGTERM'); };
  const onInt = () => { void handler('SIGINT'); };
  emitter.on('SIGTERM', onTerm); emitter.on('SIGINT', onInt);
  return { dispose() { emitter.off('SIGTERM', onTerm); emitter.off('SIGINT', onInt); }, settled: () => pending };
}
