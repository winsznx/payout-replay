// FIXTURE DATA: deterministic synthetic identities for unit tests only. None of
// these addresses or hashes are claimed to exist on Portaldot.
import { encodeAddress } from '@polkadot/util-crypto';

import type { AssetDescriptor, NetworkIdentity, PayerWallets } from '../src/types.js';

const key = (byte: number) => new Uint8Array(32).fill(byte);

export const SS58_PREFIX = 42;
export const NATIVE_PAYER = encodeAddress(key(1), SS58_PREFIX);
export const NATIVE_ALICE = encodeAddress(key(2), SS58_PREFIX);
export const NATIVE_BOB = encodeAddress(key(3), SS58_PREFIX);
export const NATIVE_ALICE_OTHER_PREFIX = encodeAddress(key(2), 0);

export const EVM_PAYER = '0x1111111111111111111111111111111111111111';
export const EVM_CAROL = '0x2222222222222222222222222222222222222222';
export const EVM_DAVE = '0x3333333333333333333333333333333333333333';
export const TEST_TOKEN = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

export const NETWORK: NetworkIdentity = {
  native: {
    genesisHash: '0x' + 'ab'.repeat(32),
    specName: 'fixture-runtime',
    specVersion: 1,
    ss58Prefix: SS58_PREFIX,
    tokenSymbol: 'tPOT',
    tokenDecimals: 14,
  },
  evm: { chainId: 31337, executorAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' },
};

export const PAYERS: PayerWallets = { native: NATIVE_PAYER, evm: EVM_PAYER };

export const ASSETS: AssetDescriptor[] = [
  { environment: 'native', assetId: 'tPOT', symbol: 'tPOT', decimals: 14, allowlisted: true, capability: 'verified' },
  { environment: 'evm', assetId: TEST_TOKEN, symbol: 'PRT', decimals: 6, allowlisted: true, capability: 'verified' },
];

export const CONTEXT = { assets: ASSETS, payers: PAYERS, ss58Prefix: SS58_PREFIX };

export const VALID_CSV = [
  'line_id,environment,asset_id,destination,amount,reference,recipient_name',
  `TASK-101,native,tPOT,${NATIVE_ALICE},50,TASK-101,Contributor A`,
  `TASK-102,evm,${TEST_TOKEN},${EVM_CAROL},100.25,TASK-102,"Contributor, B"`,
  `TASK-103,evm,${TEST_TOKEN},${EVM_DAVE},7,TASK-103,Contributor D`,
].join('\n');
