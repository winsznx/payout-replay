import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijkmnpqrstuvwxyz';

export type IdPrefix =
  | 'usr'
  | 'uid'
  | 'chl'
  | 'ses'
  | 'org'
  | 'wal'
  | 'ast'
  | 'pr'
  | 'imp'
  | 'mv'
  | 'obl'
  | 'apr'
  | 'plan'
  | 'att'
  | 'obs'
  | 'stm'
  | 'res'
  | 'exc'
  | 'aud'
  | 'key'
  | 'whk'
  | 'dlv'
  | 'evt'
  | 'trc';

/** Prefixed random ID, e.g. `pr_7k2m...`; 20 characters of entropy (~100 bits). */
export function newId(prefix: IdPrefix): string {
  const bytes = randomBytes(20);
  let body = '';
  for (const byte of bytes) body += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${body}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
