import { describe, expect, it } from 'vitest';

import { exportExceptionsCsv, exportReconciliationCsv } from '../src/export.js';
import { freezeManifest, validateManifestCsv } from '../src/manifest.js';
import type { AttemptOutcome, AttemptRecord, ChainEvidence } from '../src/reconcile.js';
import { reconcileRun } from '../src/reconcile.js';
import { createExecutionPlan, createRecoveryPlan, revalidateRecoveryPlan } from '../src/recovery.js';
import { ASSETS, CONTEXT, EVM_CAROL, EVM_DAVE, EVM_PAYER, NATIVE_ALICE, NATIVE_ALICE_OTHER_PREFIX, NATIVE_BOB, NATIVE_PAYER, NETWORK, PAYERS, TEST_TOKEN, VALID_CSV } from './fixtures.js';

const frozen = freezeManifest({
  runId: 'run_1',
  version: 1,
  network: NETWORK,
  payers: PAYERS,
  assets: ASSETS,
  lines: validateManifestCsv(VALID_CSV, CONTEXT).lines,
});
const [nativeLine, evmLine, evmLine2] = ['TASK-101', 'TASK-102', 'TASK-103'].map(
  (lineId) => frozen.manifest.obligations.find((obligation) => obligation.lineId === lineId)!,
) as [typeof frozen.manifest.obligations[number], typeof frozen.manifest.obligations[number], typeof frozen.manifest.obligations[number]];

const evidence = (txHash: string, finalized = true): ChainEvidence => ({
  provider: 'fixture',
  txHash,
  blockHash: '0xblock',
  blockNumber: '10',
  finalized,
  observedAt: '2026-11-04T00:00:00Z',
});

let counter = 0;
function attempt(obligationId: string, outcome: AttemptOutcome, extra: Partial<AttemptRecord> = {}): AttemptRecord {
  counter += 1;
  return { attemptId: `att_${counter}`, obligationId, attemptNumber: counter, source: 'app', phase: 'submitted', outcome, ...extra };
}

const paidNative = (overrides: Partial<{ to: string; amount: string; from: string }> = {}): AttemptOutcome => ({
  kind: 'finalized_success',
  evidence: { ...evidence('0xnative'), extrinsicIndex: 2 },
  transfers: [
    {
      environment: 'native',
      assetId: 'tPOT',
      from: overrides.from ?? NATIVE_PAYER,
      to: overrides.to ?? NATIVE_ALICE,
      amountBaseUnits: overrides.amount ?? nativeLine.amountBaseUnits,
    },
  ],
});

const paidEvm = (obligationId: string, to: string, amount: string, digest = frozen.digest.slice(7)): AttemptOutcome => ({
  kind: 'finalized_success',
  evidence: { ...evidence(`0xevm${obligationId.slice(2, 8)}`), logIndex: 1 },
  transfers: [
    { environment: 'evm', assetId: TEST_TOKEN, from: EVM_PAYER, to, amountBaseUnits: amount, obligationId, manifestDigest: `sha256:${digest}` },
  ],
});

const reverted: AttemptOutcome = { kind: 'finalized_failure', evidence: evidence('0xrev'), reason: 'evm_reverted', detail: 'insufficient allowance' };

function run(attempts: AttemptRecord[]) {
  return reconcileRun({ manifestDigest: frozen.digest, obligations: frozen.manifest.obligations, totals: frozen.manifest.totals, attempts });
}
const statusOf = (result: ReturnType<typeof run>, obligationId: string) =>
  result.obligations.find((state) => state.obligationId === obligationId)!.status;

