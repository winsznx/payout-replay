import { createHash } from 'node:crypto';

import { and, eq, gt, isNull } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';

import type { ApiScope, Principal, Services } from '../context.js';
import { apiKeys, sessions, userIdentities, users } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import type { CanonicalWallet } from './wallet-signature.js';

export const SESSION_COOKIE = 'pr_session';
export const SESSION_TTL_MS = 12 * 60 * 60_000;
const ISSUER = 'payout-replay';

function secretKey(services: Services): Uint8Array {
  return new TextEncoder().encode(services.config.SESSION_SECRET);
}

/** Finds the user that owns this wallet, creating both on first sign-in. */
export async function upsertIdentity(services: Services, wallet: CanonicalWallet): Promise<{ userId: string; identityId: string }> {
  const [existing] = await services.db
    .select()
    .from(userIdentities)
    .where(and(eq(userIdentities.environment, wallet.environment), eq(userIdentities.addressKey, wallet.addressKey)));
  if (existing) {
    await services.db.update(userIdentities).set({ verifiedAt: new Date(), address: wallet.address }).where(eq(userIdentities.id, existing.id));
    return { userId: existing.userId, identityId: existing.id };
  }
  const userId = newId('usr');
  const identityId = newId('uid');
  await services.db.transaction(async (tx) => {
    await tx.insert(users).values({ id: userId });
    await tx.insert(userIdentities).values({
      id: identityId,
      userId,
      environment: wallet.environment,
      address: wallet.address,
      addressKey: wallet.addressKey,
      verifiedAt: new Date(),
    });
  });
  return { userId, identityId };
}

/** Links an additional verified wallet to an existing user (e.g. their EVM payer). */
export async function linkIdentity(services: Services, userId: string, wallet: CanonicalWallet): Promise<string> {
  const [existing] = await services.db
    .select()
    .from(userIdentities)
    .where(and(eq(userIdentities.environment, wallet.environment), eq(userIdentities.addressKey, wallet.addressKey)));
  if (existing) {
    if (existing.userId !== userId) {
      throw new Error('wallet already belongs to another user');
    }
    await services.db.update(userIdentities).set({ verifiedAt: new Date() }).where(eq(userIdentities.id, existing.id));
    return existing.id;
  }
  const identityId = newId('uid');
  await services.db.insert(userIdentities).values({
    id: identityId,
    userId,
    environment: wallet.environment,
    address: wallet.address,
    addressKey: wallet.addressKey,
    verifiedAt: new Date(),
  });
  return identityId;
}

export async function createSession(services: Services, userId: string, identityId: string): Promise<{ token: string; expiresAt: Date }> {
  const sessionId = newId('ses');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await services.db.insert(sessions).values({ id: sessionId, userId, identityId, expiresAt });
  const token = await new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(services.config.WEB_ORIGIN)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(secretKey(services));
  return { token, expiresAt };
}

export async function principalFromSession(services: Services, token: string): Promise<Principal | null> {
  let sessionId: string;
  try {
    const { payload } = await jwtVerify(token, secretKey(services), { issuer: ISSUER, audience: services.config.WEB_ORIGIN });
    if (typeof payload.sid !== 'string') return null;
    sessionId = payload.sid;
  } catch {
    return null;
  }
  const [row] = await services.db
    .select({ session: sessions, identity: userIdentities })
    .from(sessions)
    .innerJoin(userIdentities, eq(userIdentities.id, sessions.identityId))
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
  if (!row) return null;
  return {
    kind: 'user',
    userId: row.session.userId,
    sessionId,
    identity: { id: row.identity.id, environment: row.identity.environment, address: row.identity.address },
  };
}

export async function revokeSession(services: Services, sessionId: string): Promise<void> {
  await services.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
}

export function hashApiSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export async function principalFromApiKey(services: Services, secret: string): Promise<Principal | null> {
  const [key] = await services.db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.secretHash, hashApiSecret(secret)), isNull(apiKeys.revokedAt)));
  if (!key) return null;
  await services.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id));
  return { kind: 'api_key', keyId: key.id, orgId: key.orgId, scopes: key.scopes as ApiScope[] };
}
