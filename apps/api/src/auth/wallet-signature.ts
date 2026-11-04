import { checkEvmAddress, checkNativeAddress, nativePublicKeyHex } from '@payout-replay/core';
import { u8aToHex, u8aWrapBytes, stringToU8a } from '@polkadot/util';
import { cryptoWaitReady, signatureVerify } from '@polkadot/util-crypto';
import { type Hex, verifyMessage } from 'viem';

export type WalletEnvironment = 'native' | 'evm';

export interface CanonicalWallet {
  environment: WalletEnvironment;
  address: string;
  addressKey: string;
}

export function canonicalWallet(environment: WalletEnvironment, address: string, ss58Prefix: number): CanonicalWallet | null {
  const check = environment === 'evm' ? checkEvmAddress(address) : checkNativeAddress(address, ss58Prefix);
  if (!check.ok) return null;
  return {
    environment,
    address: check.canonical,
    addressKey: environment === 'evm' ? check.canonical.toLowerCase() : nativePublicKeyHex(check.canonical),
  };
}

/**
 * EVM: EIP-191 personal_sign recovered with viem.
 * Native: sr25519/ed25519/ecdsa via @polkadot/util-crypto. Browser extensions
 * wrap the message in <Bytes>…</Bytes> before signing, so both forms are tried.
 */
export async function verifyWalletSignature(
  wallet: CanonicalWallet,
  message: string,
  signature: string,
): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) return false;
  if (wallet.environment === 'evm') {
    try {
      return await verifyMessage({ address: wallet.address as Hex, message, signature: signature as Hex });
    } catch {
      return false;
    }
  }
  await cryptoWaitReady();
  const raw = stringToU8a(message);
  for (const payload of [u8aWrapBytes(raw), raw]) {
    try {
      const result = signatureVerify(payload, signature, wallet.address);
      if (result.isValid && u8aToHex(result.publicKey) === wallet.addressKey) return true;
    } catch {
      return false;
    }
  }
  return false;
}
