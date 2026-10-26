// Legacy document IDs plus authoritative workspace IDs, with an absolute end.
export const workspaceIdentifier = (value:unknown):value is string => typeof value==='string' && (
 /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}(?![\s\S])/.test(value) ||
 /^[A-Za-z0-9_-]{1,100}(?![\s\S])/.test(value)
);
