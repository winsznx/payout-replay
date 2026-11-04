import type { AttemptLocator, AttemptOutcome, Environment, ObligationState } from '@payout-replay/core';
import { sha256Hex } from '@payout-replay/core';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Services } from '../context.js';
import { chainObservations, exceptions, obligations, paymentAttempts, payoutRuns, settlementMatches } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { type AttemptRow, type RunRow, type RunState, TERMINAL_OUTCOMES, loadRunState } from './state.js';
import { enqueueWebhook } from './webhooks.js';

const lastRun = new Map<string, number>();
const running = new Map<string, Promise<RunState | null>>();

/** Compares outcomes ignoring the observation timestamp, so only real changes are logged. */
function outcomeChanged(previous: AttemptOutcome, next: AttemptOutcome): boolean {
  const stable = (outcome: AttemptOutcome): string =>
    JSON.stringify('evidence' in outcome && outcome.evidence ? { ...outcome, evidence: { ...outcome.evidence, observedAt: '' } } : outcome);
  return stable(previous) !== stable(next);
}

function locatorFor(row: AttemptRow): AttemptLocator {
  return {
    environment: row.environment,
    txHash: row.txHash!,
    payer: row.payer,
    obligationId: row.obligationId,
    ...(row.nonce === null ? {} : { nonce: row.nonce }),
    ...(row.reportedBlockHash ? { blockHash: row.reportedBlockHash } : {}),
    ...(row.mortalityBirth !== null && row.mortalityPeriod !== null
      ? { mortality: { birthBlock: row.mortalityBirth, period: row.mortalityPeriod } }
      : {}),
  };
}

/** What we can say about an attempt from the chain right now. Never upgrades certainty. */
async function observe(services: Services, row: AttemptRow): Promise<AttemptOutcome> {
  if (row.phase === 'signature_rejected') return { kind: 'not_broadcast' };
  if (row.phase === 'prepared') {
    const age = Date.now() - row.preparedAt.getTime();
    return age < services.config.SIGNATURE_WINDOW_MS
      ? { kind: 'pending', detail: 'waiting for the wallet signature' }
      : {
          kind: 'unknown',
          detail: 'the signature request was never resolved; the wallet may have signed and broadcast without the app recording it',
        };
  }
  if (!row.txHash) {
    return { kind: 'unknown', detail: 'submission outcome unknown and no transaction identity was recorded' };
  }
  try {
    return await services.chains.adapterFor(row.environment).observeAttempt(locatorFor(row));
  } catch (error) {
    return { kind: 'unknown', detail: `verification unavailable: ${(error as Error).message}` };
  }
}

async function persistOutcome(services: Services, row: AttemptRow, outcome: AttemptOutcome, provider: string): Promise<void> {
  const previous = row.outcome as AttemptOutcome;
  const now = new Date();
  const changed = outcomeChanged(previous, outcome);
  await services.db
    .update(paymentAttempts)
    .set({
      outcome,
      outcomeKind: outcome.kind,
      observedAt: now,
      ...(outcome.kind === 'finalized_success' || outcome.kind === 'finalized_failure' ? { finalizedAt: row.finalizedAt ?? now } : {}),
    })
    .where(eq(paymentAttempts.id, row.id));
  if (!changed) return;
  const evidence = 'evidence' in outcome ? outcome.evidence : undefined;
  await services.db.insert(chainObservations).values({
    id: newId('obs'),
    attemptId: row.id,
    provider: evidence?.provider ?? provider,
    outcomeKind: outcome.kind,
    blockHash: evidence?.blockHash ?? null,
    blockNumber: evidence?.blockNumber ?? null,
    extrinsicIndex: evidence?.extrinsicIndex ?? null,
    logIndex: evidence?.logIndex ?? null,
    finalized: evidence?.finalized ?? false,
    raw: outcome,
    observedAt: now,
  });
}

