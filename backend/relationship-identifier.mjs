// Preserve legacy consumer IDs and admit authoritative WorkspaceDomain IDs.
// Absolute end assertion rejects trailing line terminators (unlike $).
export const relationshipIdentifier = value => typeof value === 'string' && (
 /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}(?![\s\S])/.test(value) ||
 /^[A-Za-z0-9_-]{1,100}(?![\s\S])/.test(value)
);
