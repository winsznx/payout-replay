import '@polkadot/api-augment';

import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { cryptoWaitReady } from '@polkadot/util-crypto';

import { GENESIS, NATIVE_WS_URL } from './env.js';

export async function connectNative(): Promise<ApiPromise> {
  const api = await ApiPromise.create({ provider: new WsProvider(NATIVE_WS_URL), noInitWarn: true });
  if (api.genesisHash.toHex() !== GENESIS) throw new Error(`unexpected genesis ${api.genesisHash.toHex()}`);
  return api;
}

export async function nativePair(mnemonic: string): Promise<KeyringPair> {
  await cryptoWaitReady();
  return new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromUri(mnemonic);
}

export interface SignedNative {
  txHash: string;
  nonce: number;
  mortality: { birthBlock: number; period: number };
  send(): Promise<{ blockHash: string }>;
}

/**
 * Signs Balances.transfer_keep_alive with a mortal era exactly as the web app
 * does, and returns the identity before broadcast so the attempt can be
 * recorded even if broadcasting fails.
 */
export async function signTransfer(api: ApiPromise, pair: KeyringPair, dest: string, value: bigint, period = 64): Promise<SignedNative> {
  const tx = api.tx.balances.transferKeepAlive(dest, value);
  // Anchor the era on the finalized head: a best-block checkpoint can be
  // reorged away under BABE, which invalidates the signature in the pool.
  const header = await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead());
  const current = header.number.toNumber();
  const era = api.registry.createType('ExtrinsicEra', { current, period });
  const nonce = (await api.rpc.system.accountNextIndex(pair.address)).toNumber();
  await tx.signAsync(pair, { era, blockHash: header.hash, nonce });
  return {
    txHash: tx.hash.toHex(),
    nonce,
    mortality: { birthBlock: era.asMortalEra.birth(current), period: era.asMortalEra.period.toNumber() },
    send: () =>
      new Promise((resolve, reject) => {
        tx.send((result) => {
          if (result.dispatchError) {
            reject(new Error(`dispatch error: ${result.dispatchError.toString()}`));
            return;
          }
          if (result.status.isInBlock) resolve({ blockHash: result.status.asInBlock.toHex() });
          if (result.status.isInvalid || result.status.isDropped || result.status.isUsurped) reject(new Error(`pool status ${result.status.type}`));
        }).catch(reject);
      }),
  };
}

/**
 * Waits until the sender's nonce is consumed at the finalized head. The block
 * that first reported inclusion can be reorged away while the same extrinsic
 * lands in a sibling, so the block hash is not a reliable handle.
 */
export async function waitForFinalizedNonce(api: ApiPromise, sender: string, nonce: number, timeoutMs = 180_000): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const finalized = await api.at(await api.rpc.chain.getFinalizedHead());
    if ((await finalized.query.system.account(sender)).nonce.toNumber() > nonce) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`nonce ${nonce} of ${sender} not consumed at the finalized head within ${timeoutMs}ms`);
}
