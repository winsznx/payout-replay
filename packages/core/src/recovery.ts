import { canonicalJson, sha256Digest } from './canonical.js';
import type { ObligationState, ObligationStatus, ReconciliationResult } from './reconcile.js';
import type { Environment, FrozenManifest, Obligation } from './types.js';

export interface ChainSnapshot {
  native?: { finalizedBlockHash: string; finalizedBlockNumber: string; specVersion: number };
  evm?: { finalizedBlockNumber: string; finalizedBlockHash: string };
}

export interface EligibleLine {
  obligationId: string;
  lineId: string;
  environment: Environment;
  assetId: string;
  symbol: string;
  decimals: number;
  payer: string;
  destination: string;
  amountBaseUnits: string;
  reference: string;
  priorStatus: 'approved_unattempted' | 'failed_verified';
  reason: string;
  lastAttemptId?: string;
}

export interface BlockedLine {
  obligationId: string;
  lineId: string;
  status: ObligationStatus;
  reason: string;
}

export interface RecoveryPlan {
  schema: 'payout-replay/recovery-plan@1';
  runId: string;
  manifestVersion: number;
  manifestDigest: string;
  chainSnapshot: ChainSnapshot;
  createdAt: string;
  expiresAt: string;
  eligible: EligibleLine[];
  blocked: BlockedLine[];
  /** sha256 over the canonical plan body; an application integrity value, not a chain signature. */
  fingerprint: string;
}

export const DEFAULT_PLAN_TTL_MS = 5 * 60 * 1000;

const BLOCK_REASONS: Record<Exclude<ObligationStatus, 'approved_unattempted' | 'failed_verified'>, string> = {
  paid_verified: 'Already paid and verified on-chain; paying again would be a duplicate.',
  awaiting_signature: 'A signature request is open for this line.',
  submitted: 'An attempt is in flight; it may still land.',
  confirming: 'Included in a block and waiting for finality.',
  incorrect: 'A finalized transfer does not match the approval; needs a human decision, not an automatic retry.',
  needs_review: 'A previous attempt has an unknown outcome; retrying could pay twice.',
  manually_resolved: 'Resolved manually by an operator; not eligible for automatic payment.',
};

export function isEligible(state: ObligationState): boolean {
  if (state.status === 'approved_unattempted') return true;
  return state.status === 'failed_verified' && state.allAttemptsFinalAndFailed;
}

function eligibleReason(state: ObligationState): string {
  return state.status === 'approved_unattempted'
    ? 'No attempt was ever broadcast for this line.'
    : state.explanation;
}

export interface CreatePlanInput {
  frozen: FrozenManifest;
  reconciliation: ReconciliationResult;
  chainSnapshot: ChainSnapshot;
  now?: Date;
  ttlMs?: number;
  /** Restrict the plan to one environment, e.g. when only one wallet is connected. */
  environment?: Environment;
}

/**
 * Fail-closed selection: an obligation is eligible only when it was never
 * attempted or every attempt failed conclusively. Everything else is listed
 * as blocked with the reason, so the operator sees why nothing was offered.
 */
export function createRecoveryPlan(input: CreatePlanInput): RecoveryPlan {
  const { frozen, reconciliation } = input;
  if (reconciliation.manifestDigest !== frozen.digest) {
    throw new Error('reconciliation result belongs to a different manifest version');
  }
  const now = input.now ?? new Date();
  const byId = new Map(frozen.manifest.obligations.map((obligation) => [obligation.obligationId, obligation]));
  const eligible: EligibleLine[] = [];
  const blocked: BlockedLine[] = [];

  for (const state of reconciliation.obligations) {
    const obligation = byId.get(state.obligationId);
    if (!obligation) throw new Error(`obligation ${state.obligationId} not in manifest`);
    if (input.environment && obligation.environment !== input.environment) continue;
    if (isEligible(state)) {
      eligible.push(toEligible(obligation, state));
    } else {
      const reason =
        state.status === 'failed_verified'
          ? 'Some attempts are not conclusively failed.'
          : BLOCK_REASONS[state.status as keyof typeof BLOCK_REASONS];
      blocked.push({ obligationId: state.obligationId, lineId: state.lineId, status: state.status, reason });
    }
  }

  const body: Omit<RecoveryPlan, 'fingerprint'> = {
    schema: 'payout-replay/recovery-plan@1',
    runId: frozen.manifest.runId,
    manifestVersion: frozen.manifest.version,
    manifestDigest: frozen.digest,
    chainSnapshot: input.chainSnapshot,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_PLAN_TTL_MS)).toISOString(),
    eligible,
    blocked,
  };
  return { ...body, fingerprint: sha256Digest(canonicalJson(body)) };
}

