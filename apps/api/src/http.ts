import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { z } from 'zod';

import { SESSION_COOKIE, principalFromApiKey, principalFromSession } from './auth/session.js';
import type { AppEnv } from './context.js';
import { ApiError } from './lib/errors.js';
import { newId } from './lib/ids.js';

export const traceMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const incoming = c.req.header('x-trace-id');
  const traceId = incoming && /^[A-Za-z0-9_\-]{8,64}$/.test(incoming) ? incoming : newId('trc');
  c.set('traceId', traceId);
  c.header('x-trace-id', traceId);
  await next();
};

/** Resolves a session cookie or `Authorization: Bearer prk_…` API key. Never fails the request by itself. */
export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const services = c.get('services');
  const authorization = c.req.header('authorization');
  if (authorization?.startsWith('Bearer ')) {
    const principal = await principalFromApiKey(services, authorization.slice(7).trim());
    if (!principal) throw new ApiError('UNAUTHENTICATED', 'API key is invalid or revoked');
    c.set('principal', principal);
    return next();
  }
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const principal = await principalFromSession(services, token);
    if (principal) c.set('principal', principal);
  }
  return next();
};

/**
 * Cookie-authenticated writes must come from the web app's origin. API-key
 * requests carry no ambient credentials, so they are exempt.
 */
export const csrfMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
  if (c.get('principal')?.kind === 'api_key') return next();
  const origin = c.req.header('origin');
  const allowed = c.get('services').config.WEB_ORIGIN;
  if (origin !== allowed) throw new ApiError('FORBIDDEN', 'cross-origin request refused');
  return next();
};

interface Bucket {
  tokens: number;
  updated: number;
}

/** Token bucket per client key. In-process; a multi-instance deployment would back this with Redis. */
export function rateLimit(options: { capacity: number; refillPerSecond: number; key: (c: Context<AppEnv>) => string }): MiddlewareHandler<AppEnv> {
  const buckets = new Map<string, Bucket>();
  return async (c, next) => {
    const key = options.key(c);
    const now = Date.now();
    const bucket = buckets.get(key) ?? { tokens: options.capacity, updated: now };
    bucket.tokens = Math.min(options.capacity, bucket.tokens + ((now - bucket.updated) / 1000) * options.refillPerSecond);
    bucket.updated = now;
    if (bucket.tokens < 1) {
      buckets.set(key, bucket);
      c.header('retry-after', String(Math.ceil((1 - bucket.tokens) / options.refillPerSecond)));
      throw new ApiError('RATE_LIMITED', 'too many requests', undefined, true);
    }
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    if (buckets.size > 10_000) {
      for (const [entry, value] of buckets) if (now - value.updated > 600_000) buckets.delete(entry);
    }
    return next();
  };
}

export function clientKey(c: Context<AppEnv>): string {
  const principal = c.get('principal');
  if (principal?.kind === 'user') return principal.userId;
  if (principal?.kind === 'api_key') return principal.keyId;
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? 'anonymous';
}

export async function parseBody<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'request body must be JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'request body is invalid',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return parsed.data;
}

export function idempotencyKey(c: Context<AppEnv>): string {
  const key = c.req.header('idempotency-key');
  if (!key) throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
  return key;
}
