import type { Principal } from '../context.js';
import type { Database } from '../db/client.js';
import { auditEvents } from '../db/schema.js';
import { newId } from './ids.js';

type Executor = Pick<Database, 'insert'>;

export interface AuditInput {
  orgId: string | null;
  principal: Principal | undefined;
  action: string;
  objectType: string;
  objectId: string;
  beforeDigest?: string | null;
  afterDigest?: string | null;
  detail?: Record<string, unknown>;
  traceId: string;
}

export async function recordAudit(db: Executor, input: AuditInput): Promise<void> {
  const actor =
    input.principal?.kind === 'user'
      ? { actorId: input.principal.userId, actorKind: 'user' }
      : input.principal?.kind === 'api_key'
        ? { actorId: input.principal.keyId, actorKind: 'api_key' }
        : { actorId: null, actorKind: 'system' };
  await db.insert(auditEvents).values({
    id: newId('aud'),
    orgId: input.orgId,
    ...actor,
    action: input.action,
    objectType: input.objectType,
    objectId: input.objectId,
    beforeDigest: input.beforeDigest ?? null,
    afterDigest: input.afterDigest ?? null,
    detail: input.detail ?? {},
    correlationId: input.traceId,
  });
}
