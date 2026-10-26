// Standalone foundation. Importing this module never accesses browser APIs.
export const SAMPLE_RATE = 16000;
export const HEADER_BYTES = 44;
// Session preparation is bounded at 10s, followed by a store operation bounded at
// 10s. Keep this outer delivery watchdog longer than both stages; it is not a
// durability guarantee. Buffer saturation still stops capture immediately.
const CHECKPOINT_DELIVERY_TIMEOUT_MS = 21_000;
const ACTIVE = new Set(['requesting', 'preparing', 'recording', 'pausing', 'paused', 'resuming', 'stopping']);
const ERRORS = new Set(['permission-unavailable', 'unsupported-audio', 'invalid-limits', 'invalid-pcm', 'capture-stalled', 'capture-failed', 'encoding-failed', 'persistence-failed']);

export function resolveCaptureLimits(server = {}) {
  const seconds = server.maxDurationSeconds ?? 300;
  const bytes = server.maxWavBytes ?? 16 * 1024 * 1024;
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isSafeInteger(bytes) || bytes < 46) throw new Error('invalid-limits');
  const maxWavBytes = Math.min(16 * 1024 * 1024, bytes);
  const maxFrames = Math.min(Math.floor(Math.min(300, seconds) * SAMPLE_RATE), Math.floor((maxWavBytes - HEADER_BYTES) / 2));
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1) throw new Error('invalid-limits');
  return Object.freeze({ maxFrames, maxWavBytes, maxDurationSeconds: maxFrames / SAMPLE_RATE, encoderDurationSeconds: Math.min(300, seconds) });
}

/** Dependencies are owned by the caller; none are defaulted to real browser globals.
 * getUserMedia(constraints), createAudioContext({sampleRate}), prepareWorklet(context),
 * createEncoder({maxDurationSeconds,maxBytes}), timers:{setTimeout,clearTimeout},
 * visibility:{isHidden(),subscribe(callback)}, pagehide:{subscribe(callback)}.
 * Worklet factory must return an unconnected AudioWorkletNode configured for one input,
 * one mono output, channelCount:1, channelCountMode:'explicit', channelInterpretation:'discrete'.
 */
