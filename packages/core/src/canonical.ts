import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no insignificant
 * whitespace, `undefined` members dropped. Only safe integers are allowed as
 * numbers so that every implementation serialises them identically; monetary
 * values are always decimal strings.
 */
export function canonicalJson(value: unknown): string {
  return encode(value as Json);
}

function encode(value: Json | undefined): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`canonical JSON only encodes safe integers, got ${value}`);
      }
      return String(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
      const members = Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(value[key])}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
  }
}

export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(sha256(typeof input === 'string' ? utf8ToBytes(input) : input));
}

export function sha256Digest(input: string | Uint8Array): string {
  return `sha256:${sha256Hex(input)}`;
}

/** The 32-byte digest as the `bytes32` value the EVM executor records. */
export function digestToBytes32(digest: string): `0x${string}` {
  const match = /^sha256:([0-9a-f]{64})$/.exec(digest);
  if (!match) throw new TypeError(`not a sha256 digest: ${digest}`);
  return `0x${match[1]}`;
}