/** EVM: pick up executor settlements for this payer and obligation that no app attempt recorded. */
async function scanUnrecordedSettlements(services: Services, state: RunState): Promise<boolean> {
  const evm = services.chains.evm;
  if (!evm) return false;
  const known = new Set(state.attemptRows.map((row) => row.txHash?.toLowerCase()).filter(Boolean));
  const paid = new Set(state.reconciliation.obligations.filter((item) => item.status === 'paid_verified').map((item) => item.obligationId));
  let inserted = false;
  for (const row of state.obligationRows) {
    if (row.environment !== 'evm' || paid.has(row.obligationId)) continue;
    let outcomes: AttemptOutcome[];
    try {
      outcomes = await evm.scanSettlements({ obligationId: row.obligationId, payer: row.payer });
    } catch {
      continue;
    }
    for (const outcome of outcomes) {
      if (outcome.kind !== 'finalized_success' || known.has(outcome.evidence.txHash.toLowerCase())) continue;
      const attemptNumber =
        Math.max(0, ...state.attemptRows.filter((attempt) => attempt.obligationRowId === row.id).map((attempt) => attempt.attemptNumber)) + 1;
      const attemptId = newId('att');
      await services.db
        .insert(paymentAttempts)
        .values({
          id: attemptId,
          runId: state.run.id,
          obligationRowId: row.id,
          obligationId: row.obligationId,
          attemptNumber,
          source: 'chain_scan',
          environment: 'evm',
          payer: row.payer,
          phase: 'submitted',
          txHash: outcome.evidence.txHash,
          idempotencyKey: `chain_scan:${row.id}:${outcome.evidence.txHash.toLowerCase()}`,
          outcome,
          outcomeKind: outcome.kind,
          preparedAt: new Date(),
          submittedAt: new Date(),
          finalizedAt: new Date(),
          observedAt: new Date(),
        })
        .onConflictDoNothing();
      known.add(outcome.evidence.txHash.toLowerCase());
      inserted = true;
    }
  }
  return inserted;
}

function exceptionFingerprint(runId: string, exception: ObligationState['exceptions'][number]): string {
  return sha256Hex(`${runId}|${exception.obligationId}|${exception.attemptId ?? ''}|${exception.type}`);
}

async function persistDerivedState(services: Services, state: RunState): Promise<void> {
  const now = new Date();
  const rowByObligation = new Map(state.obligationRows.map((row) => [row.obligationId, row]));
  const transitions: { row: (typeof state.obligationRows)[number]; next: ObligationState }[] = [];

  for (const next of state.reconciliation.obligations) {
    const row = rowByObligation.get(next.obligationId);
    if (!row) continue;
    if (row.status !== next.status || row.explanation !== next.explanation) {
      await services.db
        .update(obligations)
        .set({ status: next.status, explanation: next.explanation, updatedAt: now })
        .where(eq(obligations.id, row.id));
      if (row.status !== next.status) transitions.push({ row, next });
    }
    if (next.status === 'paid_verified' && next.settledBy) {
      await services.db
        .insert(settlementMatches)
        .values({
          id: newId('stm'),
          obligationRowId: row.id,
          attemptId: next.settledBy.attemptId,
          txHash: next.settledBy.evidence.txHash,
          verifiedAmountBaseUnits: row.amountBaseUnits,
          category: 'exact',
          proofVersion: 1,
        })
        .onConflictDoNothing();
    }
  }

  for (const exception of state.reconciliation.exceptions) {
    const row = rowByObligation.get(exception.obligationId);
    await services.db
      .insert(exceptions)
      .values({
        id: newId('exc'),
        runId: state.run.id,
        obligationRowId: row?.id ?? null,
        fingerprint: exceptionFingerprint(state.run.id, exception),
        severity: exception.severity,
        type: exception.type,
        message: exception.message,
        evidence: exception,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [exceptions.runId, exceptions.fingerprint],
        set: { lastSeenAt: now, message: exception.message, evidence: exception },
      });
  }

  const runStatus = runStatusFor(state);
  await services.db
    .update(payoutRuns)
    .set({ status: runStatus, lastReconciledAt: now, updatedAt: now, revision: sql`${payoutRuns.revision} + 1` })
    .where(eq(payoutRuns.id, state.run.id));

  for (const { row, next } of transitions) {
    if (next.status === 'paid_verified') {
      await enqueueWebhook(services, state.run.orgId, 'obligation.paid_verified', `evt_paid_${row.id}`, {
        runId: state.run.id,
        lineId: row.lineId,
        obligationId: row.obligationId,
        txHash: next.settledBy?.evidence.txHash,
      });
    }
    if (next.status === 'needs_review') {
      await enqueueWebhook(services, state.run.orgId, 'obligation.needs_review', `evt_review_${row.id}_${now.getTime()}`, {
        runId: state.run.id,
        lineId: row.lineId,
        obligationId: row.obligationId,
        explanation: next.explanation,
      });
    }
  }
  if (runStatus !== state.run.status) {
    await enqueueWebhook(services, state.run.orgId, 'payout_run.updated', `evt_run_${state.run.id}_${runStatus}_${now.getTime()}`, {
      runId: state.run.id,
      status: runStatus,
      counts: state.reconciliation.counts,
    });
  }
}