export function createRecordingController(deps) {
  let current = null, generation = 0, disposed = false, checkpointAttempt = null, sinkUsed = false;
  let snapshot = Object.freeze({ state: 'idle', artifact: null, error: null, reason: null, persistenceStatus: 'disabled', receivedFrames: 0, persistedFrames: 0 });
  const subscribers = new Set();
  const publish = (patch) => {
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const fn of subscribers) { try { fn(snapshot); } catch {} }
  };
  const live = a => current === a && a.generation === generation && !disposed;
  const tracksOff = a => {
    if (!a.stream || a.stoppedStream === a.stream) return;
    a.stoppedStream = a.stream;
    for (const track of a.stream.getTracks()) { try { track.stop(); } catch {} }
  };
  const clearTimer = (a, key) => { if (a[key] != null) deps.timers.clearTimeout(a[key]); a[key] = null; };
  const cleanup = a => {
    tracksOff(a);
    for (const key of ['watchdog', 'deadline', 'finalTimer', 'preparationTimer', 'permissionTimer', 'transitionTimer']) clearTimer(a, key);
    for (const unsub of a.unsubscribers) { try { unsub(); } catch {} }
    a.unsubscribers = [];
    if (a.node) { a.node.port.onmessage = null; a.node.onprocessorerror = null; try { a.node.port.close(); } catch {} }
    if (a.context) a.context.onstatechange = null;
    for (const node of [a.source, a.node, a.gain]) { try { node?.disconnect(); } catch {} }
    try { Promise.resolve(a.context?.close()).catch(() => {}); } catch {}
    try { a.encoder?.abort(); } catch {}
  };
  // Capture ACK and storage acknowledgement are intentionally separate. Only receipts
  // advance persistedFrames. One full immutable operation + one filling buffer maximum.
  const ownsCheckpoint = a => !disposed && checkpointAttempt === a && a.checkpoint.owner === generation;
  const checkpointPatch = (a, patch) => { if (ownsCheckpoint(a)) publish(patch); };
  const abandonCheckpoint = a => {
    if (!a?.checkpoint) return;
    a.checkpoint.halted = true; a.checkpoint.used = 0;
    clearTimer(a, 'checkpointTimer');
  };
  const persistenceFailure = (a, unknown = false) => {
    const c = a.checkpoint;
    if (!c || !ownsCheckpoint(a)) return;
    c.halted = true; c.used = 0;
    clearTimer(a, 'checkpointTimer');
    checkpointPatch(a, { persistenceStatus: unknown ? 'uncertain' : 'failed' });
    if (live(a)) fail(a, 'persistence-failed');
  };
  const validReceipt = (a, r, frames, segments, status) => {
    const c = a.checkpoint, identity = c.sink.identity;
    return r && r.schema === 2 && r.id === identity.id && r.writerEpoch === identity.writerEpoch
      && Number.isSafeInteger(r.revision) && r.revision >= 0
      && ['committed', 'already-committed'].includes(r.result)
      && r.committedFrames === frames && r.committedSegmentCount === segments
      && r.committedPcmBytes === frames * 2 && r.status === status
      && r.expiresAt === c.sink.expiresAt
      && ['maxFrames', 'maxWavBytes', 'maxDurationSeconds'].every(k => r.limits?.[k] === a.limits[k]);
  };
  const pumpCheckpoint = a => {
    const c = a.checkpoint;
    if (!c || !ownsCheckpoint(a) || c.halted || c.pending) return;
    let operation, expectedFrames = c.frames, expectedSegments = c.index;
    let expectedStatus = 'capturing';
    if (c.used === SAMPLE_RATE || (c.intent && c.used > 0)) {
      const pcm = c.buffer.slice(0, c.used);
      expectedFrames += c.used; expectedSegments++;
      c.used = 0;
      operation = () => c.sink.append({ segmentIndex: c.index, startFrame: c.frames, pcm });
    } else if (c.intent) {
      expectedStatus = c.intent.kind;
      operation = () => c.sink.finish(c.intent);
    } else return;
    const token = {}; c.pending = token;
    a.checkpointTimer = deps.timers.setTimeout(() => {
      if (c.pending !== token || !ownsCheckpoint(a)) return;
      // The operation may have committed. Never pretend that timeout is an abort.
      c.pending = null;
      persistenceFailure(a, true);
    }, CHECKPOINT_DELIVERY_TIMEOUT_MS);
    let result;
    try { result = operation(); } catch (error) { result = Promise.reject(error); }
    Promise.resolve(result).then(receipt => {
      if (c.pending !== token || !ownsCheckpoint(a)) return;
      c.pending = null; clearTimer(a, 'checkpointTimer');
      if (!validReceipt(a, receipt, expectedFrames, expectedSegments, expectedStatus)) return persistenceFailure(a, true);
      c.frames = receipt.committedFrames; c.index = receipt.committedSegmentCount;
      checkpointPatch(a, { persistedFrames: c.frames,
        persistenceStatus: c.halted ? 'failed' : expectedStatus === 'capturing' ? (c.intent ? 'draining' : 'active') : expectedStatus });
      if (expectedStatus !== 'capturing') { c.halted = true; return; }
      pumpCheckpoint(a);
    }, error => {
      if (c.pending !== token || !ownsCheckpoint(a)) return;
      c.pending = null;
      persistenceFailure(a, error?.outcome !== 'aborted' && error?.outcome !== 'not-started');
    });
  };
  const collectCheckpoint = (a, pcm) => {
    const c = a.checkpoint;
    if (!c) return true;
    // Check the whole chunk before retaining any part or accepting it into the WAV.
    if (c.halted || (c.pending && c.used + pcm.length > SAMPLE_RATE)) {
      persistenceFailure(a, Boolean(c.pending)); return false;
    }
    let offset = 0;
    while (offset < pcm.length) {
      const count = Math.min(pcm.length - offset, SAMPLE_RATE - c.used);
      c.buffer.set(pcm.subarray(offset, offset + count), c.used);
      c.used += count; offset += count;
      pumpCheckpoint(a);
      if (c.halted || !live(a)) return false;
    }
    return true;
  };
  const endCheckpoint = (a, intent, owner) => {
    if (!a.checkpoint) return;
    a.checkpoint.owner = owner;
    if (a.checkpoint.halted) return;
    a.checkpoint.intent = intent;
    checkpointPatch(a, { persistenceStatus: 'draining' });
    pumpCheckpoint(a);
  };
  const fail = (a, code) => {
    if (!live(a)) return;
    current = null; const terminalGeneration = ++generation;
    cleanup(a);
    if (generation !== terminalGeneration || current || disposed) return;
    publish({ state: 'error', artifact: null, error: ERRORS.has(code) ? code : 'capture-failed', reason: null });
    endCheckpoint(a, { kind: 'interrupted', reason: ['invalid-pcm', 'capture-stalled', 'persistence-failed'].includes(code) ? code : 'capture-failed', observedReceivedFrames: a.frames }, terminalGeneration);
  };
  const cancelAttempt = (a, reason = 'cancelled') => {
    if (!live(a)) return;
    current = null; const terminalGeneration = ++generation;
    cleanup(a);
    if (generation !== terminalGeneration || current || disposed) return;
    publish({ state: 'cancelled', artifact: null, error: null, reason });
    endCheckpoint(a, { kind: 'interrupted', reason: ['hidden', 'pagehide', 'track-ended', 'context-interrupted'].includes(reason) ? reason : 'disposed', observedReceivedFrames: a.frames }, terminalGeneration);
  };
  const armWatchdog = a => {
    clearTimer(a, 'watchdog');
    a.watchdog = deps.timers.setTimeout(() => fail(a, 'capture-stalled'), 2000);
  };
  const stopAttempt = (a, reason = 'user-stop') => {
    if (!live(a)) return;
    // Stop hardware before asking the processor for its final accounting.
    tracksOff(a);
    if (!live(a)) return;
    if (snapshot.state === 'requesting' || snapshot.state === 'preparing' || !a.processorStarted) return cancelAttempt(a, reason);
    if (!['recording', 'pausing', 'paused', 'resuming'].includes(snapshot.state)) return;
    a.reason = reason;
    clearTimer(a, 'watchdog'); clearTimer(a, 'deadline'); clearTimer(a, 'transitionTimer');
    publish({ state: 'stopping', reason });
    if (!live(a)) return;
    a.finalTimer = deps.timers.setTimeout(() => fail(a, 'capture-stalled'), 2000);
    try { a.node.port.postMessage({ type: 'stop' }); } catch { fail(a, 'capture-failed'); }
  };
  const message = (a, data) => {
    if (!live(a) || !['recording', 'pausing', 'paused', 'resuming', 'stopping'].includes(snapshot.state)) return;
    if (!data || typeof data !== 'object') return fail(a, 'invalid-pcm');
    if (data.type === 'error') return fail(a, 'invalid-pcm');
    if (data.type === 'paused' || data.type === 'resumed') {
      const expected = data.type === 'paused' ? 'pause' : 'resume';
      if (a.transition !== expected || data.chunkCount !== a.seq || data.totalFrames !== a.frames) return fail(a, 'invalid-pcm');
      a.transition = null; clearTimer(a, 'transitionTimer');
      // A stop may race the acknowledgement. Accounting is checked, but the
      // late acknowledgement must never revive stopping/finished capture.
      if (snapshot.state === 'stopping') return;
      if (data.type === 'paused') {
        a.pauseCount++; publish({ state: 'paused', pauseCount: a.pauseCount });
      } else {
        publish({ state: 'recording' });
        if (live(a) && snapshot.state === 'recording') armWatchdog(a);
      }
      return;
    }
    if (data.type === 'chunk') {
      if (snapshot.state === 'paused' || snapshot.state === 'resuming') return fail(a, 'invalid-pcm');
      if (a.final || data.seq !== a.seq || !(data.pcm instanceof Int16Array) || data.pcm.length < 1 || data.pcm.length > 128 || a.frames + data.pcm.length > a.limits.maxFrames) return fail(a, 'invalid-pcm');
      if (a.checkpoint && (a.checkpoint.halted || (a.checkpoint.pending && a.checkpoint.used + data.pcm.length > SAMPLE_RATE))) return persistenceFailure(a, Boolean(a.checkpoint.pending));
      try { a.encoder.appendPcm16(data.pcm); } catch { return fail(a, 'invalid-pcm'); }
      a.frames += data.pcm.length; a.seq++;
      if (!collectCheckpoint(a, data.pcm)) return;
      if (a.checkpoint) checkpointPatch(a, { receivedFrames: a.frames });
      if (!live(a)) return;
      try { a.node.port.postMessage({ type: 'ack', seq: data.seq }); } catch { return fail(a, 'capture-failed'); }
      if (snapshot.state === 'recording') armWatchdog(a);
      return;
    }
    if (data.type !== 'final' || a.final || data.chunkCount !== a.seq || data.totalFrames !== a.frames || a.frames < 1 || !['user-stop', 'limit'].includes(data.reason) || (data.reason === 'limit' && a.frames !== a.limits.maxFrames) || (snapshot.state !== 'stopping' && data.reason !== 'limit')) return fail(a, 'invalid-pcm');
    a.final = true;
    tracksOff(a);
    const reason = a.reason ?? data.reason;
    const interrupted = !['user-stop', 'limit'].includes(reason);
    let artifact;
    try {
      const result = a.encoder.finalize(a.frames);
      if (result.frameCount !== a.frames) throw new Error();
      artifact = result.bytes;
      if (!(artifact instanceof Uint8Array) || artifact.byteLength !== HEADER_BYTES + a.frames * 2 || artifact.byteLength > a.limits.maxWavBytes) throw new Error();
    } catch { return fail(a, 'encoding-failed'); }
    if (!live(a)) return;
    current = null; const terminalGeneration = ++generation;
    const frames = a.frames;
    cleanup(a);
    if (generation !== terminalGeneration || current || disposed) return;
    publish({ state: 'ready', artifact, error: null, reason, frames, sampleRate: SAMPLE_RATE, interrupted, reachedLimit: data.reason === 'limit' || reason === 'duration-limit' });
    endCheckpoint(a, interrupted
      ? { kind: 'interrupted', reason, observedReceivedFrames: frames }
      : { kind: 'sealed', accounting: { receivedFrames: frames, receivedChunkCount: a.seq, finalChunkCount: data.chunkCount, finalTotalFrames: data.totalFrames, processorReason: data.reason, stopReason: reason } }, terminalGeneration);
  };
  const transitionAttempt = (a, kind) => {
    if (!live(a) || a.transition || snapshot.state !== (kind === 'pause' ? 'recording' : 'paused') || !a.processorStarted) return;
    clearTimer(a, 'watchdog');
    a.transition = kind;
    publish({ state: kind === 'pause' ? 'pausing' : 'resuming' });
    if (!live(a) || snapshot.state === 'stopping') return;
    a.transitionTimer = deps.timers.setTimeout(() => fail(a, 'capture-stalled'), 2000);
    try { a.node.port.postMessage({ type: kind }); } catch { fail(a, 'capture-failed'); }
  };
  async function run(a) {
    try {
      if (!live(a)) return;
      a.permissionTimer = deps.timers.setTimeout(() => fail(a, 'capture-stalled'), 30000);
      a.stream = await deps.getUserMedia({ audio: { channelCount: { exact: 1 }, sampleRate: { ideal: SAMPLE_RATE } }, video: false });
      if (!live(a)) { cleanup(a); return; }
      clearTimer(a, 'permissionTimer');
      if (deps.visibility.isHidden()) { cancelAttempt(a, 'hidden'); return; }
      const audioTracks = a.stream.getAudioTracks();
      if (audioTracks.length !== 1 || audioTracks[0].readyState !== 'live') return fail(a, 'unsupported-audio');
      const track = audioTracks[0];
      const reportedChannels = track.getSettings?.().channelCount;
      if (reportedChannels != null && reportedChannels !== 1) return fail(a, 'unsupported-audio');
      const ended = () => stopAttempt(a, 'track-ended');
      track.addEventListener('ended', ended);
      a.unsubscribers.push(() => track.removeEventListener('ended', ended));
      publish({ state: 'preparing' });
      if (!live(a)) return;
      a.preparationTimer = deps.timers.setTimeout(() => fail(a, 'capture-stalled'), 2000);
      a.context = deps.createAudioContext({ sampleRate: SAMPLE_RATE });
      if (!live(a)) { cleanup(a); return; }
      if (a.context.sampleRate !== SAMPLE_RATE || a.context.state !== 'running') return fail(a, 'unsupported-audio');
      a.context.onstatechange = () => { if (a.context.state !== 'running') stopAttempt(a, 'context-interrupted'); };
      a.node = await deps.prepareWorklet(a.context);
      if (!live(a)) { cleanup(a); return; }
      clearTimer(a, 'preparationTimer');
      if (deps.visibility.isHidden()) return cancelAttempt(a, 'hidden');
      if (a.context.state !== 'running' || track.readyState !== 'live') return cancelAttempt(a, 'preparation-interrupted');
      // No path to destination exists except through the silent worklet AND zero gain.
      a.node.channelCount = 1; a.node.channelCountMode = 'explicit'; a.node.channelInterpretation = 'discrete';
      a.node.port.onmessage = event => message(a, event.data);
      a.node.onprocessorerror = () => fail(a, 'capture-failed');
      a.source = a.context.createMediaStreamSource(a.stream);
      a.source.channelCount = 1; a.source.channelCountMode = 'explicit'; a.source.channelInterpretation = 'discrete';
      a.gain = a.context.createGain(); a.gain.gain.value = 0;
      a.source.connect(a.node); a.node.connect(a.gain); a.gain.connect(a.context.destination);
      publish({ state: 'recording', reason: null });
      if (!live(a)) return;
      a.processorStarted = true;
      a.node.port.postMessage({ type: 'start', maxFrames: a.limits.maxFrames });
      if (!live(a)) return;
      armWatchdog(a);
      a.deadline = deps.timers.setTimeout(() => stopAttempt(a, 'duration-limit'), a.limits.maxDurationSeconds * 1000);
    } catch { if (live(a)) fail(a, snapshot.state === 'requesting' ? 'permission-unavailable' : 'capture-failed'); else cleanup(a); }
  }
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    start(serverLimits) {
      if (disposed) return Promise.resolve();
      if (current && ACTIVE.has(snapshot.state)) return current.promise;
      let limits;
      try { limits = resolveCaptureLimits(serverLimits); } catch { publish({ state: 'error', artifact: null, error: 'invalid-limits' }); return Promise.resolve(); }
      const sink = deps.checkpointSink;
      if (sink && (sinkUsed || !sink.identity || sink.identity.schema !== 2
        || !Number.isSafeInteger(sink.expiresAt) || typeof sink.append !== 'function' || typeof sink.finish !== 'function'
        || !['maxFrames', 'maxWavBytes', 'maxDurationSeconds'].every(k => sink.limits?.[k] === limits[k]))) {
        publish({ state: 'error', artifact: null, error: 'invalid-limits' }); return Promise.resolve();
      }
      abandonCheckpoint(checkpointAttempt);
      const a = { generation: ++generation, limits, frames: 0, seq: 0, pauseCount: 0, transition: null, final: false, unsubscribers: [] };
      current = a;
      if (sink) {
        sinkUsed = true; checkpointAttempt = a;
        a.checkpoint = { sink, owner: generation, buffer: new Int16Array(SAMPLE_RATE), used: 0,
          frames: 0, index: 0, pending: null, halted: false, intent: null };
      }
      try { a.encoder = deps.createEncoder({ maxDurationSeconds: limits.encoderDurationSeconds, maxBytes: limits.maxWavBytes }); } catch { fail(a, 'encoding-failed'); return Promise.resolve(); }
      if (!live(a)) { cleanup(a); return Promise.resolve(); }
      publish({ state: 'requesting', artifact: null, error: null, reason: null, frames: 0, pauseCount: 0, interrupted: false, receivedFrames: 0, persistedFrames: 0, persistenceStatus: sink ? 'active' : 'disabled', checkpointIdentity: sink?.identity, checkpointExpiresAt: sink?.expiresAt });
      if (!live(a)) return Promise.resolve();
      const visibilityUnsubscribe = deps.visibility.subscribe(() => { if (deps.visibility.isHidden()) stopAttempt(a, 'hidden'); });
      if (!live(a)) { visibilityUnsubscribe(); return Promise.resolve(); }
      a.unsubscribers.push(visibilityUnsubscribe);
      const pagehideUnsubscribe = deps.pagehide.subscribe(() => stopAttempt(a, 'pagehide'));
      if (!live(a)) { pagehideUnsubscribe(); return Promise.resolve(); }
      a.unsubscribers.push(pagehideUnsubscribe);
      if (deps.visibility.isHidden()) { cancelAttempt(a, 'hidden'); return Promise.resolve(); }
      a.promise = run(a);
      return a.promise;
    },
    pause() { if (current) transitionAttempt(current, 'pause'); },
    resume() { if (current) transitionAttempt(current, 'resume'); },
    stop() { if (current) stopAttempt(current); },
    cancel() { if (current) cancelAttempt(current); },
    dispose() {
      if (disposed) return;
      disposed = true;
      abandonCheckpoint(checkpointAttempt);
      const a = current; current = null; generation++;
      if (a) { cleanup(a); publish({ state: 'cancelled', artifact: null, error: null, reason: 'disposed' }); }
      subscribers.clear();
    },
  });
}
