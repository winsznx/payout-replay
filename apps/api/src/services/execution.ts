import type { EvmTransferPayload } from '@payout-replay/adapters-evm';
import type { NativeTransferPayload } from '@payout-replay/adapters-native';
import type { AttemptOutcome, ChainSnapshot, Environment, RecoveryPlan, UnsignedTransfer } from '@payout-replay/core';
import { createRecoveryPlan, revalidateRecoveryPlan, sameAddress } from '@payout-replay/core';
import { and, eq, inArray } from 'drizzle-orm';

import type { Principal, Services } from '../context.js';
import { manualResolutions, obligations, paymentAttempts, payoutRuns, recoveryPlans, userIdentities } from '../db/schema.js';
import { recordAudit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { reconcileRunNow } from './reconciliation.js';
import { type RunRow, type RunState, TERMINAL_OUTCOMES, loadRunState } from './state.js';
import { enqueueWebhook } from './webhooks.js';

type User = Extract<Principal, { kind: 'user' }>;
export type PlanKind = 'execution' | 'recovery';
export type AnyUnsignedTransfer = UnsignedTransfer<EvmTransferPayload> | UnsignedTransfer<NativeTransferPayload>;

const EXECUTABLE_RUN_STATUSES = new Set(['approved', 'executing', 'reconciling', 'incomplete', 'needs_review', 'recovering']);

async function requireFreshState(services: Services, run: RunRow): Promise<RunState> {
  const state = await reconcileRunNow(services, run, { force: true });
  if (!state) throw new ApiError('UNPROCESSABLE', 'the run has no approved manifest');
  return state;
}

async function chainSnapshot(services: Services, environments: Set<Environment>): Promise<ChainSnapshot> {
  const snapshot: ChainSnapshot = {};
  try {
    if (environments.has('native') && services.chains.native) {
      const finality = await services.chains.native.getFinality();
      const identity = await services.chains.native.getNetworkIdentity();
      snapshot.native = {
        finalizedBlockHash: finality.finalizedBlockHash,
        finalizedBlockNumber: finality.finalizedBlockNumber,
        specVersion: identity.specVersion,
      };
    }
    if (environments.has('evm') && services.chains.evm) {
      const finality = await services.chains.evm.getFinality();
      snapshot.evm = { finalizedBlockHash: finality.finalizedBlockHash, finalizedBlockNumber: finality.finalizedBlockNumber };
    }
  } catch (error) {
    throw new ApiError('CHAIN_UNAVAILABLE', `cannot read finality: ${(error as Error).message}`, undefined, true);
  }
  return snapshot;
}

/**
 * Builds an expiring plan from freshly observed chain state. The same
 * fail-closed selection serves the first execution and every correction.
 */
export async function createPlan(
  services: Services,
  user: User,
  run: RunRow,
  input: { kind: PlanKind; environment?: Environment },
  traceId: string,
): Promise<{ planId: string; plan: RecoveryPlan }> {
  if (!EXECUTABLE_RUN_STATUSES.has(run.status)) throw new ApiError('CONFLICT', `run is ${run.status}; approve the manifest first`);
  const state = await requireFreshState(services, run);
  const environments = new Set(state.frozen.manifest.obligations.map((obligation) => obligation.environment));
  const plan = createRecoveryPlan({
    frozen: state.frozen,
    reconciliation: state.reconciliation,
    chainSnapshot: await chainSnapshot(services, environments),
    ...(input.environment ? { environment: input.environment } : {}),
  });
  const planId = newId('plan');
  await services.db.transaction(async (tx) => {
    await tx
      .update(recoveryPlans)
      .set({ status: 'superseded' })
      .where(and(eq(recoveryPlans.runId, run.id), inArray(recoveryPlans.status, ['open', 'revalidated'])));
    await tx.insert(recoveryPlans).values({
      id: planId,
      runId: run.id,
      manifestVersionId: state.version.id,
      manifestDigest: plan.manifestDigest,
      kind: input.kind,
      plan,
      fingerprint: plan.fingerprint,
      status: 'open',
      expiresAt: new Date(plan.expiresAt),
      createdBy: user.userId,
    });
    if (input.kind === 'recovery' && plan.eligible.length > 0) {
      await tx.update(payoutRuns).set({ status: 'recovering', updatedAt: new Date() }).where(eq(payoutRuns.id, run.id));
    }
    await recordAudit(tx, {
      orgId: run.orgId,
      principal: user,
      action: `${input.kind}_plan.created`,
      objectType: 'recovery_plan',
      objectId: planId,
      afterDigest: plan.fingerprint,
      traceId,
      detail: { eligible: plan.eligible.length, blocked: plan.blocked.length },
    });
  });
  if (input.kind === 'recovery' && plan.eligible.length > 0) {
    await enqueueWebhook(services, run.orgId, 'recovery_plan.ready', `evt_plan_${planId}`, {
      runId: run.id,
      planId,
      eligible: plan.eligible.map((line) => line.lineId),
      blocked: plan.blocked.map((line) => ({ lineId: line.lineId, status: line.status, reason: line.reason })),
    });
  }
  return { planId, plan };
}

async function loadPlan(services: Services, planId: string): Promise<{ row: typeof recoveryPlans.$inferSelect; plan: RecoveryPlan }> {
  const [row] = await services.db.select().from(recoveryPlans).where(eq(recoveryPlans.id, planId));
  if (!row) throw new ApiError('NOT_FOUND', 'plan not found');
  return { row, plan: row.plan as RecoveryPlan };
}

async function userControls(services: Services, userId: string, environment: Environment, address: string): Promise<boolean> {
  const identities = await services.db
    .select()
    .from(userIdentities)
    .where(and(eq(userIdentities.userId, userId), eq(userIdentities.environment, environment)));
  return identities.some((identity) => sameAddress(environment, identity.address, address));
}

/**
 * INV-05 / FIX-05: immediately before a wallet prompt, re-observe the chain,
 * re-run eligibility and re-check executor state through the adapter
 * preflight. Any drift marks the plan stale; the caller must start over.
 */
export async function revalidatePlan(
  services: Services,
  user: User,
  planId: string,
  input: { environment: Environment; obligationIds?: string[] },
  traceId: string,
): Promise<{ planId: string; transfers: AnyUnsignedTransfer[]; expiresAt: string }> {
  const { row, plan } = await loadPlan(services, planId);
  const [run] = await services.db.select().from(payoutRuns).where(eq(payoutRuns.id, row.runId));
  if (!run) throw new ApiError('NOT_FOUND', 'run not found');
  if (!['open', 'revalidated'].includes(row.status)) throw new ApiError('PLAN_STALE', `plan is ${row.status}; create a new plan`);

  const wanted = new Set((input.obligationIds ?? plan.eligible.map((line) => line.obligationId)).map((id) => id.toLowerCase()));
  const lines = plan.eligible.filter((line) => line.environment === input.environment && wanted.has(line.obligationId.toLowerCase()));
  if (lines.length === 0) throw new ApiError('UNPROCESSABLE', `no eligible ${input.environment} lines in this plan`);

  const state = await requireFreshState(services, run);
  const verdict = revalidateRecoveryPlan(plan, state.reconciliation, new Date(), lines.map((line) => line.obligationId));
  if (!verdict.ok) {
    // Expiry and tampering kill the whole plan; a line that moved on only blocks that line.
    if (verdict.code !== 'PLAN_STALE') {
      await services.db.update(recoveryPlans).set({ status: verdict.code === 'PLAN_EXPIRED' ? 'expired' : 'stale' }).where(eq(recoveryPlans.id, planId));
    }
    throw new ApiError(verdict.code === 'PLAN_EXPIRED' ? 'PLAN_EXPIRED' : 'PLAN_STALE', verdict.message, { changed: verdict.changed });
  }
  const payer = lines[0]!.payer;
  if (!(await userControls(services, user.userId, input.environment, payer))) {
    throw new ApiError('WRONG_WALLET', `sign in with or link the ${input.environment} payout wallet ${payer} to prepare these payments`);
  }

  const adapter = services.chains.adapterFor(input.environment);
  const transfers: AnyUnsignedTransfer[] = [];
  for (const line of lines) {
    try {
      transfers.push(await adapter.buildUnsignedTransfer(line, { manifestDigest: plan.manifestDigest }));
    } catch (error) {
      throw new ApiError('CHAIN_UNAVAILABLE', `preflight failed for ${line.lineId}: ${(error as Error).message}`, undefined, true);
    }
  }
  if (transfers.some((transfer) => transfer.preflight.some((issue) => issue.code === 'ALREADY_EXECUTED'))) {
    throw new ApiError('PLAN_STALE', 'the executor already recorded one of these obligations; reconcile before paying', {
      transfers: transfers.filter((transfer) => transfer.preflight.some((issue) => issue.code === 'ALREADY_EXECUTED')).map((t) => t.obligationId),
    });
  }
  await services.db.update(recoveryPlans).set({ status: 'revalidated', revalidatedAt: new Date() }).where(eq(recoveryPlans.id, planId));
  await recordAudit(services.db, {
    orgId: run.orgId,
    principal: user,
    action: 'plan.revalidated',
    objectType: 'recovery_plan',
    objectId: planId,
    afterDigest: plan.fingerprint,
    traceId,
    detail: { environment: input.environment, lines: lines.map((line) => line.lineId) },
  });
  return { planId, transfers, expiresAt: plan.expiresAt };
}

/**
 * Records the intent to sign before the wallet prompt opens. Holding a row
 * lock on the obligation guarantees one in-flight attempt per obligation even
 * with two operators clicking at once.
 */
export async function prepareAttempt(
  services: Services,
  user: User,
  input: { planId: string; obligationId: string; idempotencyKey: string; nonce?: number },
  traceId: string,
): Promise<typeof paymentAttempts.$inferSelect> {
  const { row: planRow, plan } = await loadPlan(services, input.planId);
  if (planRow.status !== 'revalidated') throw new ApiError('PLAN_STALE', 'revalidate the plan immediately before signing');
  if (Date.now() >= Date.parse(plan.expiresAt)) throw new ApiError('PLAN_EXPIRED', 'plan expired; create a fresh one');
  const line = plan.eligible.find((item) => item.obligationId.toLowerCase() === input.obligationId.toLowerCase());
  if (!line) throw new ApiError('UNPROCESSABLE', 'obligation is not eligible in this plan');
  if (!(await userControls(services, user.userId, line.environment, line.payer))) {
    throw new ApiError('WRONG_WALLET', `only the ${line.environment} payout wallet ${line.payer} can pay this line`);
  }

  return services.db.transaction(async (tx) => {
    const [obligation] = await tx
      .select()
      .from(obligations)
      .where(and(eq(obligations.manifestVersionId, planRow.manifestVersionId), eq(obligations.obligationId, line.obligationId)))
      .for('update');
    if (!obligation) throw new ApiError('NOT_FOUND', 'obligation not found');
    if (obligation.status !== 'approved_unattempted' && obligation.status !== 'failed_verified') {
      throw new ApiError('PLAN_STALE', `line ${obligation.lineId} is now ${obligation.status}`);
    }
    const existing = await tx.select().from(paymentAttempts).where(eq(paymentAttempts.obligationRowId, obligation.id));
    const open = existing.find((attempt) => !TERMINAL_OUTCOMES.has((attempt.outcome as AttemptOutcome).kind));
    if (open) throw new ApiError('CONFLICT', `attempt ${open.id} for ${obligation.lineId} is still unresolved`);

    const pending: AttemptOutcome = { kind: 'pending', detail: 'waiting for the wallet signature' };
    const [attempt] = await tx
      .insert(paymentAttempts)
      .values({
        id: newId('att'),
        runId: planRow.runId,
        obligationRowId: obligation.id,
        obligationId: obligation.obligationId,
        attemptNumber: existing.length + 1,
        source: 'app',
        planId: planRow.id,
        environment: obligation.environment,
        payer: obligation.payer,
        phase: 'prepared',
        nonce: input.nonce ?? null,
        idempotencyKey: input.idempotencyKey,
        outcome: pending,
        outcomeKind: pending.kind,
        createdBy: user.userId,
        preparedAt: new Date(),
      })
      .returning();
    await tx
      .update(obligations)
      .set({ status: 'awaiting_signature', explanation: 'Waiting for the payout wallet to sign.', updatedAt: new Date() })
      .where(eq(obligations.id, obligation.id));
    await tx
      .update(payoutRuns)
      .set({ status: planRow.kind === 'recovery' ? 'recovering' : 'executing', updatedAt: new Date() })
      .where(eq(payoutRuns.id, planRow.runId));
    await recordAudit(tx, {
      orgId: null,
      principal: user,
      action: 'attempt.prepared',
      objectType: 'payment_attempt',
      objectId: attempt!.id,
      traceId,
      detail: { obligationId: obligation.obligationId, lineId: obligation.lineId, planId: planRow.id, attemptNumber: attempt!.attemptNumber },
    });
    return attempt!;
  });
}

export interface AttemptResult {
  phase: 'signature_rejected' | 'submitted' | 'submission_unknown';
  txHash?: string;
  nonce?: number;
  blockHash?: string;
  mortality?: { birthBlock: number; period: number };
}

/**
 * Records what the wallet did. Transaction identity is write-once in the
 * database; a "submission unknown" result keeps the line blocked until the
 * chain proves an outcome. Payments are never resent by the server.
 */
export async function recordAttemptResult(
  services: Services,
  user: User,
  attemptId: string,
  result: AttemptResult,
  traceId: string,
): Promise<typeof paymentAttempts.$inferSelect> {
  const [attempt] = await services.db.select().from(paymentAttempts).where(eq(paymentAttempts.id, attemptId));
  if (!attempt) throw new ApiError('NOT_FOUND', 'attempt not found');
  if (attempt.createdBy !== user.userId) throw new ApiError('FORBIDDEN', 'only the operator who opened the signing request can record its result');
  if (attempt.phase !== 'prepared') throw new ApiError('CONFLICT', `attempt is already ${attempt.phase}`);
  if (result.phase === 'submitted' && !result.txHash) throw new ApiError('VALIDATION_FAILED', 'a submitted attempt needs its transaction hash');

  const outcome: AttemptOutcome =
    result.phase === 'signature_rejected'
      ? { kind: 'not_broadcast' }
      : result.txHash
        ? { kind: 'pending', detail: 'broadcast; waiting for inclusion' }
        : { kind: 'unknown', detail: 'the wallet signed but the broadcast result was lost' };
  const [updated] = await services.db
    .update(paymentAttempts)
    .set({
      phase: result.phase,
      txHash: result.txHash ?? null,
      nonce: result.nonce ?? attempt.nonce,
      reportedBlockHash: result.blockHash ?? null,
      mortalityBirth: result.mortality?.birthBlock ?? null,
      mortalityPeriod: result.mortality?.period ?? null,
      submittedAt: result.phase === 'signature_rejected' ? null : new Date(),
      outcome,
      outcomeKind: outcome.kind,
    })
    .where(eq(paymentAttempts.id, attemptId))
    .returning();
  await recordAudit(services.db, {
    orgId: null,
    principal: user,
    action: `attempt.${result.phase}`,
    objectType: 'payment_attempt',
    objectId: attemptId,
    traceId,
    detail: { txHash: result.txHash ?? null, nonce: result.nonce ?? null },
  });
  return updated!;
}

/** PAY-11: attach an out-of-band transaction to an obligation; it counts only after chain verification. */
export async function importTransaction(
  services: Services,
  principal: Principal,
  run: RunRow,
  input: { obligationId: string; txHash: string; blockHash?: string; idempotencyKey: string },
  traceId: string,
): Promise<typeof paymentAttempts.$inferSelect> {
  const state = await loadRunState(services, run);
  if (!state) throw new ApiError('UNPROCESSABLE', 'the run has no approved manifest');
  const row = state.obligationRows.find((item) => item.obligationId.toLowerCase() === input.obligationId.toLowerCase());
  if (!row) throw new ApiError('NOT_FOUND', 'obligation not found in the approved manifest');
  if (row.environment === 'native' && !input.blockHash) {
    throw new ApiError('VALIDATION_FAILED', 'native transactions need the block hash they were included in');
  }
  const duplicate = state.attemptRows.find((attempt) => attempt.txHash?.toLowerCase() === input.txHash.toLowerCase());
  if (duplicate) throw new ApiError('CONFLICT', `transaction already recorded as attempt ${duplicate.id}`);
  const outcome: AttemptOutcome = { kind: 'pending', detail: 'imported reference awaiting verification' };
  const [attempt] = await services.db
    .insert(paymentAttempts)
    .values({
      id: newId('att'),
      runId: run.id,
      obligationRowId: row.id,
      obligationId: row.obligationId,
      attemptNumber: state.attemptRows.filter((item) => item.obligationRowId === row.id).length + 1,
      source: 'imported',
      environment: row.environment,
      payer: row.payer,
      phase: 'submitted',
      txHash: input.txHash,
      reportedBlockHash: input.blockHash ?? null,
      idempotencyKey: input.idempotencyKey,
      outcome,
      outcomeKind: outcome.kind,
      createdBy: principal.kind === 'user' ? principal.userId : null,
      preparedAt: new Date(),
      submittedAt: new Date(),
    })
    .returning();
  await recordAudit(services.db, {
    orgId: run.orgId,
    principal,
    action: 'attempt.imported',
    objectType: 'payment_attempt',
    objectId: attempt!.id,
    traceId,
    detail: { lineId: row.lineId, txHash: input.txHash },
  });
  await reconcileRunNow(services, run, { force: true });
  return attempt!;
}

/** FIX-08: a human decision, kept distinct from `paid_verified` and never used to authorise payment. */
export async function resolveManually(
  services: Services,
  user: User,
  run: RunRow,
  input: { obligationId: string; reason: string; proofReference?: string },
  traceId: string,
): Promise<void> {
  const state = await loadRunState(services, run);
  if (!state) throw new ApiError('UNPROCESSABLE', 'the run has no approved manifest');
  const row = state.obligationRows.find((item) => item.obligationId.toLowerCase() === input.obligationId.toLowerCase());
  if (!row) throw new ApiError('NOT_FOUND', 'obligation not found');
  const current = state.reconciliation.obligations.find((item) => item.obligationId === row.obligationId);
  if (current?.status === 'paid_verified') throw new ApiError('CONFLICT', 'line is already verified on-chain');
  await services.db.insert(manualResolutions).values({
    id: newId('res'),
    obligationRowId: row.id,
    reason: input.reason,
    proofReference: input.proofReference ?? null,
    resolvedBy: user.userId,
  });
  await recordAudit(services.db, {
    orgId: run.orgId,
    principal: user,
    action: 'obligation.manually_resolved',
    objectType: 'obligation',
    objectId: row.id,
    traceId,
    detail: { lineId: row.lineId, reason: input.reason, proofReference: input.proofReference ?? null },
  });
  await reconcileRunNow(services, run, { force: true });
}
