import { sameAddress } from './address.js';
import type { AssetTotal, Environment, Obligation } from './types.js';

export type AttemptSource = 'app' | 'imported';

/** Where an attempt sits from the operator's point of view, before chain evidence is applied. */
export type AttemptPhase = 'prepared' | 'signature_rejected' | 'submitted' | 'submission_unknown';

export interface ChainEvidence {
  provider: string;
  txHash: string;
  blockHash?: string;
  blockNumber?: string;
  extrinsicIndex?: number;
  logIndex?: number;
  finalized: boolean;
  observedAt: string;
}

export interface ObservedTransfer {
  environment: Environment;
  assetId: string;
  from: string;
  to: string;
  amountBaseUnits: string;
  /** Present when the transfer carries an on-chain obligation reference (EVM executor event). */
  obligationId?: string;
  manifestDigest?: string;
}

export type FailureReason =
  | 'evm_reverted'
  | 'native_extrinsic_failed'
  | 'native_mortality_expired'
  | 'evm_nonce_consumed_without_execution';

/**
 * The adapter's verdict for one attempt. Adapters must return `unknown`
 * whenever they cannot prove an outcome; core never upgrades it.
 */
export type AttemptOutcome =
  | { kind: 'not_broadcast' }
  | { kind: 'pending'; detail: string }
  | { kind: 'included'; evidence: ChainEvidence }
  | { kind: 'finalized_success'; evidence: ChainEvidence; transfers: ObservedTransfer[] }
  | { kind: 'finalized_failure'; evidence?: ChainEvidence; reason: FailureReason; detail: string }
  | { kind: 'unknown'; detail: string };

export interface AttemptRecord {
  attemptId: string;
  obligationId: string;
  attemptNumber: number;
  source: AttemptSource;
  phase: AttemptPhase;
  outcome: AttemptOutcome;
}

export interface ManualResolution {
  obligationId: string;
  reason: string;
  resolvedBy: string;
  resolvedAt: string;
}

export type ObligationStatus =
  | 'approved_unattempted'
  | 'submitted'
  | 'confirming'
  | 'paid_verified'
  | 'failed_verified'
  | 'incorrect'
  | 'needs_review'
  | 'manually_resolved';

export type ExceptionType =
  | 'amount_mismatch'
  | 'wrong_recipient'
  | 'wrong_asset'
  | 'wrong_payer'
  | 'digest_mismatch'
  | 'duplicate_settlement'
  | 'concurrent_attempt'
  | 'unattributed_transfer'
  | 'outcome_unknown';

export interface ReconciliationException {
  type: ExceptionType;
  severity: 'critical' | 'warning';
  obligationId: string;
  attemptId?: string;
  message: string;
  transfer?: ObservedTransfer;
}

export interface ObligationState {
  obligationId: string;
  lineId: string;
  status: ObligationStatus;
  /** One sentence derived from evidence, safe to show the operator verbatim. */
  explanation: string;
  settledBy?: { attemptId: string; evidence: ChainEvidence };
  latestAttemptId?: string;
  allAttemptsFinalAndFailed: boolean;
  exceptions: ReconciliationException[];
}

export type RunStatus = 'executing' | 'reconciling' | 'complete' | 'incomplete' | 'needs_review';

export interface ReconciliationResult {
  manifestDigest: string;
  status: RunStatus;
  obligations: ObligationState[];
  exceptions: ReconciliationException[];
  partition: AssetPartition[];
  counts: Record<ObligationStatus, number>;
}

export interface AssetPartition {
  environment: Environment;
  assetId: string;
  symbol: string;
  decimals: number;
  totalBaseUnits: string;
  verifiedBaseUnits: string;
  outstandingBaseUnits: string;
}

