# @payout-replay/sdk

TypeScript SDK for [Payout Replay](https://github.com/winsznx/payout-replay): manifest validation, reconciliation, fail-closed recovery planning, the Portaldot V3 native and EVM adapters, and a typed client for the REST API.

## Install

Not published to npm yet. Install the release tarballs, which carry the packages this one depends on:

```bash
npm install \
  https://github.com/winsznx/payout-replay/releases/download/v0.1.0/payout-replay-core-0.1.0.tgz \
  https://github.com/winsznx/payout-replay/releases/download/v0.1.0/payout-replay-adapters-evm-0.1.0.tgz \
  https://github.com/winsznx/payout-replay/releases/download/v0.1.0/payout-replay-adapters-native-0.1.0.tgz \
  https://github.com/winsznx/payout-replay/releases/download/v0.1.0/payout-replay-sdk-0.1.0.tgz
```

## Use

```ts
import { PayoutReplayClient, NativeAdapter } from '@payout-replay/sdk';

const client = new PayoutReplayClient({ baseUrl: 'https://payout-replay.vercel.app', apiKey: process.env.PAYOUT_REPLAY_KEY });
const lines = await client.listLines('pr_…');

// Or check an extrinsic yourself, with no hosted API involved
const native = new NativeAdapter({ wsUrl: 'wss://test-node-v3.portaldot.dev' });
```

Full reference: [docs/api.md](https://github.com/winsznx/payout-replay/blob/main/docs/api.md). MIT licensed.
