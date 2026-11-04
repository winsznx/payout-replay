import { and, inArray, lt } from 'drizzle-orm';

import type { Services } from './context.js';
import { recoveryPlans } from './db/schema.js';
import { reconcileRunNow, runsNeedingReconciliation } from './services/reconciliation.js';
import { deliverDueWebhooks } from './services/webhooks.js';

export interface WorkerHandle {
  stop(): Promise<void>;
  lastSuccessAt(): Date | null;
}

/**
 * Background loop: reconcile runs with unresolved attempts, expire stale
 * plans and deliver webhooks. It only reads the chain; workers never sign or
 * broadcast, so a duplicated tick cannot move funds.
 */
export function startWorker(services: Services): WorkerHandle {
  let stopped = false;
  let lastSuccess: Date | null = null;
  let current: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    await services.db
      .update(recoveryPlans)
      .set({ status: 'expired' })
      .where(and(inArray(recoveryPlans.status, ['open', 'revalidated']), lt(recoveryPlans.expiresAt, new Date())));
    for (const run of await runsNeedingReconciliation(services)) {
      if (stopped) return;
      try {
        await reconcileRunNow(services, run);
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', job: 'reconcile_run', runId: run.id, message: (error as Error).message }));
      }
    }
    await deliverDueWebhooks(services);
    lastSuccess = new Date();
  };

  const schedule = (): void => {
    if (stopped) return;
    setTimeout(() => {
      current = tick()
        .catch((error: unknown) => console.error(JSON.stringify({ level: 'error', job: 'worker_tick', message: (error as Error).message })))
        .finally(schedule);
    }, services.config.WORKER_INTERVAL_MS);
  };
  schedule();

  return {
    async stop() {
      stopped = true;
      await current;
    },
    lastSuccessAt: () => lastSuccess,
  };
}

