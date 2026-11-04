import { createHmac } from 'node:crypto';

import { and, eq, isNull, lte } from 'drizzle-orm';

import type { Services } from '../context.js';
import { webhookDeliveries, webhookEndpoints } from '../db/schema.js';
import { newId } from '../lib/ids.js';

export const WEBHOOK_EVENTS = [
  'payout_run.updated',
  'obligation.paid_verified',
  'obligation.needs_review',
  'recovery_plan.ready',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const MAX_ATTEMPTS = 8;

/** Fan an event out to every subscribed endpoint. `eventId` is deterministic so re-enqueueing is a no-op. */
export async function enqueueWebhook(
  services: Services,
  orgId: string,
  type: WebhookEvent,
  eventId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const endpoints = await services.db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.orgId, orgId), eq(webhookEndpoints.isActive, true)));
  const subscribed = endpoints.filter((endpoint) => (endpoint.events as string[]).includes(type));
  if (subscribed.length === 0) return;
  await services.db
    .insert(webhookDeliveries)
    .values(
      subscribed.map((endpoint) => ({
        id: newId('dlv'),
        endpointId: endpoint.id,
        eventId,
        eventType: type,
        payload: { id: eventId, type, createdAt: new Date().toISOString(), data },
        nextAttemptAt: new Date(),
      })),
    )
    .onConflictDoNothing();
}

/**
 * Signature header: `t=<unix seconds>,v1=<hex hmac-sha256(secret, "<t>.<body>")>`.
 * Receivers reject stale timestamps and repeated event IDs to prevent replay.
 */
export function signWebhook(secret: string, body: string, timestamp: number): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

export async function deliverDueWebhooks(services: Services, fetcher: typeof fetch = fetch): Promise<number> {
  const due = await services.db
    .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(and(isNull(webhookDeliveries.deliveredAt), lte(webhookDeliveries.nextAttemptAt, new Date())))
    .limit(25);
  for (const { delivery, endpoint } of due) {
    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    let status: number | null = null;
    let error: string | null = null;
    try {
      const response = await fetcher(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-payout-replay-event': delivery.eventType,
          'x-payout-replay-event-id': delivery.eventId,
          'x-payout-replay-signature': signWebhook(endpoint.secret, body, timestamp),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
    } catch (caught) {
      error = (caught as Error).message;
    }
    const attemptCount = delivery.attemptCount + 1;
    const delivered = status !== null && status >= 200 && status < 300;
    const giveUp = !delivered && attemptCount >= MAX_ATTEMPTS;
    await services.db
      .update(webhookDeliveries)
      .set({
        attemptCount,
        lastStatus: status,
        lastError: error,
        deliveredAt: delivered ? new Date() : null,
        nextAttemptAt: delivered || giveUp ? null : new Date(Date.now() + 2 ** attemptCount * 1_000),
      })
      .where(eq(webhookDeliveries.id, delivery.id));
  }
  return due.length;
}
