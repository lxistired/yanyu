/** Public metadata only, extracted unchanged from the original registry DTO. */
export type IntegrationKind =
  'model.text' | 'asr.transcribe' | 'tts' | 'live' | 'im' | 'hardware' | 'payment';
export interface IntegrationCapability {
  id: string;
  label: string;
  kind: IntegrationKind;
  implemented: boolean;
  configured: boolean;
  /** Local eligibility only. Does not attest to credentials, compatibility, reachability or balance. */
  available: boolean;
  reason: 'eligible' | 'contract-only' | 'unconfigured' | 'disabled' | 'unavailable';
}