function toEligible(obligation: Obligation, state: ObligationState): EligibleLine {
  return {
    obligationId: obligation.obligationId,
    lineId: obligation.lineId,
    environment: obligation.environment,
    assetId: obligation.assetId,
    symbol: obligation.symbol,
    decimals: obligation.decimals,
    payer: obligation.payer,
    destination: obligation.destination,
    amountBaseUnits: obligation.amountBaseUnits,
    reference: obligation.reference,
    priorStatus: state.status as EligibleLine['priorStatus'],
    reason: eligibleReason(state),
    ...(state.latestAttemptId ? { lastAttemptId: state.latestAttemptId } : {}),
  };
}

export type RevalidationResult =
  | { ok: true; eligibleObligationIds: string[] }
  | { ok: false; code: 'PLAN_EXPIRED' | 'PLAN_TAMPERED' | 'MANIFEST_CHANGED' | 'PLAN_STALE'; message: string; changed: string[] };

/**
 * INV-05: recompute eligibility from fresh chain observations immediately
 * before signing. Any line that left the eligible set invalidates the plan;
 * the caller must create a new one rather than sign a subset silently.
 */
export function revalidateRecoveryPlan(
  plan: RecoveryPlan,
  fresh: ReconciliationResult,
  now: Date = new Date(),
  /** Lines about to be signed. Others in the plan may legitimately have been paid since. */
  obligationIds?: readonly string[],
): RevalidationResult {
  const { fingerprint, ...body } = plan;
  if (sha256Digest(canonicalJson(body)) !== fingerprint) {
    return { ok: false, code: 'PLAN_TAMPERED', message: 'plan contents do not match its fingerprint', changed: [] };
  }
  if (now.getTime() >= Date.parse(plan.expiresAt)) {
    return { ok: false, code: 'PLAN_EXPIRED', message: 'plan expired; create a fresh one', changed: [] };
  }
  if (fresh.manifestDigest !== plan.manifestDigest) {
    return { ok: false, code: 'MANIFEST_CHANGED', message: 'manifest version changed since the plan was created', changed: [] };
  }
  const freshById = new Map(fresh.obligations.map((state) => [state.obligationId, state]));
  const wanted = obligationIds ? new Set(obligationIds.map((id) => id.toLowerCase())) : null;
  const targets = wanted ? plan.eligible.filter((line) => wanted.has(line.obligationId.toLowerCase())) : plan.eligible;
  if (wanted && targets.length !== wanted.size) {
    return { ok: false, code: 'PLAN_STALE', message: 'some requested lines are not in this plan', changed: [] };
  }
  const changed = targets
    .filter((line) => {
      const state = freshById.get(line.obligationId);
      return !state || !isEligible(state);
    })
    .map((line) => line.obligationId);
  if (changed.length > 0) {
    return {
      ok: false,
      code: 'PLAN_STALE',
      message: `${changed.length} line(s) are no longer safe to pay; recompute the plan`,
      changed,
    };
  }
  return { ok: true, eligibleObligationIds: targets.map((line) => line.obligationId) };
}

export interface ExecutionGroup {
  environment: Environment;
  payer: string;
  lines: EligibleLine[];
}

/**
 * Partitions eligible lines into independent native and EVM queues. There is
 * no atomicity across groups; each transfer is verified on its own.
 */
export function createExecutionPlan(plan: RecoveryPlan): ExecutionGroup[] {
  const groups = new Map<Environment, ExecutionGroup>();
  for (const line of plan.eligible) {
    const group = groups.get(line.environment) ?? { environment: line.environment, payer: line.payer, lines: [] };
    group.lines.push(line);
    groups.set(line.environment, group);
  }
  return (['native', 'evm'] as const).flatMap((environment) => {
    const group = groups.get(environment);
    return group ? [group] : [];
  });
}
