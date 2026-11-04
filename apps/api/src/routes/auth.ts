import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';

import { requireUser } from '../auth/access.js';
import { consumeChallenge, issueChallenge } from '../auth/challenge.js';
import { SESSION_COOKIE, createSession, linkIdentity, revokeSession, upsertIdentity } from '../auth/session.js';
import type { AppEnv } from '../context.js';
import { memberships, organisations, userIdentities, users } from '../db/schema.js';
import { parseBody } from '../http.js';
import { recordAudit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';

const environment = z.enum(['native', 'evm']);

export const authRoutes = new Hono<AppEnv>()
  .post('/auth/challenge', async (c) => {
    const body = await parseBody(c, z.object({ environment, address: z.string().min(1).max(128) }));
    return c.json(await issueChallenge(c.get('services'), { ...body, purpose: 'sign_in', orgId: null }), 201);
  })
  /**
   * Signs in with a wallet. When a session already exists and `link` is set,
   * the proven wallet is attached to the current user instead, which is how
   * one operator holds both a native and an EVM identity.
   */
  .post('/auth/verify', async (c) => {
    const services = c.get('services');
    const body = await parseBody(c, z.object({ challengeId: z.string(), signature: z.string().max(1024), link: z.boolean().optional() }));
    const wallet = await consumeChallenge(services, { challengeId: body.challengeId, signature: body.signature, purpose: 'sign_in', orgId: null });
    const current = c.get('principal');
    if (body.link) {
      const user = requireUser(current);
      try {
        await linkIdentity(services, user.userId, wallet);
      } catch (error) {
        throw new ApiError('CONFLICT', (error as Error).message);
      }
      await recordAudit(services.db, {
        orgId: null,
        principal: user,
        action: 'identity.linked',
        objectType: 'user',
        objectId: user.userId,
        traceId: c.get('traceId'),
        detail: { environment: wallet.environment, address: wallet.address },
      });
      return c.json({ linked: wallet });
    }
    const { userId, identityId } = await upsertIdentity(services, wallet);
    const session = await createSession(services, userId, identityId);
    setCookie(c, SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: services.config.NODE_ENV === 'production',
      sameSite: 'Lax',
      path: '/',
      expires: session.expiresAt,
    });
    await recordAudit(services.db, {
      orgId: null,
      principal: undefined,
      action: 'session.created',
      objectType: 'user',
      objectId: userId,
      traceId: c.get('traceId'),
      detail: { environment: wallet.environment, address: wallet.address },
    });
    return c.json({ userId, wallet, expiresAt: session.expiresAt.toISOString() });
  })
  .post('/auth/logout', async (c) => {
    const principal = c.get('principal');
    if (principal?.kind === 'user') await revokeSession(c.get('services'), principal.sessionId);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  })
  .get('/me', async (c) => {
    const user = requireUser(c.get('principal'));
    const { db } = c.get('services');
    const [profile] = await db.select().from(users).where(eq(users.id, user.userId));
    const identities = await db
      .select({ id: userIdentities.id, environment: userIdentities.environment, address: userIdentities.address, verifiedAt: userIdentities.verifiedAt })
      .from(userIdentities)
      .where(eq(userIdentities.userId, user.userId));
    const orgs = await db
      .select({ id: organisations.id, slug: organisations.slug, name: organisations.name, role: memberships.role })
      .from(memberships)
      .innerJoin(organisations, eq(organisations.id, memberships.orgId))
      .where(eq(memberships.userId, user.userId));
    return c.json({ user: { id: user.userId, displayName: profile?.displayName ?? null }, session: user.identity, identities, organisations: orgs });
  });
