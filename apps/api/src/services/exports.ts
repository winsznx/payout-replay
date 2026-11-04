import type { AttemptOutcome } from '@payout-replay/core';
import { exportExceptionsCsv, exportReconciliationCsv, formatBaseUnits } from '@payout-replay/core';
import { asc, eq, inArray } from 'drizzle-orm';

import type { Services } from '../context.js';
import { approvals, chainObservations, runImports } from '../db/schema.js';
import type { RunState } from './state.js';

export const KNOWN_LIMITATIONS = [
  'Approval is recorded off-chain in the application; it is not an on-chain multi-party authorisation.',
  'The executor manifestDigest is an audit correlation value, not proof that the manifest was approved.',
  'Native and EVM transfers settle independently; there is no atomicity across environments.',
  'Transfers made outside Payout Replay are only counted when their transaction reference is imported and verified.',
  'manually_resolved lines carry no on-chain proof and remain outstanding in the settled totals.',
  'Portaldot V3 testnet only. Contracts are unaudited.',
];

function correctionAttemptIds(state: RunState): Set<string> {
  return new Set(state.attemptRows.filter((row) => row.attemptNumber > 1 && row.source !== 'chain_scan').map((row) => row.id));
}

function finalizedAt(state: RunState): Map<string, string> {
  return new Map(state.attemptRows.filter((row) => row.finalizedAt).map((row) => [row.id, row.finalizedAt!.toISOString()]));
}

export function reconciliationCsv(state: RunState): string {
  return exportReconciliationCsv({
    frozen: state.frozen,
    reconciliation: state.reconciliation,
    verificationAt: (state.run.lastReconciledAt ?? new Date()).toISOString(),
    correctionAttemptIds: correctionAttemptIds(state),
    finalizedAt: finalizedAt(state),
  });
}

export function exceptionsCsv(state: RunState): string {
  return exportExceptionsCsv({ frozen: state.frozen, reconciliation: state.reconciliation });
}

/** EXP-07: everything an auditor needs to re-verify the run independently of this service. */
export async function evidencePackage(services: Services, state: RunState): Promise<Record<string, unknown>> {
  const attemptIds = state.attemptRows.map((row) => row.id);
  const [observations, decisions, [upload]] = await Promise.all([
    attemptIds.length
      ? services.db.select().from(chainObservations).where(inArray(chainObservations.attemptId, attemptIds)).orderBy(asc(chainObservations.observedAt))
      : Promise.resolve([]),
    services.db.select().from(approvals).where(eq(approvals.manifestVersionId, state.version.id)),
    services.db.select({ sha: runImports.fileSha256, name: runImports.fileName }).from(runImports).where(eq(runImports.id, state.version.importId)),
  ]);
  return {
    schema: 'payout-replay/evidence@1',
    generatedAt: new Date().toISOString(),
    run: { id: state.run.id, name: state.run.name, status: state.run.status, lastReconciledAt: state.run.lastReconciledAt },
    sourceFile: upload ? { sha256: upload.sha, name: upload.name } : null,
    manifest: { version: state.version.version, digest: state.frozen.digest, canonicalJson: state.frozen.canonicalJson },
    approvals: decisions.map((decision) => ({
      reviewerId: decision.reviewerId,
      decision: decision.decision,
      method: decision.method,
      digest: decision.digest,
      at: decision.createdAt,
    })),
    reconciliation: {
      status: state.reconciliation.status,
      counts: state.reconciliation.counts,
      partition: state.reconciliation.partition.map((part) => ({
        ...part,
        total: formatBaseUnits(part.totalBaseUnits, part.decimals),
        verified: formatBaseUnits(part.verifiedBaseUnits, part.decimals),
        outstanding: formatBaseUnits(part.outstandingBaseUnits, part.decimals),
      })),
      obligations: state.reconciliation.obligations,
      exceptions: state.reconciliation.exceptions,
    },
    attempts: state.attemptRows.map((row) => ({
      id: row.id,
      obligationId: row.obligationId,
      attemptNumber: row.attemptNumber,
      source: row.source,
      environment: row.environment,
      payer: row.payer,
      phase: row.phase,
      txHash: row.txHash,
      nonce: row.nonce,
      outcome: row.outcome as AttemptOutcome,
      preparedAt: row.preparedAt,
      submittedAt: row.submittedAt,
      finalizedAt: row.finalizedAt,
    })),
    observations: observations.map((observation) => ({
      attemptId: observation.attemptId,
      provider: observation.provider,
      outcomeKind: observation.outcomeKind,
      blockHash: observation.blockHash,
      blockNumber: observation.blockNumber,
      extrinsicIndex: observation.extrinsicIndex,
      logIndex: observation.logIndex,
      finalized: observation.finalized,
      observedAt: observation.observedAt,
    })),
    network: state.frozen.manifest.network,
    knownLimitations: KNOWN_LIMITATIONS,
  };
}
