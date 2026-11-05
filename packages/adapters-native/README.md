# @payout-replay/adapters-native

Portaldot V3 native runtime adapter for [Payout Replay](https://github.com/winsznx/payout-replay). Builds Balances.transfer_keep_alive with a mortal era, attributes Balances.Transfer events by extrinsic index, and proves a payment never landed once its era is finalized.

Most apps want [`@payout-replay/sdk`](https://www.npmjs.com/package/@payout-replay/sdk), which re-exports this package. MIT licensed.