describe('reconcileObligation', () => {
  it('should mark an exact finalized native transfer paid_verified', () => {
    expect(statusOf(run([attempt(nativeLine.obligationId, paidNative())]), nativeLine.obligationId)).toBe('paid_verified');
  });

  it('should treat an SS58 prefix difference as the same recipient', () => {
    const result = run([attempt(nativeLine.obligationId, paidNative({ to: NATIVE_ALICE_OTHER_PREFIX }))]);
    expect(statusOf(result, nativeLine.obligationId)).toBe('paid_verified');
  });

  it.each([
    ['wrong recipient', { to: NATIVE_BOB }, 'wrong_recipient'],
    ['wrong amount', { amount: '1' }, 'amount_mismatch'],
    ['wrong payer', { from: NATIVE_BOB }, 'wrong_payer'],
  ])('should mark %s incorrect and preserve the exception', (_label, overrides, type) => {
    const result = run([attempt(nativeLine.obligationId, paidNative(overrides))]);
    expect([statusOf(result, nativeLine.obligationId), result.exceptions.map((exception) => exception.type)]).toEqual(['incorrect', [type]]);
  });

  it('should never treat an unknown outcome as failure', () => {
    const result = run([attempt(evmLine.obligationId, { kind: 'unknown', detail: 'RPC timed out after broadcast' }, { phase: 'submission_unknown' })]);
    expect(statusOf(result, evmLine.obligationId)).toBe('needs_review');
  });

  it('should keep an included but unfinalized transfer confirming', () => {
    const result = run([attempt(evmLine.obligationId, { kind: 'included', evidence: evidence('0xinc', false) })]);
    expect(statusOf(result, evmLine.obligationId)).toBe('confirming');
  });

  it('should report failed_verified only when every attempt failed conclusively', () => {
    const allFailed = run([attempt(evmLine.obligationId, reverted), attempt(evmLine.obligationId, reverted)]);
    const oneUnknown = run([attempt(evmLine.obligationId, reverted), attempt(evmLine.obligationId, { kind: 'unknown', detail: 'x' })]);
    expect([statusOf(allFailed, evmLine.obligationId), statusOf(oneUnknown, evmLine.obligationId)]).toEqual(['failed_verified', 'needs_review']);
  });

  it('should hold a prepared attempt as awaiting_signature so it cannot be offered again', () => {
    const result = run([attempt(evmLine.obligationId, { kind: 'pending', detail: 'wallet prompt open' }, { phase: 'prepared' })]);
    expect(statusOf(result, evmLine.obligationId)).toBe('awaiting_signature');
  });

  it('should keep a rejected signature as unattempted', () => {
    const result = run([attempt(evmLine.obligationId, { kind: 'not_broadcast' }, { phase: 'signature_rejected' })]);
    expect(statusOf(result, evmLine.obligationId)).toBe('approved_unattempted');
  });

  it('should not let an executor event for another obligation settle this one', () => {
    const result = run([attempt(evmLine.obligationId, paidEvm(evmLine2.obligationId, EVM_CAROL, evmLine.amountBaseUnits))]);
    expect([statusOf(result, evmLine.obligationId), result.exceptions[0]?.type]).toEqual(['incorrect', 'unattributed_transfer']);
  });

  it('should flag an executor digest that does not match the frozen manifest', () => {
    const result = run([attempt(evmLine.obligationId, paidEvm(evmLine.obligationId, EVM_CAROL, evmLine.amountBaseUnits, 'ff'.repeat(32)))]);
    expect(result.exceptions.map((exception) => exception.type)).toEqual(['digest_mismatch']);
  });

  it('should count one transaction once when an app attempt and a chain scan both report it', () => {
    // #given the same finalized tx reported twice
    const paid = paidEvm(evmLine.obligationId, EVM_CAROL, evmLine.amountBaseUnits);
    // #when reconciled
    const result = run([attempt(evmLine.obligationId, paid), attempt(evmLine.obligationId, paid, { source: 'chain_scan' })]);
    // #then it is a single settlement
    expect([statusOf(result, evmLine.obligationId), result.exceptions.length]).toEqual(['paid_verified', 0]);
  });

  it('should settle through a replacement transaction found by chain scan', () => {
    const replaced: AttemptOutcome = { kind: 'finalized_failure', reason: 'evm_replaced', detail: 'nonce reused by another tx' };
    const scanned = paidEvm(evmLine.obligationId, EVM_CAROL, evmLine.amountBaseUnits);
    const result = run([attempt(evmLine.obligationId, replaced), attempt(evmLine.obligationId, scanned, { source: 'chain_scan' })]);
    expect(statusOf(result, evmLine.obligationId)).toBe('paid_verified');
  });

  it('should send a double payment to review with a duplicate_settlement exception', () => {
    const paid = paidEvm(evmLine.obligationId, EVM_CAROL, evmLine.amountBaseUnits);
    const second: AttemptOutcome = paid.kind === 'finalized_success' ? { ...paid, evidence: { ...paid.evidence, txHash: '0xsecond' } } : paid;
    const result = run([attempt(evmLine.obligationId, paid), attempt(evmLine.obligationId, second)]);
    expect([statusOf(result, evmLine.obligationId), result.exceptions.map((exception) => exception.type)]).toEqual(['needs_review', ['duplicate_settlement']]);
  });

  it('should keep a manual resolution distinct from paid_verified and outstanding in totals', () => {
    const result = reconcileRun({
      manifestDigest: frozen.digest,
      obligations: frozen.manifest.obligations,
      totals: frozen.manifest.totals,
      attempts: [],
      manualResolutions: [{ obligationId: evmLine.obligationId, reason: 'paid by bank wire', resolvedBy: 'owner', resolvedAt: '2026-11-04T00:00:00Z' }],
    });
    const prt = result.partition.find((part) => part.symbol === 'PRT')!;
    expect([statusOf(result, evmLine.obligationId), prt.verifiedBaseUnits]).toEqual(['manually_resolved', '0']);
  });
});

