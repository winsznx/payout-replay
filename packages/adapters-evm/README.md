# @payout-replay/adapters-evm

Portaldot V3 EVM (pallet-revive) adapter for [Payout Replay](https://github.com/winsznx/payout-replay). Builds PayoutExecutor calls, pairs PaymentExecuted with the token Transfer at the finalized tag, and proves a failure only when the nonce is consumed and wasExecuted stays false.

Most apps want [`@payout-replay/sdk`](https://www.npmjs.com/package/@payout-replay/sdk), which re-exports this package. MIT licensed.
