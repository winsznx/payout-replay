// Proves the contracts on Portaldot V3 are exactly this repository's source.
// Recompile with the pinned settings (cd contracts && forge build), then:
//   pnpm --filter @payout-replay/live verify-contracts
// For each contract it reads the runtime code with eth_getCode and compares it
// byte for byte with Foundry's deployedBytecode. Metadata hashing is off
// (bytecode_hash = "none", cbor_metadata = false), so a match is exact, not fuzzy.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type Hex, createPublicClient, getAddress, http, keccak256 } from 'viem';

import { EVM_CHAIN_ID, EVM_RPC_URL } from './env.js';

const DEPLOYED: Record<string, Hex> = {
  PayoutExecutor: '0x09a46d341cBB557b84311aAA8A95cB40992464e1',
  TestToken: '0x07f843390b48470347Cb435451cB26DE798A1330',
};

const reader = createPublicClient({ transport: http(EVM_RPC_URL, { timeout: 60_000 }) });
if ((await reader.getChainId()) !== EVM_CHAIN_ID) throw new Error(`RPC is not chain ${EVM_CHAIN_ID}`);

let mismatches = 0;
for (const [name, address] of Object.entries(DEPLOYED)) {
  const artifact = JSON.parse(readFileSync(fileURLToPath(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url)), 'utf8')) as {
    deployedBytecode: { object: Hex };
  };
  const local = artifact.deployedBytecode.object.toLowerCase() as Hex;
  const onChain = ((await reader.getCode({ address })) ?? '0x').toLowerCase() as Hex;
  const match = local === onChain;
  if (!match) mismatches += 1;
  console.log(`${match ? 'MATCH   ' : 'MISMATCH'} ${name} at ${getAddress(address)}`);
  console.log(`         local    ${keccak256(local)} (${(local.length - 2) / 2} bytes)`);
  console.log(`         on-chain ${keccak256(onChain)} (${(onChain.length - 2) / 2} bytes)`);
}
if (mismatches) {
  console.error(`${mismatches} contract(s) differ from this source`);
  process.exit(1);
}
