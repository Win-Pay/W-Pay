#!/usr/bin/env bash
# Builds every Soroban contract to WASM.
#
# The Soroban SDK refuses to build with plain cargo unless it is told that the
# surrounding build system provides its spec-shaking support (normally done by
# `stellar contract build`). We set that flag explicitly so the build is
# reproducible in CI without the Stellar CLI, and use the `wasm32v1-none`
# target required by the SDK (Rust >= 1.84).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/packages/contracts/Cargo.toml"
TARGET="wasm32v1-none"
OUT="$ROOT/packages/contracts/target/$TARGET/release"

export SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1

CONTRACTS=(
  wpay-payment-router
  wpay-invoice-manager
  wpay-escrow-manager
  wpay-refund-manager
  wpay-subscription-manager
  wpay-settlement-manager
  wpay-merchant-registry
  wpay-treasury-vault
  wpay-fee-manager
  wpay-configuration-manager
  wpay-emergency-pause
  wpay-role-manager
  wpay-upgrade-manager
  wpay-price-oracle
  wpay-governance
  wpay-impact-nft
)

if ! rustup target list --installed | grep -qx "$TARGET"; then
  echo "error: Rust target $TARGET is not installed. Run: rustup target add $TARGET" >&2
  exit 1
fi

for crate in "${CONTRACTS[@]}"; do
  echo "==> building $crate"
  cargo build --manifest-path "$MANIFEST" -p "$crate" --target "$TARGET" --release
done

echo
echo "WASM artifacts in $OUT:"
ls -lh "$OUT"/*.wasm
