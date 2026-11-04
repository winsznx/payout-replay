# API

Base path `/api/v1`. Signed-in operators use a session cookie from wallet sign-in. Integrations use `Authorization: Bearer prk_…` with an organisation API key. Keys carry `runs:read` and optionally `runs:write`; they can never approve, sign or register payout wallets.

Every write needs an `Idempotency-Key` header (8 to 128 URL-safe characters). Repeating a key with the same body returns the stored response with `Idempotent-Replayed: true`. Repeating it with a different body returns 409.

Errors always look like this:

```json
{ "error": { "code": "PLAN_STALE", "message": "1 line(s) are no longer safe to pay; recompute the plan", "retryable": false, "traceId": "trc_…", "details": { "changed": ["0x…"] } } }
```

Status codes: 400 validation, 401 and 403 auth, 404 not found or not yours, 409 version conflict, stale plan or idempotency mismatch, 422 unusable instruction, 429 throttled, 503 chain verification unavailable.

## Auth

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/challenge` | `{ environment, address }` returns a single-use message bound to domain, origin, network, purpose and expiry |
| POST | `/auth/verify` | `{ challengeId, signature, link? }` signs in, or with `link: true` attaches the wallet to the current user |
| POST | `/auth/logout` | revokes the session |
| GET | `/me` | user, linked wallets, organisations and roles |

## Organisations

| Method | Path | Role |
|---|---|---|
| POST | `/orgs` | any signed-in user, who becomes owner |
| GET | `/orgs/:orgId` | member |
| GET, POST | `/orgs/:orgId/members` | member, owner to change |
| POST | `/orgs/:orgId/wallet-challenges` | operator+ |
| POST | `/orgs/:orgId/wallets` | owner, with the wallet's own signature |
| GET | `/orgs/:orgId/wallets` | member; includes chain binding, RPC health and fee balance |
| GET | `/orgs/:orgId/assets` | member; verified assets and network capability |
| GET, POST | `/orgs/:orgId/runs` | member, operator+ to create |
| GET | `/orgs/:orgId/audit` | member |
| GET, POST | `/orgs/:orgId/api-keys`, `/orgs/:orgId/api-keys/:keyId/revoke` | owner |
| POST | `/orgs/:orgId/webhooks` | owner; returns the signing secret once |

## Runs

| Method | Path | Role | What it does |
|---|---|---|---|
| GET | `/runs/:runId` | member | run, summary, latest version and manifest, latest import report, latest plan, version history |
| GET | `/runs/:runId/lines` | member | obligations with status, explanation, exceptions and every attempt's proof |
| POST | `/runs/:runId/import` | operator+ | `{ csv, fileName?, columnMapping? }` returns a validation report |
| POST | `/runs/:runId/validate` | operator+ | re-validates the latest upload against current wallets and assets |
| POST | `/runs/:runId/freeze` | operator+ | `{ acknowledgeDuplicates, expectedRevision? }` creates an immutable version |
| POST | `/runs/:runId/approvals` | reviewer or owner | `{ version, digest, decision, reason? }`; the digest must match |
| POST | `/runs/:runId/execute/plan` | signed-in operator | builds an expiring plan from fresh chain state |
| POST | `/runs/:runId/recovery-plans` | signed-in operator | same selection, labelled as a correction |
| POST | `/recovery-plans/:planId/revalidate` | signed-in operator controlling the payer | `{ environment, obligationIds? }` re-checks those lines and returns unsigned calls with preflight issues |
| POST | `/runs/:runId/attempts` | signed-in operator controlling the payer | `{ planId, obligationId }` opens one attempt under a row lock |
| POST | `/attempts/:attemptId/result` | the operator who opened it | `{ phase, txHash?, nonce?, blockHash?, mortality? }`; identity is write-once |
| POST | `/runs/:runId/external-transactions` | operator+ | attach an out-of-band transaction for verification |
| POST | `/runs/:runId/resolutions` | owner | manual resolution, never counted as paid |
| POST | `/runs/:runId/reconcile` | member | re-observes the chain now (debounced) |
| GET | `/runs/:runId/evidence` | member | summary, lines and open exceptions |
| GET | `/runs/:runId/export.csv` | member | one row per original line |
| GET | `/runs/:runId/exceptions.csv` | member | every discrepancy |
| GET | `/runs/:runId/evidence.json` | member | manifest, approvals, attempts, observations, limitations |

## Public

`GET /health` and `GET /health/chain`. The second returns network identity, finality, capability and verified assets, with no organisation data.

## Webhooks

Events: `payout_run.updated`, `obligation.paid_verified`, `obligation.needs_review`, `recovery_plan.ready`. Each POST carries `x-payout-replay-event`, `x-payout-replay-event-id` and `x-payout-replay-signature: t=<unix>,v1=<hex>`, where `v1 = HMAC-SHA256(secret, "<t>.<body>")`. Reject timestamps older than five minutes and event IDs you've already processed. Failed deliveries retry with exponential backoff, up to eight attempts. [examples/accounting-sync/src/webhook-receiver.ts](../examples/accounting-sync/src/webhook-receiver.ts) is a working receiver.

## SDK

```ts
import { PayoutReplayClient } from '@payout-replay/sdk';

const client = new PayoutReplayClient({ baseUrl: 'https://api.example.com', apiKey: process.env.PAYOUT_REPLAY_KEY! });
const lines = await client.listLines('pr_…');
const csv = await client.exportCsv('pr_…');
```

The same package exports `parseManifest`, `validateManifest`, `freezeManifest`, `reconcileRun`, `createRecoveryPlan`, `createExecutionPlan`, and the `EvmAdapter` and `NativeAdapter` classes for use without the hosted API.
