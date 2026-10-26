// Standalone asset: admission into the application's worklet build is NOT done.
class OwnedPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.started = false; this.finished = false; this.frames = 0; this.seq = 0;
    this.paused = false; this.ack = 0; this.maxFrames = 0;
    this.port.onmessage = ({ data }) => {
      if (this.finished) return;
      if (data?.type === 'start' && !this.started && sampleRate === 16000 && Number.isSafeInteger(data.maxFrames) && data.maxFrames > 0 && data.maxFrames <= Math.min(300 * 16000, Math.floor((16 * 1024 * 1024 - 44) / 2))) {
        this.started = true; this.maxFrames = data.maxFrames;
      } else if (data?.type === 'ack' && Number.isSafeInteger(data.seq) && data.seq === this.ack && data.seq < this.seq) {
        this.ack++;
      } else if (data?.type === 'pause' && this.started && !this.paused) {
        this.paused = true;
        this.port.postMessage({ type: 'paused', chunkCount: this.seq, totalFrames: this.frames });
      } else if (data?.type === 'resume' && this.started && this.paused) {
        this.paused = false;
        this.port.postMessage({ type: 'resumed', chunkCount: this.seq, totalFrames: this.frames });
      } else if (data?.type === 'stop' && this.started) {
        this.finish('user-stop');
      } else this.error();
    };
  }
  error() { this.finished = true; this.port.postMessage({ type: 'error' }); }
  finish(reason) {
    this.finished = true;
    this.port.postMessage({ type: 'final', chunkCount: this.seq, totalFrames: this.frames, reason });
  }
  process(inputs, outputs) {
    // Silence every output on every branch, including before start and after failure.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (!this.started || this.finished) return !this.finished;
    if (this.paused) return true;
    const input = inputs[0];
    if (inputs.length !== 1 || !input || input.length !== 1 || !(input[0] instanceof Float32Array) || input[0].length < 1 || input[0].length > 128 || this.seq - this.ack >= 32) { this.error(); return false; }
    const samples = input[0];
    const count = Math.min(samples.length, this.maxFrames - this.frames);
    const pcm = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      if (!Number.isFinite(samples[i])) { this.error(); return false; }
      const value = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = Math.round(value < 0 ? value * 32768 : value * 32767);
    }
    this.port.postMessage({ type: 'chunk', seq: this.seq++, pcm }, [pcm.buffer]);
    this.frames += count;
    if (this.frames === this.maxFrames) { this.finish('limit'); return false; }
    return true;
  }
}
registerProcessor('owned-pcm-capture', OwnedPcmCapture);
