# EVM CLI Cancel Execution

## Overview

This guide is runbook-first: discover the user's sender-side streams on the resolved chain, drop non-cancelable and zero-refundable streams, let the user pick any subset (default = all eligible), group by Lockup contract for display purposes only, run preflight checks, preview the per-stream transactions, require explicit confirmation, then broadcast one `cancel(uint256)` transaction per selected stream and verify each receipt for the `CancelLockupStream` event.

Each selected stream becomes its own broadcast — the skill does not use `cancelMultiple`. The function signature `cancel(uint256)` is unified across Lockup v1.0 → v4.0, so no version dispatch is required for the call itself.

The skill charges no markup. Cancellation is free at the protocol level — `cancel(uint256)` is non-payable on every Lockup version, so `MSG_VALUE = 0` always.

## Execution Sequence

Use this sequence for every cancel run:

01. Complete [Intake & Planning Inputs](#intake--planning-inputs): wallet, optional chain, optional token symbol.
02. Run [Chain Discovery](#chain-discovery) if the user did not specify a chain.
03. Run [Stream Discovery](#stream-discovery) against the Sablier Streams indexer, then pipe the result through [scripts/filter-cancelable.sh](#drop-non-cancelable-and-zero-refundable-streams) to drop non-cancelable streams and streams with zero refundable balance.
04. Run [Stream Selection](#stream-selection) to let the user pick any subset of the eligible streams (default: all).
05. Treat each selected stream as its own transaction. Group by Lockup contract for **display purposes only** — `cancel(uint256)` is per-stream, so the preview groups streams by contract just so the user sees how many distinct contracts are in play.
06. Run [Access-Control Check](#access-control-check) per stream. Drop any stream where the wallet is not the sender (defensive — should be unreachable given the indexer filter).
07. Run [Preflight Checks](#preflight-checks): per-stream gas estimate and an aggregate native-balance check. There is no `MSG_VALUE` branch — `cancel(uint256)` is non-payable on every Lockup version.
08. Build and show a single human-readable preview that lists every stream and its refundable amount (no broadcast).
09. Require explicit user confirmation.
10. Broadcast each stream with `cast send`, sequentially. The user signs once per stream.
11. For each broadcast, wait/poll up to 5 minutes for the confirmed receipt and then decode the `CancelLockupStream` event from the logs to confirm the cancellation amount.
12. Direct the user to each successfully canceled stream on [app.sablier.com](https://app.sablier.com).

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

1. **`--browser` (preferred)** — delegates signing to the user's browser wallet extension (MetaMask, Rabby, etc.). A local server starts on port 9545 and opens a browser tab where the user approves the transaction. Private keys never touch the terminal or chat. Inform the user: *"A browser tab will open per stream — approve each transaction in your wallet extension (e.g. MetaMask)."*
2. **`--private-key` (fallback)** — only if `--browser` fails at runtime (e.g. no browser available, extension error). Ask the user to provide a private key or set the `ETH_PRIVATE_KEY` environment variable. Never proactively ask the user to paste a private key in the chat.

Do not continue without a signing method.

### Confirmation Rule (Mandatory)

Always use this sequence for cancellations:

1. Build a single human-readable preview that lists every stream the runbook is about to cancel.
2. Show the preview to the user.
3. Ask for explicit confirmation covering the entire set.
4. Only after confirmation, run `cast send` per stream.

Never broadcast before explicit user confirmation. If the user declines a signature for any stream mid-flow, stop and skip the remaining streams; tell them which streams already broadcast and which were aborted.

### Receipt Wait Timeout (Mandatory)

For every broadcasted stream, wait/poll for a confirmed receipt for up to **5 minutes** before treating that transaction as failed or unconfirmed. Run the loop independently per stream.

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

If the receipt is still unavailable after 5 minutes for a stream, stop, tell the user the transaction may still be pending, and share the hash for manual follow-up. If `status` is not `0x1`, the transaction reverted — show the hash and ask the user to investigate on a block explorer. Already-confirmed cancellations remain confirmed; do not unwind them.

## Intake & Planning Inputs

Collect these before hitting the indexer:

- `wallet` — the sender address that will sign each cancel transaction. Required.
- `chain` (optional) — name and ID resolved from [Supported Chains](#supported-chains). If omitted, [Chain Discovery](#chain-discovery) infers it from the indexer.
- `symbol` (optional) — narrows the indexer query. If omitted, all the wallet's sender-side streams on the chain are listed.
- `signing_method` — `--browser` preferred, `--private-key` fallback.

Note: the skill never asks for a custom cancel amount. `cancel(uint256)` is amount-less — it stops vesting at the current block, sends the unvested remainder back to the sender, and leaves the already-vested portion claimable by the recipient.

Resolve the sender address now so subsequent indexer queries and preview lines agree with what the wallet extension reports:

```bash
OWNER=$(cast wallet address --browser)
```

If the user supplied a wallet address earlier (`WALLET`), compare it to `$OWNER` after connection and stop with a clear error if they disagree. Lowercase both sides before comparing — `cast wallet address` returns a checksummed address while user input may be lowercase:

```bash
if [ -n "${WALLET:-}" ]; then
  WALLET_LC=$(echo "$WALLET" | tr '[:upper:]' '[:lower:]')
  OWNER_LC=$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')
  if [ "$WALLET_LC" != "$OWNER_LC" ]; then
    echo "Connected wallet ($OWNER) does not match the wallet you supplied ($WALLET)." >&2
    exit 1
  fi
fi
```

## Chain Discovery

If the user did not specify a chain, query the indexer across *all* chains for the wallet and collect the distinct `chainId` values that have non-canceled, non-depleted streams where the wallet is the sender. The wallet is the sender — only senders can cancel — so recipient-only streams are intentionally ignored.

```bash
INDEXER="https://indexer.hyperindex.xyz/53b7e25/v1/graphql"
WALLET_LC=$(echo "$WALLET" | tr '[:upper:]' '[:lower:]')

QUERY='query($w: String!) {
  LockupStream(
    where: {
      canceled: { _eq: false },
      depleted: { _eq: false },
      sender: { _eq: $w }
    }
    limit: 500
  ) {
    chainId
  }
}'

CHAIN_IDS=$(curl -sS "$INDEXER" \
  -H 'content-type: application/json' \
  --data "$(jq -n --arg q "$QUERY" --arg w "$WALLET_LC" '{query:$q,variables:{w:$w}}')" \
  | jq -r '[.data.LockupStream[].chainId] | unique | .[]')
```

Outcomes:

- **No chain IDs returned** — stop and tell the user no active sender-side Sablier streams were found for that wallet anywhere. Suggest they double-check the wallet address.
- **Exactly one chain ID** — auto-select it. Tell the user which chain was inferred before moving on.
- **2–4 chain IDs** — use `AskUserQuestion` with one option per chain (label = chain name from [Supported Chains](#supported-chains), description = chain ID).
- **More than 4 chain IDs** — list all of them as a numbered table and ask the user to reply with the chain name. `AskUserQuestion` caps at 4 options.

After resolution, set `CHAIN_ID` and look up `RPC_URL` from [Supported Chains](#supported-chains). If a chain ID returned by the indexer is not in that table, check [Sablier Lockup deployments](https://docs.sablier.com/guides/lockup/deployments) and ask the user for an RPC URL.

## Stream Discovery

The Sablier **Streams indexer** serves every chain and every Lockup version from a single endpoint:

```
https://indexer.hyperindex.xyz/53b7e25/v1/graphql
```

No auth header or API key is required. Query syntax is Hasura GraphQL (`_eq`, `_or`, etc.).

### Query: wallet's active sender-side streams on the chain

Restrict to streams where `sender == wallet` — only senders can cancel. Filter out canceled and depleted streams. If the user provided a token symbol, add it to the `where` clause.

```bash
INDEXER="https://indexer.hyperindex.xyz/53b7e25/v1/graphql"

# Without symbol filter (listing all tokens the wallet has sender-side streams in)
QUERY='query($w: String!, $c: numeric!) {
  LockupStream(
    where: {
      chainId: { _eq: $c },
      canceled: { _eq: false },
      depleted: { _eq: false },
      sender: { _eq: $w }
    }
    order_by: { endTime: asc }
    limit: 500
  ) {
    id alias tokenId contract chainId version
    sender recipient cancelable canceled depleted
    withdrawnAmount intactAmount
    startTime endTime
    asset { address symbol decimals }
  }
}'

RESPONSE=$(curl -sS "$INDEXER" \
  -H 'content-type: application/json' \
  --data "$(jq -n --arg q "$QUERY" --arg w "$WALLET" --argjson c "$CHAIN_ID" \
    '{query: $q, variables: {w: $w, c: $c}}')")

STREAMS=$(echo "$RESPONSE" | jq '.data.LockupStream')
```

`limit: 500` is intentional: a single sender may legitimately have dozens of active streams. If a user has more than 500 active sender-side streams on a single chain, raise the limit or paginate.

### Drop non-cancelable and zero-refundable streams

The indexer's `cancelable` boolean is set at stream creation but does not reflect post-creation overrides; the runbook re-checks `isCancelable(streamId)` on-chain to be safe. The indexer also cannot express "refundable > 0" directly — that depends on `block.timestamp` against the stream's schedule. Presenting the user the whole sender-side wallet (e.g. 50 streams) when most are non-cancelable or fully vested wastes their attention.

Run every candidate through [scripts/filter-cancelable.sh](../scripts/filter-cancelable.sh), which batches `isCancelable(uint256)` and `refundableAmountOf(uint256)` across all streams into a single `Multicall3.aggregate` call:

```bash
STREAMS=$(echo "$STREAMS" \
  | "$SKILL_DIR/scripts/filter-cancelable.sh" \
      --rpc-url "$RPC_URL" \
      --chain-id "$CHAIN_ID")
```

The script preserves input order, drops streams where `isCancelable == false`, drops streams where `refundableAmountOf == 0`, and stamps `.refundable` (base-unit string) and `.cancelable: true` onto every survivor. Pass `--include-zero` during debugging if you need to see zero-refundable but cancelable entries. `--chain-id` selects the correct Multicall3 deployment — the canonical address works on every Sablier chain except Abstract (2741), XDC (50), and ZKsync Era (324).

Empty-list outcomes:

- **Filter dropped every candidate because they are all non-cancelable** — stop and tell the user: *"None of these vesting streams are cancelable — refunding is not possible. Cancellation was disabled at stream creation."*
- **Filter dropped every candidate because every cancelable stream has zero refundable** — stop and tell the user every active stream is fully vested with nothing left to recover, so there is nothing to cancel.
- **Filter is empty for any other reason** — tell the user nothing matched and stop; do not fall back to presenting non-cancelable streams.

With a symbol filter add `asset: { symbol: { _eq: $s } }` inside the top-level `where`:

```
_and: [
  { chainId: { _eq: $c } },
  { canceled: { _eq: false } },
  { depleted: { _eq: false } },
  { asset: { symbol: { _eq: $s } } },
  { sender: { _eq: $w } }
]
```

Addresses must be lowercased for comparison in the indexer; normalise with `tr '[:upper:]' '[:lower:]'` before substituting.

### Resolving an unknown token symbol

If the user did not provide a symbol, derive the distinct set from the unfiltered result:

```bash
SYMBOLS=$(echo "$STREAMS" | jq -r '[.[].asset.symbol] | unique | .[]')
```

Present the distinct symbols via `AskUserQuestion` (cap at 4 options, fall back to free-text entry beyond that), then re-filter `$STREAMS` locally by the chosen symbol. If the user just wants to "cancel everything" they can also skip the symbol filter — the per-stream flow happily mixes tokens.

### Edge cases

- **Zero streams matching** — tell the user nothing was found for that (chain, wallet[, symbol]) and stop. Suggest they double-check the chain and wallet; do not fall back to other chains.
- **Two different tokens share the same symbol on a chain** — list each match with its asset address and use `AskUserQuestion` so the user picks the correct asset.

## Stream Selection

The default is **cancel all eligible streams on the chain**. Only ask the user to narrow the set if they explicitly say so or if the list is small enough that confirming each pick is faster than confirming a bulk action.

- **Exactly one stream matches** — auto-select it and show the user a one-line confirmation: `Selected LK3-1-42 — 1,234.56 USDC refundable, recipient 0xabc…`. Proceed to the per-stream tx assembly.

- **Multiple streams (≤4)** — present them as `AskUserQuestion` with `multiSelect: true`. Each option label shows `${alias} — ${refundable} ${symbol}`; the description includes the recipient and the stream end date. Add a separate option `All ${N} eligible streams (recommended)` so the user can opt for the bulk action without ticking each box. **Do not** add an "Other" option — `AskUserQuestion` adds it automatically and the user can use it for free-text overrides.

- **More than 4 streams** — render a Markdown table directly in your chat reply (not in tool stdout) and ask the user to reply with `all` or a comma-separated list of indices (e.g. `1,3,7`). Do not call `AskUserQuestion` with >4 options (the tool caps at 4).

  **Render the table in the assistant message, not in a Bash `echo`/`printf`.** Most chat UIs collapse tool output by default, so a list printed from `bash` is invisible to the user. Use Bash only to compute values (timestamps, formatted amounts); assemble the table as Markdown in your own response so it renders inline.

  Use a GitHub-flavored Markdown table with exactly these columns, in this order: `#`, `Stream`, `Refundable to you`, `Total Vesting`, `Ends`, `Recipient`. The `Total Vesting` column is the indexer's `intactAmount` (`depositAmount - withdrawnAmount`) — i.e. the total tokens still held in the stream for the recipient, both already unlocked and still vesting. Right-align numeric columns with `---:` so amounts line up. Sort rows by `endTime` ascending (earliest end first) — this matches the indexer query's `order_by`, so preserve the input order. Format `Ends` as `Mon DD, YYYY` (e.g. `Oct 12, 2027`) — never `YYYY-MM-DD`. Abbreviate the recipient address as `0xabcd…wxyz`.

  Example generators:

  ```bash
  ENDS=$(date -u -r "$END_TIME" "+%b %d, %Y" 2>/dev/null || date -u -d "@$END_TIME" "+%b %d, %Y")

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
  |  # | Stream         | Refundable to you |   Total Vesting | Ends         | Recipient           |
  | -: | :------------- | ----------------: | --------------: | :----------- | :------------------ |
  |  1 | LK3-8453-2890  |     0.008233 USDC |  0.008233 USDC  | Mar 29, 2026 | 0xc517…063c         |
  |  2 | LK3-8453-2329  |        0.035 USDC |     0.07 USDC   | Aug 10, 2026 | 0x0298…249f         |
  ```

  After the table, ask: *"Reply with `all` to cancel every row, or comma-separated row numbers (e.g. `1,3`) to pick a subset."* Validate every index is in `[1, N]` and unique; reject ambiguous input by re-prompting.

The result of this step is `SELECTED` — a JSON array of stream objects, each carrying at minimum `.contract`, `.version`, `.tokenId`, `.refundable`, `.alias`, `.recipient`, `.sender`, and `.asset`.

## Group by Lockup contract (display only)

Each `cancel(uint256)` call hits exactly one Lockup contract and one stream — there is no batch entrypoint for cancel in this skill. For preview purposes, group the selection by `.contract` so the user sees how many distinct contracts are in play:

```bash
GROUPS=$(echo "$SELECTED" | jq -c '
  group_by(.contract)
  | map({
      contract: .[0].contract,
      version: .[0].version,
      streams: .
    })
')
```

Invariant: a Lockup contract address always corresponds to a single deployed version, so grouping by `contract` automatically groups by `version`. Even though the runbook uses the unified `cancel(uint256)` signature regardless of version, the version is still useful in the preview to label each group accurately.

This grouping is **for display only**. Each stream still produces its own `cast send` (one transaction per stream).

## Access-Control Check

Apply per stream. The access rule is unified across Lockup versions: only the stream's `sender` can call `cancel(uint256)` on a cancelable stream.

| `version` (any v1.0 → v4.0) | Who can sign `cancel`? | Notes for this skill                                                                                                                                                                           |
| --------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v1.0`–`v4.0`               | The stream's `sender`. | The skill only surfaces streams where `OWNER == sender`, so this rule is auto-satisfied. There is no version dispatch — the function signature `cancel(uint256)` is the same on every version. |

If for any reason a selected stream's `sender` is not the connected `OWNER` (this should never happen given the indexer filter, but check defensively), drop that stream from the set and warn the user.

## Preflight Checks

### Refundable amounts (per stream)

`scripts/filter-cancelable.sh` already ran during [Stream Discovery](#stream-discovery) and stamped the live `.refundable` value (base units) onto each stream. Reuse those values verbatim — the refundable amount is the unvested remainder that returns to the sender on cancellation:

```bash
# Per-stream values for preview and verification.
IDS=$(echo "$SELECTED" | jq -r '[.[].tokenId] | join(",")')
REFUNDABLES=$(echo "$SELECTED" | jq -r '[.[].refundable] | join(",")')
```

If you skipped the filter step (debugging, or the caller already narrowed the input), recompute via direct contract calls — but the production path always uses the filter result.

### Cancel fee `MSG_VALUE`

Always `0`. `cancel(uint256)` is non-payable on every Lockup version (v1.0 → v4.0), so there is no fee gate and no `calculateMinFeeWei` lookup. Do not pass `--value` to `cast estimate` or `cast send` for cancel.

### Per-stream gas estimate

Estimate gas per stream against the unified `cancel(uint256)` signature:

```bash
GAS_ESTIMATE=$(cast estimate "$CONTRACT" \
  "cancel(uint256)" "$ID" \
  --rpc-url "$RPC_URL" --from "$OWNER")
```

There is no version branch — `cancel(uint256)` is non-payable on every Lockup version, so do not pass `--value`.

### Aggregate native-balance check

Sum the gas costs across all selected streams; verify the wallet has enough native token to cover every transaction:

```bash
GAS_PRICE=$(cast gas-price --rpc-url "$RPC_URL")
BALANCE=$(cast balance "$OWNER" --rpc-url "$RPC_URL")

# Validate every value before piping through bc — an empty operand silently turns
# "0 + " into a parser error and the same value cascades through every downstream
# bc invocation, producing many lines of bc: parser error.
for v in TOTAL_GAS_UNITS GAS_PRICE BALANCE; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || { echo "Error: $v not numeric: '${!v}'"; exit 1; }
done

# Accumulate across streams (pseudo-loop — implement per stream during gas calc above).
TOTAL_NEEDED=$(echo "$TOTAL_GAS_UNITS * $GAS_PRICE" | bc)

if [ "$(echo "$BALANCE < $TOTAL_NEEDED" | bc)" -eq 1 ]; then
  echo "Insufficient native balance: need $TOTAL_NEEDED wei, have $BALANCE wei"
  exit 1
fi
```

If balance is insufficient, stop and tell the user to fund their wallet before trying again. Recommend [Transak](https://transak.com/buy) as one option.

## Preview

Present only human-readable values. Do not show raw calldata or base-unit integers by default. Format amounts with the `fmt_amount` helper from [Stream Selection](#stream-selection) — `cast format-units "$AMOUNT" "$DECIMALS"` followed by trailing-zero stripping — so values display as `0.08` / `0.5` / `100` instead of `0.080000` / `0.500000` / `100.000000`. Significant decimals are preserved (e.g. `0.000668` stays `0.000668`).

The preview is a single message that lists every stream, the per-stream refundable amount, the recipient, the per-stream tx count, and per-token totals across the entire set. Tell the user explicitly: **one transaction per stream — selecting N streams produces N wallet approvals. A revert on one stream never affects the others**.

Example for a sender with three eligible streams across two Lockup contracts on Base:

```
Chain:         Base (8453)
Signer:        0xOwner…  (matches sender)
Total fee:     0 ETH         ← cancel is free on every Lockup version
Estimated gas: 0.0014 ETH    ← sum across all streams
Mode:          per-stream — one tx per stream, N approvals total

Group 1/2 — Lockup Linear v1.2  (display only)
  Contract:    0xAAA…
  Streams (2):
    LL2-8453-887  →  120 USDC refundable to you   (recipient 0xc517…063c)
    LL2-8453-902  →   45.5 USDC refundable to you (recipient 0xc517…063c)

Group 2/2 — Lockup v4.0  (display only)
  Contract:    0xc19a09A66887017F603E5dF420ed3Cb9a5c07C0A
  Streams (1):
    LK3-8453-1027 →  1,234.56789 SABL refundable to you  (recipient 0xab12…cd34)

Per-token totals:
  USDC:  165.5
  SABL:  1,234.56789
```

Then show the confirmation prompt:

```text
+--------------------------------------+
| Confirm broadcast for 3 transactions?|
| Reply exactly: YES                   |
+--------------------------------------+
```

If the user does not explicitly confirm with `YES`, stop. If the set contains a single stream, phrase the prompt as `Confirm broadcast for 1 transaction?` (no `s`).

## Broadcast

Broadcast each stream sequentially. The user will see one browser approval prompt per stream. Capture the tx hash for each.

```bash
# Unified cancel(uint256) signature — non-payable on every Lockup version.
TX_HASH=$(cast send "$CONTRACT" \
  "cancel(uint256)" "$ID" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser \
  --async)
```

Inform the user before each stream: *"A browser tab will open — approve transaction {i}/{N} in your wallet extension (e.g. MetaMask)."* If `--browser` fails at runtime, fall back to `--private-key` as described in [Signing Method](#signing-method-mandatory). If the user declines a signature mid-flow, stop and tell them which stream hashes already broadcast and which were not attempted.

## Verify Receipt

For each stream, run the [Receipt Wait Timeout](#receipt-wait-timeout-mandatory) loop and capture the `RECEIPT` JSON. After confirming `status == 0x1`, decode the `CancelLockupStream(uint256 indexed streamId, address indexed sender, address indexed recipient, IERC20 indexed token, uint128 senderAmount, uint128 recipientAmount)` event from the logs and cross-check `senderAmount` against the previewed `.refundable`:

```bash
TOPIC=$(cast keccak "CancelLockupStream(uint256,address,address,address,uint128,uint128)")

EVENT=$(echo "$RECEIPT" | jq --arg t "$TOPIC" --arg c "$(echo "$CONTRACT" | tr '[:upper:]' '[:lower:]')" \
  '[.logs[] | select((.address | ascii_downcase) == $c) | select(.topics[0] == $t)] | .[0]')

if [ "$EVENT" = "null" ]; then
  echo "Warning: no CancelLockupStream event in receipt for $TX_HASH"
fi

# senderAmount and recipientAmount are concatenated in .data — slice out the first 64 hex chars
# after 0x for senderAmount, the next 64 for recipientAmount.
DATA=$(echo "$EVENT" | jq -r .data)
SENDER_AMOUNT_HEX="0x${DATA:2:64}"
RECIPIENT_AMOUNT_HEX="0x${DATA:66:64}"
SENDER_AMOUNT=$(cast to-dec "$SENDER_AMOUNT_HEX")
```

`SENDER_AMOUNT` should match the previewed `.refundable` for this stream. If they disagree, surface the diff to the user — this can happen if vesting advanced between preview and broadcast.

On revert: surface the tx hash and let the user investigate. Do not unwind already-confirmed cancellations — each cancel is its own transaction, so a revert on stream `i` leaves streams `1..i-1` confirmed and streams `i+1..N` unbroadcast.

After verification, list each successfully canceled stream with its app link. Use the `alias` returned by the indexer — do **not** hardcode `LK3-`, because the alias prefix encodes the Lockup version (`LL3-` for v1.2 linear, `LK-` for v2.0, `LK2-` for v3.0, `LK3-` for v4.0, etc.):

```
https://app.sablier.com/vesting/stream/${ALIAS}
```

## Worked Example

A sender with three eligible streams on Base — two on Lockup v1.2 (USDC) and one on v4.0 (SABL) — running per-stream cancellations:

```bash
INDEXER="https://indexer.hyperindex.xyz/53b7e25/v1/graphql"
CHAIN_ID=8453
RPC_URL="https://mainnet.base.org"
WALLET="0xSender…"

OWNER=$(cast wallet address --browser)

# 1) Stream discovery (no symbol filter — let the user mix tokens)
RESPONSE=$(curl -sS "$INDEXER" \
  -H 'content-type: application/json' \
  --data "$(jq -n \
    --arg q 'query($w:String!,$c:numeric!){LockupStream(where:{chainId:{_eq:$c},canceled:{_eq:false},depleted:{_eq:false},sender:{_eq:$w}} order_by:{endTime:asc} limit:500){id alias tokenId contract version sender recipient cancelable canceled depleted withdrawnAmount intactAmount startTime endTime asset{address symbol decimals}}}' \
    --arg w "$(echo "$WALLET" | tr '[:upper:]' '[:lower:]')" \
    --argjson c "$CHAIN_ID" \
    '{query:$q,variables:{w:$w,c:$c}}')")

# 2) Drop non-cancelable / zero-refundable streams via Multicall3 (one RPC round trip)
STREAMS=$(echo "$RESPONSE" | jq '.data.LockupStream' \
  | "$SKILL_DIR/scripts/filter-cancelable.sh" \
      --rpc-url "$RPC_URL" \
      --chain-id "$CHAIN_ID")

# 3) Default selection: all eligible streams.
SELECTED="$STREAMS"

# 4) Per-stream gas estimation
TOTAL_GAS_UNITS=0
GAS_PRICE=$(cast gas-price --rpc-url "$RPC_URL")
declare -a STREAM_PLANS=()

for ROW in $(echo "$SELECTED" | jq -c '.[]'); do
  CONTRACT=$(echo "$ROW" | jq -r .contract)
  ID=$(echo "$ROW" | jq -r .tokenId)

  GAS_ESTIMATE=$(cast estimate "$CONTRACT" \
    "cancel(uint256)" "$ID" \
    --rpc-url "$RPC_URL" --from "$OWNER")
  [[ "$GAS_ESTIMATE" =~ ^[0-9]+$ ]] || { echo "Error: GAS_ESTIMATE not numeric: '$GAS_ESTIMATE'"; exit 1; }

  TOTAL_GAS_UNITS=$((TOTAL_GAS_UNITS + GAS_ESTIMATE))
  STREAM_PLANS+=("$CONTRACT|$ID")
done

# 5) Aggregate balance check
BALANCE=$(cast balance "$OWNER" --rpc-url "$RPC_URL")
TOTAL_NEEDED=$(echo "$TOTAL_GAS_UNITS * $GAS_PRICE" | bc)
if [ "$(echo "$BALANCE < $TOTAL_NEEDED" | bc)" -eq 1 ]; then
  echo "Insufficient native balance: need $TOTAL_NEEDED wei, have $BALANCE wei"
  exit 1
fi

# 6) Preview + YES confirmation omitted for brevity

# 7) Broadcast each stream
for PLAN in "${STREAM_PLANS[@]}"; do
  IFS='|' read -r CONTRACT ID <<< "$PLAN"

  TX_HASH=$(cast send "$CONTRACT" \
    "cancel(uint256)" "$ID" \
    --rpc-url "$RPC_URL" --from "$OWNER" --browser --async)

  echo "Broadcasted: $TX_HASH"
  # Poll receipt (see "Receipt Wait Timeout" loop), then decode
  # CancelLockupStream events as shown in "Verify Receipt".
done

# 8) Per-stream app links
echo "$SELECTED" | jq -r '.[] | "https://app.sablier.com/vesting/stream/" + .alias'
```

## Supported Chains

The `contract` address returned by the indexer is always the correct address for the stream's Lockup version, so the table below is primarily for resolving `CHAIN_ID` and a default RPC URL. The `SablierLockup` column lists the **v4.0** deployment as a reference; older streams on the same chain live on other `SablierV2Lockup*` addresses, all surfaced through the indexer.

| Chain         | Chain ID   | Native Asset | SablierLockup (v4.0)                         | RPC URL                                          |
| ------------- | ---------- | ------------ | -------------------------------------------- | ------------------------------------------------ |
| Ethereum      | `1`        | ETH          | `0x93b37Bd5B6b278373217333Ac30D7E74c85fBDCB` | `https://ethereum-rpc.publicnode.com`            |
| Abstract      | `2741`     | ETH          | `0x2a8887a7Cc494e35EEB615df34026DBfaE027a5C` | `https://api.mainnet.abs.xyz`                    |
| Arbitrum      | `42161`    | ETH          | `0xD103611856F3c2BbAe61D9bF138078794fC09C33` | `https://arb1.arbitrum.io/rpc`                   |
| Avalanche     | `43114`    | AVAX         | `0xB891b41533776Ec20f7738c647a11506AA44b8A8` | `https://api.avax.network/ext/bc/C/rpc`          |
| Base          | `8453`     | ETH          | `0xc19a09A66887017F603E5dF420ed3Cb9a5c07C0A` | `https://mainnet.base.org`                       |
| Berachain     | `80094`    | BERA         | `0x2455c72a4aFE3b0e2B26b5EFD7F8EFFE6B828C90` | `https://rpc.berachain.com`                      |
| BNB Chain     | `56`       | BNB          | `0x6cd06Aaf06506bC3fF382d83023354E2B80EeD22` | `https://bsc-dataseed1.bnbchain.org`             |
| Chiliz        | `88888`    | CHZ          | `0x003b2D58A97315CE9fB3888Db6BCB9770e73f398` | `https://rpc.chiliz.com`                         |
| Denergy       | `369369`   | WATT         | `0xB9636F3dc2Fc1B5Ad2a7323210084DBEeD7B2377` | `https://rpc.d.energy`                           |
| Gnosis        | `100`      | xDAI         | `0xF24e804B0Eb4fC0eAD41dF0e392D25fb230Bbab4` | `https://rpc.gnosischain.com`                    |
| HyperEVM      | `999`      | HYPE         | `0x5369E34C92EACC1cceaFFe1be01F057C68ca1b19` | `https://rpc.hyperliquid.xyz/evm`                |
| Lightlink     | `1890`     | ETH          | `0xa39376a844dB3aA3fAaF119321b761cfE296fe19` | `https://replicator.phoenix.lightlink.io/rpc/v1` |
| Linea Mainnet | `59144`    | ETH          | `0xFb898e1626c9B32F89fFB0FedD145B89590d219e` | `https://rpc.linea.build`                        |
| Mode          | `34443`    | ETH          | `0x43916BAb157B56124C46dC09D45A9516489D84B7` | `https://mainnet.mode.network`                   |
| Monad         | `143`      | MON          | `0x82723C1ffEc9D43dE5FA80b25Da8df99AfD470ba` | `https://rpc.monad.xyz`                          |
| Morph         | `2818`     | ETH          | `0xA74F2Cf047A67509f332DD9B2D6D51989e546548` | `https://rpc.morphl2.io`                         |
| OP Mainnet    | `10`       | ETH          | `0x945ba0D0EeAa5766d4bae5455a9817D7ae150550` | `https://mainnet.optimism.io`                    |
| Polygon       | `137`      | POL          | `0xCEb5253Db890347D45778FB0834fb3c0B57aFf93` | `https://polygon-bor-rpc.publicnode.com`         |
| Scroll        | `534352`   | ETH          | `0x9435E262A4A312d30D6C41fE055f648e91Af411e` | `https://rpc.scroll.io`                          |
| Sonic         | `146`      | S            | `0xa697988451F921185A8c824aD4867DC8933C4ECB` | `https://rpc.soniclabs.com`                      |
| Superseed     | `5330`     | ETH          | `0x3AC18F736d0E1B9bd9259Cd6C8a43539C86C16fD` | `https://mainnet.superseed.xyz`                  |
| Unichain      | `130`      | ETH          | `0xE72830E2845B74aA3bA71fB6E833D7A677129793` | `https://mainnet.unichain.org`                   |
| XDC           | `50`       | XDC          | `0x16f5c4Ddc5b828F00E8f92267f3ABf60b700dB5c` | `https://rpc.xinfin.network`                     |
| ZKsync Era    | `324`      | ETH          | `0xc2FDF5DCDEaa1F7c83e569D03b22eA8636073F4A` | `https://mainnet.era.zksync.io`                  |
| Sepolia       | `11155111` | ETH          | `0xe61cb9153356419bdaD0A8767c059f92d221a3C4` | `https://ethereum-sepolia-rpc.publicnode.com`    |

Ethereum can also be referred to as "Mainnet".
