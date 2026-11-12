#!/usr/bin/env bash
# Builds and deploys the shared contracts to Stellar testnet, then prints the
# ids to paste into .env.
#
# Needs: Rust with the wasm32v1-none target, and the Stellar CLI.
#   brew install rustup stellar-cli && rustup default stable && rustup target add wasm32v1-none
set -euo pipefail
cd "$(dirname "$0")/../contracts"

SOURCE="${STELLAR_SOURCE:-mandate-deployer}"
WASM=target/wasm32v1-none/release

NET="--network testnet"
if ! stellar keys address "$SOURCE" >/dev/null 2>&1; then
  stellar keys generate "$SOURCE"
fi
# Friendbot funding; harmless if the account is already funded.
stellar keys fund "$SOURCE" $NET >/dev/null 2>&1 || true
ADMIN="$(stellar keys address "$SOURCE")"

stellar contract build

deploy() { # alias, wasm file, [constructor args...]
  local alias="$1" wasm="$2"
  shift 2
  if [ "$#" -gt 0 ]; then
    stellar contract deploy $NET --source "$SOURCE" --alias "$alias" --wasm "$WASM/$wasm" -- "$@"
  else
    stellar contract deploy $NET --source "$SOURCE" --alias "$alias" --wasm "$WASM/$wasm"
  fi
}

VERIFIER="$(deploy mandate_ed25519_verifier mandate_ed25519_verifier.wasm)"
LIMIT="$(deploy mandate_spending_limit mandate_spending_limit_policy.wasm)"
REGISTRY="$(deploy mandate_seller_registry mandate_seller_registry.wasm --admin "$ADMIN")"
SELLER_POLICY="$(deploy mandate_verified_seller mandate_verified_seller_policy.wasm)"

cat <<EOF

Paste into .env:
ED25519_VERIFIER_ID=$VERIFIER
SPENDING_LIMIT_POLICY_ID=$LIMIT
SELLER_REGISTRY_ID=$REGISTRY
VERIFIED_SELLER_POLICY_ID=$SELLER_POLICY

Registry admin (the attester): $ADMIN

Next (see README, "Create a mandate"):
  1. Deploy a smart account for the owner   -> SMART_ACCOUNT_ID
  2. Register the demo merchant as a verified seller
  3. node --env-file=.env scripts/create-mandate.ts      -> AGENT_CONTEXT_RULE_ID
  4. node --env-file=.env scripts/fund-smart-account.ts --amount <units>
EOF
