import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

import type { AppEnv, Services } from './context.js';
import { authMiddleware, clientKey, csrfMiddleware, rateLimit, traceMiddleware } from './http.js';
import { ApiError, errorBody } from './lib/errors.js';
import { idempotency } from './lib/idempotency.js';
import { authRoutes } from './routes/auth.js';
import { orgRoutes } from './routes/orgs.js';
import { runRoutes } from './routes/runs.js';

export function createApp(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', traceMiddleware);
  app.use('*', secureHeaders({ contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }));
  app.use(
    '*',
    cors({
      origin: services.config.WEB_ORIGIN,
      credentials: true,
      allowHeaders: ['content-type', 'idempotency-key', 'authorization', 'x-trace-id'],
      exposeHeaders: ['x-trace-id', 'idempotent-replayed'],
    }),
  );
  app.use('*', bodyLimit({ maxSize: 6 * 1024 * 1024, onError: () => { throw new ApiError('VALIDATION_FAILED', 'request body too large'); } }));
  app.use('*', async (c, next) => {
    c.set('services', services);
    await next();
  });

  app.onError((error, c) => {
    const traceId = c.get('traceId') ?? 'unknown';
    if (error instanceof ApiError) return c.json(errorBody(error, traceId), error.status);
    console.error(JSON.stringify({ level: 'error', traceId, path: c.req.path, message: error.message, stack: error.stack }));
    return c.json(errorBody(new ApiError('INTERNAL', 'unexpected error'), traceId), 500);
  });
  app.notFound((c) => c.json(errorBody(new ApiError('NOT_FOUND', 'route not found'), c.get('traceId') ?? 'unknown'), 404));

  app.get('/health', (c) => c.json({ ok: true }));
  /** Public, read-only network capability summary (no organisation data). */
  app.get(
    '/health/chain',
    rateLimit({ capacity: 30, refillPerSecond: 0.5, key: clientKey }),
    async (c) => {
      const health = await services.chains.health();
      return c.json(health);
    },
  );

  const v1 = new Hono<AppEnv>();
  v1.use('*', authMiddleware);
  v1.use('*', csrfMiddleware);
  v1.use('/auth/*', rateLimit({ capacity: 20, refillPerSecond: 0.2, key: clientKey }));
  v1.use('*', rateLimit({ capacity: 240, refillPerSecond: 4, key: clientKey }));
  v1.use('*', idempotency);
  v1.route('/', authRoutes);
  v1.route('/', orgRoutes);
  v1.route('/', runRoutes);
  app.route('/api/v1', v1);

  return app;
}