describe('reconcileRun', () => {
  it('should hold INV-10: verified + outstanding = total per asset', () => {
    const result = run([
      attempt(nativeLine.obligationId, paidNative()),
      attempt(evmLine.obligationId, paidEvm(evmLine.obligationId, EVM_CAROL, evmLine.amountBaseUnits)),
      attempt(evmLine2.obligationId, reverted),
    ]);
    for (const part of result.partition) {
      expect(BigInt(part.verifiedBaseUnits) + BigInt(part.outstandingBaseUnits)).toBe(BigInt(part.totalBaseUnits));
    }
  });

  it('should be idempotent', () => {
    const attempts = [attempt(nativeLine.obligationId, paidNative()), attempt(evmLine2.obligationId, reverted)];
    expect(run(attempts)).toEqual(run(attempts));
  });

  it.each([
    ['complete when all lines are verified', () => [
      attempt(nativeLine.obligationId, paidNative()),
      attempt(evmLine.obligationId, paidEvm(evmLine.obligationId, EVM_CAROL, evmLine.amountBaseUnits)),
      attempt(evmLine2.obligationId, paidEvm(evmLine2.obligationId, EVM_DAVE, evmLine2.amountBaseUnits)),
    ], 'complete'],
    ['incomplete with a conclusive failure', () => [attempt(nativeLine.obligationId, paidNative()), attempt(evmLine2.obligationId, reverted)], 'incomplete'],
    ['needs_review with an unknown attempt', () => [attempt(evmLine2.obligationId, { kind: 'unknown', detail: 'x' })], 'needs_review'],
    ['reconciling with a pending attempt', () => [attempt(evmLine2.obligationId, { kind: 'pending', detail: 'in mempool' })], 'reconciling'],
    ['executing with nothing attempted', () => [], 'executing'],
  ] as const)('should be %s', (_label, attempts, status) => {
    expect(run([...attempts()]).status).toBe(status);
  });
});

