import '@polkadot/api-augment';
import type { ApiPromise } from '@polkadot/api';

import type { NativeTransferPayload } from './types';

const NATIVE_WS_URL = process.env.NEXT_PUBLIC_NATIVE_WS_URL ?? 'wss://test-node-v3.portaldot.dev';
const APP_NAME = 'Payout Replay';

let apiPromise: Promise<ApiPromise> | null = null;

async function nativeApi(): Promise<ApiPromise> {
  apiPromise ??= (async () => {
    const { ApiPromise, WsProvider } = await import('@polkadot/api');
    return ApiPromise.create({ provider: new WsProvider(NATIVE_WS_URL), noInitWarn: true });
  })().catch((error: unknown) => {
    apiPromise = null;
    throw error;
  });
  return apiPromise;
}

export interface NativeAccount {
  address: string;
  name: string | undefined;
  source: string;
}

export async function connectNative(): Promise<NativeAccount[]> {
  const { web3Accounts, web3Enable } = await import('@polkadot/extension-dapp');
  const extensions = await web3Enable(APP_NAME);
  if (extensions.length === 0) {
    throw new Error('No Polkadot-compatible extension found. Install Polkadot.js, Talisman or SubWallet and allow this site.');
  }
  const accounts = await web3Accounts({ ss58Format: 42 });
  return accounts.map((account) => ({ address: account.address, name: account.meta.name, source: account.meta.source }));
}

export async function signNativeMessage(address: string, message: string): Promise<string> {
  const { web3FromAddress } = await import('@polkadot/extension-dapp');
  const { stringToHex } = await import('@polkadot/util');
  const injector = await web3FromAddress(address);
  if (!injector.signer.signRaw) throw new Error('This extension cannot sign messages.');
  const { signature } = await injector.signer.signRaw({ address, data: stringToHex(message), type: 'bytes' });
  return signature;
}

export type NativeSendResult =
  | { kind: 'rejected' }
  | {
      kind: 'sent' | 'unknown';
      txHash: string;
      nonce: number;
      mortality: { birthBlock: number; period: number };
      error?: string;
    };

/**
 * Builds the call locally, refuses to continue unless it is byte-identical
 * to the call the server prepared on the same chain, signs with a mortal era
 * so "never included" becomes provable, then broadcasts.
 */
export async function sendNativeTransfer(address: string, payload: NativeTransferPayload): Promise<NativeSendResult> {
  const api = await nativeApi();
  if (api.genesisHash.toHex() !== payload.genesisHash) throw new Error('The extension network does not match the frozen manifest.');
  if (api.runtimeVersion.specVersion.toNumber() !== payload.specVersion) {
    throw new Error('The runtime was upgraded since this plan was prepared. Revalidate before signing.');
  }
  const tx = api.tx.balances.transferKeepAlive(payload.dest, BigInt(payload.value));
  if (tx.method.toHex() !== payload.callHex) throw new Error('Prepared call and local call differ. Refusing to sign.');

  const { web3FromAddress } = await import('@polkadot/extension-dapp');
  const injector = await web3FromAddress(address);
  const header = await api.rpc.chain.getHeader();
  const current = header.number.toNumber();
  const era = api.registry.createType('ExtrinsicEra', { current, period: payload.eraPeriod });
  const nonce = (await api.rpc.system.accountNextIndex(address)).toNumber();
  const birthBlock = era.asMortalEra.birth(current);
  const mortality = { birthBlock, period: era.asMortalEra.period.toNumber() };

  try {
    await tx.signAsync(address, { signer: injector.signer, era, blockHash: header.hash, nonce });
  } catch {
    return { kind: 'rejected' };
  }
  const txHash = tx.hash.toHex();
  try {
    await new Promise<void>((resolve, reject) => {
      tx.send((result) => {
        if (result.status.isReady || result.status.isBroadcast || result.status.isInBlock) resolve();
        if (result.status.isInvalid || result.status.isDropped || result.status.isUsurped) {
          reject(new Error(`transaction pool reported ${result.status.type}`));
        }
      }).catch(reject);
    });
    return { kind: 'sent', txHash, nonce, mortality };
  } catch (error) {
    return { kind: 'unknown', txHash, nonce, mortality, error: (error as Error).message };
  }
}
