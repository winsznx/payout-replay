import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../context.js';
import { idempotencyRecords } from '../db/schema.js';
import { ApiError } from './errors.js';

const KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/;

/**
 * Every mutating request carries an Idempotency-Key. A repeated key with the
 * same body replays the stored response; with a different body it is refused,
 * so a retried POST can never create a second attempt or plan.
 */
export const idempotency: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return next();
  const key = c.req.header('idempotency-key');
  if (!key) throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', 'mutating requests require an Idempotency-Key header');
  if (!KEY_PATTERN.test(key)) throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key must be 8-128 URL-safe characters');

  const principal = c.get('principal');
  const principalId = principal?.kind === 'user' ? principal.userId : principal?.kind === 'api_key' ? principal.keyId : `anon:${key}`;
  const route = `${c.req.method} ${c.req.path}`;
  const body = await c.req.raw.clone().text();
  const requestHash = createHash('sha256').update(`${route}\n${body}`).digest('hex');
  const { db } = c.get('services');

  const [existing] = await db
    .select()
    .from(idempotencyRecords)
    .where(and(eq(idempotencyRecords.principal, principalId), eq(idempotencyRecords.key, key)));
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new ApiError('IDEMPOTENCY_MISMATCH', 'Idempotency-Key was already used with a different request');
    }
    c.header('Idempotent-Replayed', 'true');
    return c.json(existing.response as Record<string, unknown>, existing.status as 200);
  }

  await next();

  const status = c.res.status;
  if (status >= 500) return;
  const contentType = c.res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return;
  const response = await c.res.clone().json();
  await db
    .insert(idempotencyRecords)
    .values({ key, principal: principalId, route, requestHash, status, response })
    .onConflictDoNothing();
};
