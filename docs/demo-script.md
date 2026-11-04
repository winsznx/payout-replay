# Demo film script

Target length 2:40. Recorded on the frozen build against Portaldot V3, with real wallets (MetaMask for EVM, Polkadot.js or Talisman for native). The one injected failure is said out loud and shown on screen as injected.

| Time | Screen | Voice-over |
|---|---|---|
| 0:00 | A spreadsheet of contributor payouts, five rows, two in tPOT and three in a test token | "This is how a DAO pays contributors: a sheet someone approved." |
| 0:14 | The same sheet beside a wallet history | "Approved doesn't mean paid. The sheet can't tell you which transfers actually landed." |
| 0:28 | A failed transfer and a timed-out one, side by side | "When something breaks halfway, retrying blind can pay someone twice." |
| 0:38 | Payout Replay landing page | "Payout Replay tells you who actually got paid, and fixes only what didn't." |
| 0:48 | Import: drop the CSV, line-level validation, totals by asset, who has to sign | "Import the approved sheet. Every address and amount is checked against the asset's real decimals." |
| 0:58 | Freeze, then the review screen with the digest; approve | "Freezing gives the version a fingerprint. Approval is for that exact fingerprint, and it doesn't move money." |
| 1:05 | Execute: native line signed in the Polkadot extension, EVM line approved and signed in MetaMask | "Each payment is signed by the payout wallet itself: a native transfer, and a token payment through our executor contract." |
| 1:20 | Settlement: the ticks fill in, Show proof opens extrinsic index, block hash, log index | "It counts as paid only when a finalised block shows the exact transfer, attributed to that transaction." |
| 1:35 | One EVM line fails on-chain (allowance revoked), the trail shows the revert | "This one reverted on-chain. That's a proven failure." |
| 1:45 | A line marked "submission unknown" (caption: injected for the demo) shows Needs review | "This one's wallet response was lost. Nobody knows if it went out, so the app won't guess." |
| 1:55 | Recover: Safe to pay has only the reverted line; Blocked lists the paid lines and the unknown one, each with its reason | "Recovery offers the proven failure and nothing else." |
| 2:05 | Sign the correction, watch it settle | "The correction reuses the original obligation, so the contract would refuse it a second time." |
| 2:12 | The native extrinsic and the executor event, raw | "Both sides are Portaldot V3: a transfer_keep_alive extrinsic on the runtime, and a PaymentExecuted event on the EVM." |
| 2:28 | Export: download the CSV, open it in a spreadsheet, statuses and tx hashes per row | "You get your own sheet back, with proof on every row and the exceptions kept, not hidden." |
| 2:38 | End card with repo link and "testnet only, contracts unaudited" | |

## Checks before recording

- The build matches the submitted commit.
- Both payout wallets are funded, and the test token is allowlisted on the deployed executor.
- `/health/chain` shows both environments as verified.
- Run with sound off once to make sure the captions carry the story.