/** Maps core's run status onto the persisted lifecycle without regressing pre-execution states. */
function runStatusFor(state: RunState): string {
  const anyAttempt = state.attemptRows.length > 0;
  if (!anyAttempt) return state.run.status === 'executing' ? 'executing' : 'approved';
  const status = state.reconciliation.status;
  if (status === 'executing') return 'executing';
  if (status === 'incomplete' && state.run.status === 'recovering') return 'recovering';
  return status;
}

/**
 * Refreshes every non-final attempt from the chain, records provenance and
 * recomputes the run. Idempotent: finalized outcomes are never re-observed, so
 * repeated runs cannot regress a settled line or duplicate a settlement.
 */
export async function reconcileRunNow(services: Services, run: RunRow, options: { force?: boolean } = {}): Promise<RunState | null> {
  const inflight = running.get(run.id);
  if (inflight) {
    // Callers need observations taken after their request, not a job that started earlier;
    // the debounce below still collapses bursts of non-forced requests.
    await inflight.catch(() => undefined);
    return reconcileRunNow(services, run, options);
  }
  const since = Date.now() - (lastRun.get(run.id) ?? 0);
  if (!options.force && since < services.config.RECONCILE_DEBOUNCE_MS) return loadRunState(services, run);

  const job = (async () => {
    let state = await loadRunState(services, run);
    if (!state) return null;
    for (const row of state.attemptRows) {
      if (TERMINAL_OUTCOMES.has((row.outcome as AttemptOutcome).kind)) continue;
      const outcome = await observe(services, row);
      const provider = row.environment === 'evm' ? services.chains.evm?.provider ?? 'evm' : services.chains.native?.provider ?? 'native';
      await persistOutcome(services, row, outcome, provider);
    }
    state = await loadRunState(services, run);
    if (!state) return null;
    if (await scanUnrecordedSettlements(services, state)) {
      state = await loadRunState(services, run);
      if (!state) return null;
    }
    await persistDerivedState(services, state);
    lastRun.set(run.id, Date.now());
    const [fresh] = await services.db.select().from(payoutRuns).where(eq(payoutRuns.id, run.id));
    return fresh ? loadRunState(services, fresh) : state;
  })().finally(() => running.delete(run.id));
  running.set(run.id, job);
  return job;
}

export async function runsNeedingReconciliation(services: Services): Promise<RunRow[]> {
  return services.db
    .select()
    .from(payoutRuns)
    .where(inArray(payoutRuns.status, ['executing', 'recovering', 'reconciling', 'needs_review', 'incomplete']));
}

export function environmentsOf(state: RunState): Set<Environment> {
  return new Set(state.frozen.manifest.obligations.map((obligation) => obligation.environment));
}

export async function openExceptions(services: Services, runId: string): Promise<(typeof exceptions.$inferSelect)[]> {
  return services.db.select().from(exceptions).where(and(eq(exceptions.runId, runId), eq(exceptions.resolution, 'open')));
}
