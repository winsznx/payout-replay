# Payout Replay

Know who actually got paid. Fix only what didn't.

Payout Replay takes the payout spreadsheet a DAO or Web3 team already approved, helps the treasury wallet pay each line on Portaldot V3 (native tPOT and EVM tokens), checks every line against finalised chain evidence, and offers a correction only for lines the chain proves unpaid. The output is the same spreadsheet with a status, transaction, block and exception for every row.

It is non-custodial. The app never holds keys and never signs. Every payment and every correction is signed by the payout wallet itself.

Built for the Portaldot Hacker House 2026, Ecosystem DApps track.

- App: https://payout-replay.vercel.app
- Live V3 evidence: [docs/real-run-results.md](docs/real-run-results.md), produced by running S1 to S7 against that deployment
- Contracts on Portaldot V3 EVM (chain 420420777): `PayoutExecutor` at `0x09a46d341cBB557b84311aAA8A95cB40992464e1`, TEST TOKEN PRT at `0x07f843390b48470347Cb435451cB26DE798A1330`

## The rule it is built around

An approved line, a submitted transaction and a verified settlement are three different things. A timed-out RPC call, a lost wallet response or a missing local record never means a recipient wasn't paid. When Payout Replay can't prove what happened to a payment, it says so and refuses to offer it again.

That rule decides most of the design:

- A native transfer counts as paid only when an extrinsic signed by the payout wallet emits `Balances.Transfer` in its own `ApplyExtrinsic` phase, inside a block that is canonical at or below the GRANDPA finalised head.
- An EVM payment counts only when the `PaymentExecuted` event from our executor pairs with the ERC-20 `Transfer` it caused, in a block at or below the `finalized` tag.
- "Not found" turns into a conclusive failure only when the chain makes inclusion impossible. Native extrinsics are signed with a 64-block mortal era, so once the whole era is finalised without the extrinsic, it can never land. For EVM, the nonce has to be consumed while the executor's `wasExecuted` flag stays false.
- Everything else stays `needs_review`, and the recovery planner never selects it.

## What runs where

| Path | What it is |
|---|---|
| [packages/core](packages/core) | Pure TypeScript engine: strict CSV import, canonical manifest and SHA-256 digest, obligation IDs, reconciliation, fail-closed recovery planning, CSV export |
| [packages/adapters-native](packages/adapters-native) | Portaldot V3 runtime adapter on `@polkadot/api`: `Balances.transfer_keep_alive`, event attribution by extrinsic index, mortality-based failure proof |
| [packages/adapters-evm](packages/adapters-evm) | Portaldot V3 EVM (pallet-revive) adapter on `viem`: executor calls, receipt and event pairing, nonce-based failure proof, log scan for replacement transactions |
| [packages/sdk](packages/sdk) | Public SDK: the engine, both adapters and a typed REST client |
| [contracts](contracts) | `PayoutExecutor.sol` and the labelled `TestToken.sol` with a Foundry suite |
| [apps/api](apps/api) | Hono API on PostgreSQL: wallet sign-in, RBAC, immutable manifests, plans, attempts, reconciliation worker, exports, API keys, webhooks |
| [apps/web](apps/web) | Next.js operator app: import, review, execute, settlement, recover, export |
| [examples/accounting-sync](examples/accounting-sync) | Sample integration: pull reconciled sheets into a folder and receive signed webhooks |
| [scripts/live](scripts/live) | Tooling for real V3 runs: test keys, funding, deploy, and the S1 to S7 scenario runner |
| [docs](docs) | Architecture, network proof, API, threat model, limitations, demo script, real run results |

## Portaldot V3 facts this build depends on

These were verified against the live testnet on 2026-11-04, not taken from docs. Details are in [docs/network-proof.md](docs/network-proof.md).

- Native RPC `wss://test-node-v3.portaldot.dev`, spec `portaldot-v3` v3002, genesis `0xd4f9acbc…155283bd`, `tPOT` with 14 decimals, SS58 prefix 42, BABE and GRANDPA finality.
- `Balances.transfer` does not exist on V3. Payouts use `Balances.transfer_keep_alive`, which is present in the live metadata.
- EVM RPC `https://test-evm-rpc-v3.portaldot.dev`, chain ID 420420777. This is the pallet-revive eth-rpc proxy, not Frontier. PUSH0, MCOPY and TSTORE execute, but blob opcodes don't, so the contracts compile for `cancun` with no blob use.
- An EVM address's tPOT lives in its mapped native account (`h160` followed by twelve `0xEE` bytes when unmapped). The live tooling checks this against `ReviveApi.account_id`.
- Contract deploys are expensive: revive charges 0.06 tPOT per byte of stored code plus a 30% code-hash lockup, so each of our two contracts cost about 250 tPOT.

## Portaldot tools it works with

