import { u8aToHex } from '@polkadot/util';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import { getAddress, isAddress } from 'viem';

import type { Environment } from './types.js';

export type AddressCheck =
  | { ok: true; canonical: string; warning?: string }
  | { ok: false; message: string };

export function checkEvmAddress(input: string): AddressCheck {
  const value = input.trim();
  if (!isAddress(value, { strict: false })) {
    return { ok: false, message: `"${input}" is not a 20-byte hex EVM address` };
  }
  const body = value.slice(2);
  const hasMixedCase = /[a-f]/.test(body) && /[A-F]/.test(body);
  if (hasMixedCase && getAddress(value) !== value) {
    return { ok: false, message: `"${input}" has an invalid EIP-55 checksum` };
  }
  const canonical = getAddress(value);
  if (canonical === '0x0000000000000000000000000000000000000000') {
    return { ok: false, message: 'the zero address cannot receive payouts' };
  }
  return { ok: true, canonical };
}

/**
 * Validates an SS58 address and re-encodes it with the network prefix. A
 * different prefix is accepted with a warning because it encodes the same
 * public key, but raw hex keys and EVM addresses are rejected outright.
 */
export function checkNativeAddress(input: string, ss58Prefix: number): AddressCheck {
  const value = input.trim();
  if (value.startsWith('0x')) {
    return { ok: false, message: `"${input}" looks like hex, native destinations must be SS58 addresses` };
  }
  let publicKey: Uint8Array;
  try {
    publicKey = decodeAddress(value, false);
  } catch (error) {
    return { ok: false, message: `"${input}" is not a valid SS58 address (${(error as Error).message})` };
  }
  if (publicKey.length !== 32) {
    return { ok: false, message: `"${input}" decodes to ${publicKey.length} bytes, expected a 32-byte account` };
  }
  const canonical = encodeAddress(publicKey, ss58Prefix);
  return canonical === value
    ? { ok: true, canonical }
    : { ok: true, canonical, warning: `re-encoded with network prefix ${ss58Prefix} as ${canonical}` };
}

export function checkAddress(environment: Environment, input: string, ss58Prefix: number): AddressCheck {
  return environment === 'evm' ? checkEvmAddress(input) : checkNativeAddress(input, ss58Prefix);
}

export function nativePublicKeyHex(address: string): `0x${string}` {
  return u8aToHex(decodeAddress(address));
}

export function sameAddress(environment: Environment, a: string, b: string): boolean {
  if (environment === 'evm') return a.toLowerCase() === b.toLowerCase();
  try {
    return nativePublicKeyHex(a) === nativePublicKeyHex(b);
  } catch {
    return false;
  }
}
