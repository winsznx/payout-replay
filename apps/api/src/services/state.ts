import type {
  AttemptOutcome,
  AttemptPhase,
  AttemptRecord,
  AttemptSource,
  FrozenManifest,
  ManualResolution,
  PayoutManifest,
  ReconciliationResult,
} from '@payout-replay/core';
import { reconcileRun, verifyManifestDigest } from '@payout-replay/core';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import type { Services } from '../context.js';
import { manifestVersions, manualResolutions, obligations, paymentAttempts, payoutRuns } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';

export type RunRow = typeof payoutRuns.$inferSelect;
export type VersionRow = typeof manifestVersions.$inferSelect;
export type AttemptRow = typeof paymentAttempts.$inferSelect;
export type ObligationRow = typeof obligations.$inferSelect;

export const TERMINAL_OUTCOMES = new Set<AttemptOutcome['kind']>(['finalized_success', 'finalized_failure', 'not_broadcast']);

export function parseFrozen(version: VersionRow): FrozenManifest {
  const manifest = JSON.parse(version.canonicalJson) as PayoutManifest;
  const frozen: FrozenManifest = { manifest, canonicalJson: version.canonicalJson, digest: version.digest };
  if (!verifyManifestDigest(frozen)) {
    throw new ApiError('INTERNAL', `stored manifest ${version.id} no longer matches its digest`);
  }
  return frozen;
}

export async function latestVersion(services: Services, runId: string): Promise<VersionRow | undefined> {
  const [version] = await services.db
    .select()
    .from(manifestVersions)
    .where(eq(manifestVersions.runId, runId))
    .orderBy(desc(manifestVersions.version))
    .limit(1);
  return version;
}

export async function approvedVersion(services: Services, runId: string): Promise<VersionRow | undefined> {
  const [version] = await services.db
    .select()
    .from(manifestVersions)
    .where(and(eq(manifestVersions.runId, runId), eq(manifestVersions.status, 'approved')))
    .orderBy(desc(manifestVersions.version))
    .limit(1);
  return version;
}

export function toAttemptRecord(row: AttemptRow): AttemptRecord {
  return {
    attemptId: row.id,
    obligationId: row.obligationId,
    attemptNumber: row.attemptNumber,
    source: row.source as AttemptSource,
    phase: row.phase as AttemptPhase,
    outcome: row.outcome as AttemptOutcome,
  };
}

export interface RunState {
  run: RunRow;
  version: VersionRow;
  frozen: FrozenManifest;
  obligationRows: ObligationRow[];
  attemptRows: AttemptRow[];
  resolutions: ManualResolution[];
  reconciliation: ReconciliationResult;
}

/** Loads the approved manifest and every stored attempt and recomputes state without touching the chain. */
export async function loadRunState(services: Services, run: RunRow): Promise<RunState | null> {
  const version = await approvedVersion(services, run.id);
  if (!version) return null;
  const frozen = parseFrozen(version);
  const obligationRows = await services.db
    .select()
    .from(obligations)
    .where(eq(obligations.manifestVersionId, version.id))
    .orderBy(asc(obligations.lineId));
  const rowIds = obligationRows.map((row) => row.id);
  const attemptRows = rowIds.length
    ? await services.db
        .select()
        .from(paymentAttempts)
        .where(inArray(paymentAttempts.obligationRowId, rowIds))
        .orderBy(asc(paymentAttempts.attemptNumber))
    : [];
  const resolutionRows = rowIds.length
    ? await services.db.select().from(manualResolutions).where(inArray(manualResolutions.obligationRowId, rowIds))
    : [];
  const obligationIdByRow = new Map(obligationRows.map((row) => [row.id, row.obligationId]));
  const resolutions: ManualResolution[] = resolutionRows.map((row) => ({
    obligationId: obligationIdByRow.get(row.obligationRowId)!,
    reason: row.reason,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.createdAt.toISOString(),
  }));
  const reconciliation = reconcileRun({
    manifestDigest: frozen.digest,
    obligations: frozen.manifest.obligations,
    totals: frozen.manifest.totals,
    attempts: attemptRows.map(toAttemptRecord),
    manualResolutions: resolutions,
  });
  return { run, version, frozen, obligationRows, attemptRows, resolutions, reconciliation };
}
