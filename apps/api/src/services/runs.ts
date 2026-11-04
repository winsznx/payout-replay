import type { AssetDescriptor, Environment, ManifestField, PayerWallets, ValidationReport } from '@payout-replay/core';
import { freezeManifest, validateManifestCsv } from '@payout-replay/core';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';

import type { Principal, Services } from '../context.js';
import {
  approvals,
  manifestVersions,
  obligations,
  paymentAttempts,
  payoutRuns,
  recoveryPlans,
  runImports,
  wallets,
} from '../db/schema.js';
import { recordAudit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { type RunRow, latestVersion, parseFrozen } from './state.js';

export async function activePayers(services: Services, orgId: string): Promise<PayerWallets> {
  const rows = await services.db
    .select()
    .from(wallets)
    .where(and(eq(wallets.orgId, orgId), eq(wallets.isActive, true)));
  const payers: PayerWallets = {};
  for (const row of rows) payers[row.environment] = row.address;
  return payers;
}

export async function verifiedAssets(services: Services): Promise<AssetDescriptor[]> {
  const health = await services.chains.health();
  return health.assets;
}

export async function createRun(services: Services, principal: Principal, orgId: string, name: string, traceId: string): Promise<RunRow> {
  const userId = principal.kind === 'user' ? principal.userId : null;
  if (!userId) throw new ApiError('FORBIDDEN', 'runs are created by signed-in operators');
  const [run] = await services.db
    .insert(payoutRuns)
    .values({ id: newId('pr'), orgId, name, status: 'draft', createdBy: userId })
    .returning();
  await recordAudit(services.db, { orgId, principal, action: 'run.created', objectType: 'payout_run', objectId: run!.id, traceId, detail: { name } });
  return run!;
}

const EDITABLE_STATUSES = new Set(['draft', 'validated', 'awaiting_approval', 'approved']);

/** Validates an upload and stores it with its checksum. Nothing is frozen here. */
export async function importCsv(
  services: Services,
  principal: Principal,
  run: RunRow,
  input: { csv: string; fileName?: string; columnMapping?: Partial<Record<ManifestField, string>> },
  traceId: string,
): Promise<{ importId: string; report: ValidationReport }> {
  if (principal.kind !== 'user') throw new ApiError('FORBIDDEN', 'imports are performed by signed-in operators');
  if (!EDITABLE_STATUSES.has(run.status)) {
    throw new ApiError('CONFLICT', `run is ${run.status}; payments have started, so start a new run for different lines`);
  }
  const report = validateManifestCsv(input.csv, {
    assets: await verifiedAssets(services),
    payers: await activePayers(services, run.orgId),
    ss58Prefix: services.chains.ss58Prefix(),
    ...(input.columnMapping ? { columnMapping: input.columnMapping } : {}),
  });
  const importId = newId('imp');
  await services.db.insert(runImports).values({
    id: importId,
    runId: run.id,
    fileName: input.fileName ?? null,
    fileSha256: report.fileSha256,
    csvText: input.csv,
    columnMapping: input.columnMapping ?? {},
    report,
    createdBy: principal.userId,
  });
  if (run.status === 'draft' || run.status === 'validated') {
    await services.db
      .update(payoutRuns)
      .set({ status: report.ok ? 'validated' : 'draft', updatedAt: new Date(), revision: run.revision + 1 })
      .where(eq(payoutRuns.id, run.id));
  }
  await recordAudit(services.db, {
    orgId: run.orgId,
    principal,
    action: 'run.imported',
    objectType: 'payout_run',
    objectId: run.id,
    afterDigest: `sha256:${report.fileSha256}`,
    traceId,
    detail: { importId, ok: report.ok, lines: report.lines.length, issues: report.issues.length },
  });
  return { importId, report };
}

export async function latestImport(services: Services, runId: string): Promise<typeof runImports.$inferSelect | undefined> {
  const [row] = await services.db.select().from(runImports).where(eq(runImports.runId, runId)).orderBy(desc(runImports.createdAt)).limit(1);
  return row;
}

/**
 * Freezes the latest valid import into a new immutable manifest version. A
 * version whose payments have already been broadcast can never be replaced,
 * because new obligation IDs would let the same line be paid twice.
 */
export async function freezeRun(
  services: Services,
  principal: Principal,
  run: RunRow,
  input: { acknowledgeDuplicates: boolean; expectedRevision?: number },
  traceId: string,
): Promise<typeof manifestVersions.$inferSelect> {
  if (principal.kind !== 'user') throw new ApiError('FORBIDDEN', 'freezing requires a signed-in operator');
  const upload = await latestImport(services, run.id);
  if (!upload) throw new ApiError('UNPROCESSABLE', 'import a CSV before freezing');
  const report = upload.report as ValidationReport;
  if (!report.ok) throw new ApiError('UNPROCESSABLE', 'the latest import has blocking validation errors', { issues: report.issues });
  if (report.requiresAcknowledgement && !input.acknowledgeDuplicates) {
    throw new ApiError('UNPROCESSABLE', 'duplicate-looking lines must be acknowledged before freezing', { duplicates: report.duplicates });
  }

  const used = new Set<Environment>(report.lines.map((line) => line.environment));
  let network;
  try {
    network = await services.chains.networkIdentity(used);
  } catch (error) {
    throw new ApiError('CHAIN_UNAVAILABLE', `cannot bind the manifest to a verified network: ${(error as Error).message}`, undefined, true);
  }
  const assets = await verifiedAssets(services);
  const payers = await activePayers(services, run.orgId);

  return services.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(payoutRuns).where(eq(payoutRuns.id, run.id)).for('update');
    if (!locked) throw new ApiError('NOT_FOUND', 'run not found');
    if (input.expectedRevision !== undefined && locked.revision !== input.expectedRevision) {
      throw new ApiError('VERSION_CONFLICT', 'the run changed since you loaded it; reload and review again');
    }
    if (!EDITABLE_STATUSES.has(locked.status)) throw new ApiError('CONFLICT', `run is ${locked.status} and can no longer be re-frozen`);

    const previous = await tx
      .select({ id: manifestVersions.id })
      .from(manifestVersions)
      .where(and(eq(manifestVersions.runId, run.id), ne(manifestVersions.status, 'superseded')));
    if (previous.length > 0) {
      const attempts = await tx
        .select({ id: paymentAttempts.id })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.runId, run.id))
        .limit(1);
      if (attempts.length > 0) {
        throw new ApiError('CONFLICT', 'payments were already attempted for this run; changes require a new run');
      }
      for (const old of previous) {
        await tx.update(manifestVersions).set({ status: 'superseded' }).where(eq(manifestVersions.id, old.id));
      }
      await tx
        .update(recoveryPlans)
        .set({ status: 'invalidated' })
        .where(and(eq(recoveryPlans.runId, run.id), inArray(recoveryPlans.status, ['open', 'revalidated'])));
    }

    const version = locked.currentVersion + 1;
    const frozen = freezeManifest({ runId: run.id, version, network, payers, assets, lines: report.lines });
    const [row] = await tx
      .insert(manifestVersions)
      .values({
        id: newId('mv'),
        runId: run.id,
        version,
        importId: upload.id,
        canonicalJson: frozen.canonicalJson,
        digest: frozen.digest,
        status: 'awaiting_approval',
        duplicatesAcknowledged: input.acknowledgeDuplicates,
        frozenBy: principal.userId,
        frozenAt: new Date(),
      })
      .returning();
    await tx.insert(obligations).values(
      frozen.manifest.obligations.map((obligation) => ({
        id: newId('obl'),
        manifestVersionId: row!.id,
        runId: run.id,
        obligationId: obligation.obligationId,
        lineId: obligation.lineId,
        reference: obligation.reference,
        environment: obligation.environment,
        assetId: obligation.assetId,
        payer: obligation.payer,
        destination: obligation.destination,
        amountBaseUnits: obligation.amountBaseUnits,
        status: 'approved_unattempted',
        explanation: 'Frozen and waiting for approval.',
      })),
    );
    await tx
      .update(payoutRuns)
      .set({ status: 'awaiting_approval', currentVersion: version, updatedAt: new Date(), revision: locked.revision + 1 })
      .where(eq(payoutRuns.id, run.id));
    await recordAudit(tx, {
      orgId: run.orgId,
      principal,
      action: 'manifest.frozen',
      objectType: 'manifest_version',
      objectId: row!.id,
      afterDigest: frozen.digest,
      traceId,
      detail: { version, lines: frozen.manifest.obligations.length, sourceFile: upload.fileSha256 },
    });
    return row!;
  });
}

