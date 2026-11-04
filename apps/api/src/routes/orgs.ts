import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';

import { authorizeOrg, requireUser } from '../auth/access.js';
import { consumeChallenge, issueChallenge } from '../auth/challenge.js';
import { hashApiSecret, linkIdentity } from '../auth/session.js';
import { canonicalWallet } from '../auth/wallet-signature.js';
import type { AppEnv } from '../context.js';
import {
  apiKeys,
  auditEvents,
  memberships,
  organisations,
  payoutRuns,
  userIdentities,
  users,
  wallets,
  webhookEndpoints,
} from '../db/schema.js';
import { parseBody } from '../http.js';
import { recordAudit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import { newId, randomToken } from '../lib/ids.js';
import { createRun } from '../services/runs.js';
import { WEBHOOK_EVENTS } from '../services/webhooks.js';

const environment = z.enum(['native', 'evm']);
const role = z.enum(['owner', 'operator', 'reviewer', 'viewer']);

export const orgRoutes = new Hono<AppEnv>()
  .post('/orgs', async (c) => {
    const user = requireUser(c.get('principal'));
    const services = c.get('services');
    const body = await parseBody(
      c,
      z.object({
        name: z.string().trim().min(2).max(80),
        slug: z
          .string()
          .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, 'slug must be 3-40 lowercase letters, digits or hyphens'),
      }),
    );
    const id = newId('org');
    try {
      await services.db.transaction(async (tx) => {
        await tx.insert(organisations).values({ id, slug: body.slug, name: body.name, createdBy: user.userId });
        await tx.insert(memberships).values({ orgId: id, userId: user.userId, role: 'owner' });
        await recordAudit(tx, { orgId: id, principal: user, action: 'org.created', objectType: 'organisation', objectId: id, traceId: c.get('traceId'), detail: body });
      });
    } catch (error) {
      if (String((error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code) === '23505') {
        throw new ApiError('CONFLICT', 'that slug is taken');
      }
      throw error;
    }
    return c.json({ id, ...body, role: 'owner' }, 201);
  })
  .get('/orgs/:orgId', async (c) => {
    const services = c.get('services');
    const { role: myRole } = await authorizeOrg(services, c.get('principal'), c.req.param('orgId'), 'read');
    const [org] = await services.db.select().from(organisations).where(eq(organisations.id, c.req.param('orgId')));
    return c.json({ ...org, role: myRole });
  })
  .get('/orgs/:orgId/members', async (c) => {
    const services = c.get('services');
    const orgId = c.req.param('orgId');
    await authorizeOrg(services, c.get('principal'), orgId, 'read');
    const rows = await services.db
      .select({ userId: memberships.userId, role: memberships.role, since: memberships.createdAt })
      .from(memberships)
      .where(eq(memberships.orgId, orgId));
    const memberIds = rows.map((row) => row.userId);
    const identities = memberIds.length
      ? await services.db.select().from(userIdentities).where(inArray(userIdentities.userId, memberIds))
      : [];
    return c.json(
      rows.map((row) => ({
        ...row,
        wallets: identities.filter((identity) => identity.userId === row.userId).map((identity) => ({ environment: identity.environment, address: identity.address })),
      })),
    );
  })
  /** Invite by wallet address; the person proves control when they first sign in with it. */
  .post('/orgs/:orgId/members', async (c) => {
    const services = c.get('services');
    const orgId = c.req.param('orgId');
    const user = requireUser(c.get('principal'));
    await authorizeOrg(services, user, orgId, 'administer');
    const body = await parseBody(c, z.object({ environment, address: z.string(), role }));
    const wallet = canonicalWallet(body.environment, body.address, services.chains.ss58Prefix());
    if (!wallet) throw new ApiError('VALIDATION_FAILED', 'invalid address');
    let [identity] = await services.db
      .select()
      .from(userIdentities)
      .where(and(eq(userIdentities.environment, wallet.environment), eq(userIdentities.addressKey, wallet.addressKey)));
    if (!identity) {
      const userId = newId('usr');
      await services.db.insert(users).values({ id: userId });
      [identity] = await services.db
        .insert(userIdentities)
        .values({ id: newId('uid'), userId, environment: wallet.environment, address: wallet.address, addressKey: wallet.addressKey, verifiedAt: new Date(0) })
        .returning();
    }
    await services.db
      .insert(memberships)
      .values({ orgId, userId: identity!.userId, role: body.role })
      .onConflictDoUpdate({ target: [memberships.orgId, memberships.userId], set: { role: body.role } });
    await recordAudit(services.db, { orgId, principal: user, action: 'member.set_role', objectType: 'membership', objectId: identity!.userId, traceId: c.get('traceId'), detail: body });
    return c.json({ userId: identity!.userId, role: body.role }, 201);
  })
  .post('/orgs/:orgId/wallet-challenges', async (c) => {
    const services = c.get('services');
    const orgId = c.req.param('orgId');
    await authorizeOrg(services, requireUser(c.get('principal')), orgId, 'operate');
    const body = await parseBody(c, z.object({ environment, address: z.string().min(1).max(128) }));
    return c.json(await issueChallenge(services, { ...body, purpose: 'bind_payout_wallet', orgId }), 201);
  })
  /** Registers a payout source after verifying the wallet's own signature (ORG-02). */
  .post('/orgs/:orgId/wallets', async (c) => {
    const services = c.get('services');
    const orgId = c.req.param('orgId');
    const user = requireUser(c.get('principal'));
    await authorizeOrg(services, user, orgId, 'administer');
    const body = await parseBody(c, z.object({ challengeId: z.string(), signature: z.string().max(1024) }));
    const wallet = await consumeChallenge(services, { ...body, purpose: 'bind_payout_wallet', orgId });
    try {
      await linkIdentity(services, user.userId, wallet);
    } catch (error) {
      throw new ApiError('CONFLICT', (error as Error).message);
    }
    const id = newId('wal');
    await services.db.transaction(async (tx) => {
      await tx
        .update(wallets)
        .set({ isActive: false })
        .where(and(eq(wallets.orgId, orgId), eq(wallets.environment, wallet.environment), eq(wallets.isActive, true)));
      await tx.insert(wallets).values({
        id,
        orgId,
        environment: wallet.environment,
        address: wallet.address,
        chainIdentity: services.chains.networkLabel(wallet.environment),
        verifiedBy: user.userId,
        verifiedAt: new Date(),
      });
      await recordAudit(tx, { orgId, principal: user, action: 'wallet.registered', objectType: 'wallet', objectId: id, traceId: c.get('traceId'), detail: { ...wallet } });
    });
    return c.json({ id, environment: wallet.environment, address: wallet.address }, 201);
  })
  /** ORG-03: each payout source with chain identity, RPC health, balance and fee asset. */
  .get('/orgs/:orgId/wallets', async (c) => {
    const services = c.get('services');
    const orgId = c.req.param('orgId');
    await authorizeOrg(services, c.get('principal'), orgId, 'read');
    const rows = await services.db.select().from(wallets).where(and(eq(wallets.orgId, orgId), eq(wallets.isActive, true)));
    const health = await services.chains.health();
    const result = await Promise.all(
      rows.map(async (row) => {
        let balance: string | null = null;
        let balanceError: string | null = null;
        try {
          balance =
            row.environment === 'native'
              ? (await services.chains.native!.getFreeBalance(row.address)).toString()
              : (await services.chains.evm!.getGasBalance(row.address)).toString();
        } catch (error) {
          balanceError = (error as Error).message.split('\n')[0] ?? 'unavailable';
        }
        const env = health[row.environment];
        return {
          id: row.id,
          environment: row.environment,
          address: row.address,
          chainIdentity: row.chainIdentity,
          chainMatches: row.chainIdentity === services.chains.networkLabel(row.environment),
          verifiedAt: row.verifiedAt,
          feeAsset: env.feeAsset,
          feeBalanceBaseUnits: balance,
          feeBalanceDecimals: row.environment === 'native' ? (env.identity?.tokenDecimals as number | undefined) ?? null : 18,
          balanceError,
          rpcAvailable: env.rpcAvailable,
          capability: env.capability,
        };
      }),
    );
    return c.json(result);
  })
  .get('/orgs/:orgId/assets', async (c) => {
    const services = c.get('services');
    await authorizeOrg(services, c.get('principal'), c.req.param('orgId'), 'read');
    const health = await services.chains.health();
    return c.json({ assets: health.assets, native: health.native, evm: health.evm });
  })
  .get('/orgs/:orgId/runs', async (c) => {
    const services = c.get('services');
    const orgId = c.req.param('orgId');
    await authorizeOrg(services, c.get('principal'), orgId, 'read');
    const runs = await services.db.select().from(payoutRuns).where(eq(payoutRuns.orgId, orgId)).orderBy(desc(payoutRuns.updatedAt));
    return c.json(runs);
  })
  .post('/orgs/:orgId/runs', async (c) => {
    const services = c.get('services');
    const orgId = c.req.param('orgId');
    const principal = c.get('principal');
    await authorizeOrg(services, principal, orgId, 'operate');
    const body = await parseBody(c, z.object({ name: z.string().trim().min(2).max(120) }));
    return c.json(await createRun(services, principal!, orgId, body.name, c.get('traceId')), 201);
  })
  .get('/orgs/:orgId/audit', async (c) => {
    const services = c.get('services');
    const orgId = c.req.param('orgId');
    await authorizeOrg(services, c.get('principal'), orgId, 'read');
    const rows = await services.db.select().from(auditEvents).where(eq(auditEvents.orgId, orgId)).orderBy(desc(auditEvents.createdAt)).limit(200);
    return c.json(rows);
  })
  .get('/orgs/:orgId/api-keys', async (c) => {
    const services = c.get('services');
    const orgId = c.req.param('orgId');
    await authorizeOrg(services, requireUser(c.get('principal')), orgId, 'administer');
    const rows = await services.db
      .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, scopes: apiKeys.scopes, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(eq(apiKeys.orgId, orgId));
    return c.json(rows);
  })
  /** The secret is shown once and only its SHA-256 is stored. Keys can read and register attempts but never sign. */
  .post('/orgs/:orgId/api-keys', async (c) => {
    const services = c.get('services');
    const orgId = c.req.param('orgId');
    const user = requireUser(c.get('principal'));
    await authorizeOrg(services, user, orgId, 'administer');
    const body = await parseBody(c, z.object({ name: z.string().trim().min(2).max(60), scopes: z.array(z.enum(['runs:read', 'runs:write'])).min(1) }));
    const secret = `prk_${randomToken(24)}`;
    const id = newId('key');
    await services.db.insert(apiKeys).values({ id, orgId, name: body.name, prefix: secret.slice(0, 10), secretHash: hashApiSecret(secret), scopes: body.scopes, createdBy: user.userId });
    await recordAudit(services.db, { orgId, principal: user, action: 'api_key.created', objectType: 'api_key', objectId: id, traceId: c.get('traceId'), detail: { name: body.name, scopes: body.scopes } });
    return c.json({ id, secret, scopes: body.scopes }, 201);
  })
  .post('/orgs/:orgId/api-keys/:keyId/revoke', async (c) => {
    const services = c.get('services');
    const orgId = c.req.param('orgId');
    const user = requireUser(c.get('principal'));
    await authorizeOrg(services, user, orgId, 'administer');
    await services.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, c.req.param('keyId')), eq(apiKeys.orgId, orgId), isNull(apiKeys.revokedAt)));
    await recordAudit(services.db, { orgId, principal: user, action: 'api_key.revoked', objectType: 'api_key', objectId: c.req.param('keyId'), traceId: c.get('traceId') });
    return c.json({ ok: true });
  })
  .post('/orgs/:orgId/webhooks', async (c) => {
    const services = c.get('services');
    const orgId = c.req.param('orgId');
    const user = requireUser(c.get('principal'));
    await authorizeOrg(services, user, orgId, 'administer');
    const body = await parseBody(c, z.object({ url: z.string().url().startsWith('https://').or(z.string().url().startsWith('http://localhost')), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1) }));
    const id = newId('whk');
    const secret = `whsec_${randomToken(24)}`;
    await services.db.insert(webhookEndpoints).values({ id, orgId, url: body.url, secret, events: body.events });
    await recordAudit(services.db, { orgId, principal: user, action: 'webhook.created', objectType: 'webhook_endpoint', objectId: id, traceId: c.get('traceId'), detail: body });
    return c.json({ id, secret, ...body }, 201);
  });
