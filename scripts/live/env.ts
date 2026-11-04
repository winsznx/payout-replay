import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const NATIVE_WS_URL = process.env.NATIVE_WS_URL ?? 'wss://test-node-v3.portaldot.dev';
export const EVM_RPC_URL = process.env.EVM_RPC_URL ?? 'https://test-evm-rpc-v3.portaldot.dev';
export const EVM_CHAIN_ID = Number(process.env.EVM_CHAIN_ID ?? 420420777);
export const GENESIS = '0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd';

/** Testnet-only keys live in internal/, which is gitignored. They must never hold real value. */
export const KEYS_PATH = fileURLToPath(new URL('../../internal/live-keys.json', import.meta.url));
export const DEPLOYMENT_PATH = fileURLToPath(new URL('../../internal/live-deployment.json', import.meta.url));

export interface LiveKeys {
  createdAt: string;
  note: string;
  native: { mnemonic: string; address: string };
  evm: { privateKey: `0x${string}`; address: `0x${string}`; mappedNativeAccount: string };
  recipients: { native: { mnemonic: string; address: string }[]; evm: `0x${string}`[] };
}

export interface LiveDeployment {
  chainId: number;
  executor: `0x${string}`;
  token: `0x${string}`;
  deployBlock: string;
  executorCodeHash: string;
  deployTxs: Record<string, string>;
  compiler: string;
  deployedAt: string;
}

export function loadKeys(): LiveKeys {
  if (!existsSync(KEYS_PATH)) throw new Error(`no keys at ${KEYS_PATH}; run pnpm keys first`);
  return JSON.parse(readFileSync(KEYS_PATH, 'utf8')) as LiveKeys;
}

export function loadDeployment(): LiveDeployment {
  if (!existsSync(DEPLOYMENT_PATH)) throw new Error(`no deployment at ${DEPLOYMENT_PATH}; deploy the contracts first`);
  return JSON.parse(readFileSync(DEPLOYMENT_PATH, 'utf8')) as LiveDeployment;
}

export function saveJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