/** Off-chain approval of one exact version and digest. Approval never sends funds. */
export async function decideApproval(
  services: Services,
  principal: Principal,
  run: RunRow,
  input: { version: number; digest: string; decision: 'approve' | 'reject'; reason?: string },
  traceId: string,
): Promise<{ status: string }> {
  if (principal.kind !== 'user') throw new ApiError('FORBIDDEN', 'approvals require a signed-in reviewer');
  if (input.decision === 'reject' && !input.reason?.trim()) throw new ApiError('VALIDATION_FAILED', 'a rejection needs a reason');
  return services.db.transaction(async (tx) => {
    const [version] = await tx
      .select()
      .from(manifestVersions)
      .where(and(eq(manifestVersions.runId, run.id), eq(manifestVersions.version, input.version)))
      .for('update');
    if (!version) throw new ApiError('NOT_FOUND', `version ${input.version} not found`);
    if (version.digest !== input.digest) {
      throw new ApiError('VERSION_CONFLICT', 'the digest you reviewed does not match this version');
    }
    if (version.status !== 'awaiting_approval') throw new ApiError('CONFLICT', `version is ${version.status}`);
    parseFrozen(version);

    const approved = input.decision === 'approve';
    await tx
      .update(manifestVersions)
      .set({ status: approved ? 'approved' : 'rejected', ...(approved ? { approvedAt: new Date() } : {}) })
      .where(eq(manifestVersions.id, version.id));
    await tx.insert(approvals).values({
      id: newId('apr'),
      manifestVersionId: version.id,
      reviewerId: principal.userId,
      decision: input.decision,
      method: 'off-chain-app',
      digest: version.digest,
      reason: input.reason ?? null,
    });
    const status = approved ? 'approved' : 'draft';
    await tx.update(payoutRuns).set({ status, updatedAt: new Date(), revision: run.revision + 1 }).where(eq(payoutRuns.id, run.id));
    await recordAudit(tx, {
      orgId: run.orgId,
      principal,
      action: approved ? 'manifest.approved' : 'manifest.rejected',
      objectType: 'manifest_version',
      objectId: version.id,
      afterDigest: version.digest,
      traceId,
      detail: { version: version.version, reason: input.reason ?? null },
    });
    return { status };
  });
}

export async function versionHistory(services: Services, runId: string): Promise<unknown[]> {
  const versions = await services.db.select().from(manifestVersions).where(eq(manifestVersions.runId, runId)).orderBy(desc(manifestVersions.version));
  const decisions = versions.length
    ? await services.db.select().from(approvals).where(inArray(approvals.manifestVersionId, versions.map((version) => version.id)))
    : [];
  return versions.map((version) => ({
    id: version.id,
    version: version.version,
    digest: version.digest,
    status: version.status,
    frozenBy: version.frozenBy,
    frozenAt: version.frozenAt,
    approvedAt: version.approvedAt,
    duplicatesAcknowledged: version.duplicatesAcknowledged,
    decisions: decisions
      .filter((decision) => decision.manifestVersionId === version.id)
      .map((decision) => ({
        reviewerId: decision.reviewerId,
        decision: decision.decision,
        method: decision.method,
        reason: decision.reason,
        at: decision.createdAt,
      })),
  }));
}

export { latestVersion };
