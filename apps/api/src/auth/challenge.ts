import { and, eq, gt, isNull } from 'drizzle-orm';

import type { Services } from '../context.js';
import { authChallenges } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId, randomToken } from '../lib/ids.js';
import { type CanonicalWallet, type WalletEnvironment, canonicalWallet, verifyWalletSignature } from './wallet-signature.js';

const CHALLENGE_TTL_MS = 5 * 60_000;

export type ChallengePurpose = 'sign_in' | 'bind_payout_wallet';

export interface IssuedChallenge {
  challengeId: string;
  message: string;
  expiresAt: string;
}

/**
 * The message binds domain, origin, network, purpose, organisation, address,
 * nonce and expiry so a signature cannot be replayed on another site, chain,
 * org or action.
 */
export function challengeMessage(input: {
  domain: string;
  origin: string;
  network: string;
  purpose: ChallengePurpose;
  orgId: string | null;
  wallet: CanonicalWallet;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}): string {
  const statement =
    input.purpose === 'sign_in'
      ? 'Sign in to Payout Replay. This signature does not move funds.'
      : 'Register this wallet as an organisation payout source in Payout Replay. This signature does not move funds or grant spending rights.';
  return [
    `${input.domain} wants you to sign with your ${input.wallet.environment === 'evm' ? 'EVM' : 'Portaldot native'} account:`,
    input.wallet.address,
    '',
    statement,
    '',
    `URI: ${input.origin}`,
    `Network: ${input.network}`,
    `Purpose: ${input.purpose}`,
    ...(input.orgId ? [`Organisation: ${input.orgId}`] : []),
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
    `Expiration Time: ${input.expiresAt.toISOString()}`,
  ].join('\n');
}

export async function issueChallenge(
  services: Services,
  input: { environment: WalletEnvironment; address: string; purpose: ChallengePurpose; orgId: string | null },
): Promise<IssuedChallenge> {
  const ss58 = services.chains.ss58Prefix();
  const wallet = canonicalWallet(input.environment, input.address, ss58);
  if (!wallet) throw new ApiError('VALIDATION_FAILED', `not a valid ${input.environment} address`);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
  const nonce = randomToken(16);
  const message = challengeMessage({
    domain: services.config.APP_DOMAIN,
    origin: services.config.WEB_ORIGIN,
    network: services.chains.networkLabel(input.environment),
    purpose: input.purpose,
    orgId: input.orgId,
    wallet,
    nonce,
    issuedAt,
    expiresAt,
  });
  const challengeId = newId('chl');
  await services.db.insert(authChallenges).values({
    id: challengeId,
    purpose: input.purpose,
    environment: wallet.environment,
    address: wallet.address,
    orgId: input.orgId,
    nonce,
    message,
    expiresAt,
  });
  return { challengeId, message, expiresAt: expiresAt.toISOString() };
}

/** Consumes a challenge exactly once and returns the wallet whose signature it carries. */
export async function consumeChallenge(
  services: Services,
  input: { challengeId: string; signature: string; purpose: ChallengePurpose; orgId: string | null },
): Promise<CanonicalWallet> {
  const [challenge] = await services.db
    .update(authChallenges)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(authChallenges.id, input.challengeId),
        isNull(authChallenges.consumedAt),
        gt(authChallenges.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!challenge) throw new ApiError('UNAUTHENTICATED', 'challenge is unknown, expired or already used');
  if (challenge.purpose !== input.purpose || challenge.orgId !== input.orgId) {
    throw new ApiError('UNAUTHENTICATED', 'challenge was issued for a different action');
  }
  const wallet = canonicalWallet(challenge.environment, challenge.address, services.chains.ss58Prefix());
  if (!wallet || !(await verifyWalletSignature(wallet, challenge.message, input.signature))) {
    throw new ApiError('UNAUTHENTICATED', 'signature does not match the challenge and address');
  }
  return wallet;
}
