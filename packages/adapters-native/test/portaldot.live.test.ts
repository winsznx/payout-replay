// LIVE READ-ONLY TEST against Portaldot V3 testnet. It signs nothing; it
// re-verifies third-party extrinsics that are already finalized on V3.
// Run with PORTALDOT_LIVE=1.
import { reconcileObligation } from '@payout-replay/core';
import { afterAll, describe, expect, it } from 'vitest';

import { NativeAdapter } from '../src/adapter.js';

const LIVE = process.env.PORTALDOT_LIVE === '1';
const GENESIS = '0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd';

// Finalized V3 block #320172, extrinsic 1: an unsigned revive.ethTransact whose
// Balances.Transfer moves 1.5 tPOT between two EVM-mapped accounts (h160 ++ 0xEE*12).
const EVM_ORIGINATED = {
  blockHash: '0x6e7abcbe4e33772a1630536e2ab8e75e86393632f35cb6aa92c359ee61b21837',
  from: '5F9vE6fT3fpCnQc7XqUC1vDA1EfSQvZSdtoR8TEwtVS18BgG',
};
// Self-transfer in canary block #106425 (Plumbline): succeeds but emits no Balances.Transfer.
const SELF_TRANSFER = {
  blockHash: '0xf71728583059750fbdb8095730835eae53955148675b11cae98c90d3374b4c1d',
  txHash: '0xa7effe5d5ab7d7c512690d285065fd83919f8b83dc04de1630e1e4ddff91d90b',
  signer: '5EhP3KWtUkaRuFUoejCfmYHfi54d2fomNFoyVjNFFsRUzDsb',
};

const adapter = new NativeAdapter({ wsUrl: 'wss://test-node-v3.portaldot.dev', expectedGenesisHash: GENESIS });

afterAll(async () => {
  await adapter.disconnect();
});

describe.runIf(LIVE)('NativeAdapter on Portaldot V3 (read-only)', () => {
  it('should bind to the V3 genesis and report tPOT with 14 decimals', async () => {
    const identity = await adapter.getNetworkIdentity();
    expect([identity.genesisHash, identity.specName, identity.ss58Prefix, identity.tokenSymbol, identity.tokenDecimals]).toEqual([
      GENESIS,
      'portaldot-v3',
      42,
      'tPOT',
      14,
    ]);
  });

  it('should mark tPOT verified because transfer_keep_alive exists in live metadata', async () => {
    const asset = await adapter.validateAsset('tPOT');
    expect(asset.capability).toBe('verified');
  });

  it('should refuse an unsigned EVM-originated transfer even though it moved funds from the payer account', async () => {
    // #given a revive.ethTransact extrinsic whose Balances.Transfer debits the mapped account
    const api = await adapter.api();
    const block = await api.rpc.chain.getBlock(EVM_ORIGINATED.blockHash);
    const txHash = block.block.extrinsics[1]!.hash.toHex();
    // #when observed as a native attempt from that account
    const outcome = await adapter.observeAttempt({
      environment: 'native',
      txHash,
      payer: EVM_ORIGINATED.from,
      obligationId: `0x${'00'.repeat(32)}`,
      blockHash: EVM_ORIGINATED.blockHash,
    });
    // #then it is not accepted as a native payment by that wallet
    expect(outcome.kind).toBe('unknown');
  });

  it('should refuse to attribute an extrinsic to a wallet that did not sign it', async () => {
    const outcome = await adapter.observeAttempt({
      environment: 'native',
      txHash: SELF_TRANSFER.txHash,
      payer: EVM_ORIGINATED.from,
      obligationId: `0x${'00'.repeat(32)}`,
      blockHash: SELF_TRANSFER.blockHash,
    });
    expect(outcome.kind).toBe('unknown');
  });

  it('should not let a successful self-transfer settle an obligation', async () => {
    // #given a successful extrinsic with no Balances.Transfer event
    const outcome = await adapter.observeAttempt({
      environment: 'native',
      txHash: SELF_TRANSFER.txHash,
      payer: SELF_TRANSFER.signer,
      obligationId: `0x${'01'.repeat(32)}`,
      blockHash: SELF_TRANSFER.blockHash,
    });
    // #when reconciled against an obligation it might appear to pay
    const state = reconcileObligation(
      {
        obligationId: `0x${'01'.repeat(32)}`,
        lineId: 'L1',
        environment: 'native',
        assetId: 'tPOT',
        symbol: 'tPOT',
        decimals: 14,
        payer: SELF_TRANSFER.signer,
        destination: SELF_TRANSFER.signer,
        amountBaseUnits: '1000000000000',
        reference: 'L1',
      },
      [{ attemptId: 'a1', obligationId: `0x${'01'.repeat(32)}`, attemptNumber: 1, source: 'imported', phase: 'submitted', outcome }],
      'sha256:00',
    );
    // #then it is flagged rather than counted as paid
    expect([outcome.kind, state.status]).toEqual(['finalized_success', 'incorrect']);
  });

  it('should report a hash that is absent from the reported block as unknown', async () => {
    const outcome = await adapter.observeAttempt({
      environment: 'native',
      txHash: `0x${'ab'.repeat(32)}`,
      payer: EVM_ORIGINATED.from,
      obligationId: `0x${'00'.repeat(32)}`,
      blockHash: EVM_ORIGINATED.blockHash,
    });
    expect(outcome.kind).toBe('unknown');
  });
});
