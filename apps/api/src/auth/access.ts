import { and, eq } from 'drizzle-orm';

import type { ApiScope, Principal, Role, Services } from '../context.js';
import { memberships, organisations, payoutRuns } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';

const RANK: Record<Role, number> = { viewer: 0, reviewer: 1, operator: 2, owner: 3 };

/** Roles allowed per capability. Reviewers approve; operators prepare and execute. */
export const CAN = {
  read: ['viewer', 'reviewer', 'operator', 'owner'],
  operate: ['operator', 'owner'],
  review: ['reviewer', 'owner'],
  administer: ['owner'],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAN;

const SCOPE_FOR: Record<Capability, ApiScope | null> = {
  read: 'runs:read',
  operate: 'runs:write',
  review: null,
  administer: null,
};

export function requirePrincipal(principal: Principal | undefined): Principal {
  if (!principal) throw new ApiError('UNAUTHENTICATED', 'sign in or provide an API key');
  return principal;
}

export function requireUser(principal: Principal | undefined): Extract<Principal, { kind: 'user' }> {
  const resolved = requirePrincipal(principal);
  if (resolved.kind !== 'user') throw new ApiError('FORBIDDEN', 'this action requires a signed-in wallet, not an API key');
  return resolved;
}

/**
 * Every org-scoped read and write goes through here. Unknown orgs and orgs the
 * caller is not a member of return the same 404 so org IDs cannot be probed.
 */
export async function authorizeOrg(
  services: Services,
  principal: Principal | undefined,
  orgId: string,
  capability: Capability,
): Promise<{ orgId: string; role: Role | null }> {
  const resolved = requirePrincipal(principal);
  if (resolved.kind === 'api_key') {
    const scope = SCOPE_FOR[capability];
    if (resolved.orgId !== orgId) throw new ApiError('NOT_FOUND', 'organisation not found');
    if (!scope || !resolved.scopes.includes(scope)) throw new ApiError('FORBIDDEN', `API key lacks permission to ${capability}`);
    return { orgId, role: null };
  }
  const [row] = await services.db
    .select({ role: memberships.role })
    .from(memberships)
    .innerJoin(organisations, eq(organisations.id, memberships.orgId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, resolved.userId)));
  if (!row) throw new ApiError('NOT_FOUND', 'organisation not found');
  if (!(CAN[capability] as readonly Role[]).includes(row.role)) {
    throw new ApiError('FORBIDDEN', `role ${row.role} cannot ${capability}`);
  }
  return { orgId, role: row.role };
}

export async function authorizeRun(
  services: Services,
  principal: Principal | undefined,
  runId: string,
  capability: Capability,
): Promise<{ run: typeof payoutRuns.$inferSelect; role: Role | null }> {
  requirePrincipal(principal);
  const [run] = await services.db.select().from(payoutRuns).where(eq(payoutRuns.id, runId));
  if (!run) throw new ApiError('NOT_FOUND', 'run not found');
  const { role } = await authorizeOrg(services, principal, run.orgId, capability);
  return { run, role };
}

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}