function transferMismatches(
  obligation: Obligation,
  transfer: ObservedTransfer,
  manifestDigest: string,
): { type: ExceptionType; message: string }[] {
  const problems: { type: ExceptionType; message: string }[] = [];
  if (transfer.environment !== obligation.environment || transfer.assetId.toLowerCase() !== obligation.assetId.toLowerCase()) {
    problems.push({ type: 'wrong_asset', message: `paid ${transfer.assetId}, expected ${obligation.assetId}` });
  }
  if (!sameAddress(obligation.environment, transfer.from, obligation.payer)) {
    problems.push({ type: 'wrong_payer', message: `paid from ${transfer.from}, expected ${obligation.payer}` });
  }
  if (!sameAddress(obligation.environment, transfer.to, obligation.destination)) {
    problems.push({ type: 'wrong_recipient', message: `paid to ${transfer.to}, expected ${obligation.destination}` });
  }
  if (transfer.amountBaseUnits !== obligation.amountBaseUnits) {
    problems.push({
      type: 'amount_mismatch',
      message: `paid ${transfer.amountBaseUnits} base units, expected ${obligation.amountBaseUnits}`,
    });
  }
  if (transfer.manifestDigest !== undefined && transfer.manifestDigest.toLowerCase() !== manifestDigest.toLowerCase()) {
    problems.push({ type: 'digest_mismatch', message: `executor recorded digest ${transfer.manifestDigest}` });
  }
  return problems;
}

/** Picks the transfer an attempt made for this obligation, preferring an on-chain obligation ID match. */
function attributableTransfer(obligation: Obligation, transfers: readonly ObservedTransfer[]): ObservedTransfer | undefined {
  const tagged = transfers.filter((transfer) => transfer.obligationId !== undefined);
  if (tagged.length > 0) {
    return tagged.find((transfer) => transfer.obligationId!.toLowerCase() === obligation.obligationId.toLowerCase());
  }
  return transfers.find((transfer) => transfer.environment === obligation.environment) ?? transfers[0];
}

/**
 * Applies the PRD matching rules to one obligation. The ordering matters:
 * finalized proof of payment wins, then anything still in flight or unknown
 * blocks, and only a complete set of conclusive failures yields
 * `failed_verified`. Absence of evidence is never treated as non-payment.
 */
