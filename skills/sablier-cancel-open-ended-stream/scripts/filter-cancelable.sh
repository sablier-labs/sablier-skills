#!/usr/bin/env bash
#
# filter-cancelable.sh — Batch-query Sablier Flow `statusOf` and
# `refundableAmountOf` via Multicall3, drop voided streams, and stamp
# the live refundable balance onto every survivor. One RPC round trip
# per chunk regardless of stream count; drop-in replacement for two
# per-stream `cast call` loops.
#
# Note: this script is intentionally NOT byte-identical to its sibling
# in skills/sablier-cancel-vesting/scripts/filter-cancelable.sh. The
# cancelability/voidedness selectors differ between Lockup and Flow:
#   Lockup → isCancelable(uint256)
#   Flow   → statusOf(uint256)
# Treat the two scripts as parallel-but-divergent and review them
# manually whenever one changes.
#
# Input (stdin or --input FILE):
#   A JSON array of stream objects. Each element MUST contain:
#     .contract  — SablierFlow contract address (string, 0x-prefixed)
#     .tokenId   — Stream token id (decimal string)
#   Any extra fields are passed through untouched.
#
# Output (stdout):
#   A JSON array in the same input order, filtered to entries where
#   statusOf != 5 (VOIDED). Each survivor is augmented with a
#   `.refundable` field (base-unit decimal string) and a `.status`
#   field (decimal int). Zero-refundable streams are kept (a recipient
#   can still void them, and a sender's refundable can be 0 if
#   everything is already streamed). Use --include-voided to keep
#   VOIDED entries as well (debugging).
#
# Usage:
#   filter-cancelable.sh --rpc-url <url> [--chain-id <id>] [--multicall <addr>]
#                        [--chunk <n>] [--input <file>] [--include-voided]
#
# Example:
#   curl -sS "$INDEXER" ... \
#     | jq '.data.FlowStream' \
#     | scripts/filter-cancelable.sh --rpc-url https://mainnet.base.org \
#                                    --chain-id 8453
#
# Notes:
#   - Multicall3 is deterministically deployed at
#     0xcA11bde05977b3631167028862bE2a173976CA11 on every EVM-equivalent chain
#     Sablier supports, with these exceptions (auto-selected when --chain-id
#     is provided, or pass --multicall to override explicitly):
#       Abstract   (2741) → 0xAa4De41dba0Ca5dCBb288b7cC6b708F3aaC759E7
#       XDC        (50)   → 0x0B1795ccA8E4eC4df02346a082df54D437F8D9aF
#       ZKsync Era (324)  → 0xF9cda624FBC7e059355ce98a31693d299FACd963
#   - `aggregate` is non-tolerant: any reverting subcall fails the whole
#     batch. That is deliberate — every non-depleted Sablier Flow stream
#     supports both `statusOf` and `refundableAmountOf`, so a revert
#     signals a real problem (wrong chain, corrupted input, indexer bug)
#     worth surfacing loudly.
#   - Requires: cast, jq.

set -euo pipefail

CANONICAL_MULTICALL="0xcA11bde05977b3631167028862bE2a173976CA11"

# Chain IDs whose canonical Multicall3 deployment is not at the default
# address. Mirrors viem's per-chain overrides for the chains Sablier supports
# (see ~/sablier/sdk/src/evm/chains/specs.ts).
multicall_for_chain() {
  case "$1" in
    2741) echo "0xAa4De41dba0Ca5dCBb288b7cC6b708F3aaC759E7" ;; # Abstract
    50)   echo "0x0B1795ccA8E4eC4df02346a082df54D437F8D9aF" ;; # XDC
    324)  echo "0xF9cda624FBC7e059355ce98a31693d299FACd963" ;; # ZKsync Era
    *)    echo "$CANONICAL_MULTICALL" ;;
  esac
}

CHUNK=100
RPC_URL=""
CHAIN_ID=""
MULTICALL=""
INPUT=""
INCLUDE_VOIDED=0

usage() {
  sed -n '3,55p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --rpc-url)        RPC_URL="$2"; shift 2 ;;
    --chain-id)       CHAIN_ID="$2"; shift 2 ;;
    --multicall)      MULTICALL="$2"; shift 2 ;;
    --chunk)          CHUNK="$2"; shift 2 ;;
    --input)          INPUT="$2"; shift 2 ;;
    --include-voided) INCLUDE_VOIDED=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$RPC_URL" ]; then
  echo "Error: --rpc-url is required" >&2
  exit 2
fi

# --multicall wins. Otherwise derive from --chain-id (falling back to the
# canonical address for any chain ID not in the override table).
if [ -z "$MULTICALL" ]; then
  MULTICALL=$(multicall_for_chain "$CHAIN_ID")
fi

for cmd in cast jq; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "$cmd not found" >&2
    exit 1
  }
