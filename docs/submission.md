# Portaldot Hacker House 2026 submission

| Field | Value |
| --- | --- |
| Project | Payout Replay |
| Track | Ecosystem DApps |
| One sentence | Non-custodial payout execution and reconciliation that proves every line of an approved payout sheet against finalized Portaldot V3 state, and only ever re-pays what the chain proves unpaid. |
| Team | winsznx (solo): product, contracts, backend, frontend |
| Repository | https://github.com/winsznx/payout-replay (public, MIT) |
| Live app | https://payout-replay.vercel.app |
| Demo video | https://youtu.be/9N1dcZsTf8w (2:34) |
| Pitch deck | https://claude.ai/artifact/HkuUkmoWLkf7BTVV39tZMq |
| Built | October 14 to November 6, 2026, from scratch; see the commit history |

## Portaldot integration

- Native runtime: tPOT payouts as `Balances.transfer_keep_alive`, signed with a 64-block mortal era, verified by `Balances.Transfer` in the extrinsic's own `ApplyExtrinsic` phase at or below the GRANDPA finalized head.
- EVM through pallet-revive: ERC-20 payouts through `PayoutExecutor`, verified by pairing `PaymentExecuted` with the token `Transfer` at the `finalized` tag; duplicate obligation IDs revert on-chain.
- H160 to native account mapping checked against `ReviveApi.account_id`.
- Works with the official Portaldot Extension for native signing; proofs can be looked up in the official Node Console.

## Testnet deployment

| Item | Value |
| --- | --- |
| Native RPC | `wss://test-node-v3.portaldot.dev`, genesis `0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd` |
| EVM RPC | `https://test-evm-rpc-v3.portaldot.dev`, chain 420420777 |
| PayoutExecutor | `0x09a46d341cBB557b84311aAA8A95cB40992464e1`, deploy tx `0x529ac79279e8e899c188e507e3600f27257cc19e23ab5464dfb34b9aff8476fc`, block 326175 |
| TEST TOKEN PRT | `0x07f843390b48470347Cb435451cB26DE798A1330`, deploy tx `0x6e1b37bb7b50e0a46f0834ad8c5f1a1b2aa2f108f3abe7fb302d0fe13cc982f2`, block 340057 |
| Source check | Both contracts match this repository byte for byte: `pnpm --filter @payout-replay/live verify-contracts` |
| Explorer | https://node-console.portaldot.dev (block links in the README) |

## Transactions

| Scenario | Transaction | Block |
| --- | --- | --- |
| Native tPOT payout | `0x97169b560c812931409ee17c30db1c6f53c178be8b33dcef078aac7b5a65eeb2` | 340484 |
| EVM token payout | `0x26a9f1e862f4544d0cf404762b5e71f1b87882738c8eece97b8706614492863b` | 340491 |
| Payment that reverts on-chain | `0xcfbf3ba99f1c70fe48cc8ddd978906a70ae887309807f483aa3b3ff2caa2ce2e` | 340495 |
| Replay of a paid obligation, reverted | `0x89ea48a6d51a83b814f818ce832d85839b62204c588e3126e90df14baefb001f` | 340508 |

All eight live checks with full proof are in [real-run-results.md](real-run-results.md). The production browser run `pr_ash15eez9sabt55gex8f` is described in the README's Tests section.

## Third-party code

OpenZeppelin Contracts, forge-std, polkadot.js, viem, Hono, Drizzle ORM, postgres.js, zod, jose, Next.js, React, SWR, Tailwind CSS and puppeteer-core, all through their published packages under their own licences. Demo music: "Clean Soul" by Kevin MacLeod (incompetech.com), CC BY 4.0.