export function reconcileObligation(
  obligation: Obligation,
  attempts: readonly AttemptRecord[],
  manifestDigest: string,
  manualResolution?: ManualResolution,
): ObligationState {
  const own = attempts
    .filter((attempt) => attempt.obligationId.toLowerCase() === obligation.obligationId.toLowerCase())
    .sort((a, b) => a.attemptNumber - b.attemptNumber);
  const broadcast = own.filter((attempt) => attempt.outcome.kind !== 'not_broadcast');
  const latest = own.at(-1);
  const exceptions: ReconciliationException[] = [];
  const base = {
    obligationId: obligation.obligationId,
    lineId: obligation.lineId,
    ...(latest ? { latestAttemptId: latest.attemptId } : {}),
  };

  const successes: { attempt: AttemptRecord; transfer: ObservedTransfer | undefined; evidence: ChainEvidence }[] = [];
  for (const attempt of broadcast) {
    if (attempt.outcome.kind !== 'finalized_success') continue;
    successes.push({
      attempt,
      transfer: attributableTransfer(obligation, attempt.outcome.transfers),
      evidence: attempt.outcome.evidence,
    });
  }

  const exact = successes.filter(
    (success) => success.transfer && transferMismatches(obligation, success.transfer, manifestDigest).length === 0,
  );
  const mismatched = successes.filter((success) => !exact.includes(success));

  for (const success of mismatched) {
    if (!success.transfer) {
      exceptions.push({
        type: 'unattributed_transfer',
        severity: 'critical',
        obligationId: obligation.obligationId,
        attemptId: success.attempt.attemptId,
        message: `transaction ${success.evidence.txHash} finalized without a transfer attributable to this obligation`,
      });
      continue;
    }
    for (const problem of transferMismatches(obligation, success.transfer, manifestDigest)) {
      exceptions.push({
        ...problem,
        severity: 'critical',
        obligationId: obligation.obligationId,
        attemptId: success.attempt.attemptId,
        transfer: success.transfer,
      });
    }
  }
  if (exact.length > 1) {
    for (const extra of exact.slice(1)) {
      exceptions.push({
        type: 'duplicate_settlement',
        severity: 'critical',
        obligationId: obligation.obligationId,
        attemptId: extra.attempt.attemptId,
        message: `obligation was paid more than once; ${extra.evidence.txHash} is an additional settlement`,
        ...(extra.transfer ? { transfer: extra.transfer } : {}),
      });
    }
  }

  const inFlight = broadcast.filter(
    (attempt) => attempt.outcome.kind === 'pending' || attempt.outcome.kind === 'included',
  );
  const unknown = broadcast.filter((attempt) => attempt.outcome.kind === 'unknown');
  for (const attempt of unknown) {
    exceptions.push({
      type: 'outcome_unknown',
      severity: 'warning',
      obligationId: obligation.obligationId,
      attemptId: attempt.attemptId,
      message: attempt.outcome.kind === 'unknown' ? attempt.outcome.detail : 'outcome unknown',
    });
  }

  const allAttemptsFinalAndFailed =
    broadcast.length > 0 && broadcast.every((attempt) => attempt.outcome.kind === 'finalized_failure');

  const first = exact[0];
  if (first) {
    if (inFlight.length > 0 || unknown.length > 0) {
      exceptions.push({
        type: 'concurrent_attempt',
        severity: 'warning',
        obligationId: obligation.obligationId,
        message: 'another attempt for this paid obligation is still in flight or unresolved and must be watched',
      });
    }
    if (mismatched.length > 0 || exact.length > 1) {
      return {
        ...base,
        status: 'needs_review',
        explanation: `Paid by ${first.evidence.txHash}, but other finalized transfers for this line need review.`,
        settledBy: { attemptId: first.attempt.attemptId, evidence: first.evidence },
        allAttemptsFinalAndFailed: false,
        exceptions,
      };
    }
    return {
      ...base,
      status: 'paid_verified',
      explanation: `Finalized transfer ${first.evidence.txHash} in block ${first.evidence.blockNumber ?? '?'} matches payer, recipient, asset and amount.`,
      settledBy: { attemptId: first.attempt.attemptId, evidence: first.evidence },
      allAttemptsFinalAndFailed: false,
      exceptions,
    };
  }

  if (mismatched.length > 0) {
    return {
      ...base,
      status: 'incorrect',
      explanation: 'A finalized transfer exists for this line but does not match the approved obligation; it stays outstanding until reviewed.',
      allAttemptsFinalAndFailed: false,
      exceptions,
    };
  }

  if (manualResolution) {
    return {
      ...base,
      status: 'manually_resolved',
      explanation: `Marked resolved by ${manualResolution.resolvedBy}: ${manualResolution.reason}. No on-chain settlement was verified.`,
      allAttemptsFinalAndFailed,
      exceptions,
    };
  }

  if (unknown.length > 0) {
    return {
      ...base,
      status: 'needs_review',
      explanation: 'At least one attempt has an outcome that cannot be established, so retrying could pay twice.',
      allAttemptsFinalAndFailed: false,
      exceptions,
    };
  }

  const includedOnly = inFlight.filter((attempt) => attempt.outcome.kind === 'included');
  if (includedOnly.length > 0) {
    return {
      ...base,
      status: 'confirming',
      explanation: 'Included in a block and waiting for finality before it counts as paid.',
      allAttemptsFinalAndFailed: false,
      exceptions,
    };
  }
  if (inFlight.length > 0) {
    return {
      ...base,
      status: 'submitted',
      explanation: 'Submitted and waiting to be included in a block.',
      allAttemptsFinalAndFailed: false,
      exceptions,
    };
  }

  if (allAttemptsFinalAndFailed) {
    const last = broadcast.at(-1)!.outcome;
    const detail = last.kind === 'finalized_failure' ? last.detail : 'failed';
    return {
      ...base,
      status: 'failed_verified',
      explanation: `Every attempt failed conclusively on-chain (${detail}); no funds moved.`,
      allAttemptsFinalAndFailed: true,
      exceptions,
    };
  }

  return {
    ...base,
    status: 'approved_unattempted',
    explanation: own.some((attempt) => attempt.phase === 'signature_rejected')
      ? 'The signer rejected the request; nothing was broadcast.'
      : 'Approved and not yet attempted.',
    allAttemptsFinalAndFailed: false,
    exceptions,
  };
}

