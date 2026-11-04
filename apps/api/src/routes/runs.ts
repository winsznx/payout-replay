import type { ManifestField, RecoveryPlan, ValidationReport } from '@payout-replay/core';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';

import { authorizeRun, requireUser } from '../auth/access.js';
import type { AppEnv } from '../context.js';
import { obligations, paymentAttempts, recoveryPlans } from '../db/schema.js';
import { idempotencyKey, parseBody } from '../http.js';
import { ApiError } from '../lib/errors.js';
import {
  createPlan,
  importTransaction,
  prepareAttempt,
  recordAttemptResult,
  resolveManually,
  revalidatePlan,
} from '../services/execution.js';
import { evidencePackage, exceptionsCsv, reconciliationCsv } from '../services/exports.js';
import { openExceptions, reconcileRunNow } from '../services/reconciliation.js';
import { decideApproval, freezeRun, importCsv, latestImport, latestVersion, versionHistory } from '../services/runs.js';
import { loadRunState, parseFrozen } from '../services/state.js';
import { lineViews, runSummary } from '../services/summary.js';

const environment = z.enum(['native', 'evm']);
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const MAX_CSV_CHARS = 5 * 1024 * 1024;

function csvResponse(body: string, fileName: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${fileName}"`,
      'cache-control': 'no-store',
    },
  });
}

