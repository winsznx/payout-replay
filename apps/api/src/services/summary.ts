import type { AttemptOutcome } from '@payout-replay/core';
import { formatBaseUnits } from '@payout-replay/core';

import type { Services } from '../context.js';
import type { RunState } from './state.js';

/** Line view shared by the run page, the live settlement screen and the API. */
export function lineViews(services: Services, state: RunState): Record<string, unknown>[] {
  const stateById = new Map(state.reconciliation.obligations.map((item) => [item.obligationId, item]));
  return state.frozen.manifest.obligations.map((obligation) => {
    const derived = stateById.get(obligation.obligationId)!;
    const attempts = state.attemptRows
      .filter((row) => row.obligationId === obligation.obligationId)
      .map((row) => {
        const outcome = row.outcome as AttemptOutcome;
        const evidence = 'evidence' in outcome ? outcome.evidence : undefined;
        return {
          id: row.id,
          attemptNumber: row.attemptNumber,
          source: row.source,
          phase: row.phase,
          txHash: row.txHash,
          nonce: row.nonce,
          outcome,
          explorerUrl: row.txHash ? services.chains.explorerTxUrl(row.environment, row.txHash) : null,
          blockHash: evidence?.blockHash ?? null,
          blockNumber: evidence?.blockNumber ?? null,
          extrinsicIndex: evidence?.extrinsicIndex ?? null,
          logIndex: evidence?.logIndex ?? null,
          finalized: evidence?.finalized ?? false,
          provider: evidence?.provider ?? null,
          preparedAt: row.preparedAt,
          submittedAt: row.submittedAt,
          observedAt: row.observedAt,
        };
      });
    return {
      ...obligation,
      amount: formatBaseUnits(obligation.amountBaseUnits, obligation.decimals),
      status: derived.status,
      explanation: derived.explanation,
      exceptions: derived.exceptions,
      settledBy: derived.settledBy ?? null,
      attempts,
    };
  });
}

export function runSummary(state: RunState): Record<string, unknown> {
  return {
    runId: state.run.id,
    manifestVersion: state.version.version,
    manifestDigest: state.frozen.digest,
    status: state.run.status,
    counts: { total: state.frozen.manifest.obligations.length, ...state.reconciliation.counts },
    partition: state.reconciliation.partition.map((part) => ({
      ...part,
      total: formatBaseUnits(part.totalBaseUnits, part.decimals),
      verified: formatBaseUnits(part.verifiedBaseUnits, part.decimals),
      outstanding: formatBaseUnits(part.outstandingBaseUnits, part.decimals),
    })),
    exceptions: state.reconciliation.exceptions.length,
    lastVerifiedAt: state.run.lastReconciledAt,
  };
}
