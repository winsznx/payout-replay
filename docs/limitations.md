# Limitations

What Payout Replay does not do or cannot prove today. Each item is a deliberate boundary or a known gap, not a bug we're hiding.

## By design

- No custody, no keys, no unattended signing. The service can't move funds, which also means it can't finish a payout on its own.
- No atomicity across native and EVM. Each transfer settles and is verified independently.
- App approval is off-chain. Reviewers approve a digest inside the app. The executor records `manifestDigest` as a correlation value, which is not proof that anyone approved anything.
- No guessing about out-of-band payments. A transfer made outside the app counts only after someone attaches its transaction reference and the chain verifies payer, recipient, asset and exact amount. Equal-amount transfers to the same address are never matched automatically.
- A manually resolved line is never `paid_verified`. It stays outstanding in the settled totals.

## Known gaps

- Native assets other than tPOT (the Assets pallet) are not enabled. Nothing has verified that path on V3.
- The executor's duplicate guard covers calls through the executor only. A payer can still send the same tokens directly from their wallet. Reconciliation won't count such a transfer unless it is attached and verified.
- New manifest versions get new obligation IDs. That's why a run whose payments have started can never be re-versioned; corrections reuse the original obligation.
- The EVM adapter can't conclude anything about a dropped transaction until its nonce is consumed. An operator who wants to release such a line must consume the nonce, for example with a 0-value self-transfer. Until then the line stays `needs_review`, which is the safe default.
- An attempt whose transaction hash was never recorded can't be found by scanning, so it stays `needs_review`. The web app signs first and records the hash before broadcasting, so this only happens if the browser closes while the wallet prompt is open.
- Rate limiting and the reconcile debounce are in-process. Running several API replicas would need a shared store.
- Live updates use polling (5 seconds while anything is in flight), not server-sent events.
- Webhook delivery is at-least-once with exponential backoff up to eight attempts. Receivers must deduplicate by event ID. The example receiver does.
- No public V3 block explorer exists, so explorer links are off by default. Proof is shown as raw transaction, block, extrinsic and log references.

## Safety

- Testnet only. The contracts have a Foundry suite but no external audit.
- Fee-on-transfer and rebasing tokens revert in the executor, because it checks the recipient's balance delta. Only allowlisted tokens are accepted.
