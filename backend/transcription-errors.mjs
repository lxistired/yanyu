// Closed public vocabulary. Never interpolate worker diagnostics or stored error text.
const messages = Object.freeze({
  "ASR_FAILED": "Local recognition failed; re-upload required",
  "ASR_DEADLINE": "Job deadline exceeded",
  "ASR_OUTPUT_LIMIT": "Result output limit exceeded",
  "ASR_WORKER_OUTPUT": "Malformed worker output",
  "ASR_DIAGNOSTICS_LIMIT": "Worker diagnostics exceeded",
  "ASR_CANCELLED": "已取消",
  "ASR_INTERRUPTED": "服务中断；请明确继续识别，或取消以删除临时音频",
  "ASR_PENDING_EXPIRED": "Pending audio expired or unavailable; re-upload required",
  "ASR_PENDING_UNAVAILABLE": "Pending audio unavailable; re-upload required",
  "ASR_CHECKPOINT_INVALID": "Checkpoint invalid; re-upload required",
  "ASR_AUDIO_INVALID": "Invalid, truncated or unsupported audio; re-upload required",
  "ASR_MODEL_UNAVAILABLE": "Local model unavailable; check the offline model setup and re-upload",
  "ASR_LANGUAGE_INVALID": "Language must be auto, zh or en"
});
const legacy = new Map(Object.entries(messages).map(([code, message]) => [message, code]));
legacy.set('Checkpoint settings invalid; re-upload required', 'ASR_CHECKPOINT_INVALID');
export function workerErrorCode(value) {
 // A known code never grants permission to forward the associated worker message.
 return typeof value?.error_code === 'string' && Object.hasOwn(messages, value.error_code)
  ? value.error_code : 'ASR_FAILED';
}
export function publicTranscriptionError(value) {
 if (value === null || value === undefined) return {error: null, error_code: null};
 const code = typeof value === 'string'
  ? (Object.hasOwn(messages, value) ? value : legacy.get(value)) : null;
 const safeCode = code || 'ASR_FAILED';
 return {error: messages[safeCode], error_code: safeCode};
}
