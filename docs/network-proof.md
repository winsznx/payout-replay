# Portaldot V3 network proof

Everything here was read from the live testnet on 2026-11-04. Where a fact came from somewhere else, the source is named.

## Native runtime

Probed over JSON-RPC at `https://test-node-v3.portaldot.dev`. The same host serves WebSocket at `wss://`.

| Query | Result |
|---|---|
| `system_chain` | `PortaldotV3 Test` |
| `system_version` | `3.0.0-dev-fddd43141f2` |
| `system_properties` | `{"ss58Format":42,"tokenDecimals":14,"tokenSymbol":"tPOT"}` |
| `chain_getBlockHash [0]` | `0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd` |
| `state_getRuntimeVersion` | specName `portaldot-v3`, specVersion 3002 |
| `rpc_methods` | includes `grandpa_*` and `babe_*`; finalised head lagged best by about 2 blocks |
| `api.consts.balances.existentialDeposit` | `10000000000000` (0.1 tPOT) |
| `api.tx.balances.transfer` | not present |
| `api.tx.balances.transferKeepAlive` | present |

The live adapter test (`PORTALDOT_LIVE=1 pnpm --filter @payout-replay/adapters-native test`) re-checks the identity and metadata facts on every run. It also pins two real cases:

- Block #106425, extrinsic 1, is a successful `balances.transferKeepAlive` from `5EhP3K…zDsb` to itself. Its events are `Withdraw, Deposit, TransactionFeePaid, ExtrinsicSuccess`, with no `Balances.Transfer`. Reconciliation treats it as `incorrect`, not paid.
- Block #320172, extrinsic 1, is an unsigned `revive.ethTransact` whose `Balances.Transfer` moves 1.5 tPOT between two EVM-mapped accounts. The native adapter refuses to attribute it to the debited account as a native payment.

## EVM

Probed at `https://test-evm-rpc-v3.portaldot.dev`.

| Query | Result |
|---|---|
| `eth_chainId` | `0x190f1ca9` (420420777) |
| `web3_clientVersion` | `eth-rpc/main-fddd431/…`, the Parity pallet-revive proxy |
| `eth_getBlockByNumber("finalized")` | supported |
| opcode probes via `eth_call` with creation code | PUSH0, TSTORE/TLOAD and MCOPY work; BLOBBASEFEE fails with `InvalidInstruction` |

Because of the opcode result, the contracts compile with solc 0.8.28 for `evm_version = "cancun"` and use no blob opcodes.

## Account mapping

An H160 holds its tPOT in a native account. For an unmapped address, that account is the 20 address bytes followed by twelve `0xEE` bytes. `scripts/live/keys.ts` computes this offline and refuses to continue unless `ReviveApi.account_id` returns the same account. For our EVM payout key `0x380785F4f466D5C71361F3A2823BCe2d6d87BB90`, the mapped account is `5DLAmpahUMZjit1jkt2SngGRmtUADDCBxbqNbh1kCxQXHMeL`, confirmed by the runtime.

EVM balances read through `eth_getBalance` use 18 decimals, which is the native amount times 10^4. Wallet fee displays on the wallets screen use that scale.

## Deployment

Deployed on 2026-11-05 from the EVM payout key with `scripts/live/deploy.ts`. Compiler: solc 0.8.28, evm_version cancun, optimizer 10000 runs, no CBOR metadata.

| Contract | Address | Transaction |
|---|---|---|
| PayoutExecutor | `0x09a46d341cBB557b84311aAA8A95cB40992464e1` | `0x529ac79279e8e899c188e507e3600f27257cc19e23ab5464dfb34b9aff8476fc` (block 326175) |
| TEST TOKEN PRT | `0x07f843390b48470347Cb435451cB26DE798A1330` | `0x6e1b37bb7b50e0a46f0834ad8c5f1a1b2aa2f108f3abe7fb302d0fe13cc982f2` |

Token allowlisting was `0x35d6641740f6809120af0dc7e32574581dcb2fbef0abfb726b3443d9fa71f502` and the demo mint was `0x65f50930658b930d2f5fee7fe7e68d90ff67f19ad550a3f7673f70d75c9b05f0`. The executor runtime code hash is `0x51eb5a3948cffbfb026d84fd6e09af2dcee1df87d613e56ab9dcefce88289556`, which `/health/chain` re-reads and compares on every check.

Deploying is expensive on V3, and the huge `eth_estimateGas` values are not padding. Revive meters storage deposits as gas: `depositPerByte` is 6·10^12 planck (0.06 tPOT per byte of runtime code), and a further 30% of that is locked against the code hash. The 3.2 KB executor charged 275 tPOT and the token about 249. Storage-writing calls such as `approve` cost 2 to 4 tPOT each. Since a fixed EVM-style gas limit like 3,000,000 is rejected outright, the scenario runner sizes the gas for reverting transactions from a real estimate of a successful call.

## Other sources

- Hackathon announcement "PortaldotV3 Testnet: Updated Network Info" on the DoraHacks page, for the endpoints.
- Edy Cu, "Plumbline: Portaldot's docs list Balances.transfer. On V3 it doesn't exist" (dev.to, 2026-10-31), which led us to check the transfer call. We re-verified it ourselves above.