done

if [ -n "$INPUT" ]; then
  STREAMS=$(cat "$INPUT")
else
  STREAMS=$(cat)
fi

if ! echo "$STREAMS" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "Error: input must be a JSON array" >&2
  exit 2
fi

COUNT=$(echo "$STREAMS" | jq 'length')
if [ "$COUNT" -eq 0 ]; then
  echo "[]"
  exit 0
fi

mapfile -t CONTRACTS < <(echo "$STREAMS" | jq -r '.[].contract // ""')
mapfile -t TOKEN_IDS < <(echo "$STREAMS" | jq -r '.[].tokenId // ""')

for idx in $(seq 0 $((COUNT - 1))); do
  if [ -z "${CONTRACTS[$idx]}" ] || [ -z "${TOKEN_IDS[$idx]}" ]; then
    echo "Error: stream at index $idx is missing .contract or .tokenId" >&2
    exit 2
  fi
done

# Two parallel arrays — one entry per stream, indexed identically to the input.
STATUSES=()
REFUNDABLES=()

i=0
while [ "$i" -lt "$COUNT" ]; do
  END=$((i + CHUNK))
  [ "$END" -gt "$COUNT" ] && END="$COUNT"

  # Build calldata for both selectors per stream. Multicall3 returns results
  # in the same order they were submitted; we interleave (statusOf, refundable)
  # per stream so we can decode them pair-wise below.
  CALL_TUPLES=()
  for j in $(seq "$i" $((END - 1))); do
    DATA_STATUS=$(cast calldata "statusOf(uint256)" "${TOKEN_IDS[$j]}")
    DATA_REFUNDABLE=$(cast calldata "refundableAmountOf(uint256)" "${TOKEN_IDS[$j]}")
    CALL_TUPLES+=("(${CONTRACTS[$j]},${DATA_STATUS})")
    CALL_TUPLES+=("(${CONTRACTS[$j]},${DATA_REFUNDABLE})")
  done
  CALLS="[$(IFS=,; echo "${CALL_TUPLES[*]}")]"

  RAW=$(cast call "$MULTICALL" \
    "aggregate((address,bytes)[])(uint256,bytes[])" \
    "$CALLS" \
    --rpc-url "$RPC_URL")

  # cast prints the (uint256, bytes[]) return on two lines. Each bytes entry
  # is an ABI-padded uint256 (exactly 64 hex chars). Contract addresses in
  # the output are 40 chars, so this length-anchored regex isolates return
  # data cleanly.
  CHUNK_HEXES=$(echo "$RAW" | grep -oE '0x[0-9a-fA-F]{64}' || true)
  GOT=$(printf '%s\n' "$CHUNK_HEXES" | grep -c . || true)
  WANT=$(((END - i) * 2))
  if [ "$GOT" -ne "$WANT" ]; then
    echo "Error: Multicall3 returned $GOT entries, expected $WANT" >&2
    echo "Raw output:" >&2
    echo "$RAW" >&2
    exit 1
  fi

  # Decode pair-wise: every two entries correspond to one stream. Validate
  # each `cast to-dec` output is a pure decimal integer before stashing it —
  # the downstream `STATUSES_JSON` pipeline pipes through `jq -R 'tonumber'`,
  # which would throw a cryptic error if cast ever surfaced non-numeric text
  # (e.g. an unexpected error string).
  pair=0
  while IFS= read -r HEX; do
    DEC=$(cast to-dec "$HEX")
    [[ "$DEC" =~ ^[0-9]+$ ]] || {
      echo "Error: cast to-dec returned non-decimal output for $HEX: '$DEC'" >&2
      exit 1
    }
    if [ "$pair" -eq 0 ]; then
      STATUSES+=("$DEC")
      pair=1
    else
      REFUNDABLES+=("$DEC")
      pair=0
    fi
  done <<< "$CHUNK_HEXES"

  i=$END
done

STATUSES_JSON=$(printf '%s\n' "${STATUSES[@]}" | jq -R 'tonumber' | jq -s .)
REFUNDABLES_JSON=$(printf '%s\n' "${REFUNDABLES[@]}" | jq -R . | jq -s .)

# Flow.Status.VOIDED == 5. See flow/src/types/DataTypes.sol.
# shellcheck disable=SC2016 # $k, $statuses, $refundables are jq variables, not shell variables.
JQ_FILTER='[range(0; length) as $k | .[$k] + {status: $statuses[$k], refundable: $refundables[$k]}]'
if [ "$INCLUDE_VOIDED" -eq 0 ]; then
  JQ_FILTER="${JQ_FILTER} | map(select(.status != 5))"
fi

echo "$STREAMS" | jq \
  --argjson statuses "$STATUSES_JSON" \
  --argjson refundables "$REFUNDABLES_JSON" \
  "$JQ_FILTER"