const ALL_STATUSES: ObligationStatus[] = [
  'approved_unattempted',
  'submitted',
  'confirming',
  'paid_verified',
  'failed_verified',
  'incorrect',
  'needs_review',
  'manually_resolved',
];

export function deriveRunStatus(states: readonly ObligationState[]): RunStatus {
  const has = (status: ObligationStatus) => states.some((state) => state.status === status);
  if (has('needs_review') || has('incorrect')) return 'needs_review';
  if (has('submitted') || has('confirming')) return 'reconciling';
  const allSettled = states.every((state) => state.status === 'paid_verified' || state.status === 'manually_resolved');
  const anyOpenException = states.some((state) => state.exceptions.some((exception) => exception.severity === 'critical'));
  if (allSettled && !anyOpenException) return 'complete';
  if (states.every((state) => state.status === 'approved_unattempted')) return 'executing';
  return 'incomplete';
}

/**
 * INV-10: per asset, verified + outstanding = frozen total. Manually resolved
 * lines stay outstanding in this partition because no settlement was proven.
 */
export function partitionByAsset(
  obligations: readonly Obligation[],
  states: readonly ObligationState[],
  totals: readonly AssetTotal[],
): AssetPartition[] {
  const verified = new Set(states.filter((state) => state.status === 'paid_verified').map((state) => state.obligationId));
  return totals.map((total) => {
    let verifiedSum = 0n;
    for (const obligation of obligations) {
      if (obligation.environment !== total.environment || obligation.assetId !== total.assetId) continue;
      if (verified.has(obligation.obligationId)) verifiedSum += BigInt(obligation.amountBaseUnits);
    }
    const totalSum = BigInt(total.amountBaseUnits);
    return {
      environment: total.environment,
      assetId: total.assetId,
      symbol: total.symbol,
      decimals: total.decimals,
      totalBaseUnits: totalSum.toString(),
      verifiedBaseUnits: verifiedSum.toString(),
      outstandingBaseUnits: (totalSum - verifiedSum).toString(),
    };
  });
}

export interface ReconcileRunInput {
  manifestDigest: string;
  obligations: readonly Obligation[];
  totals: readonly AssetTotal[];
  attempts: readonly AttemptRecord[];
  manualResolutions?: readonly ManualResolution[];
}

/** Pure and idempotent: the same inputs always produce the same result. */
export function reconcileRun(input: ReconcileRunInput): ReconciliationResult {
  const resolutions = new Map(
    (input.manualResolutions ?? []).map((resolution) => [resolution.obligationId.toLowerCase(), resolution]),
  );
  const obligations = input.obligations.map((obligation) =>
    reconcileObligation(
      obligation,
      input.attempts,
      input.manifestDigest,
      resolutions.get(obligation.obligationId.toLowerCase()),
    ),
  );
  const counts = Object.fromEntries(ALL_STATUSES.map((status) => [status, 0])) as Record<ObligationStatus, number>;
  for (const state of obligations) counts[state.status] += 1;
  return {
    manifestDigest: input.manifestDigest,
    status: deriveRunStatus(obligations),
    obligations,
    exceptions: obligations.flatMap((state) => state.exceptions),
    partition: partitionByAsset(input.obligations, obligations, input.totals),
    counts,
  };
}
