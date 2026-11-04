#!/usr/bin/env bash
# Starts a local anvil chain, deploys PayoutExecutor and the TEST TOKEN, and
# prints the env lines for apps/api/.env. Local development only; this is
# not Portaldot evidence.
set -euo pipefail

PORT="${ANVIL_PORT:-8545}"
RPC="http://127.0.0.1:${PORT}"
# anvil's first two default accounts: deployer and demo payout wallet.
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
PAYOUT_WALLET="${PAYOUT_WALLET:-0x70997970C51812dc3A010C7d01b50e0d17dc79C8}"

if ! curl -s -o /dev/null -X POST "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'; then
  nohup anvil --port "$PORT" --silent >/dev/null 2>&1 &
  sleep 1
fi

cd "$(dirname "$0")/../contracts"
PAYOUT_WALLET="$PAYOUT_WALLET" forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --broadcast --silent
RUN=broadcast/Deploy.s.sol/31337/run-latest.json
EXECUTOR=$(jq -r '.transactions[] | select(.contractName=="PayoutExecutor") | .contractAddress' "$RUN")
TOKEN=$(jq -r '.transactions[] | select(.contractName=="TestToken") | .contractAddress' "$RUN")

cat <<ENV
EVM_RPC_URL=$RPC
EVM_CHAIN_ID=31337
EVM_EXECUTOR_ADDRESS=$(cast to-check-sum-address "$EXECUTOR")
EVM_TOKENS=$(cast to-check-sum-address "$TOKEN")
EVM_PROVIDER_LABEL=anvil-local
ENV
