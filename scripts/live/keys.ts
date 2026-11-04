// Generates fresh testnet-only keys for the live V3 scenarios and prints the
// one address that needs funding. Refuses to overwrite existing keys.
import '@polkadot/api-augment';

import { existsSync } from 'node:fs';

import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { u8aConcat, u8aToHex } from '@polkadot/util';
import { cryptoWaitReady, encodeAddress, mnemonicGenerate } from '@polkadot/util-crypto';
import { hexToBytes } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { GENESIS, KEYS_PATH, type LiveKeys, NATIVE_WS_URL, saveJson } from './env.js';

/** pallet-revive fallback mapping for an unmapped H160: the 20 bytes followed by twelve 0xEE bytes. */
export function fallbackAccountFor(h160: `0x${string}`): string {
  return encodeAddress(u8aConcat(hexToBytes(h160), new Uint8Array(12).fill(0xee)), 42);
}

if (existsSync(KEYS_PATH)) {
  console.log(`keys already exist at ${KEYS_PATH}; not overwriting`);
  process.exit(0);
}

await cryptoWaitReady();
const keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });
const nativeMnemonic = mnemonicGenerate();
const native = keyring.addFromUri(nativeMnemonic);
const recipients = Array.from({ length: 2 }, () => {
  const mnemonic = mnemonicGenerate();
  return { mnemonic, address: keyring.addFromUri(mnemonic).address };
});
const evmKey = generatePrivateKey();
const evm = privateKeyToAccount(evmKey);
const evmRecipients = Array.from({ length: 3 }, () => privateKeyToAccount(generatePrivateKey()).address);
const mapped = fallbackAccountFor(evm.address);

// Cross-check the offline mapping against the runtime when ReviveApi is available.
const api = await ApiPromise.create({ provider: new WsProvider(NATIVE_WS_URL), noInitWarn: true });
if (api.genesisHash.toHex() !== GENESIS) throw new Error('connected to an unexpected chain');
let runtimeMapped: string | null = null;
try {
  const call = (api.call as unknown as Record<string, Record<string, (address: string) => Promise<{ toU8a(): Uint8Array }>>>).reviveApi;
  if (call?.accountId) runtimeMapped = encodeAddress((await call.accountId(evm.address)).toU8a(), 42);
} catch (error) {
  console.log(`ReviveApi.account_id not callable through this API version: ${(error as Error).message}`);
}
await api.disconnect();
if (runtimeMapped && runtimeMapped !== mapped) {
  throw new Error(`runtime maps ${evm.address} to ${runtimeMapped}, offline mapping gave ${mapped}`);
}

const keys: LiveKeys = {
  createdAt: new Date().toISOString(),
  note: 'Portaldot V3 TESTNET ONLY. Never send real value to these keys.',
  native: { mnemonic: nativeMnemonic, address: native.address },
  evm: { privateKey: evmKey, address: evm.address, mappedNativeAccount: mapped },
  recipients: { native: recipients, evm: evmRecipients },
};
saveJson(KEYS_PATH, keys);

console.log(`saved ${KEYS_PATH}`);
console.log(`native payout wallet (fund this):  ${native.address}`);
console.log(`native public key:                 ${u8aToHex(native.publicKey)}`);
console.log(`EVM payout wallet:                 ${evm.address}`);
console.log(`EVM mapped native account:         ${mapped}${runtimeMapped ? ' (confirmed by ReviveApi)' : ' (offline fallback mapping)'}`);