- [Portaldot Extension](https://chromewebstore.google.com/detail/portaldot-extension/cpdecangbhmfijmlmjglfcocfpaojceo), the official browser wallet. It injects through the standard polkadot.js extension API as `portaldot extension`, so the app's native sign-in, wallet registration and tPOT payments work with it unchanged, alongside Polkadot.js, Talisman and SubWallet.
- [Node Console](https://node-console.portaldot.dev), the official V3 block explorer. Every native proof the app records (block hash, extrinsic index, nonce) can be looked up there.
- Any EIP-1193 wallet, such as MetaMask, for the EVM side. The app adds chain 420420777 to the wallet on first use.

## Run it locally

Requirements: Node 22+, pnpm, Foundry, PostgreSQL 16 and `jq`.

```bash
pnpm install
cd contracts && forge install foundry-rs/forge-std --no-git && forge build && cd ..
pnpm build

# Database
createdb payout_replay

# A local EVM chain with the executor and TEST TOKEN deployed; prints env lines
./scripts/local-evm.sh

# API: copy the example, paste the printed EVM lines, set SESSION_SECRET
cp apps/api/.env.example apps/api/.env
pnpm --filter @payout-replay/api dev

# Web app on http://localhost:3000, proxying /api/v1 to the API
cp apps/web/.env.example apps/web/.env.local   # set NEXT_PUBLIC_EVM_* to the local chain
pnpm --filter @payout-replay/web dev
```

The native side uses the real V3 node even locally. Reading it needs no funds.

## Tests

```bash
pnpm --filter @payout-replay/core test            # 90 unit tests: import, digests, reconciliation, recovery, export
pnpm test:contracts                                # 20 Foundry tests including a 512-run fuzz of duplicate IDs
pnpm --filter @payout-replay/adapters-evm test     # adapter against anvil: pay, revert, correct, duplicate, unknown, RPC loss
PORTALDOT_LIVE=1 pnpm --filter @payout-replay/adapters-native test   # read-only checks against real V3 blocks
pnpm --filter @payout-replay/api test              # API end-to-end on Postgres + anvil: S2 to S7, isolation, idempotency, CSRF, DB immutability
pnpm --filter @payout-replay/sdk test
TOKEN=0x… EXECUTOR=0x… pnpm --filter @payout-replay/web e2e   # real browser run in Chrome against the local stack
WEB_URL=https://payout-replay.vercel.app node apps/web/e2e/production-flow.mjs   # the deployed app on V3, see below
```

`production-flow.mjs` drives the deployed app in Chrome through a whole run on Portaldot V3: wallet sign-in and registration, CSV import, freeze and approval, a native tPOT payment and two EVM token payments, one of which reverts on-chain, recovery of only that line, and the export. Its wallets are a test harness that signs with the testnet keys in `internal/`, standing in for the extension popups; every transaction is real. The last passing run is `pr_ash15eez9sabt55gex8f` on 2026-11-05.

Fixture data in tests is labelled as such. Anvil runs prove the code paths. Only [docs/real-run-results.md](docs/real-run-results.md) counts as Portaldot evidence.

## Live V3 run

```bash
pnpm --filter @payout-replay/live keys        # testnet-only keys into internal/ (gitignored)
# fund the printed native address with tPOT, then:
AMOUNT_TPOT=360 pnpm --filter @payout-replay/live fund-evm   # each contract deploy costs ~250 tPOT in revive code deposits
pnpm --filter @payout-replay/live exec tsx deploy.ts
# start the API with the V3 EVM settings and the deployed addresses, then:
API_URL=https://payout-replay.vercel.app WEB_ORIGIN=https://payout-replay.vercel.app \
  pnpm --filter @payout-replay/live scenarios   # writes docs/real-run-results.md
```

## Deployment

The API and its Postgres run with Docker Compose on a VPS ([infra/deploy](infra/deploy)). Postgres has no published port, and migrations run when the API starts.

```bash
cp infra/deploy/.env.example infra/deploy/.env   # fill POSTGRES_PASSWORD and SESSION_SECRET
docker compose -f infra/deploy/compose.yml --env-file infra/deploy/.env up -d --build
```

The web app is on Vercel with `apps/web` as the root directory and `API_URL` pointing at the API. Next rewrites proxy `/api/v1` and `/health` to it, so the browser only talks to the Vercel origin and the session cookie stays first-party.

## Third-party code

OpenZeppelin Contracts 5.x (Ownable2Step, SafeERC20, ReentrancyGuard), forge-std, polkadot.js (`@polkadot/api`, `util`, `util-crypto`, `extension-dapp`), viem, Hono, Drizzle ORM, postgres.js, zod, jose, Next.js, React, SWR, Tailwind CSS and puppeteer-core for the browser test. All are used through their published packages under their own licences.

## Licence

MIT. See [LICENSE](LICENSE).