describe('recovery planning', () => {
  const snapshot = { evm: { finalizedBlockNumber: '10', finalizedBlockHash: '0xblock' } };
  const now = new Date('2026-11-04T00:00:00Z');

  const scenario = () =>
    run([
      attempt(nativeLine.obligationId, paidNative()),
      attempt(evmLine.obligationId, reverted),
      attempt(evmLine2.obligationId, { kind: 'unknown', detail: 'timeout' }, { phase: 'submission_unknown' }),
    ]);

  it('should offer only conclusively failed or unattempted lines', () => {
    // #given one paid, one reverted, one unknown
    // #when a plan is built
    const plan = createRecoveryPlan({ frozen, reconciliation: scenario(), chainSnapshot: snapshot, now });
    // #then only the reverted line is eligible
    expect({ eligible: plan.eligible.map((line) => line.lineId), blocked: plan.blocked.map((line) => [line.lineId, line.status]) }).toEqual({
      eligible: ['TASK-102'],
      blocked: [
        ['TASK-101', 'paid_verified'],
        ['TASK-103', 'needs_review'],
      ],
    });
  });

  it('should keep the original obligation ID on the correction', () => {
    const plan = createRecoveryPlan({ frozen, reconciliation: scenario(), chainSnapshot: snapshot, now });
    expect(plan.eligible[0]?.obligationId).toBe(evmLine.obligationId);
  });

  it('should revalidate a fresh, unchanged plan', () => {
    const plan = createRecoveryPlan({ frozen, reconciliation: scenario(), chainSnapshot: snapshot, now });
    expect(revalidateRecoveryPlan(plan, scenario(), new Date(now.getTime() + 1000)).ok).toBe(true);
  });

  it('should invalidate a plan once a line it offered became paid elsewhere', () => {
    const plan = createRecoveryPlan({ frozen, reconciliation: scenario(), chainSnapshot: snapshot, now });
    const fresh = run([
      attempt(nativeLine.obligationId, paidNative()),
      attempt(evmLine.obligationId, reverted),
      attempt(evmLine.obligationId, { kind: 'pending', detail: 'someone else signed' }),
    ]);
    const result = revalidateRecoveryPlan(plan, fresh, now);
    expect(result.ok ? null : [result.code, result.changed]).toEqual(['PLAN_STALE', [evmLine.obligationId]]);
  });

  type Plan = ReturnType<typeof createRecoveryPlan>;
  it.each<[string, (plan: Plan) => [Plan, Date], string]>([
    ['expired', (plan) => [plan, new Date(now.getTime() + 10 * 60_000)], 'PLAN_EXPIRED'],
    ['tampered', (plan) => [{ ...plan, eligible: [...plan.eligible, ...plan.eligible] }, now], 'PLAN_TAMPERED'],
  ])('should reject a %s plan', (_label, mutate, code) => {
    const [plan, at] = mutate(createRecoveryPlan({ frozen, reconciliation: scenario(), chainSnapshot: snapshot, now }));
    const result = revalidateRecoveryPlan(plan, scenario(), at);
    expect(result.ok ? null : result.code).toBe(code);
  });

  it('should split execution into independent native and EVM groups', () => {
    const plan = createRecoveryPlan({ frozen, reconciliation: run([]), chainSnapshot: snapshot, now });
    expect(createExecutionPlan(plan).map((group) => [group.environment, group.lines.length])).toEqual([
      ['native', 1],
      ['evm', 2],
    ]);
  });
});

describe('export', () => {
  const result = run([
    attempt(nativeLine.obligationId, paidNative()),
    attempt(evmLine.obligationId, paidEvm(evmLine.obligationId, EVM_CAROL, '1')),
  ]);
  const csv = exportReconciliationCsv({ frozen, reconciliation: result, verificationAt: '2026-11-04T00:00:00Z' });
  const rows = csv.trim().split('\r\n');

  it('should emit one row per original obligation plus a header', () => {
    expect(rows.length).toBe(frozen.manifest.obligations.length + 1);
  });

  it('should keep base units as exact strings', () => {
    expect(rows[1]).toContain(',5000000000000000,');
  });

  it('should keep the original recipient name quoted correctly', () => {
    expect(rows[2]).toContain('"Contributor, B"');
  });

  it('should list mismatches in the exceptions file', () => {
    expect(exportExceptionsCsv({ frozen, reconciliation: result })).toContain('amount_mismatch');
  });
});
