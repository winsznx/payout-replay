// LOCAL INTEGRATION TEST against anvil (chain 31337), not Portaldot. It runs
// the real contracts and the real adapter code paths; Portaldot V3 evidence is
// recorded separately in docs/real-run-results.md.
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { EligibleLine } from '@payout-replay/core';
import { type Hex, createTestClient, createWalletClient, getAddress, http, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EvmAdapter } from '../src/adapter.js';

const PORT = 8600 + Math.floor(Math.random() * 200);
const RPC = `http://127.0.0.1:${PORT}`;
const DEPLOYER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const PAYER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const RECIPIENT = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const DIGEST = `sha256:${'ab'.repeat(32)}`;

function artifact(name: string): { abi: unknown[]; bytecode: Hex } {
  const path = fileURLToPath(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url));
  const json = JSON.parse(readFileSync(path, 'utf8')) as { abi: unknown[]; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

let anvil: ChildProcess;
const client = createTestClient({ chain: foundry, mode: 'anvil', transport: http(RPC) }).extend(publicActions);
const deployer = createWalletClient({ account: DEPLOYER, chain: foundry, transport: http(RPC) });
const payer = createWalletClient({ account: PAYER, chain: foundry, transport: http(RPC) });
let adapter: EvmAdapter;
let executor: Hex;
let token: Hex;

async function deploy(name: string, args: unknown[]): Promise<Hex> {
  const { abi, bytecode } = artifact(name);
  const hash = await deployer.deployContract({ abi, bytecode, args });
  const receipt = await client.waitForTransactionReceipt({ hash });
  return getAddress(receipt.contractAddress!);
}

async function finalize(): Promise<void> {
  await client.mine({ blocks: 70 });
}

function line(lineId: string, obligationId: Hex, amount = '25000000'): EligibleLine {
  return {
    obligationId,
    lineId,
    environment: 'evm',
    assetId: token,
    symbol: 'PRT',
    decimals: 6,
    payer: PAYER.address,
    destination: RECIPIENT,
    amountBaseUnits: amount,
    reference: lineId,
    priorStatus: 'approved_unattempted',
    reason: 'test',
  };
}

async function send(call: { to: Hex; data: Hex }, nonce?: number): Promise<Hex> {
  return payer.sendTransaction({ ...call, gas: 300_000n, ...(nonce === undefined ? {} : { nonce }) });
}

beforeAll(async () => {
  anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) {
    try {
      await client.getChainId();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  executor = await deploy('PayoutExecutor', [DEPLOYER.address]);
  token = await deploy('TestToken', [DEPLOYER.address]);
  const tokenAbi = artifact('TestToken').abi;
  const executorAbi = artifact('PayoutExecutor').abi;
  await client.waitForTransactionReceipt({
    hash: await deployer.writeContract({ address: executor, abi: executorAbi, functionName: 'setTokenAllowlisted', args: [token, true] }),
  });
  await client.waitForTransactionReceipt({
    hash: await deployer.writeContract({ address: token, abi: tokenAbi, functionName: 'mint', args: [PAYER.address, 1_000_000_000n] }),
  });
  adapter = new EvmAdapter({ rpcUrl: RPC, chainId: 31337, executorAddress: executor, providerLabel: 'anvil' });
}, 30_000);

afterAll(() => {
  anvil?.kill();
});

describe('EvmAdapter on anvil', () => {
  it('should verify the chain and the allowlisted test token', async () => {
    const asset = await adapter.validateAsset(token);
    expect([asset.symbol, asset.decimals, asset.capability]).toEqual(['PRT', 6, 'verified']);
  });

  it('should pay, stay confirming until finality, then verify with executor and Transfer events (S2)', async () => {
    // #given an exact-amount approval and execution built by the adapter
    const obligationId = `0x${'01'.repeat(32)}` as Hex;
    const unsigned = await adapter.buildUnsignedTransfer(line('S2', obligationId), { manifestDigest: DIGEST });
    expect(unsigned.preflight.filter((issue) => issue.blocking)).toEqual([]);
    await client.waitForTransactionReceipt({ hash: await send(unsigned.payload.approve!) });
    const hash = await send(unsigned.payload.execute);
    await client.waitForTransactionReceipt({ hash });

    // #when observed before and after finality
    const before = await adapter.observeAttempt({ environment: 'evm', txHash: hash, payer: PAYER.address, obligationId });
    await finalize();
    const after = await adapter.observeAttempt({ environment: 'evm', txHash: hash, payer: PAYER.address, obligationId });

    // #then it moves from included to a finalized, attributed transfer
    expect(before.kind).toBe('included');
    expect(after.kind === 'finalized_success' && after.transfers).toEqual([
      {
        environment: 'evm',
        assetId: token,
        from: PAYER.address,
        to: RECIPIENT,
        amountBaseUnits: '25000000',
        obligationId,
        manifestDigest: DIGEST,
      },
    ]);
  });

  it('should classify a reverted payment as a finalized failure (S3)', async () => {
    const obligationId = `0x${'02'.repeat(32)}` as Hex;
    const unsigned = await adapter.buildUnsignedTransfer(line('S3', obligationId), { manifestDigest: DIGEST });
    const hash = await send(unsigned.payload.execute);
    await client.waitForTransactionReceipt({ hash });
    await finalize();
    const outcome = await adapter.observeAttempt({ environment: 'evm', txHash: hash, payer: PAYER.address, obligationId });
    expect(outcome.kind === 'finalized_failure' && outcome.reason).toBe('evm_reverted');
  });

  it('should correct S3 exactly once, then refuse a duplicate on-chain (S4, S6)', async () => {
    // #given the failed obligation from S3
    const obligationId = `0x${'02'.repeat(32)}` as Hex;
    const unsigned = await adapter.buildUnsignedTransfer(line('S3', obligationId), { manifestDigest: DIGEST });
    await client.waitForTransactionReceipt({ hash: await send(unsigned.payload.approve!) });
    const correction = await send(unsigned.payload.execute);
    await client.waitForTransactionReceipt({ hash: correction });

    // #when the same payment is sent again with fresh allowance
    const again = await adapter.buildUnsignedTransfer(line('S3', obligationId), { manifestDigest: DIGEST });
    await client.waitForTransactionReceipt({ hash: await send(again.payload.approve!) });
    const duplicate = await send(again.payload.execute);
    await client.waitForTransactionReceipt({ hash: duplicate });
    await finalize();

    // #then preflight warned, the duplicate reverted, and one settlement exists
    const duplicateOutcome = await adapter.observeAttempt({ environment: 'evm', txHash: duplicate, payer: PAYER.address, obligationId });
    const settlements = await adapter.scanSettlements({ obligationId, payer: PAYER.address });
    expect({
      preflight: again.preflight.some((issue) => issue.code === 'ALREADY_EXECUTED'),
      duplicate: duplicateOutcome.kind === 'finalized_failure' && duplicateOutcome.reason,
      settlements: settlements.map((outcome) => outcome.kind),
      recipient: await client.readContract({ address: token, abi: artifact('TestToken').abi, functionName: 'balanceOf', args: [RECIPIENT] }),
    }).toEqual({ preflight: true, duplicate: 'evm_reverted', settlements: ['finalized_success'], recipient: 50_000_000n });
  });

  it('should report an unknown hash with an unused nonce as unknown, never failed (S5)', async () => {
    const nonce = await client.getTransactionCount({ address: PAYER.address });
    const outcome = await adapter.observeAttempt({
      environment: 'evm',
      txHash: `0x${'ee'.repeat(32)}`,
      payer: PAYER.address,
      obligationId: `0x${'03'.repeat(32)}`,
      nonce,
    });
    expect(outcome.kind).toBe('unknown');
  });

  it('should conclude failure once the nonce is consumed without executing the obligation', async () => {
    const nonce = await client.getTransactionCount({ address: PAYER.address });
    await client.waitForTransactionReceipt({ hash: await payer.sendTransaction({ to: PAYER.address, value: 0n, nonce }) });
    await finalize();
    const outcome = await adapter.observeAttempt({
      environment: 'evm',
      txHash: `0x${'ef'.repeat(32)}`,
      payer: PAYER.address,
      obligationId: `0x${'04'.repeat(32)}`,
      nonce,
    });
    expect(outcome.kind === 'finalized_failure' && outcome.reason).toBe('evm_nonce_consumed_without_execution');
  });

  it('should report RPC failures as unknown', async () => {
    const offline = new EvmAdapter({ rpcUrl: 'http://127.0.0.1:1', chainId: 31337, executorAddress: executor });
    const outcome = await offline.observeAttempt({ environment: 'evm', txHash: `0x${'aa'.repeat(32)}`, payer: PAYER.address, obligationId: `0x${'05'.repeat(32)}` });
    expect(outcome.kind).toBe('unknown');
  });
});
