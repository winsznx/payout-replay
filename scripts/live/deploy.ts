// Deploys PayoutExecutor and the labelled TEST TOKEN to Portaldot V3 EVM
// (pallet-revive) from the EVM payout key, allowlists the token, mints demo
// balance, and records addresses, code hash and transaction hashes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type Hex, createPublicClient, createWalletClient, defineChain, getAddress, http, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { DEPLOYMENT_PATH, EVM_CHAIN_ID, EVM_RPC_URL, type LiveDeployment, loadKeys, saveJson } from './env.js';

const chain = defineChain({
  id: EVM_CHAIN_ID,
  name: 'Portaldot V3 Testnet',
  nativeCurrency: { name: 'tPOT', symbol: 'tPOT', decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC_URL] } },
});

function artifact(name: string): { abi: unknown[]; bytecode: Hex; compiler: string } {
  const path = fileURLToPath(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url));
  const json = JSON.parse(readFileSync(path, 'utf8')) as { abi: unknown[]; bytecode: { object: Hex }; metadata?: { compiler?: { version?: string } } };
  return { abi: json.abi, bytecode: json.bytecode.object, compiler: json.metadata?.compiler?.version ?? 'unknown' };
}

const keys = loadKeys();
const account = privateKeyToAccount(keys.evm.privateKey);
const wallet = createWalletClient({ account, chain, transport: http(EVM_RPC_URL) });
const reader = createPublicClient({ chain, transport: http(EVM_RPC_URL, { timeout: 60_000 }) });

if ((await reader.getChainId()) !== EVM_CHAIN_ID) throw new Error('wrong chain');
console.log(`deployer ${account.address} balance ${await reader.getBalance({ address: account.address })} wei`);

const txs: Record<string, string> = {};
async function confirm(label: string, hash: Hex) {
  txs[label] = hash;
  const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  console.log(`${label}: ${hash} in block ${receipt.blockNumber}`);
  return receipt;
}

const executorArtifact = artifact('PayoutExecutor');
const tokenArtifact = artifact('TestToken');
// Each deploy costs ~250 tPOT in revive code deposits, so a rerun after a partial
// failure reuses the executor by its deploy tx: EXECUTOR_DEPLOY_TX=0x… pnpm deploy
const existingExecutorTx = process.env.EXECUTOR_DEPLOY_TX as Hex | undefined;
const executorReceipt = existingExecutorTx
  ? await confirm('deploy PayoutExecutor', existingExecutorTx)
  : await confirm(
      'deploy PayoutExecutor',
      await wallet.deployContract({ abi: executorArtifact.abi, bytecode: executorArtifact.bytecode, args: [account.address] }),
    );
if (existingExecutorTx && getAddress(executorReceipt.from) !== account.address) throw new Error('executor was deployed by another key');
const tokenReceipt = await confirm(
  'deploy TestToken',
  await wallet.deployContract({ abi: tokenArtifact.abi, bytecode: tokenArtifact.bytecode, args: [account.address] }),
);
const executor = getAddress(executorReceipt.contractAddress!);
const token = getAddress(tokenReceipt.contractAddress!);
await confirm(
  'allowlist TestToken',
  await wallet.writeContract({ address: executor, abi: executorArtifact.abi, functionName: 'setTokenAllowlisted', args: [token, true] }),
);
await confirm(
  'mint 10000 PRT to payout wallet',
  await wallet.writeContract({ address: token, abi: tokenArtifact.abi, functionName: 'mint', args: [account.address, 10_000_000_000n] }),
);

const code = await reader.getCode({ address: executor });
const deployment: LiveDeployment = {
  chainId: EVM_CHAIN_ID,
  executor,
  token,
  deployBlock: executorReceipt.blockNumber.toString(),
  executorCodeHash: keccak256(code ?? '0x'),
  deployTxs: txs,
  compiler: `solc ${executorArtifact.compiler}, evm_version cancun, optimizer 10000 runs, cbor_metadata false`,
  deployedAt: new Date().toISOString(),
};
saveJson(DEPLOYMENT_PATH, deployment);
console.log(JSON.stringify(deployment, null, 2));
