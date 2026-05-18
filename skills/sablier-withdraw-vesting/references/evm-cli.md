# EVM CLI Withdraw Execution

## Overview

This guide is runbook-first: discover the user's streams on the resolved chain, let the user pick any subset (default = all eligible), group the selection by Lockup contract, run preflight checks, preview the batch, require explicit confirmation, then broadcast one `withdrawMultiple` per Lockup contract and verify each receipt.

Each selected stream is withdrawn at its full currently-unlocked balance (`withdrawableAmountOf`). The skill never asks for a custom per-stream amount in batch mode — the goal is to drain everything that's currently claimable on the user's selection.

The skill charges no markup. The only fee paid is the on-chain protocol fee (`calculateMinFeeWei`) on Lockup v3.0+, set by the comptroller. It may be `0`. v1.x and v2.x are non-payable.

## Execution Sequence

Use this sequence for every batch withdraw:

01. Complete [Intake & Planning Inputs](#intake--planning-inputs): wallet, optional chain, optional token symbol.
02. Run [Chain Discovery](#chain-discovery) if the user did not specify a chain.
03. Run [Stream Discovery](#stream-discovery) against the Sablier Streams indexer, then pipe the result through [scripts/evm/filter-withdrawable.sh](#drop-streams-with-nothing-to-withdraw) to drop streams with zero currently-withdrawable balance.
04. Run [Stream Selection](#stream-selection) to let the user pick any subset of the eligible streams (default: all).
05. Run [Group by Lockup contract](#group-by-lockup-contract) — split the selection into one batch per distinct contract address. Each batch becomes one transaction.
06. Run [Access-Control Check](#access-control-check) for each group. Skip groups whose access rules the wallet doesn't satisfy.
07. Run [Preflight Checks](#preflight-checks): per-group `MSG_VALUE` (the max `calculateMinFeeWei` across the group on v3.0+; `0` otherwise), per-group gas estimate, and an aggregate native-balance check.
08. Build and show a single human-readable batch preview (no broadcast).
09. Require explicit user confirmation.
10. Broadcast each group with `cast send`, sequentially. The user signs once per group.
11. For each broadcast, wait/poll up to 5 minutes for the confirmed receipt and then scan logs for any `InvalidWithdrawalInWithdrawMultiple` events (v2.0+) so silently-failed streams are surfaced.
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
- `signing_method` — `--browser` preferred, `--private-key` fallback.

Note: the skill never asks for a custom withdraw amount in batch mode — every selected stream is withdrawn in full at the current `withdrawableAmountOf`. If the user wants a partial amount on a single stream, they should select only that one stream; even then the runbook will withdraw the full unlocked balance for that stream.

Resolve the sender address now so subsequent indexer queries and preview lines agree with what the wallet extension reports:

```bash
OWNER=$(cast wallet address --browser)
```

If the user supplied a wallet address earlier, compare it to `$OWNER` after connection and stop with a clear error if they disagree.

## Chain Discovery

If the user did not specify a chain, query the indexer across *all* chains for the wallet and collect the distinct `chainId` values that have non-depleted streams where the wallet is the recipient. Sender-only streams are intentionally ignored — withdrawing on those pushes tokens to the recipient, not to the caller, so they are not useful to surface.

```bash
INDEXER="https://indexer.hyperindex.xyz/53b7e25/v1/graphql"
WALLET_LC=$(echo "$WALLET" | tr '[:upper:]' '[:lower:]')

QUERY='query($w: String!) {
  LockupStream(
    where: {
      depleted: { _eq: false },
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
  | jq -r '[.data.LockupStream[].chainId] | unique | .[]')
```

Outcomes:

- **No chain IDs returned** — stop and tell the user no active Sablier streams were found for that wallet anywhere. Suggest they double-check the wallet address.
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

### Query: wallet's active streams on the chain

Restrict to streams where `recipient == wallet` — withdraw always pushes tokens to the recipient, so sender-only streams would just relay funds to a third party and should not be presented. Filter out depleted streams. If the user provided a token symbol, add it to the `where` clause.

```bash
INDEXER="https://indexer.hyperindex.xyz/53b7e25/v1/graphql"

# Without symbol filter (listing all tokens the wallet has streams in)
QUERY='query($w: String!, $c: numeric!) {
  LockupStream(
    where: {
      chainId: { _eq: $c },
      depleted: { _eq: false },
      recipient: { _eq: $w }
    }
    order_by: { endTime: asc }
    limit: 500
  ) {
    id alias tokenId contract chainId version category
    sender recipient canceled depleted
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

`limit: 500` is intentional: the batch flow may legitimately surface dozens of streams. If a user has more than 500 active streams on a single chain, raise the limit or paginate.

### Drop streams with nothing to withdraw

The indexer cannot express "withdrawable > 0" directly — that value depends on `block.timestamp` against the stream's schedule (start, cliff, segments, tranches) minus `withdrawnAmount`, and the indexer only stores event-driven state. Presenting the user the whole wallet (e.g. 77 streams) when most have `withdrawableAmountOf == 0` at the current block wastes their attention.

Run every candidate through [scripts/evm/filter-withdrawable.sh](../scripts/evm/filter-withdrawable.sh), which batches `withdrawableAmountOf(uint256)` across all streams into a single `Multicall3.aggregate` call:

```bash
STREAMS=$(echo "$STREAMS" \
  | "$SKILL_DIR/scripts/evm/filter-withdrawable.sh" \
      --rpc-url "$RPC_URL" \
      --chain-id "$CHAIN_ID")
```

The script preserves input order, adds a `.withdrawable` field (base-unit string) to each survivor, and drops zero-amount entries. Pass `--include-zero` during debugging if you need to see what was filtered out. `--chain-id` selects the correct Multicall3 deployment — the canonical address works on every Sablier chain except Abstract (2741), XDC (50), and ZKsync Era (324).

If the filtered list is empty, stop and tell the user nothing is currently unlocked across any of their streams on this chain; do not fall back to presenting the zero-withdrawable set.

With a symbol filter add `asset: { symbol: { _eq: $s } }` inside the top-level `where`:

```
_and: [
  { chainId: { _eq: $c } },
  { depleted: { _eq: false } },
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

- **Exactly one stream matches** — auto-select it and show the user a one-line confirmation: `Selected LK3-1-42 — 1,234.56 USDC withdrawable, sender 0xabc…`. Proceed to grouping.

- **Multiple streams (≤4)** — present them as `AskUserQuestion` with `multiSelect: true`. Each option label shows `${alias} — ${withdrawable} ${symbol}`; the description includes the sender and the stream end date. Add a separate option `All ${N} eligible streams (recommended)` so the user can opt for the bulk action without ticking each box. **Do not** add an "Other" option — `AskUserQuestion` adds it automatically and the user can use it for free-text overrides.

- **More than 4 streams** — render a Markdown table directly in your chat reply (not in tool stdout) and ask the user to reply with `all` or a comma-separated list of indices (e.g. `1,3,7`). Do not call `AskUserQuestion` with >4 options (the tool caps at 4).

  **Render the table in the assistant message, not in a Bash `echo`/`printf`.** Most chat UIs collapse tool output by default, so a list printed from `bash` is invisible to the user. Use Bash only to compute values (timestamps, formatted amounts); assemble the table as Markdown in your own response so it renders inline.

  Use a GitHub-flavored Markdown table with exactly these columns, in this order: `#`, `Stream`, `Withdrawable`, `Total Vesting`, `Ends`, `Sender`. The `Total Vesting` column is the indexer's `intactAmount` (`depositAmount - withdrawnAmount`) — i.e. the total tokens still held in the stream for the recipient, both already unlocked and still vesting. Do **not** include `Version` or `Category`. Right-align numeric columns with `---:` so amounts line up. Sort rows by `endTime` ascending (earliest end first) — this matches the indexer query's `order_by`, so preserve the input order. Format `Ends` as `Mon DD, YYYY` (e.g. `Oct 12, 2027`) — never `YYYY-MM-DD`. Abbreviate the sender address as `0xabcd…wxyz` and append `(you)` when it equals the signer.

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
  |  # | Stream         | Withdrawable |   Total Vesting | Ends         | Sender              |
  | -: | :------------- | -----------: | --------------: | :----------- | :------------------ |
  |  1 | LK2-8453-2890  | 0.008233 USDC | 0.008233 USDC  | Mar 29, 2026 | 0xc517…063c         |
  |  2 | LK2-8453-2329  |    0.035 USDC |     0.07 USDC  | Aug 10, 2026 | 0x0298…249f (you)   |
  ```

  After the table, ask: *"Reply with `all` to withdraw every row, or comma-separated row numbers (e.g. `1,3`) to pick a subset."* Validate every index is in `[1, N]` and unique; reject ambiguous input by re-prompting.

The result of this step is `SELECTED` — a JSON array of stream objects, each carrying at minimum `.contract`, `.version`, `.tokenId`, `.withdrawable`, `.alias`, `.recipient`, `.sender`, and `.asset`.

## Group by Lockup contract

Each `withdrawMultiple` call hits exactly one Lockup contract, so split the selection by `.contract`:

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

Invariant: a Lockup contract address always corresponds to a single deployed version, so grouping by `contract` automatically groups by `version`. The runbook treats `version` as authoritative for ABI dispatch and fee logic — never re-derive the version from the alias prefix at this stage.

If `GROUPS` has one element, the entire batch is one transaction. If it has more than one (e.g. the wallet has v1.2 streams on `0x...AAA` and v4.0 streams on `0x...BBB`), the user signs one transaction per group, sequentially.

## Access-Control Check

Apply per group, using the group's `version`:

| `version`                              | Who can sign `withdrawMultiple`?                                                                                                       | Notes for this skill                                                                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `v1.0`, `v1.1`                         | The `sender`, `recipient`, or an approved operator. The single shared `to` parameter must equal `recipient` if the caller is `sender`. | The skill always passes `to = OWNER`, and only surfaces streams where `OWNER == recipient`, so this rule is auto-satisfied. |
| `v1.2`, `v2.0`, `v2.1`, `v3.0`, `v4.0` | Anyone — there is no `to` parameter; tokens always flow to each stream's own `recipient`.                                              | No additional check is required.                                                                                            |

If for any reason the group contains a stream whose `recipient` is not the connected `OWNER` (this should never happen given the indexer filter, but check defensively), drop that stream from the group and warn the user. If the entire group becomes empty after filtering, drop the group.

## Preflight Checks

### Withdrawable amounts (per stream)

`scripts/evm/filter-withdrawable.sh` already ran during [Stream Discovery](#stream-discovery) and stamped the live `.withdrawable` value (base units) onto each stream. Reuse those values verbatim — every selected stream is withdrawn for its full `.withdrawable` amount:

```bash
# Per-stream amounts in the same order as the group's streams.
AMOUNTS=$(echo "$GROUP" | jq -r '[.streams[].withdrawable] | join(",")')
IDS=$(echo "$GROUP" | jq -r '[.streams[].tokenId] | join(",")')
```

If you skipped the filter step (debugging, or the caller already narrowed the input), recompute via direct contract calls — but the production path always uses the filter result.

### Withdraw fee `MSG_VALUE` (per group)

`withdrawMultiple` is `payable` on Lockup **v2.0 onward** and non-payable on v1.x. A non-zero `--value` against a non-payable contract reverts. Branch on the group's `version`:

```bash
case "$VERSION" in
  v1.*|v2.*)
    # withdrawMultiple is non-payable on v1.x, and on v2.x there is no protocol fee
    # configured (calculateMinFeeWei does not exist; the contract is payable but the
    # skill never sends value).
    MSG_VALUE=0
    ;;
  *)
    # v3.0+ — batch calculateMinFeeWei for every stream in the group via Multicall3,
    # take the MAX. See the rationale below.
    MSG_VALUE=$(echo "$GROUP" | jq '.streams' \
      | "$SKILL_DIR/scripts/evm/max-min-fee.sh" \
          --rpc-url "$RPC_URL" --chain-id "$CHAIN_ID")
    ;;
esac

# Defensive: a non-numeric MSG_VALUE will cascade into bc parser errors below.
[[ "$MSG_VALUE" =~ ^[0-9]+$ ]] || { echo "Error: MSG_VALUE not numeric: '$MSG_VALUE'"; exit 1; }
```

[scripts/evm/max-min-fee.sh](../scripts/evm/max-min-fee.sh) collapses the per-stream `cast call` loop into a single Multicall3 round trip — important on public RPCs (Base, Arbitrum, etc.) that throttle bursts. A per-stream loop intermittently produces empty stdout when individual calls are rate-limited, which silently propagates into the bc accumulators below and surfaces as cascading `bc: parser error` lines on the v3.0+ branch.

**Why MAX, not SUM.** `withdrawMultiple` does not call `withdraw` externally — it `delegatecall`s into `withdraw` for each stream (see `lockup/src/SablierLockup.sol:437-447`). Solidity preserves `msg.value` across `delegatecall`, and the inner `_withdraw` checks `msg.value >= calculateMinFeeWei(streamId)` (see `lockup/src/SablierLockup.sol:682-687`). So a single `msg.value` covers every iteration; the contract receives the fee exactly once per outer call. Sending the SUM would still pass the contract's check but would needlessly tie up extra ETH in the contract balance — the skill always sends the MAX, so the user pays the minimum required to satisfy every per-stream fee gate. If every stream in the group has a zero fee, `MSG_VALUE` is `0` and the transaction is fee-free.

### Per-group gas estimate

Estimate gas with the exact ABI and arguments the broadcast will use (different per version):

```bash
case "$VERSION" in
  v1.0|v1.1)
    SIG="withdrawMultiple(uint256[],address,uint128[])"
    GAS_ESTIMATE=$(cast estimate "$CONTRACT" "$SIG" \
      "[$IDS]" "$OWNER" "[$AMOUNTS]" \
      --rpc-url "$RPC_URL" --from "$OWNER")
    ;;
  *)
    SIG="withdrawMultiple(uint256[],uint128[])"
    GAS_ESTIMATE=$(cast estimate "$CONTRACT" "$SIG" \
      "[$IDS]" "[$AMOUNTS]" \
      --value "$MSG_VALUE" \
      --rpc-url "$RPC_URL" --from "$OWNER")
    ;;
esac
```

Note: in v1.0 / v1.1 the function is non-payable, so do not pass `--value`. The `IDS` and `AMOUNTS` strings are comma-separated lists already (e.g. `42,99,1027`); cast renders them as `uint256[]` / `uint128[]` automatically when wrapped in square brackets.

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

The preview is a single message that lists every group and the streams in it, plus per-token totals across the entire batch and the total native-token cost (fee + estimated gas).

Example for a wallet with v1.2 USDC streams and v4.0 SABL streams on the same chain:

```
Chain:         Ethereum (1)
Signer:        0xOwner…  (matches recipient)
Total fee:     0.0005 ETH    ← MAX(calculateMinFeeWei) on the v4.0 group; 0 on v1.x/v2.x
Estimated gas: 0.0021 ETH    ← sum across all groups

Group 1/2 — Lockup Linear v1.2
  Contract:    0xAAA…
  Streams (2):
    LL2-1-887  →  120 USDC      (sender 0xc517…063c)
    LL2-1-902  →   45.5 USDC    (sender 0xc517…063c)
  Group fee:    0 ETH   (non-payable)

Group 2/2 — Lockup v4.0
  Contract:    0x93b37Bd5B6b278373217333Ac30D7E74c85fBDCB
  Streams (3):
    LK3-1-42   →  1,234.56789 SABL  (sender 0xab12…cd34)
    LK3-1-58   →    250 SABL        (sender 0xab12…cd34)
    LK3-1-77   →    100 SABL        (sender 0x99aa…bbcc)
  Group fee:   0.0005 ETH  ← max calculateMinFeeWei across the 3 streams

Per-token totals:
  USDC:  165.5
  SABL:  1,584.56789
```

Then show the confirmation prompt:

```text
+--------------------------------------+
| Confirm broadcast for 2 transactions?|
| Reply exactly: YES                   |
+--------------------------------------+
```

If the user does not explicitly confirm with `YES`, stop. If the batch contains a single group, phrase the prompt as `Confirm broadcast for 1 transaction?` (no `s`).

## Broadcast

Broadcast each group sequentially. The user will see one browser approval prompt per group. Capture the tx hash for each.

```bash
# v1.0 / v1.1 — non-payable, single shared `to`
TX_HASH=$(cast send "$CONTRACT" \
  "withdrawMultiple(uint256[],address,uint128[])" \
  "[$IDS]" "$OWNER" "[$AMOUNTS]" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser \
  --async)
```

```bash
# v1.2 / v2.0 / v2.1 — no `to` parameter, no fee
TX_HASH=$(cast send "$CONTRACT" \
  "withdrawMultiple(uint256[],uint128[])" \
  "[$IDS]" "[$AMOUNTS]" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser \
  --async)
```

```bash
# v3.0 / v4.0 — payable; MSG_VALUE = max(calculateMinFeeWei) across the group
TX_HASH=$(cast send "$CONTRACT" \
  "withdrawMultiple(uint256[],uint128[])" \
  "[$IDS]" "[$AMOUNTS]" \
  --value "$MSG_VALUE" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser \
  --async)
```

Inform the user before each group: *"A browser tab will open — approve transaction {i}/{N} in your wallet extension (e.g. MetaMask)."* If `--browser` fails at runtime, fall back to `--private-key` as described in [Signing Method](#signing-method-mandatory). If the user declines a signature mid-flow, stop and tell them which group hashes already broadcast and which were not attempted.

## Verify Receipt

For each group, run the [Receipt Wait Timeout](#receipt-wait-timeout-mandatory) loop and capture the `RECEIPT` JSON. After confirming `status == 0x1`, scan the logs for any `InvalidWithdrawalInWithdrawMultiple(uint256 streamId, bytes result)` events — these are emitted (instead of reverting) by Lockup **v2.0+** when an individual stream's withdrawal failed inside the batch. Do **not** treat the overall tx as a full success without this check.

```bash
TOPIC=$(cast keccak "InvalidWithdrawalInWithdrawMultiple(uint256,bytes)")

FAILED_IDS=$(echo "$RECEIPT" | jq -r --arg t "$TOPIC" \
  '[.logs[] | select(.address == ($contract|ascii_downcase)) | select(.topics[0] == $t) | .topics[1]] | .[]' \
  --arg contract "$CONTRACT")

if [ -n "$FAILED_IDS" ]; then
  echo "The transaction confirmed but the following streams in this group did NOT withdraw:"
  for HEX_ID in $FAILED_IDS; do
    DEC_ID=$(cast to-dec "$HEX_ID")
    echo "  streamId $DEC_ID"
  done
fi
```

`v1.x` Lockups don't emit this event — on those versions a per-stream failure reverts the whole `withdrawMultiple`, so a successful receipt already implies every stream withdrew.

After verification, list each successfully withdrawn stream with its app link. Use the `alias` returned by the indexer — do **not** hardcode `LK3-`, because the alias prefix encodes the Lockup version (`LL3-` for v1.2 linear, `LK-` for v2.0, `LK2-` for v3.0, `LK3-` for v4.0, etc.):

```
https://app.sablier.com/vesting/stream/${ALIAS}
```

## Worked Example

A recipient with five eligible streams on Base — three on Lockup v1.2 (USDC) and two on v4.0 (SABL) — running a single batch:

```bash
INDEXER="https://indexer.hyperindex.xyz/53b7e25/v1/graphql"
CHAIN_ID=8453
RPC_URL="https://mainnet.base.org"
WALLET="0xRecipient…"

OWNER=$(cast wallet address --browser)

# 1) Stream discovery (no symbol filter — let the user mix tokens)
RESPONSE=$(curl -sS "$INDEXER" \
  -H 'content-type: application/json' \
  --data "$(jq -n \
    --arg q 'query($w:String!,$c:numeric!){LockupStream(where:{chainId:{_eq:$c},depleted:{_eq:false},recipient:{_eq:$w}} order_by:{endTime:asc} limit:500){id alias tokenId contract version sender recipient asset{address symbol decimals} intactAmount endTime}}' \
    --arg w "$(echo "$WALLET" | tr '[:upper:]' '[:lower:]')" \
    --argjson c "$CHAIN_ID" \
    '{query:$q,variables:{w:$w,c:$c}}')")

# 2) Drop zero-withdrawable streams via Multicall3 (one RPC round trip)
STREAMS=$(echo "$RESPONSE" | jq '.data.LockupStream' \
  | "$SKILL_DIR/scripts/evm/filter-withdrawable.sh" \
      --rpc-url "$RPC_URL" \
      --chain-id "$CHAIN_ID")

# 3) Default selection: all eligible streams. SELECTED == STREAMS for the bulk path.
SELECTED="$STREAMS"

# 4) Group by Lockup contract
GROUPS=$(echo "$SELECTED" | jq -c '
  group_by(.contract)
  | map({contract: .[0].contract, version: .[0].version, streams: .})
')

# 5) Per-group fee + gas estimation
TOTAL_GAS_UNITS=0
TOTAL_MSG_VALUE=0
GAS_PRICE=$(cast gas-price --rpc-url "$RPC_URL")
declare -a GROUP_PLANS=()

for ROW in $(echo "$GROUPS" | jq -c '.[]'); do
  CONTRACT=$(echo "$ROW" | jq -r .contract)
  VERSION=$(echo "$ROW" | jq -r .version)
  IDS=$(echo "$ROW" | jq -r '[.streams[].tokenId] | join(",")')
  AMOUNTS=$(echo "$ROW" | jq -r '[.streams[].withdrawable] | join(",")')

  case "$VERSION" in
    v1.*|v2.*)
      MSG_VALUE=0
      ;;
    *)
      MSG_VALUE=$(echo "$ROW" | jq '.streams' \
        | "$SKILL_DIR/scripts/evm/max-min-fee.sh" \
            --rpc-url "$RPC_URL" --chain-id "$CHAIN_ID")
      ;;
  esac
  [[ "$MSG_VALUE" =~ ^[0-9]+$ ]] || { echo "Error: MSG_VALUE not numeric: '$MSG_VALUE'"; exit 1; }

  case "$VERSION" in
    v1.0|v1.1)
      GAS_ESTIMATE=$(cast estimate "$CONTRACT" \
        "withdrawMultiple(uint256[],address,uint128[])" \
        "[$IDS]" "$OWNER" "[$AMOUNTS]" \
        --rpc-url "$RPC_URL" --from "$OWNER")
      ;;
    *)
      GAS_ESTIMATE=$(cast estimate "$CONTRACT" \
        "withdrawMultiple(uint256[],uint128[])" \
        "[$IDS]" "[$AMOUNTS]" \
        --value "$MSG_VALUE" \
        --rpc-url "$RPC_URL" --from "$OWNER")
      ;;
  esac
  [[ "$GAS_ESTIMATE" =~ ^[0-9]+$ ]] || { echo "Error: GAS_ESTIMATE not numeric: '$GAS_ESTIMATE'"; exit 1; }

  TOTAL_GAS_UNITS=$((TOTAL_GAS_UNITS + GAS_ESTIMATE))
  TOTAL_MSG_VALUE=$(echo "$TOTAL_MSG_VALUE + $MSG_VALUE" | bc)
  GROUP_PLANS+=("$CONTRACT|$VERSION|$IDS|$AMOUNTS|$MSG_VALUE")
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
  IFS='|' read -r CONTRACT VERSION IDS AMOUNTS MSG_VALUE <<< "$PLAN"

  case "$VERSION" in
    v1.0|v1.1)
      TX_HASH=$(cast send "$CONTRACT" \
        "withdrawMultiple(uint256[],address,uint128[])" \
        "[$IDS]" "$OWNER" "[$AMOUNTS]" \
        --rpc-url "$RPC_URL" --from "$OWNER" --browser --async)
      ;;
    *)
      TX_HASH=$(cast send "$CONTRACT" \
        "withdrawMultiple(uint256[],uint128[])" \
        "[$IDS]" "[$AMOUNTS]" \
        --value "$MSG_VALUE" \
        --rpc-url "$RPC_URL" --from "$OWNER" --browser --async)
      ;;
  esac

  echo "Broadcasted: $TX_HASH"
  # Poll receipt (see "Receipt Wait Timeout" loop), then scan for
  # InvalidWithdrawalInWithdrawMultiple events as shown in "Verify Receipt".
done

# 9) Per-stream app links
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
