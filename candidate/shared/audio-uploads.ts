import type { IngestionFile } from './contracts';

/** These are storage limits; upload completion does not imply ASR availability. */
export interface AudioLimits {
  maxFileBytes: number;
  chunkBytes: number;
  maxStoredBytes: number;
  maxAssets: number;
  maxSessions: number;
  maxIdentities: number;
  maxIncomingChunks: number;
  chunkIdleTimeoutMs: number;
  chunkTimeoutMs: number;
  filesystemHeadroomBytes: number;
  maxDurationSeconds: number;
  captureMaxDurationSeconds: number;
  captureMaxBytes: number;
}
export interface AudioUploadCapabilities extends AudioLimits {
  available: boolean;
  resumable: boolean;
  asrAvailable: boolean;
}
export const DEFAULT_AUDIO_LIMITS: Readonly<AudioLimits> = Object.freeze({
  maxFileBytes: 128 * 1024 * 1024,
  chunkBytes: 1024 * 1024,
  maxStoredBytes: 512 * 1024 * 1024,
  maxAssets: 50,
  maxSessions: 2,
  maxIdentities: 500,
  maxIncomingChunks: 2,
  chunkIdleTimeoutMs: 30_000,
  chunkTimeoutMs: 120_000,
  filesystemHeadroomBytes: 64 * 1024 * 1024,
  maxDurationSeconds: 3600,
  captureMaxDurationSeconds: 600,
  captureMaxBytes: 10 * 1024 * 1024,
});
export interface AudioUploadManifest {
  name: string;
  contentType: string;
  totalBytes: number;
  chunkBytes: number;
  chunkSha256: string[];
}
export interface CreateAudioUpload extends AudioUploadManifest {
  idempotencyKey: string;
}
export type AudioUploadState =
  'receiving' | 'committing' | 'completed' | 'cancelling' | 'cancelled' | 'failed';
export type AudioUploadErrorCode =
  | 'UPLOAD_INVALID'
  | 'UPLOAD_TOO_LARGE'
  | 'UPLOAD_NOT_FOUND'
  | 'UPLOAD_CONFLICT'
  | 'UPLOAD_BUSY'
  | 'UPLOAD_QUOTA'
  | 'UPLOAD_CORRUPT'
  | 'UPLOAD_STORAGE'
  | 'UPLOAD_ABORTED';
export interface AudioUploadSession {
  id: string;
  idempotencyKey: string;
  manifest: AudioUploadManifest;
  /** SHA-256 of canonicalAudioManifest, never a file-byte SHA-256. */
  commitment: string;
  state: AudioUploadState;
  receivedBytes: number;
  nextChunkIndex: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  file?: IngestionFile;
  error?: { code: AudioUploadErrorCode; message: string; retryable: boolean };
}
export const AUDIO_CONTENT_TYPES = Object.freeze([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/x-m4a',
  'audio/webm',
  'audio/ogg',
  'audio/flac',
]);
/** Shared browser/server normalization. Reject controls before stripping a path. */
export function normalizeAudioMetadata(
  name: string,
  contentType: string,
): { name: string; contentType: string } {
  if (
    typeof name !== 'string' ||
    typeof contentType !== 'string' ||
    [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error('Invalid audio metadata');
  const normalizedName = name.normalize('NFC').split(/[\\/]/).at(-1)!.trim();
  const normalizedType = contentType.split(';')[0].trim().toLowerCase();
  if (
    !normalizedName ||
    normalizedName === '.' ||
    normalizedName === '..' ||
    normalizedName.length > 180 ||
    !AUDIO_CONTENT_TYPES.includes(normalizedType)
  )
    throw new Error('Invalid audio metadata');
  return { name: normalizedName, contentType: normalizedType };
}
/** UTF-8 encode this exact string, then SHA-256 it. No locale-dependent ordering. */
export function canonicalAudioManifest(manifest: AudioUploadManifest): string {
  const normalized = normalizeAudioMetadata(manifest.name, manifest.contentType);
  return JSON.stringify({
    version: 1,
    name: normalized.name,
    contentType: normalized.contentType,
    totalBytes: manifest.totalBytes,
    chunkBytes: manifest.chunkBytes,
    chunkSha256: manifest.chunkSha256,
  });
}
