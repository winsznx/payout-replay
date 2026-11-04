import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const environmentEnum = pgEnum('environment', ['native', 'evm']);
export const roleEnum = pgEnum('member_role', ['owner', 'operator', 'reviewer', 'viewer']);
export const capabilityEnum = pgEnum('capability_status', ['verified', 'unverified', 'unavailable']);

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  displayName: text('display_name'),
  createdAt: createdAt(),
});

/** A wallet a user has proven control of by signing a challenge. */
export const userIdentities = pgTable(
  'user_identities',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    environment: environmentEnum('environment').notNull(),
    /** Canonical address: checksummed H160 or SS58 with the network prefix. */
    address: text('address').notNull(),
    /** Comparison key: lowercase H160 or hex public key. */
    addressKey: text('address_key').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex('user_identities_env_key').on(table.environment, table.addressKey)],
);

export const authChallenges = pgTable('auth_challenges', {
  id: text('id').primaryKey(),
  purpose: text('purpose').notNull(),
  environment: environmentEnum('environment').notNull(),
  address: text('address').notNull(),
  orgId: text('org_id'),
  nonce: text('nonce').notNull(),
  message: text('message').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  identityId: text('identity_id')
    .notNull()
    .references(() => userIdentities.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const organisations = pgTable('organisations', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  'memberships',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => organisations.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: roleEnum('role').notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('memberships_org_user').on(table.orgId, table.userId)],
);

export const wallets = pgTable(
  'wallets',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organisations.id),
    environment: environmentEnum('environment').notNull(),
    address: text('address').notNull(),
    chainIdentity: text('chain_identity').notNull(),
    verifiedBy: text('verified_by')
      .notNull()
      .references(() => users.id),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('wallets_one_active_per_env')
      .on(table.orgId, table.environment)
      .where(sql`${table.isActive}`),
  ],
);

export const assets = pgTable(
  'assets',
  {
    id: text('id').primaryKey(),
    environment: environmentEnum('environment').notNull(),
    chainIdentity: text('chain_identity').notNull(),
    assetId: text('asset_id').notNull(),
    symbol: text('symbol').notNull(),
    decimals: integer('decimals').notNull(),
    allowlisted: boolean('allowlisted').notNull(),
    capability: capabilityEnum('capability').notNull(),
    codeHash: text('code_hash'),
    label: text('label'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex('assets_chain_asset').on(table.chainIdentity, table.assetId)],
);

export const payoutRuns = pgTable(
  'payout_runs',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organisations.id),
    name: text('name').notNull(),
    status: text('status').notNull(),
    currentVersion: integer('current_version').notNull().default(0),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
    /** Optimistic concurrency token, bumped on every state change. */
    revision: integer('revision').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('payout_runs_org').on(table.orgId)],
);

/** The latest uploaded CSV for a run's draft, kept with its checksum and validation report. */
export const runImports = pgTable('run_imports', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => payoutRuns.id),
  fileName: text('file_name'),
  fileSha256: text('file_sha256').notNull(),
  csvText: text('csv_text').notNull(),
  columnMapping: jsonb('column_mapping').notNull(),
  report: jsonb('report').notNull(),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
});

/** Immutable once inserted; a database trigger rejects updates to the frozen columns. */
export const manifestVersions = pgTable(
  'manifest_versions',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => payoutRuns.id),
    version: integer('version').notNull(),
    importId: text('import_id')
      .notNull()
      .references(() => runImports.id),
    canonicalJson: text('canonical_json').notNull(),
    digest: text('digest').notNull(),
    status: text('status').notNull(),
    duplicatesAcknowledged: boolean('duplicates_acknowledged').notNull(),
    frozenBy: text('frozen_by')
      .notNull()
      .references(() => users.id),
    frozenAt: timestamp('frozen_at', { withTimezone: true }).notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('manifest_versions_run_version').on(table.runId, table.version)],
);

export const obligations = pgTable(
  'obligations',
  {
    id: text('id').primaryKey(),
    manifestVersionId: text('manifest_version_id')
      .notNull()
      .references(() => manifestVersions.id),
    runId: text('run_id')
      .notNull()
      .references(() => payoutRuns.id),
    obligationId: text('obligation_id').notNull(),
    lineId: text('line_id').notNull(),
    reference: text('reference').notNull(),
    environment: environmentEnum('environment').notNull(),
    assetId: text('asset_id').notNull(),
    payer: text('payer').notNull(),
    destination: text('destination').notNull(),
    amountBaseUnits: numeric('amount_base_units', { precision: 78, scale: 0 }).notNull(),
    status: text('status').notNull(),
    explanation: text('explanation').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('obligations_version_line').on(table.manifestVersionId, table.lineId),
    uniqueIndex('obligations_version_obligation').on(table.manifestVersionId, table.obligationId),
    index('obligations_run').on(table.runId),
  ],
);

export const approvals = pgTable('approvals', {
  id: text('id').primaryKey(),
  manifestVersionId: text('manifest_version_id')
    .notNull()
    .references(() => manifestVersions.id),
  reviewerId: text('reviewer_id')
    .notNull()
    .references(() => users.id),
  decision: text('decision').notNull(),
  /** Always "off-chain-app": app approval does not move funds or replace a wallet signature. */
  method: text('method').notNull(),
  digest: text('digest').notNull(),
  reason: text('reason'),
  createdAt: createdAt(),
});

