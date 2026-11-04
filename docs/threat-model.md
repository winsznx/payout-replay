# Threat model

| Threat | Mitigation | Where |
|---|---|---|
| Recipient address or amount edited in the CSV after approval | Approval binds an exact SHA-256 digest of canonical JSON; DB triggers reject edits to frozen versions and obligations | `packages/core/src/manifest.ts`, `infra/migrations/0001_immutability_triggers.sql` |
| Manifest changed after payments started | Re-freezing is refused once any attempt exists, because new obligation IDs would allow double payment | `apps/api/src/services/runs.ts` (`freezeRun`) |
| Signature replay across site, chain, org or action | Challenges name domain, origin, network (genesis or chain ID), purpose, org, nonce and expiry; each is single-use | `apps/api/src/auth/challenge.ts` |
| Payout wallet registered by someone who doesn't control it | Registration consumes a challenge signed by that wallet; EVM and native are never inferred from each other | `apps/api/src/routes/orgs.ts` |
| Cross-organisation data access | Every org and run route goes through `authorizeOrg` / `authorizeRun`; non-members get the same 404 as a missing run | `apps/api/src/auth/access.ts` |
| CSRF on cookie sessions | Cookie writes must carry the web origin; API keys are bearer tokens with no ambient credentials | `apps/api/src/http.ts` |
| Leaked API key | Only SHA-256 hashes are stored; keys are scoped to read or write and can never sign; revocable | `apps/api/src/routes/orgs.ts` |
| Two operators paying the same line | Attempt creation locks the obligation row and refuses while any attempt is unresolved; the executor also refuses a repeated ID per payer | `apps/api/src/services/execution.ts`, `contracts/src/PayoutExecutor.sol` |
| Retry after a timeout pays twice | Timeouts are `unknown`, never `failed`; unknown blocks recovery until a mortal era closes, a nonce is consumed or a receipt appears | adapters, `packages/core/src/reconcile.ts` |
| Replacement transaction mistaken for failure | A consumed nonce is checked against `wasExecuted` at the finalised block, and the replacement's event is located by log scan | `packages/adapters-evm/src/adapter.ts` |
| Native event attributed to the wrong extrinsic | Only events whose phase is `ApplyExtrinsic(index)` of the attempt's own extrinsic count, and only if the payout wallet signed it | `packages/adapters-native/src/adapter.ts` |
| Reorg or RPC lie promotes a payment | Paid only at or below finality and only if the block hash is canonical at that height; observations record provider and block | both adapters |
| Fake or fee-on-transfer token | Token allowlist on the executor; the executor checks the recipient balance delta equals the amount | `contracts/src/PayoutExecutor.sol` |
| Reentrancy or allowance misuse | `ReentrancyGuard`, `SafeERC20`, and `transferFrom` only ever from `msg.sender`; approvals are for the exact amount | `contracts/src/PayoutExecutor.sol`, `packages/adapters-evm/src/adapter.ts` |
| Server prepares a different call than the operator signs | The browser rebuilds the native call and refuses unless it is byte-identical on the same genesis and spec version | `apps/web/src/lib/native-wallet.ts` |
| CSV formula injection | Exported cells starting with `= + - @ tab CR` get a leading quote, and all values are properly quoted | `packages/core/src/csv.ts` |
| Oversized or malformed uploads | 5 MB and 500 row limits, strict parser, 6 MB body limit, schema validation on every route | `packages/core/src/manifest.ts`, `apps/api/src/app.ts` |
| Request floods | Token-bucket rate limits per principal or IP, with a tighter limit on auth; reconcile is debounced | `apps/api/src/http.ts` |

The tests that exercise these are listed in the README.
