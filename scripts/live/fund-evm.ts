// Moves tPOT from the native payout key to the EVM key's mapped native account
// so the EVM wallet can pay gas and storage deposits on pallet-revive.
//   AMOUNT_TPOT=20 pnpm fund-evm
import { createPublicClient, formatEther, http } from 'viem';

import { EVM_RPC_URL, loadKeys } from './env.js';
import { connectNative, nativePair, signTransfer, waitForFinalized } from './native.js';

const amount = BigInt(Math.round(Number(process.env.AMOUNT_TPOT ?? '20') * 1e4)) * 10n ** 10n;
const keys = loadKeys();
const api = await connectNative();
try {
  const pair = await nativePair(keys.native.mnemonic);
  const free = (await api.query.system.account(pair.address)).data.free.toBigInt();
  console.log(`native payer ${pair.address} holds ${free} planck`);
  if (free <= amount) throw new Error('native payer cannot cover the transfer; fund it first');
  const signed = await signTransfer(api, pair, keys.evm.mappedNativeAccount, amount);
  console.log(`signed ${signed.txHash}, nonce ${signed.nonce}`);
  const { blockHash } = await signed.send();
  console.log(`included in ${blockHash}`);
  const waited = await waitForFinalized(api, blockHash);
  console.log(`finalized after ${waited}ms`);
} finally {
  await api.disconnect();
}

const evm = createPublicClient({ transport: http(EVM_RPC_URL) });
console.log(`EVM balance of ${keys.evm.address}: ${formatEther(await evm.getBalance({ address: keys.evm.address }))} tPOT`);
