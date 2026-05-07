# EVM CLI Withdraw Execution

## Overview

This guide is runbook-first: discover the user's Flow streams on the resolved chain, let the user pick any subset (default = all eligible), group the selection by `SablierFlow` contract, run preflight checks, preview the batch, require explicit confirmation, then broadcast one `batch(bytes[])` per Flow contract and verify each receipt.

Each selected stream is withdrawn at its full currently-available balance (`withdrawableAmountOf`) via `withdrawMax(uint256,address)`. Partial withdrawals are opt-in: select a single stream and supply an amount, and the runbook routes that one stream through `withdraw(uint256,address,uint128)` instead. The bulk path always drains the full available amount per stream.

The skill charges no markup. The only fee paid is the on-chain protocol fee (`calculateMinFeeWei`) set by the comptroller. It may be `0`. Because `Batch.batch` `delegatecall`s into each entry and Solidity preserves `msg.value` across delegatecall, a single `msg.value = max(calculateMinFeeWei across the batch)` covers the whole group.

`Batch.batch` is **all-or-nothing**: any sub-call revert reverts the whole transaction. There is no per-stream skip event analogous to Lockup's `InvalidWithdrawalInWithdrawMultiple` — the runbook compensates with a status precheck right before broadcast.

## Execution Sequence

Use this sequence for every batch withdraw:

01. Complete [Intake & Planning Inputs](#intake--planning-inputs): wallet, optional chain, optional token symbol, optional `to` override.
02. Run [Chain Discovery](#chain-discovery) if the user did not specify a chain.
03. Run [Stream Discovery](#stream-discovery) against the Sablier Streams indexer, then pipe the result through [scripts/filter-withdrawable.sh](#drop-streams-with-nothing-to-withdraw) to drop streams with zero currently-withdrawable balance.
04. Run [Stream Selection](#stream-selection) to let the user pick any subset of the eligible streams (default: all).
05. Run [Group by Flow contract](#group-by-flow-contract) — split the selection into one batch per distinct contract address. There is one `SablierFlow` deployment per chain, so on a single-chain invocation this is normally one group.
06. Run [Access-Control Check](#access-control-check) for each group. Drop streams whose access rules the wallet doesn't satisfy; abort the group if any selected stream fails the check, because `batch` is all-or-nothing.
07. Run [Preflight Checks](#preflight-checks): per-group `MSG_VALUE` (the max `calculateMinFeeWei` across the group), a status re-read (`statusOf != VOIDED`), per-group gas estimate, and an aggregate native-balance check.
08. Build and show a single human-readable batch preview (no broadcast).
09. Require explicit user confirmation.
10. Broadcast each group with `cast send "$FLOW" "batch(bytes[])" "[$CALL1,...]" --value "$MSG_VALUE"`, sequentially. The user signs once per group.
11. For each broadcast, wait/poll up to 5 minutes for the confirmed receipt and then decode `WithdrawFromFlowStream` events from the logs to confirm one event per selected stream.
12. Direct the user to each successfully withdrawn stream on [app.sablier.com](https://app.sablier.com).

## Mandatory Guardrails

### CLI Prerequisites Check

Before running any commands, verify the required tools are installed:

```bash
for cmd in cast curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "$cmd not found."
    exit 1
  fi
done

if ! cast send --help 2>&1 | grep -q -- '--browser'; then
  echo "Your cast version does not support --browser."
  echo "Upgrade Foundry: https://getfoundry.sh/"
  exit 1
fi
```

- `cast` — required for all onchain interactions. Install Foundry at [https://getfoundry.sh/](https://getfoundry.sh/).
- `curl` — required for querying the Sablier indexer.
- `jq` — required for parsing JSON responses and transaction receipts.

### Signing Method (Mandatory)

For any signing command (`cast send`), use this hierarchy:

1. **`--browser` (preferred)** — delegates signing to the user's browser wallet extension (MetaMask, Rabby, etc.). A local server starts on port 9545 and opens a browser tab where the user approves the transaction. Private keys never touch the terminal or chat. Inform the user: *"A browser tab will open per group — approve each transaction in your wallet extension (e.g. MetaMask)."*
2. **`--private-key` (fallback)** — only if `--browser` fails at runtime (e.g. no browser available, extension error). Ask the user to provide a private key or set the `ETH_PRIVATE_KEY` environment variable. Never proactively ask the user to paste a private key in the chat.

Do not continue without a signing method.

### Confirmation Rule (Mandatory)

Always use this sequence for batch withdraws:

1. Build a single human-readable preview that lists every group and every stream in it.
2. Show the preview to the user.
3. Ask for explicit confirmation covering the entire batch.
4. Only after confirmation, run `cast send` per group.

Never broadcast before explicit user confirmation. If the user declines a signature for any group mid-flow, stop and skip the remaining groups; tell them which groups already broadcast and which were aborted.

### Receipt Wait Timeout (Mandatory)

For every broadcasted group, wait/poll for a confirmed receipt for up to **5 minutes** before treating that transaction as failed or unconfirmed. Run the loop independently per group.

```bash
RECEIPT=""
START_TIME=$(date +%s)

while true; do
  RECEIPT=$(cast receipt "$TX_HASH" --rpc-url "$RPC_URL" --json 2>/dev/null) && break

  if [ "$(($(date +%s) - START_TIME))" -ge 300 ]; then
    echo "Timed out waiting for a confirmed receipt after 5 minutes: $TX_HASH"
    exit 1
  fi

  sleep 5
done

TX_STATUS=$(echo "$RECEIPT" | jq -r '.status')
if [ "$TX_STATUS" != "0x1" ]; then
  echo "Transaction reverted: $TX_HASH"
  exit 1
fi
```

If the receipt is still unavailable after 5 minutes for a group, stop, tell the user the transaction may still be pending, and share the hash for manual follow-up. If `status` is not `0x1`, the transaction reverted — show the hash and ask the user to investigate on a block explorer. Already-confirmed groups remain confirmed; do not unwind them.

## Intake & Planning Inputs

Collect these before hitting the indexer:

- `wallet` — the address that will sign the withdraw transactions. Required.
- `chain` (optional) — name and ID resolved from [Supported Chains](#supported-chains). If omitted, [Chain Discovery](#chain-discovery) infers it from the indexer.
- `symbol` (optional) — narrows the indexer query. If omitted, all the wallet's streams on the chain are listed.
- `to` (optional) — override the recipient of the withdrawn tokens. Defaults to `OWNER` (the connected wallet). Non-recipient callers (operators, sender, etc.) can only pass `to == recipient`.
- `signing_method` — `--browser` preferred, `--private-key` fallback.

Note: the bulk path never asks for a custom withdraw amount — every selected stream is withdrawn in full at the current `withdrawableAmountOf`. Partial withdrawals are opt-in for a single-stream selection only; even then the explicit-amount path uses `withdraw(uint256,address,uint128)` for that one stream rather than `withdrawMax`.

Resolve the sender address now so subsequent indexer queries and preview lines agree with what the wallet extension reports:

```bash
OWNER=$(cast wallet address --browser)
```

If the user supplied a wallet address earlier, compare it to `$OWNER` after connection and stop with a clear error if they disagree.

## Chain Discovery

If the user did not specify a chain, query the indexer across *all* chains for the wallet and collect the distinct `chainId` values that have non-voided Flow streams where the wallet is the recipient. Sender-only streams are intentionally ignored — Flow only allows a non-recipient caller when `to == recipient`, which would relay funds to the recipient, not the caller.

```bash
INDEXER="https://indexer.hyperindex.xyz/53b7e25/v1/graphql"
WALLET_LC=$(echo "$WALLET" | tr '[:upper:]' '[:lower:]')

QUERY='query($w: String!) {
  FlowStream(
    where: {
      voided: { _eq: false },
      recipient: { _eq: $w }
    }
    limit: 500
  ) {
    chainId
  }
}'

CHAIN_IDS=$(curl -sS "$INDEXER" \
  -H 'content-type: application/json' \
  --data "$(jq -n --arg q "$QUERY" --arg w "$WALLET_LC" '{query:$q,variables:{w:$w}}')" \
  | jq -r '[.data.FlowStream[].chainId] | unique | .[]')
```

Outcomes:

- **No chain IDs returned** — stop and tell the user no active Sablier Flow streams were found for that wallet anywhere. Suggest they double-check the wallet address.
- **Exactly one chain ID** — auto-select it. Tell the user which chain was inferred before moving on.
- **2–4 chain IDs** — use `AskUserQuestion` with one option per chain (label = chain name from [Supported Chains](#supported-chains), description = chain ID).
- **More than 4 chain IDs** — list all of them as a numbered table and ask the user to reply with the chain name. `AskUserQuestion` caps at 4 options.

After resolution, set `CHAIN_ID` and look up `RPC_URL` and `FLOW` from [Supported Chains](#supported-chains). If a chain ID returned by the indexer is not in that table, check [Sablier Flow deployments](https://docs.sablier.com/guides/flow/deployments) and ask the user for an RPC URL and the `SablierFlow` contract address.

## Stream Discovery

The Sablier **Streams indexer** serves every chain and both protocols (Lockup and Flow) from a single endpoint:

```
https://indexer.hyperindex.xyz/53b7e25/v1/graphql
```

No auth header or API key is required. Query syntax is Hasura GraphQL (`_eq`, `_or`, etc.).

### Query: wallet's active Flow streams on the chain

Restrict to streams where `recipient == wallet` — Flow's access rule lets non-recipient callers only pass `to == recipient`, so sender-only streams would just relay funds to a third party and should not be presented. Filter out voided streams. If the user provided a token symbol, add it to the `where` clause.

```bash
INDEXER="https://indexer.hyperindex.xyz/53b7e25/v1/graphql"

# Without symbol filter (listing all tokens the wallet has streams in)
QUERY='query($w: String!, $c: numeric!) {
  FlowStream(
    where: {
      chainId: { _eq: $c },
      voided: { _eq: false },
      recipient: { _eq: $w }
    }
    order_by: { id: asc }
    limit: 500
  ) {
    id alias tokenId contract chainId
    sender recipient voided paused transferable
    asset { address symbol decimals }
  }
}'

RESPONSE=$(curl -sS "$INDEXER" \
  -H 'content-type: application/json' \
  --data "$(jq -n --arg q "$QUERY" --arg w "$WALLET" --argjson c "$CHAIN_ID" \
    '{query: $q, variables: {w: $w, c: $c}}')")

STREAMS=$(echo "$RESPONSE" | jq '.data.FlowStream')
```

`limit: 500` is intentional: the batch flow may legitimately surface dozens of streams. If a user has more than 500 active streams on a single chain, raise the limit or paginate.

### Drop streams with nothing to withdraw

The indexer cannot express "withdrawable > 0" directly — that value depends on `block.timestamp` against the stream's `ratePerSecond`, snapshot debt, and current balance, and the indexer only stores event-driven state. Presenting the user the whole wallet when most have `withdrawableAmountOf == 0` at the current block (e.g. paused streams, insolvent streams) wastes their attention.

Run every candidate through [scripts/filter-withdrawable.sh](../scripts/filter-withdrawable.sh), which batches `withdrawableAmountOf(uint256)` across all streams into a single `Multicall3.aggregate` call:

```bash
STREAMS=$(echo "$STREAMS" \
  | "$SKILL_DIR/scripts/filter-withdrawable.sh" \
      --rpc-url "$RPC_URL" \
      --chain-id "$CHAIN_ID")
```

The script preserves input order, adds a `.withdrawable` field (base-unit string) to each survivor, and drops zero-amount entries. Pass `--include-zero` during debugging if you need to see what was filtered out. `--chain-id` selects the correct Multicall3 deployment — the canonical address works on every Sablier chain except Abstract (2741), XDC (50), and ZKsync Era (324). The selector for `withdrawableAmountOf(uint256)` is identical on Lockup and Flow, which is why the script is shared verbatim between the two withdraw skills.

If the filtered list is empty, stop and tell the user nothing is currently available across any of their streams on this chain; do not fall back to presenting the zero-withdrawable set.

With a symbol filter add `asset: { symbol: { _eq: $s } }` inside the top-level `where`:

```
_and: [
  { chainId: { _eq: $c } },
  { voided: { _eq: false } },
  { asset: { symbol: { _eq: $s } } },
  { recipient: { _eq: $w } }
]
```

Addresses must be lowercased for comparison in the indexer; normalise with `tr '[:upper:]' '[:lower:]'` before substituting.

### Resolving an unknown token symbol

If the user did not provide a symbol, derive the distinct set from the unfiltered result:

```bash
SYMBOLS=$(echo "$STREAMS" | jq -r '[.[].asset.symbol] | unique | .[]')
```

Present the distinct symbols via `AskUserQuestion` (cap at 4 options, fall back to free-text entry beyond that), then re-filter `$STREAMS` locally by the chosen symbol. If the user just wants to "withdraw everything" they can also skip the symbol filter — the batch flow happily mixes tokens, since each stream's `asset` is independent.

### Edge cases

- **Zero streams matching** — tell the user nothing was found for that (chain, wallet[, symbol]) and stop. Suggest they double-check the chain and wallet; do not fall back to other chains.
- **Two different tokens share the same symbol on a chain** — list each match with its asset address and use `AskUserQuestion` so the user picks the correct asset.

## Stream Selection

The default is **withdraw all eligible streams on the chain**. Only ask the user to narrow the set if they explicitly say so or if the list is small enough that confirming each pick is faster than confirming a bulk action.

- **Exactly one stream matches** — auto-select it and show the user a one-line confirmation: `Selected FL4-1-42 — 1,234.56 USDC withdrawable, sender 0xabc…`. Proceed to grouping.

- **Multiple streams (≤4)** — present them as `AskUserQuestion` with `multiSelect: true`. Each option label shows `${alias} — ${withdrawable} ${symbol}`; the description includes the sender. Add a separate option `All ${N} eligible streams (recommended)` so the user can opt for the bulk action without ticking each box. **Do not** add an "Other" option — `AskUserQuestion` adds it automatically and the user can use it for free-text overrides.

- **More than 4 streams** — render a Markdown table directly in your chat reply (not in tool stdout) and ask the user to reply with `all` or a comma-separated list of indices (e.g. `1,3,7`). Do not call `AskUserQuestion` with >4 options (the tool caps at 4).

  **Render the table in the assistant message, not in a Bash `echo`/`printf`.** Most chat UIs collapse tool output by default, so a list printed from `bash` is invisible to the user. Use Bash only to compute values (formatted amounts); assemble the table as Markdown in your own response so it renders inline.

  Use a GitHub-flavored Markdown table with exactly these columns, in this order: `#`, `Stream`, `Withdrawable`, `Token`, `Sender`. Right-align numeric columns with `---:` so amounts line up. Sort rows by `id` ascending — this matches the indexer query's `order_by`, so preserve the input order. Abbreviate the sender address as `0xabcd…wxyz` and append `(you)` when it equals the signer.

  Example generators:

  ```bash
  # Format a base-unit amount and strip trailing fractional zeros so columns
  # show "0.08" / "0.5" / "100" instead of "0.080000" / "0.500000" / "100.000000".
  # Significant decimals are preserved: "0.000668" stays "0.000668".
  fmt_amount() {
    cast format-units "$1" "$2" | sed -E 's/(\.[0-9]*[1-9])0+$/\1/; s/\.0+$//'
  }
  ```

  Apply `fmt_amount` to **every** amount shown to the user — table cells, preview lines, per-token totals.

  Example table to emit in the chat reply:

  ```markdown
  |  # | Stream         | Withdrawable | Token | Sender              |
  | -: | :------------- | -----------: | :---- | :------------------ |
  |  1 | FL4-8453-2890  |    0.008233 | USDC  | 0xc517…063c         |
  |  2 | FL4-8453-2329  |       0.035 | USDC  | 0x0298…249f (you)   |
  ```

  After the table, ask: *"Reply with `all` to withdraw every row, or comma-separated row numbers (e.g. `1,3`) to pick a subset."* Validate every index is in `[1, N]` and unique; reject ambiguous input by re-prompting.

The result of this step is `SELECTED` — a JSON array of stream objects, each carrying at minimum `.contract`, `.tokenId`, `.withdrawable`, `.alias`, `.recipient`, `.sender`, and `.asset`.

## Group by Flow contract

Each `batch(bytes[])` call hits exactly one `SablierFlow` contract, so split the selection by `.contract`:

```bash
GROUPS=$(echo "$SELECTED" | jq -c '
  group_by(.contract)
  | map({
      contract: .[0].contract,
      streams: .
    })
')
```

There is one `SablierFlow` deployment per chain, so on a single-chain invocation `GROUPS` is normally a single element and the entire batch is one transaction. If the user has streams on multiple chains, run the skill once per chain — each invocation produces its own batch.

## Access-Control Check

Apply per group. The Flow access rule is a **single rule, no version dispatch** (`SablierFlow.sol:1001`):

| Caller relation to the stream                | Allowed?                    | Notes for this skill                                                                                            |
| -------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `OWNER == recipient` (NFT owner)             | Yes, with any `to`          | Default path. The indexer filter restricts surfaced streams to this case, so it is the standard branch.         |
| `OWNER` is ERC-721-approved for the streamId | Yes, with any `to`          | Operator-style approvals. If the user wants this branch, ensure they understand the approval is per-stream NFT. |
| Anyone else (sender or unrelated)            | Only when `to == recipient` | The skill defaults `to = OWNER`, so this branch is normally unreachable.                                        |

Pre-check that every selected stream's `recipient` matches `WALLET` (or that `WALLET` is approved for that NFT). Drop any stream that fails the check and warn the user. **If any stream fails after the indexer filter, abort the entire group** — `batch` is all-or-nothing, so a single unauthorized sub-call would revert the whole transaction. The defensive recipient re-check defends against indexer staleness (e.g. NFT was transferred and the indexer hasn't caught up).

## Preflight Checks

### Withdrawable amounts (per stream)

`scripts/filter-withdrawable.sh` already ran during [Stream Discovery](#stream-discovery) and stamped the live `.withdrawable` value (base units) onto each stream. Reuse those values verbatim — every selected stream is withdrawn for its full `.withdrawable` amount via `withdrawMax`:

```bash
IDS=$(echo "$GROUP" | jq -r '[.streams[].tokenId] | join(",")')
AMOUNTS=$(echo "$GROUP" | jq -r '[.streams[].withdrawable] | join(",")')
```

If you skipped the filter step (debugging, or the caller already narrowed the input), recompute via direct contract calls — but the production path always uses the filter result.

### Stream status (per group, abort-on-VOIDED)

`Batch.batch` is all-or-nothing: a single voided stream in the selection causes the whole transaction to revert at broadcast (Flow's `_withdraw` reverts on a `VOIDED` stream). Re-read `statusOf(streamId)` for every stream in the group right before broadcast — staleness between indexer and chain head can flip a stream into `VOIDED` after the runbook started.

Batch the status reads via Multicall3 to keep this to one RPC round trip per group. Build the calldata via `cast` and call `Multicall3.aggregate`:

```bash
CONTRACT=$(echo "$GROUP" | jq -r .contract)

CALL_TUPLES=()
for ID in $(echo "$GROUP" | jq -r '.streams[].tokenId'); do
  DATA=$(cast calldata "statusOf(uint256)" "$ID")
  CALL_TUPLES+=("(${CONTRACT},${DATA})")
done
CALLS="[$(IFS=,; echo "${CALL_TUPLES[*]}")]"

RAW=$(cast call "$MULTICALL" \
  "aggregate((address,bytes)[])(uint256,bytes[])" \
  "$CALLS" \
  --rpc-url "$RPC_URL")

STATUSES=$(echo "$RAW" | grep -oE '0x[0-9a-fA-F]{64}')
VOIDED_INDEX=5  # Flow.Status.VOIDED — see flow/src/types/DataTypes.sol

i=0
while IFS= read -r HEX; do
  DEC=$(cast to-dec "$HEX")
  if [ "$DEC" = "$VOIDED_INDEX" ]; then
    BAD_ID=$(echo "$GROUP" | jq -r ".streams[$i].tokenId")
    echo "Error: stream $BAD_ID is VOIDED — batch will revert. Aborting group."
    exit 1
  fi
  i=$((i + 1))
done <<< "$STATUSES"
```

`MULTICALL` is the same chain-aware address used by `filter-withdrawable.sh`. If `statusOf` returns `VOIDED` (`5`) for any stream, abort the group and tell the user. Do not silently drop the offending stream — the user explicitly selected it; surface the change so they can re-run discovery.

### Withdraw fee `MSG_VALUE` (per group)

`Batch.batch` is `payable`. The required `msg.value` is `max(calculateMinFeeWei(streamId))` across the group, **not** the sum:

```bash
MSG_VALUE=$(echo "$GROUP" | jq '.streams' \
  | "$SKILL_DIR/scripts/max-min-fee.sh" \
      --rpc-url "$RPC_URL" --chain-id "$CHAIN_ID")

# Defensive: a non-numeric MSG_VALUE will cascade into bc parser errors below.
[[ "$MSG_VALUE" =~ ^[0-9]+$ ]] || { echo "Error: MSG_VALUE not numeric: '$MSG_VALUE'"; exit 1; }
```

[scripts/max-min-fee.sh](../scripts/max-min-fee.sh) collapses the per-stream `cast call` loop into a single Multicall3 round trip — important on public RPCs (Base, Arbitrum, etc.) that throttle bursts. A per-stream loop intermittently produces empty stdout when individual calls are rate-limited, which silently propagates into the bc accumulators below and surfaces as cascading `bc: parser error` lines.

**Why MAX, not SUM.** `Batch.batch` `delegatecall`s into `address(this)` for each entry (`@sablier/evm-utils/src/Batch.sol`). Solidity preserves `msg.value` across `delegatecall`, and the inner `_withdraw` checks `msg.value >= calculateMinFeeWei(streamId)` (`SablierFlow.sol:975-985`). So a single `msg.value` covers every iteration; the contract receives the fee exactly once per outer call. Sending the SUM would still pass the contract's check but would needlessly tie up extra ETH in the contract balance — the skill always sends the MAX, so the user pays the minimum required to satisfy every per-stream fee gate. If every stream in the group has a zero fee, `MSG_VALUE` is `0` and the transaction is fee-free.

### Per-group gas estimate

Build the per-stream calldata first, then estimate gas against the outer `batch(bytes[])` entrypoint with the exact arguments the broadcast will use.

For the default `withdrawMax` path (one entry per stream):

```bash
TO="$OWNER"  # default — override only when the user explicitly redirects withdrawal

CALLDATA_ENTRIES=()
while read -r STREAM_ID; do
  CALL=$(cast calldata "withdrawMax(uint256,address)" "$STREAM_ID" "$TO")
  CALLDATA_ENTRIES+=("$CALL")
done < <(echo "$GROUP" | jq -r '.streams[].tokenId')

CALLS="[$(IFS=,; echo "${CALLDATA_ENTRIES[*]}")]"

GAS_ESTIMATE=$(cast estimate "$CONTRACT" \
  "batch(bytes[])" "$CALLS" \
  --value "$MSG_VALUE" \
  --rpc-url "$RPC_URL" --from "$OWNER")
```

For the explicit-amount path (single-stream partial withdrawal), build the entry with `withdraw(uint256,address,uint128)` instead:

```bash
CALL=$(cast calldata "withdraw(uint256,address,uint128)" "$STREAM_ID" "$TO" "$AMOUNT")
CALLS="[$CALL]"
```

You can mix `withdrawMax` and `withdraw` entries inside the same `batch` if a power user wants partials on some streams and full sweeps on others. The default path uses `withdrawMax` exclusively.

### Aggregate native-balance check

Sum the gas costs and `MSG_VALUE` across all groups; verify the wallet has enough native token to cover the entire batch:

```bash
GAS_PRICE=$(cast gas-price --rpc-url "$RPC_URL")
BALANCE=$(cast balance "$OWNER" --rpc-url "$RPC_URL")

# Validate every value before piping through bc — an empty operand silently turns
# "0 + " into a parser error and the same value cascades through every downstream
# bc invocation, producing many lines of bc: parser error.
for v in TOTAL_GAS_UNITS TOTAL_MSG_VALUE GAS_PRICE BALANCE; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || { echo "Error: $v not numeric: '${!v}'"; exit 1; }
done

# Accumulate across groups (pseudo-loop — implement per group during fee/gas calc above).
TOTAL_NEEDED=$(echo "$TOTAL_GAS_UNITS * $GAS_PRICE + $TOTAL_MSG_VALUE" | bc)

if [ "$(echo "$BALANCE < $TOTAL_NEEDED" | bc)" -eq 1 ]; then
  echo "Insufficient native balance: need $TOTAL_NEEDED wei, have $BALANCE wei"
  exit 1
fi
```

If balance is insufficient, stop and tell the user to fund their wallet before trying again. Recommend [Transak](https://transak.com/buy) as one option.

## Preview

Present only human-readable values. Do not show raw calldata or base-unit integers by default. Format amounts with the `fmt_amount` helper from [Stream Selection](#stream-selection) — `cast format-units "$AMOUNT" "$DECIMALS"` followed by trailing-zero stripping — so values display as `0.08` / `0.5` / `100` instead of `0.080000` / `0.500000` / `100.000000`. Significant decimals are preserved (e.g. `0.000668` stays `0.000668`).

The preview is a single message that lists every group and the streams in it, plus per-token totals across the entire batch and the total native-token cost (fee + estimated gas). Tell the user explicitly: **one batch tx per Flow group, all-or-nothing — if any stream becomes voided between preview and broadcast, the whole group reverts**.

Example for a wallet with one Flow group on Base (USDC and SABL streams mixed in the same batch):

```
Chain:         Base (8453)
Signer:        0xOwner…  (matches recipient)
Withdraw to:   0xOwner…  (default — same as signer)
Total fee:     0.0005 ETH    ← MAX(calculateMinFeeWei) across the group
Estimated gas: 0.0021 ETH    ← sum across all groups
Mode:          all-or-nothing — if any stream reverts, the whole batch reverts

Group 1/1 — SablierFlow
  Contract:    0x0cbfe6ce6f05c47d6243bb3818837971c6ccb46b
  Entry type:  withdrawMax(uint256,address) per stream
  Streams (3):
    FL4-8453-887  →  120 USDC      (sender 0xc517…063c, status STREAMING_SOLVENT)
    FL4-8453-902  →   45.5 USDC    (sender 0xc517…063c, status STREAMING_SOLVENT)
    FL4-8453-1027 →  1,234.56789 SABL  (sender 0xab12…cd34, status STREAMING_INSOLVENT)
  Group fee:   0.0005 ETH  ← max calculateMinFeeWei across the 3 streams

Per-token totals:
  USDC:  165.5
  SABL:  1,234.56789
```

Then show the confirmation prompt:

```text
+--------------------------------------+
| Confirm broadcast for 1 transaction? |
| Reply exactly: YES                   |
+--------------------------------------+
```

If the user does not explicitly confirm with `YES`, stop. If the batch contains multiple groups (rare for Flow — would require multiple Flow deployments on the same chain, which Sablier does not run), phrase the prompt as `Confirm broadcast for N transactions?`.

## Broadcast

Broadcast each group sequentially. The user will see one browser approval prompt per group. Capture the tx hash for each.

```bash
# Default path: withdrawMax per stream.
TX_HASH=$(cast send "$CONTRACT" \
  "batch(bytes[])" "$CALLS" \
  --value "$MSG_VALUE" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser \
  --async)
```

`$CALLS` is the comma-joined `bytes[]` array assembled in [Per-group gas estimate](#per-group-gas-estimate). Default the per-stream sub-call to `withdrawMax(uint256,address)` so the user sweeps everything available; the explicit-amount `withdraw(uint256,address,uint128)` form is opt-in for partial withdrawals.

Inform the user before each group: *"A browser tab will open — approve transaction {i}/{N} in your wallet extension (e.g. MetaMask)."* If `--browser` fails at runtime, fall back to `--private-key` as described in [Signing Method](#signing-method-mandatory). If the user declines a signature mid-flow, stop and tell them which group hashes already broadcast and which were not attempted.

## Verify Receipt

For each group, run the [Receipt Wait Timeout](#receipt-wait-timeout-mandatory) loop and capture the `RECEIPT` JSON. After confirming `status == 0x1`, decode `WithdrawFromFlowStream(uint256 indexed streamId, address indexed to, IERC20 indexed token, address caller, uint128 withdrawAmount)` events from the logs. **Expect exactly one event per stream in the group** — `Batch.batch` is all-or-nothing, so a confirmed receipt means every selected stream withdrew successfully:

```bash
TOPIC=$(cast keccak "WithdrawFromFlowStream(uint256,address,address,address,uint128)")

EVENT_COUNT=$(echo "$RECEIPT" | jq --arg t "$TOPIC" --arg c "$(echo "$CONTRACT" | tr '[:upper:]' '[:lower:]')" \
  '[.logs[] | select((.address | ascii_downcase) == $c) | select(.topics[0] == $t)] | length')

EXPECTED=$(echo "$GROUP" | jq '.streams | length')
if [ "$EVENT_COUNT" -ne "$EXPECTED" ]; then
  echo "Warning: expected $EXPECTED WithdrawFromFlowStream events, got $EVENT_COUNT"
fi

# Cross-check per-stream withdrawn amounts against the preview values.
echo "$RECEIPT" | jq -r --arg t "$TOPIC" --arg c "$(echo "$CONTRACT" | tr '[:upper:]' '[:lower:]')" '
  .logs[]
  | select((.address | ascii_downcase) == $c)
  | select(.topics[0] == $t)
  | { streamId: (.topics[1] | ltrimstr("0x") | "0x" + .),
      to:       .topics[2],
      data:     .data }
'
```

`streamId` is the first indexed topic (after `topic0`). Decode it via `cast to-dec`. The non-indexed fields (`caller`, `withdrawAmount`) are concatenated in `.data`; slice off the first 64 hex chars after `0x` for `caller`, and the next 64 for `withdrawAmount`. Compare each `withdrawAmount` against the preview's `.withdrawable` value for that stream — they should match exactly.

There is no `InvalidWithdrawalIn*` skip event in Flow. A confirmed receipt with `status == 0x1` means every sub-call in the batch executed; a per-stream failure would have reverted the whole transaction, surfaced in step 1 of the [Receipt Wait Timeout](#receipt-wait-timeout-mandatory) loop above.

After verification, list each successfully withdrawn stream with its app link. Use the `alias` returned by the indexer:

```
https://app.sablier.com/payments/stream/${ALIAS}
```

## Worked Example

A recipient with three eligible Flow streams on Base (one USDC, two SABL on the same `SablierFlow` deployment), running a single batch:

```bash
INDEXER="https://indexer.hyperindex.xyz/53b7e25/v1/graphql"
CHAIN_ID=8453
RPC_URL="https://mainnet.base.org"
WALLET="0xRecipient…"
FLOW="0x0cbfe6ce6f05c47d6243bb3818837971c6ccb46b"

OWNER=$(cast wallet address --browser)
TO="$OWNER"  # default — withdraw to recipient itself

# 1) Stream discovery (no symbol filter — let the user mix tokens)
RESPONSE=$(curl -sS "$INDEXER" \
  -H 'content-type: application/json' \
  --data "$(jq -n \
    --arg q 'query($w:String!,$c:numeric!){FlowStream(where:{chainId:{_eq:$c},voided:{_eq:false},recipient:{_eq:$w}} order_by:{id:asc} limit:500){id alias tokenId contract sender recipient asset{address symbol decimals}}}' \
    --arg w "$(echo "$WALLET" | tr '[:upper:]' '[:lower:]')" \
    --argjson c "$CHAIN_ID" \
    '{query:$q,variables:{w:$w,c:$c}}')")

# 2) Drop zero-withdrawable streams via Multicall3 (one RPC round trip)
STREAMS=$(echo "$RESPONSE" | jq '.data.FlowStream' \
  | "$SKILL_DIR/scripts/filter-withdrawable.sh" \
      --rpc-url "$RPC_URL" \
      --chain-id "$CHAIN_ID")

# 3) Default selection: all eligible streams. SELECTED == STREAMS for the bulk path.
SELECTED="$STREAMS"

# 4) Group by Flow contract (one per chain)
GROUPS=$(echo "$SELECTED" | jq -c '
  group_by(.contract)
  | map({contract: .[0].contract, streams: .})
')

# 5) Per-group fee + status precheck + gas estimation
TOTAL_GAS_UNITS=0
TOTAL_MSG_VALUE=0
GAS_PRICE=$(cast gas-price --rpc-url "$RPC_URL")
declare -a GROUP_PLANS=()

for ROW in $(echo "$GROUPS" | jq -c '.[]'); do
  CONTRACT=$(echo "$ROW" | jq -r .contract)

  # Status precheck: abort if any stream is VOIDED.
  CALL_TUPLES=()
  for ID in $(echo "$ROW" | jq -r '.streams[].tokenId'); do
    DATA=$(cast calldata "statusOf(uint256)" "$ID")
    CALL_TUPLES+=("(${CONTRACT},${DATA})")
  done
  CALLS_STATUS="[$(IFS=,; echo "${CALL_TUPLES[*]}")]"
  RAW=$(cast call "$MULTICALL" \
    "aggregate((address,bytes)[])(uint256,bytes[])" \
    "$CALLS_STATUS" \
    --rpc-url "$RPC_URL")
  for HEX in $(echo "$RAW" | grep -oE '0x[0-9a-fA-F]{64}'); do
    [ "$(cast to-dec "$HEX")" = "5" ] && { echo "Aborting: a stream is VOIDED"; exit 1; }
  done

  # Fee.
  MSG_VALUE=$(echo "$ROW" | jq '.streams' \
    | "$SKILL_DIR/scripts/max-min-fee.sh" \
        --rpc-url "$RPC_URL" --chain-id "$CHAIN_ID")
  [[ "$MSG_VALUE" =~ ^[0-9]+$ ]] || { echo "Error: MSG_VALUE not numeric: '$MSG_VALUE'"; exit 1; }

  # Build the bytes[] entries (default path: withdrawMax per stream).
  CALLDATA_ENTRIES=()
  for ID in $(echo "$ROW" | jq -r '.streams[].tokenId'); do
    CALL=$(cast calldata "withdrawMax(uint256,address)" "$ID" "$TO")
    CALLDATA_ENTRIES+=("$CALL")
  done
  CALLS="[$(IFS=,; echo "${CALLDATA_ENTRIES[*]}")]"

  # Gas estimate against the outer batch entrypoint.
  GAS_ESTIMATE=$(cast estimate "$CONTRACT" \
    "batch(bytes[])" "$CALLS" \
    --value "$MSG_VALUE" \
    --rpc-url "$RPC_URL" --from "$OWNER")
  [[ "$GAS_ESTIMATE" =~ ^[0-9]+$ ]] || { echo "Error: GAS_ESTIMATE not numeric: '$GAS_ESTIMATE'"; exit 1; }

  TOTAL_GAS_UNITS=$((TOTAL_GAS_UNITS + GAS_ESTIMATE))
  TOTAL_MSG_VALUE=$(echo "$TOTAL_MSG_VALUE + $MSG_VALUE" | bc)
  GROUP_PLANS+=("$CONTRACT|$CALLS|$MSG_VALUE")
done

# 6) Aggregate balance check
BALANCE=$(cast balance "$OWNER" --rpc-url "$RPC_URL")
TOTAL_NEEDED=$(echo "$TOTAL_GAS_UNITS * $GAS_PRICE + $TOTAL_MSG_VALUE" | bc)
if [ "$(echo "$BALANCE < $TOTAL_NEEDED" | bc)" -eq 1 ]; then
  echo "Insufficient native balance: need $TOTAL_NEEDED wei, have $BALANCE wei"
  exit 1
fi

# 7) Preview + YES confirmation omitted for brevity

# 8) Broadcast each group
for PLAN in "${GROUP_PLANS[@]}"; do
  IFS='|' read -r CONTRACT CALLS MSG_VALUE <<< "$PLAN"

  TX_HASH=$(cast send "$CONTRACT" \
    "batch(bytes[])" "$CALLS" \
    --value "$MSG_VALUE" \
    --rpc-url "$RPC_URL" --from "$OWNER" --browser --async)

  echo "Broadcasted: $TX_HASH"
  # Poll receipt (see "Receipt Wait Timeout" loop), then decode
  # WithdrawFromFlowStream events as shown in "Verify Receipt".
done

# 9) Per-stream app links
echo "$SELECTED" | jq -r '.[] | "https://app.sablier.com/payments/stream/" + .alias'
```

## Supported Chains

The `contract` address returned by the indexer is always the correct address for the stream's `SablierFlow` deployment, so the table below is primarily for resolving `CHAIN_ID`, a default RPC URL, and the canonical `SablierFlow` address per chain.

UI support note:

- The Flow v3.0 UI alias is `FL4`, so supported payment links use `https://app.sablier.com/payments/stream/FL4-${CHAIN_ID}-${STREAM_ID}` (or `https://app.sablier.com/payments/stream/${ALIAS}` directly).

| Chain         | Chain ID   | Native Asset | SablierFlow (withdraw)                       | RPC URL                                          |
| ------------- | ---------- | ------------ | -------------------------------------------- | ------------------------------------------------ |
| Ethereum      | `1`        | ETH          | `0x844344cd871b28221d725ece9630e8bde4e3a181` | `https://ethereum-rpc.publicnode.com`            |
| Abstract      | `2741`     | ETH          | `0x2fac86e709bac0d970c0e103d3b9580d2df4be5d` | `https://api.mainnet.abs.xyz`                    |
| Arbitrum      | `42161`    | ETH          | `0xa70b8555157500b11f41a37dd93f4b4e997d583d` | `https://arb1.arbitrum.io/rpc`                   |
| Avalanche     | `43114`    | AVAX         | `0x980878b890e755c788bce5db7725bcc6df76bf5b` | `https://api.avax.network/ext/bc/C/rpc`          |
| Base          | `8453`     | ETH          | `0x0cbfe6ce6f05c47d6243bb3818837971c6ccb46b` | `https://mainnet.base.org`                       |
| Berachain     | `80094`    | BERA         | `0x1794f514d7c1d771055ffd2a880148f619107945` | `https://rpc.berachain.com`                      |
| BNB Chain     | `56`       | BNB          | `0xa9b86b045caedb791af729f6c15435b978c34f7f` | `https://bsc-dataseed1.bnbchain.org`             |
| Chiliz        | `88888`    | CHZ          | `0x4d3cecb8eeddd5e69c201017e884ae5e8338474f` | `https://rpc.chiliz.com`                         |
| Denergy       | `369369`   | WATT         | `0x0B5f82Fa564D2B7F97d6048308167aA8B710e20E` | `https://rpc.d.energy`                           |
| Gnosis        | `100`      | xDAI         | `0xb3a9a358794b101962a3741ef882b367e9e56c72` | `https://rpc.gnosischain.com`                    |
| HyperEVM      | `999`      | HYPE         | `0x91B9B0e3be6EeE0556f1cf5bCba2f2673AA28dFE` | `https://rpc.hyperliquid.xyz/evm`                |
| Lightlink     | `1890`     | ETH          | `0x95f0d947befaecafa8b1e89bbada723d81783d4b` | `https://replicator.phoenix.lightlink.io/rpc/v1` |
| Linea Mainnet | `59144`    | ETH          | `0x7a92392b7c35610a861f82c42043e6705979369c` | `https://rpc.linea.build`                        |
| Mode          | `34443`    | ETH          | `0x5a51fd153874429f4cad36cc54560beffeead6df` | `https://mainnet.mode.network`                   |
| Monad         | `143`      | MON          | `0x95004df5abe86a246664d8f5fb2683f24df768d1` | `https://rpc.monad.xyz`                          |
| Morph         | `2818`     | ETH          | `0x5ba4cc0a1014faf0967624f3f1c3d63b9ffeb287` | `https://rpc.morphl2.io`                         |
| OP Mainnet    | `10`       | ETH          | `0xe8a69dabae3003df4cb0901389766c4b2d34c2eb` | `https://mainnet.optimism.io`                    |
| Polygon       | `137`      | POL          | `0x20080f7e2d58b5cfc4e6d997c841999e3416843c` | `https://polygon-bor-rpc.publicnode.com`         |
| Scroll        | `534352`   | ETH          | `0xd3dec781af1f5ccb828f97d3e5deb86f6efc5e5a` | `https://rpc.scroll.io`                          |
| Sonic         | `146`      | S            | `0x1598ed7ffb006a4e233268e7846faa9e17ac9c16` | `https://rpc.soniclabs.com`                      |
| Superseed     | `5330`     | ETH          | `0xa80de83ea03335396161bb267e1250fb5cc99cdf` | `https://mainnet.superseed.xyz`                  |
| Unichain      | `130`      | ETH          | `0x12a6a5f809d451d29e4c1a6bca31b88c914100ac` | `https://mainnet.unichain.org`                   |
| XDC           | `50`       | XDC          | `0x2a89ddeafebf51cb8517da2d00df2365bf3ef49e` | `https://rpc.xinfin.network`                     |
| ZKsync Era    | `324`      | ETH          | `0xa1b75ac1e36504c93279c69c2583ff0c73eb036b` | `https://mainnet.era.zksync.io`                  |
| Sepolia       | `11155111` | ETH          | `0xbd9326f6366c95e39bd8ef825c1b2f2ee0dceaa1` | `https://ethereum-sepolia-rpc.publicnode.com`    |

Ethereum can also be referred to as "Mainnet".
