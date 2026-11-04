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
  const header = await api.rpc.chain.getHeader();
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

export async function waitForFinalized(api: ApiPromise, blockHash: string, timeoutMs = 180_000): Promise<number> {
  const target = (await api.rpc.chain.getHeader(blockHash)).number.toNumber();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const finalized = (await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead())).number.toNumber();
    if (finalized >= target) {
      const canonical = await api.rpc.chain.getBlockHash(target);
      if (canonical.toHex() !== blockHash) throw new Error(`block ${blockHash} was replaced at #${target}`);
      return Date.now() - started;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`block ${blockHash} not finalized within ${timeoutMs}ms`);
}