export const recoveryPlans = pgTable(
  'recovery_plans',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => payoutRuns.id),
    manifestVersionId: text('manifest_version_id')
      .notNull()
      .references(() => manifestVersions.id),
    manifestDigest: text('manifest_digest').notNull(),
    kind: text('kind').notNull(),
    plan: jsonb('plan').notNull(),
    fingerprint: text('fingerprint').notNull(),
    status: text('status').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revalidatedAt: timestamp('revalidated_at', { withTimezone: true }),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [index('recovery_plans_run').on(table.runId)],
);

/**
 * One row per signing/submission attempt. Transaction identity columns are
 * write-once (trigger enforced); outcome columns are refreshed by reconciliation.
 */
export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => payoutRuns.id),
    obligationRowId: text('obligation_row_id')
      .notNull()
      .references(() => obligations.id),
    obligationId: text('obligation_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    source: text('source').notNull(),
    planId: text('plan_id').references(() => recoveryPlans.id),
    environment: environmentEnum('environment').notNull(),
    payer: text('payer').notNull(),
    phase: text('phase').notNull(),
    txHash: text('tx_hash'),
    nonce: bigint('nonce', { mode: 'number' }),
    reportedBlockHash: text('reported_block_hash'),
    mortalityBirth: bigint('mortality_birth', { mode: 'number' }),
    mortalityPeriod: integer('mortality_period'),
    idempotencyKey: text('idempotency_key').notNull(),
    outcome: jsonb('outcome').notNull(),
    outcomeKind: text('outcome_kind').notNull(),
    createdBy: text('created_by').references(() => users.id),
    preparedAt: timestamp('prepared_at', { withTimezone: true }).notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    observedAt: timestamp('observed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('payment_attempts_idempotency').on(table.idempotencyKey),
    uniqueIndex('payment_attempts_obligation_number').on(table.obligationRowId, table.attemptNumber),
    index('payment_attempts_run').on(table.runId),
  ],
);

/** Append-only log of what each RPC said about an attempt, kept as provenance. */
export const chainObservations = pgTable(
  'chain_observations',
  {
    id: text('id').primaryKey(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => paymentAttempts.id),
    provider: text('provider').notNull(),
    outcomeKind: text('outcome_kind').notNull(),
    blockHash: text('block_hash'),
    blockNumber: text('block_number'),
    extrinsicIndex: integer('extrinsic_index'),
    logIndex: integer('log_index'),
    finalized: boolean('finalized').notNull(),
    raw: jsonb('raw').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('chain_observations_attempt').on(table.attemptId)],
);

export const settlementMatches = pgTable(
  'settlement_matches',
  {
    id: text('id').primaryKey(),
    obligationRowId: text('obligation_row_id')
      .notNull()
      .references(() => obligations.id),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => paymentAttempts.id),
    txHash: text('tx_hash').notNull(),
    verifiedAmountBaseUnits: numeric('verified_amount_base_units', { precision: 78, scale: 0 }).notNull(),
    category: text('category').notNull(),
    proofVersion: integer('proof_version').notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('settlement_matches_obligation_tx').on(table.obligationRowId, table.txHash)],
);

export const manualResolutions = pgTable('manual_resolutions', {
  id: text('id').primaryKey(),
  obligationRowId: text('obligation_row_id')
    .notNull()
    .unique()
    .references(() => obligations.id),
  reason: text('reason').notNull(),
  proofReference: text('proof_reference'),
  resolvedBy: text('resolved_by')
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
});

export const exceptions = pgTable(
  'exceptions',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => payoutRuns.id),
    obligationRowId: text('obligation_row_id').references(() => obligations.id),
    /** Stable key so repeated reconciliation updates instead of duplicating. */
    fingerprint: text('fingerprint').notNull(),
    severity: text('severity').notNull(),
    type: text('type').notNull(),
    message: text('message').notNull(),
    evidence: jsonb('evidence').notNull(),
    resolution: text('resolution').notNull().default('open'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex('exceptions_run_fingerprint').on(table.runId, table.fingerprint)],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').references(() => organisations.id),
    actorId: text('actor_id'),
    actorKind: text('actor_kind').notNull(),
    action: text('action').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id').notNull(),
    beforeDigest: text('before_digest'),
    afterDigest: text('after_digest'),
    detail: jsonb('detail').notNull(),
    correlationId: text('correlation_id').notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('audit_events_org').on(table.orgId, table.createdAt)],
);

export const apiKeys = pgTable('api_keys', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => organisations.id),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  secretHash: text('secret_hash').notNull().unique(),
  scopes: jsonb('scopes').$type<string[]>().notNull(),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const webhookEndpoints = pgTable('webhook_endpoints', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => organisations.id),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  events: jsonb('events').$type<string[]>().notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
});

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    endpointId: text('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastStatus: integer('last_status'),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('webhook_deliveries_endpoint_event').on(table.endpointId, table.eventId),
    index('webhook_deliveries_due').on(table.nextAttemptAt),
  ],
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    key: text('key').notNull(),
    principal: text('principal').notNull(),
    route: text('route').notNull(),
    requestHash: text('request_hash').notNull(),
    status: integer('status').notNull(),
    response: jsonb('response').notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('idempotency_principal_key').on(table.principal, table.key)],
);
