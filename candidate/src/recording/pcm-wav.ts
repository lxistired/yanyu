/** Original standalone foundation. No capture, resampling, downmix, or app integration. */
export const SAMPLE_RATE = 16000 as const;
export const HEADER_BYTES = 44 as const;
export const HARD_MAX_SECONDS = 300 as const;
export const HARD_MAX_BYTES = 16 * 1024 * 1024;
const BLOCK_FRAMES = 32768;
// Read internal typed-array slots, never shadowable instance properties.
const typedArrayPrototype = Object.getPrototypeOf(Int16Array.prototype);
const intrinsicLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')!.get!;
const intrinsicTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const intrinsicBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const intrinsicArrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const intrinsicValues = typedArrayPrototype.values as (this: Int16Array | Float32Array) => IterableIterator<number>;

export type WavErrorCode = 'INVALID_LIMITS' | 'INVALID_INPUT' | 'NON_FINITE_SAMPLE' |
  'LIMIT_EXCEEDED' | 'EMPTY' | 'INCOMPLETE' | 'FINALIZED' | 'FAILED' | 'ABORTED' | 'ALLOCATION_FAILED';
export class WavEncodingError extends Error {
  constructor(readonly code: WavErrorCode) { super(code); this.name = 'WavEncodingError'; }
}
export interface WavLimitsInput { maxDurationSeconds?: number; maxBytes?: number }
export interface WavLimits {
  readonly maxDurationSeconds: number;
  readonly maxBytes: number;
  readonly maxFrames: number;
}
export type WavState = 'open' | 'finalized' | 'failed' | 'aborted';
export interface WavSnapshot {
  readonly state: WavState;
  readonly frameCount: number;
  readonly durationSeconds: number;
  readonly byteLength: number;
  readonly remainingFrames: number;
}
export interface WavResult {
  readonly bytes: Uint8Array;
  readonly frameCount: number;
  readonly durationSeconds: number;
  readonly byteLength: number;
}
export interface MonoPcm16WavBuilder {
  readonly limits: Readonly<WavLimits>;
  appendFloat32(frames: Float32Array): void;
  appendPcm16(frames: Int16Array): void;
  snapshot(): Readonly<WavSnapshot>;
  finalize(expectedFrameCount: number): Readonly<WavResult>;
  /** Idempotent cleanup. Never changes a finalized or failed outcome. */
  abort(): void;
}

export function createMonoPcm16WavBuilder(input: WavLimitsInput = {}): MonoPcm16WavBuilder {
  if (input === null || typeof input !== 'object') throw new WavEncodingError('INVALID_LIMITS');
  let seconds: number;
  let bytes: number;
  try {
    const requestedSeconds = input.maxDurationSeconds;
    const requestedBytes = input.maxBytes;
    seconds = requestedSeconds === undefined ? HARD_MAX_SECONDS : requestedSeconds;
    bytes = requestedBytes === undefined ? HARD_MAX_BYTES : requestedBytes;
  } catch { throw new WavEncodingError('INVALID_LIMITS'); }
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > HARD_MAX_SECONDS ||
      !Number.isSafeInteger(bytes) || bytes < HEADER_BYTES + 2 || bytes > HARD_MAX_BYTES) {
    throw new WavEncodingError('INVALID_LIMITS');
  }
  const maxFrames = Math.min(Math.floor(seconds * SAMPLE_RATE), Math.floor((bytes - HEADER_BYTES) / 2));
  if (maxFrames < 1) throw new WavEncodingError('INVALID_LIMITS');
  const limits = Object.freeze({ maxDurationSeconds: seconds, maxBytes: bytes, maxFrames });
  let state: WavState = 'open';
  let frameCount = 0;
  let blocks: Uint8Array[] = [];
  function fail(code: WavErrorCode): never {
    state = 'failed'; blocks = []; throw new WavEncodingError(code);
  }
  function allocate(size: number): Uint8Array {
    try { return new Uint8Array(size); } catch { return fail('ALLOCATION_FAILED'); }
  }
  function requireOpen(): void {
    if (state !== 'open') throw new WavEncodingError(state === 'finalized' ? 'FINALIZED' : state === 'aborted' ? 'ABORTED' : 'FAILED');
  }
  function append(frames: Float32Array | Int16Array, float: boolean): void {
    requireOpen();
    let length: number;
    try {
      if (!(float ? frames instanceof Float32Array : frames instanceof Int16Array)) throw new Error();
      // Also validates detached/out-of-bounds views without invoking subclass species.
      intrinsicValues.call(frames);
      if (intrinsicTag.call(frames) !== (float ? 'Float32Array' : 'Int16Array')) throw new Error();
      const buffer = intrinsicBuffer.call(frames);
      if (!(buffer instanceof ArrayBuffer)) throw new Error();
      intrinsicArrayBufferLength.call(buffer); // Reject shared buffers even with a spoofed prototype.
      length = intrinsicLength.call(frames);
    } catch { fail('INVALID_INPUT'); }
    if (length > maxFrames - frameCount) fail('LIMIT_EXCEEDED');
    if (float) for (let i = 0; i < length; i++) if (!Number.isFinite(frames[i])) fail('NON_FINITE_SAMPLE');
    for (let i = 0; i < length; i++) {
      const target = frameCount + i;
      const blockIndex = Math.floor(target / BLOCK_FRAMES);
      if (!blocks[blockIndex]) blocks.push(allocate(Math.min(BLOCK_FRAMES, maxFrames - blockIndex * BLOCK_FRAMES) * 2));
      const sample = frames[i];
      const scaled = float ? (sample < 0 ? Math.max(-1, sample) * 32768 : Math.min(1, sample) * 32767) : sample;
      const value = scaled < 0 ? -Math.floor(-scaled + 0.5) : Math.floor(scaled + 0.5);
      const offset = (target % BLOCK_FRAMES) * 2;
      blocks[blockIndex][offset] = value & 255;
      blocks[blockIndex][offset + 1] = (value >> 8) & 255;
    }
    frameCount += length;
  }
  return Object.freeze({
    limits,
    appendFloat32: (frames: Float32Array) => append(frames, true),
    appendPcm16: (frames: Int16Array) => append(frames, false),
    snapshot: () => Object.freeze({ state, frameCount, durationSeconds: frameCount / SAMPLE_RATE,
      byteLength: HEADER_BYTES + frameCount * 2, remainingFrames: maxFrames - frameCount }),
    finalize(expectedFrameCount: number): Readonly<WavResult> {
      requireOpen();
      if (!Number.isSafeInteger(expectedFrameCount) || expectedFrameCount < 0 || expectedFrameCount !== frameCount) fail('INCOMPLETE');
      if (frameCount === 0) fail('EMPTY');
      const byteLength = HEADER_BYTES + frameCount * 2;
      const output = allocate(byteLength);
      const view = new DataView(output.buffer);
      const tag = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) output[offset + i] = value.charCodeAt(i); };
      tag(0, 'RIFF'); view.setUint32(4, byteLength - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true);
      view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, frameCount * 2, true);
      let offset = HEADER_BYTES;
      for (const block of blocks) { const take = Math.min(block.length, byteLength - offset); output.set(block.subarray(0, take), offset); offset += take; }
      blocks = []; state = 'finalized';
      return Object.freeze({ bytes: output, frameCount, durationSeconds: frameCount / SAMPLE_RATE, byteLength });
    },
    abort(): void { blocks = []; if (state === 'open') state = 'aborted'; },
  });
}
