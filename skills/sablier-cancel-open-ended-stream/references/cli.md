# EVM CLI Cancel Execution

## Overview

This guide is runbook-first: discover the user's Flow streams on the resolved chain where the wallet is sender or recipient, drop already-voided streams, let the user pick any subset (default = all eligible), assemble a per-stream `batch(bytes[])` of `[refundMax, void]` (or `[void]` when refund is not applicable), run preflight checks, preview the per-stream transactions, require explicit confirmation, then broadcast one transaction per selected stream and verify each receipt for `RefundFromFlowStream` / `VoidFlowStream` events.

Each selected stream becomes its own broadcast — the skill does not batch multiple streams into a single `batch(bytes[])` call. Splicing refund + void into a single per-stream transaction keeps each cancellation atomic: either both sub-calls succeed or both revert, and a revert on one stream never affects the others.

The skill charges no markup. Both `void(uint256)` and `refund(streamId,…)` are free at the protocol level — `MSG_VALUE = 0` always.

## Execution Sequence

Use this sequence for every cancel run:

01. Complete [Intake & Planning Inputs](#intake--planning-inputs): wallet, optional chain, optional token symbol.
02. Run [Chain Discovery](#chain-discovery) if the user did not specify a chain.
03. Run [Stream Discovery](#stream-discovery) against the Sablier Streams indexer, then pipe the result through [scripts/filter-cancelable.sh](#drop-voided-streams-and-stamp-refundable) to drop voided streams and stamp the live `.refundable` and `.status` onto every survivor.
04. Run [Stream Selection](#stream-selection) to let the user pick any subset of the eligible streams (default: all).
05. Run [Per-stream tx assembly](#per-stream-tx-assembly) — for each selected stream, compute `caller_role` (`sender` / `recipient` / `both`) and assemble the `bytes[]` entries (refund + void, or void only).
06. Run [Access-Control Check](#access-control-check) per stream. Drop refund sub-calls when the caller is recipient-only; defensively re-check sender/recipient against the connected wallet to guard against indexer staleness.
07. Run [Preflight Checks](#preflight-checks): per-stream `statusOf` re-read (abort that stream if VOIDED), per-stream gas estimate, and an aggregate native-balance check. There is no `MSG_VALUE` branch — void and refund are both free.
08. Build and show a single human-readable preview that lists every stream and the planned sub-calls (no broadcast).
09. Require explicit user confirmation.
10. Broadcast each stream with `cast send "$CONTRACT" "batch(bytes[])" "$CALLS"`, sequentially. The user signs once per stream. (Optimization: when the bytes array contains exactly one entry, the runbook MAY call `void(uint256)` directly instead of wrapping in `batch`.)
11. For each broadcast, wait/poll up to 5 minutes for the confirmed receipt and then decode `RefundFromFlowStream` (when applicable) and `VoidFlowStream` events from the logs.
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

1. Build a single human-readable preview that lists every stream and the planned sub-calls.
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

- `wallet` — the address that will sign each cancel transaction. Required.
- `chain` (optional) — name and ID resolved from [Supported Chains](#supported-chains). If omitted, [Chain Discovery](#chain-discovery) infers it from the indexer.
- `symbol` (optional) — narrows the indexer query. If omitted, all the wallet's streams on the chain are listed.
- `signing_method` — `--browser` preferred, `--private-key` fallback.

There is no `to` parameter — `refundMax(streamId, sender)` always sends the unstreamed balance back to the stream's sender; the contract has no concept of a redirected refund.

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

If the user did not specify a chain, query the indexer across *all* chains for the wallet and collect the distinct `chainId` values that have non-voided Flow streams where the wallet is the sender (to refund + void) or the recipient (to void only).

```bash
INDEXER="https://indexer.hyperindex.xyz/53b7e25/v1/graphql"
WALLET_LC=$(echo "$WALLET" | tr '[:upper:]' '[:lower:]')

QUERY='query($w: String!) {
  FlowStream(
    where: {
      voided: { _eq: false },
      _or: [
        { sender: { _eq: $w } },
        { recipient: { _eq: $w } }
      ]
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

Restrict to streams where the wallet is the sender or the recipient — sender to refund + void, recipient to void only. Filter out voided streams. If the user provided a token symbol, add it to the `where` clause.

```bash
INDEXER="https://indexer.hyperindex.xyz/53b7e25/v1/graphql"

# Without symbol filter (listing all tokens the wallet has streams in)
QUERY='query($w: String!, $c: numeric!) {
  FlowStream(
    where: {
      chainId: { _eq: $c },
      voided: { _eq: false },
      _or: [
        { sender: { _eq: $w } },
        { recipient: { _eq: $w } }
      ]
    }
    order_by: { id: asc }
    limit: 500
  ) {
    id alias tokenId contract chainId
    sender recipient voided paused
    asset { address symbol decimals }
  }
}'

RESPONSE=$(curl -sS "$INDEXER" \
  -H 'content-type: application/json' \
  --data "$(jq -n --arg q "$QUERY" --arg w "$WALLET" --argjson c "$CHAIN_ID" \
    '{query: $q, variables: {w: $w, c: $c}}')")

STREAMS=$(echo "$RESPONSE" | jq '.data.FlowStream')
```

`limit: 500` is intentional: a single user may legitimately have dozens of active Flow streams. If a user has more than 500 active streams on a single chain, raise the limit or paginate.

### Drop voided streams and stamp refundable

The indexer's `voided` boolean covers historical voids but can lag chain head; the runbook re-checks `statusOf(streamId)` on-chain. The indexer also cannot express "refundable > 0" directly — that depends on `block.timestamp` against the stream's `ratePerSecond`, snapshot debt, and current balance.

Run every candidate through [scripts/filter-cancelable.sh](../scripts/filter-cancelable.sh), which batches `statusOf(uint256)` and `refundableAmountOf(uint256)` across all streams into a single `Multicall3.aggregate` call:

```bash
STREAMS=$(echo "$STREAMS" \
  | "$SKILL_DIR/scripts/filter-cancelable.sh" \
      --rpc-url "$RPC_URL" \
      --chain-id "$CHAIN_ID")
```

The script preserves input order, drops streams where `statusOf == 5` (VOIDED), and stamps `.refundable` (base-unit string) and `.status` (decimal int) onto every survivor. It does **not** drop zero-refundable streams — a recipient can still void them, and a sender's `refundable` can be `0` if everything is already streamed. `--chain-id` selects the correct Multicall3 deployment — the canonical address works on every Sablier chain except Abstract (2741), XDC (50), and ZKsync Era (324).

If the filtered list is empty, stop and tell the user every active stream has already been voided on this chain; do not fall back to presenting voided streams.

With a symbol filter add `asset: { symbol: { _eq: $s } }` inside the top-level `where`:

```
_and: [
  { chainId: { _eq: $c } },
  { voided: { _eq: false } },
  { asset: { symbol: { _eq: $s } } },
  { _or: [{ sender: { _eq: $w } }, { recipient: { _eq: $w } }] }
]
```

Addresses must be lowercased for comparison in the indexer; normalise with `tr '[:upper:]' '[:lower:]'` before substituting.

### Compute the caller's role per stream

For each survivor, attach a `caller_role` field by comparing the connected wallet against the indexer's `sender` and `recipient`:

```bash
WALLET_LC=$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')

STREAMS=$(echo "$STREAMS" | jq --arg w "$WALLET_LC" '
  map(. + {
    caller_role: (
      if (.sender | ascii_downcase) == $w and (.recipient | ascii_downcase) == $w then "both"
      elif (.sender | ascii_downcase) == $w then "sender"
      elif (.recipient | ascii_downcase) == $w then "recipient"
      else "none"
      end
    )
  })
')
```

A `caller_role == "none"` should be unreachable given the indexer filter, but check defensively and drop those entries with a warning.

### Resolving an unknown token symbol

If the user did not provide a symbol, derive the distinct set from the unfiltered result:

```bash
SYMBOLS=$(echo "$STREAMS" | jq -r '[.[].asset.symbol] | unique | .[]')
```

Present the distinct symbols via `AskUserQuestion` (cap at 4 options, fall back to free-text entry beyond that), then re-filter `$STREAMS` locally by the chosen symbol.

### Edge cases

- **Zero streams matching** — tell the user nothing was found for that (chain, wallet[, symbol]) and stop. Suggest they double-check the chain and wallet; do not fall back to other chains.
- **Two different tokens share the same symbol on a chain** — list each match with its asset address and use `AskUserQuestion` so the user picks the correct asset.

## Stream Selection

The default is **cancel all eligible streams on the chain**. Only ask the user to narrow the set if they explicitly say so or if the list is small enough that confirming each pick is faster than confirming a bulk action.

- **Exactly one stream matches** — auto-select it and show the user a one-line confirmation: `Selected FL4-1-42 — 1,234.56 USDC refundable to sender, role sender, counterparty 0xabc…`. Proceed to per-stream tx assembly.

- **Multiple streams (≤4)** — present them as `AskUserQuestion` with `multiSelect: true`. Each option label shows `${alias} — ${refundable} ${symbol} (${role})`; the description includes the counterparty (the address that is not the connected wallet). Add a separate option `All ${N} eligible streams (recommended)` so the user can opt for the bulk action without ticking each box. **Do not** add an "Other" option — `AskUserQuestion` adds it automatically and the user can use it for free-text overrides.

- **More than 4 streams** — render a Markdown table directly in your chat reply (not in tool stdout) and ask the user to reply with `all` or a comma-separated list of indices (e.g. `1,3,7`). Do not call `AskUserQuestion` with >4 options (the tool caps at 4).

  **Render the table in the assistant message, not in a Bash `echo`/`printf`.** Most chat UIs collapse tool output by default, so a list printed from `bash` is invisible to the user. Use Bash only to compute values (formatted amounts); assemble the table as Markdown in your own response so it renders inline.

  Use a GitHub-flavored Markdown table with exactly these columns, in this order: `#`, `Stream`, `Refundable to sender`, `Token`, `Your role`, `Counterparty`. Right-align numeric columns with `---:` so amounts line up. Sort rows by `id` ascending — this matches the indexer query's `order_by`, so preserve the input order. The "Your role" column displays `sender`, `recipient`, or `sender + recipient`. Abbreviate the counterparty address as `0xabcd…wxyz` — the counterparty is the sender when the wallet is the recipient, and vice versa.

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
  |  # | Stream         | Refundable to sender | Token | Your role         | Counterparty        |
  | -: | :------------- | -------------------: | :---- | :---------------- | :------------------ |
  |  1 | FL4-8453-2890  |             0.008233 | USDC  | sender            | 0xc517…063c         |
  |  2 | FL4-8453-2329  |                    0 | USDC  | recipient         | 0x0298…249f         |
  |  3 | FL4-8453-2401  |                100.5 | SABL  | sender + recipient | 0x9876…edcb        |
  ```

  After the table, ask: *"Reply with `all` to cancel every row, or comma-separated row numbers (e.g. `1,3`) to pick a subset."* Validate every index is in `[1, N]` and unique; reject ambiguous input by re-prompting.

The result of this step is `SELECTED` — a JSON array of stream objects, each carrying at minimum `.contract`, `.tokenId`, `.refundable`, `.alias`, `.recipient`, `.sender`, `.caller_role`, and `.asset`.

## Per-stream tx assembly

`SablierFlow` is one address per chain, so the previous "group by contract" step from the withdraw skill collapses into a per-stream loop. For each selected stream, assemble the `bytes[]` entries that will be passed to `batch(bytes[])`:

```bash
for ROW in $(echo "$SELECTED" | jq -c '.[]'); do
  CONTRACT=$(echo "$ROW" | jq -r .contract)
  ID=$(echo "$ROW" | jq -r .tokenId)
  SENDER=$(echo "$ROW" | jq -r .sender)
  ROLE=$(echo "$ROW" | jq -r .caller_role)
  REFUNDABLE=$(echo "$ROW" | jq -r .refundable)
  ALIAS=$(echo "$ROW" | jq -r .alias)

  CALLDATA_VOID=$(cast calldata "void(uint256)" "$ID")

  if [ "$ROLE" = "sender" ] || [ "$ROLE" = "both" ]; then
    if [ "$REFUNDABLE" != "0" ]; then
      # Sender (or both) with unstreamed balance: refund + void atomically.
      CALLDATA_REFUND=$(cast calldata "refundMax(uint256,address)" "$ID" "$SENDER")
      ENTRIES="[$CALLDATA_REFUND,$CALLDATA_VOID]"
      MODE="refund + void"
    else
      # Sender (or both) with nothing left to refund: void only.
      ENTRIES="[$CALLDATA_VOID]"
      MODE="void only"
      echo "Stream $ALIAS: nothing to refund — only voiding."
    fi
  else
    # Recipient-only: refund is sender-only, so the user can void but cannot refund.
    ENTRIES="[$CALLDATA_VOID]"
    MODE="void only"
    echo "Stream $ALIAS: as recipient you can void but only the sender can refund unstreamed funds."
  fi

  # Stash for preview/broadcast — store ENTRIES verbatim because cast accepts the
  # same string for batch(bytes[]).
  STREAM_PLANS+=("$CONTRACT|$ID|$ROLE|$REFUNDABLE|$MODE|$ENTRIES")
done
```

`refundMax(uint256,address)` is the explicit signature — the second argument is the sender address (where unstreamed funds return). The contract enforces that the destination is the stream's `sender`; passing any other address reverts.

The bytes-array entries above are passed to `Batch.batch(bytes[]) payable`. `Batch.batch` `delegatecall`s every entry against `address(this)`, so `msg.sender` and `msg.value` are reused across both sub-calls — but the runbook never sends value because both `void` and `refund` are non-payable from the user's perspective (no protocol fee). Inside a single per-stream batch, the all-or-nothing behavior means: if `refundMax` reverts, the whole tx reverts; if `void` reverts, the whole tx reverts. That is the desired property — the sender either gets the refund and stops the stream atomically, or the stream stays in its current state.

## Access-Control Check

Apply per stream. The Flow access rules diverge between the two sub-calls (`SablierFlow.sol:1001` for `void`; `refund`/`refundMax` is sender-only):

| Sub-call         | Allowed callers                                                   | Notes for this skill                                                                                                                    |
| ---------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `void(uint256)`  | The `sender`, the `recipient`, or an ERC-721-approved third party | The runbook surfaces every stream where `wallet ∈ {sender, recipient}`, so this is auto-satisfied.                                      |
| `refundMax(...)` | Sender only (`onlySender`)                                        | The runbook only emits a `refundMax` sub-call when `caller_role` includes `sender`. Recipient-only callers never get a refund sub-call. |

Drop refund sub-calls when the caller is recipient-only — the per-stream tx assembly above already handles this. Defensively re-read `sender` and `recipient` from the contract for each stream right before broadcast — staleness between indexer and chain head can flip a stream into a different role (e.g. NFT was transferred and the indexer hasn't caught up). If the connected wallet is no longer in `{sender, recipient}` at broadcast time, drop the stream and warn the user.

## Preflight Checks

### Refundable amounts (per stream)

`scripts/filter-cancelable.sh` already ran during [Stream Discovery](#stream-discovery) and stamped the live `.refundable` value (base units) onto each stream. Reuse those values verbatim — the per-stream tx assembly above branches on `.refundable == "0"` to decide whether to splice in a `refundMax` sub-call.

If you skipped the filter step (debugging, or the caller already narrowed the input), recompute via direct contract calls — but the production path always uses the filter result.

### Stream status (per stream, abort-on-VOIDED)

Even though the filter dropped voided streams at discovery, the runbook re-reads `statusOf(streamId)` for every selected stream right before broadcast — staleness between indexer and chain head can flip a stream into `VOIDED` after the runbook started. Mirrors the withdraw-flow precheck, just per-stream rather than per-group.

Batch the status reads via Multicall3 across the selected set to keep this to one RPC round trip:

```bash
CONTRACT=$(echo "$SELECTED" | jq -r '.[0].contract')

CALL_TUPLES=()
for ID in $(echo "$SELECTED" | jq -r '.[].tokenId'); do
  DATA=$(cast calldata "statusOf(uint256)" "$ID")
  CALL_TUPLES+=("(${CONTRACT},${DATA})")
done
CALLS_STATUS="[$(IFS=,; echo "${CALL_TUPLES[*]}")]"

RAW=$(cast call "$MULTICALL" \
  "aggregate((address,bytes)[])(uint256,bytes[])" \
  "$CALLS_STATUS" \
  --rpc-url "$RPC_URL")

STATUSES=$(echo "$RAW" | grep -oE '0x[0-9a-fA-F]{64}')
VOIDED_INDEX=5  # Flow.Status.VOIDED — see flow/src/types/DataTypes.sol

i=0
while IFS= read -r HEX; do
  DEC=$(cast to-dec "$HEX")
  if [ "$DEC" = "$VOIDED_INDEX" ]; then
    BAD_ID=$(echo "$SELECTED" | jq -r ".[$i].tokenId")
    echo "Aborting stream $BAD_ID: it is VOIDED. Cannot re-void; skipping."
    # Drop this stream from STREAM_PLANS before broadcast.
  fi
  i=$((i + 1))
done <<< "$STATUSES"
```

`MULTICALL` is the same chain-aware address used by `filter-cancelable.sh`. If `statusOf` returns `VOIDED` (`5`) for any stream, drop that stream from the broadcast set and tell the user. Each cancellation is its own transaction, so dropping one stream does not affect the others.

### Cancel fee `MSG_VALUE`

Always `0`. Both `void(uint256)` and `refund(streamId,…)` are free at the protocol level — `Batch.batch(bytes[]) payable` is payable for forward compatibility, but the runbook never sends value for cancel. Do not pass `--value` to `cast estimate` or `cast send` for cancel.

### Per-stream gas estimate

Build the per-stream calldata first, then estimate gas against the outer `batch(bytes[])` entrypoint with the exact arguments the broadcast will use. The `ENTRIES` string was produced in [Per-stream tx assembly](#per-stream-tx-assembly):

```bash
GAS_ESTIMATE=$(cast estimate "$CONTRACT" \
  "batch(bytes[])" "$ENTRIES" \
  --rpc-url "$RPC_URL" --from "$OWNER")
```

There is no `--value` flag — cancel is free.

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

The preview is a single message that lists every stream, the user's role on each, the refundable amount, and the planned sub-calls (`refund + void` or `void only`). Tell the user explicitly: **per-stream batch — each stream is its own atomic transaction. If a stream's `void` reverts, that single transaction reverts but other streams are unaffected**.

Example for a sender with two streams (one refundable, one fully streamed) and a recipient with one stream they want to void on Base:

```
Chain:         Base (8453)
Signer:        0xOwner…
Total fee:     0 ETH         ← cancel is free (no protocol fee on void/refund)
Estimated gas: 0.0023 ETH    ← sum across all streams
Mode:          per-stream batch — one tx per stream, N approvals total

Stream 1/3 — FL4-8453-887  (your role: sender)
  Contract:    0x0cbfe6ce6f05c47d6243bb3818837971c6ccb46b
  Refundable:  120 USDC                (returns to you, the sender)
  Sub-calls:   refundMax(streamId, sender) + void(streamId)
  Counterparty: 0xc517…063c (recipient)

Stream 2/3 — FL4-8453-902  (your role: sender)
  Contract:    0x0cbfe6ce6f05c47d6243bb3818837971c6ccb46b
  Refundable:  0 USDC                  (nothing left to refund)
  Sub-calls:   void(streamId) only
  Counterparty: 0xc517…063c (recipient)
  Note:        Nothing is left to refund. The stream will be voided but no funds will be returned.

Stream 3/3 — FL4-8453-1027  (your role: recipient)
  Contract:    0x0cbfe6ce6f05c47d6243bb3818837971c6ccb46b
  Refundable:  45.5 SABL               (would return to the sender — you cannot refund)
  Sub-calls:   void(streamId) only
  Counterparty: 0xab12…cd34 (sender)
  Note:        As recipient you can void but only the sender can refund unstreamed funds.

Per-token refund totals (returned to sender):
  USDC:  120
  SABL:  0   (recipient-only voids do not refund)
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
# Default path: per-stream batch(bytes[]) — refund + void or just void.
TX_HASH=$(cast send "$CONTRACT" \
  "batch(bytes[])" "$ENTRIES" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser \
  --async)
```

**Optimization**: when `ENTRIES` contains exactly one entry (i.e. void-only — recipient cancel, or sender with zero refundable), the runbook MAY call `void(uint256)` directly instead of wrapping in `batch`. This saves the small `batch` dispatcher overhead. Both forms are correct and produce identical onchain effects:

```bash
# Optional optimization for the void-only path.
TX_HASH=$(cast send "$CONTRACT" \
  "void(uint256)" "$ID" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser \
  --async)
```

Inform the user before each stream: *"A browser tab will open — approve transaction {i}/{N} in your wallet extension (e.g. MetaMask)."* If `--browser` fails at runtime, fall back to `--private-key` as described in [Signing Method](#signing-method-mandatory). If the user declines a signature mid-flow, stop and tell them which stream hashes already broadcast and which were not attempted.

## Verify Receipt

For each stream, run the [Receipt Wait Timeout](#receipt-wait-timeout-mandatory) loop and capture the `RECEIPT` JSON. After confirming `status == 0x1`, decode the relevant Flow events from the logs:

- `RefundFromFlowStream(uint256 indexed streamId, address indexed sender, uint128 amount)` — expect exactly **1** event when the planned sub-calls included `refundMax`, **0** events otherwise.
- `VoidFlowStream(uint256 indexed streamId, address indexed sender, address indexed recipient, address caller, uint256 newTotalDebt, uint256 writtenOffDebt)` — expect exactly **1** event always.

```bash
TOPIC_REFUND=$(cast keccak "RefundFromFlowStream(uint256,address,uint128)")
TOPIC_VOID=$(cast keccak "VoidFlowStream(uint256,address,address,address,uint256,uint256)")
LC_CONTRACT=$(echo "$CONTRACT" | tr '[:upper:]' '[:lower:]')

REFUND_COUNT=$(echo "$RECEIPT" | jq --arg t "$TOPIC_REFUND" --arg c "$LC_CONTRACT" \
  '[.logs[] | select((.address | ascii_downcase) == $c) | select(.topics[0] == $t)] | length')

VOID_COUNT=$(echo "$RECEIPT" | jq --arg t "$TOPIC_VOID" --arg c "$LC_CONTRACT" \
  '[.logs[] | select((.address | ascii_downcase) == $c) | select(.topics[0] == $t)] | length')

if [ "$VOID_COUNT" -ne 1 ]; then
  echo "Warning: expected 1 VoidFlowStream event, got $VOID_COUNT"
fi
```

Cross-check `RefundFromFlowStream.amount` against the previewed `.refundable`. The `amount` is in `.data` (non-indexed) — slice the first 64 hex chars after `0x` and `cast to-dec` it. If they disagree, surface the diff to the user — this can happen if the stream balance shifted between preview and broadcast (e.g. the recipient withdrew in the same block).

There is no per-sub-call skip event in Flow. A confirmed receipt with `status == 0x1` means every sub-call in the per-stream batch executed; a sub-call failure would have reverted the whole transaction, surfaced in the [Receipt Wait Timeout](#receipt-wait-timeout-mandatory) loop above.

After verification, list each successfully canceled stream with its app link. Use the `alias` returned by the indexer:

```
https://app.sablier.com/payments/stream/${ALIAS}
```

## Worked Example

A user with three eligible streams on Base — two as sender (one with refundable balance, one fully streamed) and one as recipient — running per-stream cancellations:

```bash
INDEXER="https://indexer.hyperindex.xyz/53b7e25/v1/graphql"
CHAIN_ID=8453
RPC_URL="https://mainnet.base.org"
WALLET="0xOwner…"
FLOW="0x0cbfe6ce6f05c47d6243bb3818837971c6ccb46b"

OWNER=$(cast wallet address --browser)

# 1) Stream discovery (no symbol filter — let the user mix tokens; sender OR recipient)
RESPONSE=$(curl -sS "$INDEXER" \
  -H 'content-type: application/json' \
  --data "$(jq -n \
    --arg q 'query($w:String!,$c:numeric!){FlowStream(where:{chainId:{_eq:$c},voided:{_eq:false},_or:[{sender:{_eq:$w}},{recipient:{_eq:$w}}]} order_by:{id:asc} limit:500){id alias tokenId contract sender recipient voided paused asset{address symbol decimals}}}' \
    --arg w "$(echo "$WALLET" | tr '[:upper:]' '[:lower:]')" \
    --argjson c "$CHAIN_ID" \
    '{query:$q,variables:{w:$w,c:$c}}')")

# 2) Drop voided streams and stamp .refundable / .status via Multicall3
STREAMS=$(echo "$RESPONSE" | jq '.data.FlowStream' \
  | "$SKILL_DIR/scripts/filter-cancelable.sh" \
      --rpc-url "$RPC_URL" \
      --chain-id "$CHAIN_ID")

# 3) Compute caller_role per stream
WALLET_LC=$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')
STREAMS=$(echo "$STREAMS" | jq --arg w "$WALLET_LC" '
  map(. + {
    caller_role: (
      if (.sender | ascii_downcase) == $w and (.recipient | ascii_downcase) == $w then "both"
      elif (.sender | ascii_downcase) == $w then "sender"
      elif (.recipient | ascii_downcase) == $w then "recipient"
      else "none"
      end
    )
  }) | map(select(.caller_role != "none"))
')

# 4) Default selection: all eligible streams.
SELECTED="$STREAMS"

# 5) Per-stream tx assembly + gas estimation
TOTAL_GAS_UNITS=0
GAS_PRICE=$(cast gas-price --rpc-url "$RPC_URL")
declare -a STREAM_PLANS=()

for ROW in $(echo "$SELECTED" | jq -c '.[]'); do
  CONTRACT=$(echo "$ROW" | jq -r .contract)
  ID=$(echo "$ROW" | jq -r .tokenId)
  SENDER=$(echo "$ROW" | jq -r .sender)
  ROLE=$(echo "$ROW" | jq -r .caller_role)
  REFUNDABLE=$(echo "$ROW" | jq -r .refundable)

  CALLDATA_VOID=$(cast calldata "void(uint256)" "$ID")

  if { [ "$ROLE" = "sender" ] || [ "$ROLE" = "both" ]; } && [ "$REFUNDABLE" != "0" ]; then
    CALLDATA_REFUND=$(cast calldata "refundMax(uint256,address)" "$ID" "$SENDER")
    ENTRIES="[$CALLDATA_REFUND,$CALLDATA_VOID]"
  else
    ENTRIES="[$CALLDATA_VOID]"
  fi

  GAS_ESTIMATE=$(cast estimate "$CONTRACT" \
    "batch(bytes[])" "$ENTRIES" \
    --rpc-url "$RPC_URL" --from "$OWNER")
  [[ "$GAS_ESTIMATE" =~ ^[0-9]+$ ]] || { echo "Error: GAS_ESTIMATE not numeric: '$GAS_ESTIMATE'"; exit 1; }

  TOTAL_GAS_UNITS=$((TOTAL_GAS_UNITS + GAS_ESTIMATE))
  STREAM_PLANS+=("$CONTRACT|$ID|$ENTRIES")
done

# 6) Aggregate balance check
BALANCE=$(cast balance "$OWNER" --rpc-url "$RPC_URL")
TOTAL_NEEDED=$(echo "$TOTAL_GAS_UNITS * $GAS_PRICE" | bc)
if [ "$(echo "$BALANCE < $TOTAL_NEEDED" | bc)" -eq 1 ]; then
  echo "Insufficient native balance: need $TOTAL_NEEDED wei, have $BALANCE wei"
  exit 1
fi

# 7) Preview + YES confirmation omitted for brevity

# 8) Broadcast each stream
for PLAN in "${STREAM_PLANS[@]}"; do
  IFS='|' read -r CONTRACT ID ENTRIES <<< "$PLAN"

  TX_HASH=$(cast send "$CONTRACT" \
    "batch(bytes[])" "$ENTRIES" \
    --rpc-url "$RPC_URL" --from "$OWNER" --browser --async)

  echo "Broadcasted: $TX_HASH"
  # Poll receipt (see "Receipt Wait Timeout" loop), then decode
  # RefundFromFlowStream / VoidFlowStream events as shown in "Verify Receipt".
done

# 9) Per-stream app links
echo "$SELECTED" | jq -r '.[] | "https://app.sablier.com/payments/stream/" + .alias'
```

## Supported Chains

The `contract` address returned by the indexer is always the correct address for the stream's `SablierFlow` deployment, so the table below is primarily for resolving `CHAIN_ID`, a default RPC URL, and the canonical `SablierFlow` address per chain.

UI support note:

- The Flow v3.0 UI alias is `FL4`, so supported payment links use `https://app.sablier.com/payments/stream/FL4-${CHAIN_ID}-${STREAM_ID}` (or `https://app.sablier.com/payments/stream/${ALIAS}` directly).

| Chain         | Chain ID   | Native Asset | SablierFlow (cancel)                         | RPC URL                                          |
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
