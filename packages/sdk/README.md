# @payout-replay/sdk

TypeScript SDK for [Payout Replay](https://github.com/winsznx/payout-replay): manifest validation, reconciliation, fail-closed recovery planning, the Portaldot V3 native and EVM adapters, and a typed client for the REST API.

## Install

```bash
npm install @payout-replay/sdk
```

It brings in `@payout-replay/core`, `@payout-replay/adapters-evm` and `@payout-replay/adapters-native`.

## Use

```ts
import { PayoutReplayClient, NativeAdapter } from '@payout-replay/sdk';

const client = new PayoutReplayClient({ baseUrl: 'https://payout-replay.vercel.app', apiKey: process.env.PAYOUT_REPLAY_KEY });
const lines = await client.listLines('pr_…');

// Or check an extrinsic yourself, with no hosted API involved
const native = new NativeAdapter({ wsUrl: 'wss://test-node-v3.portaldot.dev' });
```

Full reference: [docs/api.md](https://github.com/winsznx/payout-replay/blob/main/docs/api.md). MIT licensed.