export const runRoutes = new Hono<AppEnv>()
  .get('/runs/:runId', async (c) => {
    const services = c.get('services');
    const { run, role } = await authorizeRun(services, c.get('principal'), c.req.param('runId'), 'read');
    const [state, version, upload, plan] = await Promise.all([
      loadRunState(services, run),
      latestVersion(services, run.id),
      latestImport(services, run.id),
      services.db.select().from(recoveryPlans).where(eq(recoveryPlans.runId, run.id)).orderBy(desc(recoveryPlans.createdAt)).limit(1),
    ]);
    const latest = version ? parseFrozen(version) : null;
    return c.json({
      run,
      role,
      summary: state ? runSummary(state) : null,
      latestVersion: version
        ? {
            id: version.id,
            version: version.version,
            digest: version.digest,
            status: version.status,
            frozenAt: version.frozenAt,
            approvedAt: version.approvedAt,
            manifest: latest?.manifest ?? null,
          }
        : null,
      latestImport: upload
        ? { id: upload.id, fileName: upload.fileName, fileSha256: upload.fileSha256, createdAt: upload.createdAt, report: upload.report as ValidationReport }
        : null,
      latestPlan: plan[0] ? { id: plan[0].id, kind: plan[0].kind, status: plan[0].status, plan: plan[0].plan as RecoveryPlan } : null,
      versions: await versionHistory(services, run.id),
    });
  })
  .get('/runs/:runId/lines', async (c) => {
    const services = c.get('services');
    const { run } = await authorizeRun(services, c.get('principal'), c.req.param('runId'), 'read');
    const state = await loadRunState(services, run);
    if (!state) return c.json({ items: [], total: 0 });
    const lines = lineViews(services, state);
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
    const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
    return c.json({ items: lines.slice(offset, offset + limit), total: lines.length, limit, offset });
  })
  .post('/runs/:runId/import', async (c) => {
    const services = c.get('services');
    const principal = c.get('principal');
    const { run } = await authorizeRun(services, principal, c.req.param('runId'), 'operate');
    const body = await parseBody(
      c,
      z.object({
        csv: z.string().min(1).max(MAX_CSV_CHARS),
        fileName: z.string().max(255).optional(),
        columnMapping: z.record(z.string(), z.string()).optional(),
      }),
    );
    const result = await importCsv(
      services,
      principal!,
      run,
      {
        csv: body.csv,
        ...(body.fileName ? { fileName: body.fileName } : {}),
        ...(body.columnMapping ? { columnMapping: body.columnMapping as Partial<Record<ManifestField, string>> } : {}),
      },
      c.get('traceId'),
    );
    return c.json(result, 201);
  })
  .post('/runs/:runId/validate', async (c) => {
    const services = c.get('services');
    const principal = c.get('principal');
    const { run } = await authorizeRun(services, principal, c.req.param('runId'), 'operate');
    const upload = await latestImport(services, run.id);
    if (!upload) throw new ApiError('UNPROCESSABLE', 'nothing imported yet');
    const result = await importCsv(
      services,
      principal!,
      run,
      { csv: upload.csvText, ...(upload.fileName ? { fileName: upload.fileName } : {}), columnMapping: upload.columnMapping as Partial<Record<ManifestField, string>> },
      c.get('traceId'),
    );
    return c.json(result, 201);
  })
  .post('/runs/:runId/freeze', async (c) => {
    const services = c.get('services');
    const principal = c.get('principal');
    const { run } = await authorizeRun(services, principal, c.req.param('runId'), 'operate');
    const body = await parseBody(c, z.object({ acknowledgeDuplicates: z.boolean().default(false), expectedRevision: z.number().int().optional() }));
    const version = await freezeRun(
      services,
      principal!,
      run,
      { acknowledgeDuplicates: body.acknowledgeDuplicates, ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision }) },
      c.get('traceId'),
    );
    return c.json({ id: version.id, version: version.version, digest: version.digest, status: version.status }, 201);
  })
  .post('/runs/:runId/approvals', async (c) => {
    const services = c.get('services');
    const principal = c.get('principal');
    const { run } = await authorizeRun(services, principal, c.req.param('runId'), 'review');
    const body = await parseBody(
      c,
      z.object({ version: z.number().int().positive(), digest: z.string(), decision: z.enum(['approve', 'reject']), reason: z.string().max(500).optional() }),
    );
    return c.json(
      await decideApproval(
        services,
        principal!,
        run,
        { version: body.version, digest: body.digest, decision: body.decision, ...(body.reason ? { reason: body.reason } : {}) },
        c.get('traceId'),
      ),
    );
  })
  .post('/runs/:runId/execute/plan', async (c) => {
    const services = c.get('services');
    const user = requireUser(c.get('principal'));
    const { run } = await authorizeRun(services, user, c.req.param('runId'), 'operate');
    const body = await parseBody(c, z.object({ environment: environment.optional() }));
    return c.json(await createPlan(services, user, run, { kind: 'execution', ...(body.environment ? { environment: body.environment } : {}) }, c.get('traceId')), 201);
  })
  .post('/runs/:runId/recovery-plans', async (c) => {
    const services = c.get('services');
    const user = requireUser(c.get('principal'));
    const { run } = await authorizeRun(services, user, c.req.param('runId'), 'operate');
    const body = await parseBody(c, z.object({ environment: environment.optional() }));
    return c.json(await createPlan(services, user, run, { kind: 'recovery', ...(body.environment ? { environment: body.environment } : {}) }, c.get('traceId')), 201);
  })
  .post('/recovery-plans/:planId/revalidate', async (c) => {
    const services = c.get('services');
    const user = requireUser(c.get('principal'));
    const [plan] = await services.db.select().from(recoveryPlans).where(eq(recoveryPlans.id, c.req.param('planId')));
    if (!plan) throw new ApiError('NOT_FOUND', 'plan not found');
    await authorizeRun(services, user, plan.runId, 'operate');
    const body = await parseBody(c, z.object({ environment, obligationIds: z.array(hex32).optional() }));
    return c.json(
      await revalidatePlan(services, user, plan.id, { environment: body.environment, ...(body.obligationIds ? { obligationIds: body.obligationIds } : {}) }, c.get('traceId')),
    );
  })
  .post('/runs/:runId/attempts', async (c) => {
    const services = c.get('services');
    const user = requireUser(c.get('principal'));
    await authorizeRun(services, user, c.req.param('runId'), 'operate');
    const body = await parseBody(c, z.object({ planId: z.string(), obligationId: hex32, nonce: z.number().int().nonnegative().optional() }));
    const attempt = await prepareAttempt(
      services,
      user,
      { planId: body.planId, obligationId: body.obligationId, idempotencyKey: idempotencyKey(c), ...(body.nonce === undefined ? {} : { nonce: body.nonce }) },
      c.get('traceId'),
    );
    return c.json(attempt, 201);
  })
  .post('/attempts/:attemptId/result', async (c) => {
    const services = c.get('services');
    const user = requireUser(c.get('principal'));
    const [attempt] = await services.db.select().from(paymentAttempts).where(eq(paymentAttempts.id, c.req.param('attemptId')));
    if (!attempt) throw new ApiError('NOT_FOUND', 'attempt not found');
    const { run } = await authorizeRun(services, user, attempt.runId, 'operate');
    const body = await parseBody(
      c,
      z.object({
        phase: z.enum(['signature_rejected', 'submitted', 'submission_unknown']),
        txHash: hex32.optional(),
        nonce: z.number().int().nonnegative().optional(),
        blockHash: hex32.optional(),
        mortality: z.object({ birthBlock: z.number().int().nonnegative(), period: z.number().int().positive().max(65_536) }).optional(),
      }),
    );
    const updated = await recordAttemptResult(services, user, attempt.id, body, c.get('traceId'));
    void reconcileRunNow(services, run, { force: true }).catch(() => undefined);
    return c.json(updated);
  })
  .post('/runs/:runId/external-transactions', async (c) => {
    const services = c.get('services');
    const principal = c.get('principal');
    const { run } = await authorizeRun(services, principal, c.req.param('runId'), 'operate');
    const body = await parseBody(c, z.object({ obligationId: hex32, txHash: hex32, blockHash: hex32.optional() }));
    return c.json(
      await importTransaction(
        services,
        principal!,
        run,
        { obligationId: body.obligationId, txHash: body.txHash, ...(body.blockHash ? { blockHash: body.blockHash } : {}), idempotencyKey: idempotencyKey(c) },
        c.get('traceId'),
      ),
      201,
    );
  })
  .post('/runs/:runId/resolutions', async (c) => {
    const services = c.get('services');
    const user = requireUser(c.get('principal'));
    const { run } = await authorizeRun(services, user, c.req.param('runId'), 'administer');
    const body = await parseBody(c, z.object({ obligationId: hex32, reason: z.string().trim().min(10).max(500), proofReference: z.string().max(500).optional() }));
    await resolveManually(
      services,
      user,
      run,
      { obligationId: body.obligationId, reason: body.reason, ...(body.proofReference ? { proofReference: body.proofReference } : {}) },
      c.get('traceId'),
    );
    return c.json({ ok: true }, 201);
  })
  .post('/runs/:runId/reconcile', async (c) => {
    const services = c.get('services');
    const { run } = await authorizeRun(services, c.get('principal'), c.req.param('runId'), 'read');
    const state = await reconcileRunNow(services, run);
    if (!state) throw new ApiError('UNPROCESSABLE', 'the run has no approved manifest');
    return c.json(runSummary(state));
  })
  .get('/runs/:runId/evidence', async (c) => {
    const services = c.get('services');
    const { run } = await authorizeRun(services, c.get('principal'), c.req.param('runId'), 'read');
    const state = await loadRunState(services, run);
    if (!state) throw new ApiError('UNPROCESSABLE', 'the run has no approved manifest');
    return c.json({ summary: runSummary(state), lines: lineViews(services, state), exceptions: await openExceptions(services, run.id) });
  })
  .get('/runs/:runId/export.csv', async (c) => {
    const services = c.get('services');
    const { run } = await authorizeRun(services, c.get('principal'), c.req.param('runId'), 'read');
    const state = await loadRunState(services, run);
    if (!state) throw new ApiError('UNPROCESSABLE', 'the run has no approved manifest');
    return csvResponse(reconciliationCsv(state), `${run.id}-v${state.version.version}-reconciliation.csv`);
  })
  .get('/runs/:runId/exceptions.csv', async (c) => {
    const services = c.get('services');
    const { run } = await authorizeRun(services, c.get('principal'), c.req.param('runId'), 'read');
    const state = await loadRunState(services, run);
    if (!state) throw new ApiError('UNPROCESSABLE', 'the run has no approved manifest');
    return csvResponse(exceptionsCsv(state), `${run.id}-v${state.version.version}-exceptions.csv`);
  })
  .get('/runs/:runId/evidence.json', async (c) => {
    const services = c.get('services');
    const { run } = await authorizeRun(services, c.get('principal'), c.req.param('runId'), 'read');
    const state = await loadRunState(services, run);
    if (!state) throw new ApiError('UNPROCESSABLE', 'the run has no approved manifest');
    c.header('content-disposition', `attachment; filename="${run.id}-v${state.version.version}-evidence.json"`);
    return c.json(await evidencePackage(services, state));
  })
  .get('/runs/:runId/obligations/:obligationId', async (c) => {
    const services = c.get('services');
    const { run } = await authorizeRun(services, c.get('principal'), c.req.param('runId'), 'read');
    const [row] = await services.db
      .select()
      .from(obligations)
      .where(and(eq(obligations.runId, run.id), eq(obligations.obligationId, c.req.param('obligationId'))))
      .orderBy(desc(obligations.updatedAt))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', 'obligation not found');
    return c.json(row);
  });
