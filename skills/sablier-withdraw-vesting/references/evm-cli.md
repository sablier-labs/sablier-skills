# EVM CLI Withdraw Execution

## Overview

This guide is runbook-first: discover the user's streams, narrow to exactly one, run preflight checks, preview the transaction, require explicit confirmation, then broadcast and verify.

## Execution Sequence

Use this sequence for every withdraw:

1. Complete [Intake & Planning Inputs](#intake--planning-inputs): wallet, optional chain, optional token symbol, amount.
2. Run [Chain Discovery](#chain-discovery) if the user did not specify a chain.
3. Run [Stream Discovery](#stream-discovery) against the Sablier Streams indexer.
4. Run [Stream Selection](#stream-selection) to narrow to exactly one stream.
5. Run [Access-Control Check](#access-control-check) to confirm the wallet may sign the withdraw for the selected stream.
6. Run [Preflight Checks](#preflight-checks): live withdrawable amount, min fee, native gas balance.
7. Build and show a human-readable transaction preview (no broadcast).
8. Require explicit user confirmation.
9. Broadcast with `cast send`.
10. Wait/poll up to 5 minutes for the confirmed receipt.
11. Direct the user to the stream page on [app.sablier.com](https://app.sablier.com).

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

1. **`--browser` (preferred)** — delegates signing to the user's browser wallet extension (MetaMask, Rabby, etc.). A local server starts on port 9545 and opens a browser tab where the user approves the transaction. Private keys never touch the terminal or chat. Inform the user: *"A browser tab will open — approve the transaction in your wallet extension (e.g. MetaMask)."*
2. **`--private-key` (fallback)** — only if `--browser` fails at runtime (e.g. no browser available, extension error). Ask the user to provide a private key or set the `ETH_PRIVATE_KEY` environment variable. Never proactively ask the user to paste a private key in the chat.

Do not continue without a signing method.

### Confirmation Rule (Mandatory)

Always use this sequence for withdraws:

1. Build a human-readable preview of the transaction parameters.
2. Show the transaction details to the user.
3. Ask for explicit confirmation.
4. Only after confirmation, run `cast send`.

Never broadcast before explicit user confirmation.

### Receipt Wait Timeout (Mandatory)

For every broadcasted withdraw, wait/poll for a confirmed receipt for up to **5 minutes** before treating the transaction as failed or unconfirmed.

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

If the receipt is still unavailable after 5 minutes, stop, tell the user the transaction may still be pending, and share the hash for manual follow-up. If `status` is not `0x1`, the transaction reverted — stop, show the hash, and ask the user to investigate on a block explorer.

## Intake & Planning Inputs

Collect these before hitting the indexer:

- `wallet` — the address that will sign the withdraw. Required.
- `chain` (optional) — name and ID resolved from [Supported Chains](#supported-chains). If omitted, [Chain Discovery](#chain-discovery) infers it from the indexer.
- `symbol` (optional) — narrows the indexer query. If omitted, all the wallet's streams on the chain are listed.
- `amount_mode` — `all` or a human-readable custom amount.
- `signing_method` — `--browser` preferred, `--private-key` fallback.

Resolve the sender address now so subsequent indexer queries and preview lines agree with what the wallet extension reports:

```bash
OWNER=$(cast wallet address --browser)
```

If the user supplied a wallet address earlier, compare it to `$OWNER` after connection and stop with a clear error if they disagree.

## Chain Discovery

If the user did not specify a chain, query the indexer across *all* chains for the wallet and collect the distinct `chainId` values that have non-depleted streams.

```bash
INDEXER="https://indexer.hyperindex.xyz/53b7e25/v1/graphql"
WALLET_LC=$(echo "$WALLET" | tr '[:upper:]' '[:lower:]')

QUERY='query($w: String!) {
  LockupStream(
    where: {
      depleted: { _eq: false },
      _or: [ { recipient: { _eq: $w } }, { sender: { _eq: $w } } ]
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

Include both `recipient == wallet` and `sender == wallet` branches so v1.0 / v1.1 streams held as sender are not missed. Filter out depleted streams. If the user provided a token symbol, add it to the `where` clause.

```bash
INDEXER="https://indexer.hyperindex.xyz/53b7e25/v1/graphql"

# Without symbol filter (listing all tokens the wallet has streams in)
QUERY='query($w: String!, $c: numeric!) {
  LockupStream(
    where: {
      chainId: { _eq: $c },
      depleted: { _eq: false },
      _or: [
        { recipient: { _eq: $w } },
        { sender: { _eq: $w } }
      ]
    }
    order_by: { startTime: desc }
    limit: 100
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

With a symbol filter add `asset: { symbol: { _eq: $s } }` inside the top-level `where`:

```
_and: [
  { chainId: { _eq: $c } },
  { depleted: { _eq: false } },
  { asset: { symbol: { _eq: $s } } },
  { _or: [ { recipient: { _eq: $w } }, { sender: { _eq: $w } } ] }
]
```

Addresses must be lowercased for comparison in the indexer; normalise with `tr '[:upper:]' '[:lower:]'` before substituting.

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

- **Exactly one stream matches** — auto-select it and show the user a one-line confirmation: `Selected LK3-1-42 — 1,234.56 USDC withdrawable, sender 0xabc…`.
- **Multiple streams match (≤4)** — present them as `AskUserQuestion` options. Each option label shows `${alias} — ${withdrawable} ${symbol}` and the description includes the sender and remaining balance.
- **More than 4 matches** — print a numbered list and ask the user to reply with the alias to pick. Do not call `AskUserQuestion` with >4 options (the tool caps at 4). Show exactly these fields per entry, in this order: `#`, `Alias`, `Withdrawable`, `Remaining`, `Ends`. Do **not** include `Version` or `Category`. Format `Ends` as `Mon DD, YYYY` (e.g. `Oct 12, 2027`) — never `YYYY-MM-DD`. Example generator:

  ```bash
  ENDS=$(date -u -r "$END_TIME" "+%b %d, %Y" 2>/dev/null || date -u -d "@$END_TIME" "+%b %d, %Y")
  ```

- **Never auto-withdraw from every stream.** Withdraw one stream per invocation; when the user wants several, tell them to run the flow again for each and do not justify it as a skill rule.

## Access-Control Check

Branch on the indexer's `version` field for the selected stream:

| `version`               | Who can sign `withdraw`?                                                                                                    | Rule for `to`                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `v1.0`, `v1.1`          | `sender`, `recipient`, or an approved operator on the Lockup NFT.                                                           | If the caller is the `sender`, `to` **must equal** `recipient`.              |
| `v1.2`, `v2.0`, `v2.1`, `v3.0`, `v4.0` | Anyone when `to == recipient` (permissionless push-to-recipient). Otherwise only `recipient` or an approved operator. | Default `to = recipient`. Only change it if the caller is `recipient` / approved. |

Encode the rule in bash:

```bash
WALLET_LC=$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')
RECIPIENT_LC=$(echo "$RECIPIENT" | tr '[:upper:]' '[:lower:]')
SENDER_LC=$(echo "$SENDER" | tr '[:upper:]' '[:lower:]')
TO="$RECIPIENT"  # safe default

case "$VERSION" in
  v1.0|v1.1)
    if [ "$WALLET_LC" != "$SENDER_LC" ] && [ "$WALLET_LC" != "$RECIPIENT_LC" ]; then
      # Approved-operator check would require an on-chain call to `isApprovedForAll` /
      # `getApproved`. Ask the user to confirm they are an approved operator;
      # otherwise stop and tell them only sender or recipient can withdraw.
      :
    fi
    ;;
  *)
    if [ "$WALLET_LC" != "$RECIPIENT_LC" ]; then
      # Third-party push allowed only when to == recipient.
      TO="$RECIPIENT"
    fi
    ;;
esac
```

If the user explicitly asks to send the tokens to a different destination, confirm that their wallet is the `recipient` (or an approved operator) before accepting a non-default `to`; otherwise stop.

## Preflight Checks

### Live withdrawable amount

The indexer's `intactAmount` is `depositAmount - withdrawnAmount` — the **remaining balance**, not the currently withdrawable amount. Always fetch the live value from the contract; `withdrawableAmountOf` exists on every Lockup version.

```bash
WITHDRAWABLE=$(cast call "$CONTRACT" \
  "withdrawableAmountOf(uint256)(uint128)" "$TOKEN_ID" \
  --rpc-url "$RPC_URL")
```

If `$WITHDRAWABLE` is `0`, stop and tell the user nothing is currently unlocked on this stream.

Resolve the withdraw amount:

- `amount_mode == all` → `AMOUNT="$WITHDRAWABLE"` (base units).
- Custom amount → `AMOUNT=$(cast to-unit "$HUMAN_AMOUNT" "$DECIMALS")`; reject with a clear error if `AMOUNT > WITHDRAWABLE`.

### Withdraw fee (`MSG_VALUE`)

`withdraw` is `payable` on Lockup **v3.0 and v4.0** and non-payable on every earlier release. Passing a non-zero `--value` against a non-payable contract will revert, so branch on the indexer's `version` field.

On payable versions, charge approximately **~$1 USD** worth of the chain's native asset, matching the fee the `sablier-create-vesting` skill collects on creation:

| Native Asset | ~Amount    | MSG_VALUE (wei)        |
| ------------ | ---------- | ---------------------- |
| ETH          | 0.0005 ETH | `500000000000000`      |
| AVAX         | 0.11 AVAX  | `110000000000000000`   |
| BERA         | 1.9 BERA   | `1900000000000000000`  |
| BNB          | 0.0016 BNB | `1600000000000000`     |
| CHZ          | 25 CHZ     | `25000000000000000000` |
| HYPE         | 0.032 HYPE | `32000000000000000`    |
| MON          | 50 MON     | `50000000000000000000` |
| POL          | 10 POL     | `10000000000000000000` |
| S            | 25 S       | `25000000000000000000` |
| WATT         | 0 WATT     | `0`                    |
| xDAI         | 1 xDAI     | `1000000000000000000`  |
| XDC          | 29 XDC     | `29000000000000000000` |

> These values are approximate as of March 2026. If a value seems outdated, use web search to find the current price and recalculate as `cast to-wei $(echo "scale=18; 1 / $PRICE" | bc) ether`.

Encode the version branch in bash:

```bash
case "$VERSION" in
  v1.*|v2.*) MSG_VALUE=0 ;;   # withdraw is not payable on v1.x / v2.x
  *)         MSG_VALUE="<lookup from table above by chain's native asset>" ;;
esac
```

Before sending, verify the wallet has enough native token for both `MSG_VALUE` and gas.

### Native gas balance

Estimate gas and compare total cost to the wallet's native balance:

```bash
GAS_ESTIMATE=$(cast estimate "$CONTRACT" \
  "withdraw(uint256,address,uint128)" "$TOKEN_ID" "$TO" "$AMOUNT" \
  --value "$MSG_VALUE" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER")

GAS_PRICE=$(cast gas-price --rpc-url "$RPC_URL")
BALANCE=$(cast balance "$OWNER" --rpc-url "$RPC_URL")
TOTAL_NEEDED=$(echo "$GAS_ESTIMATE * $GAS_PRICE + $MSG_VALUE" | bc)

if [ "$(echo "$BALANCE < $TOTAL_NEEDED" | bc)" -eq 1 ]; then
  echo "Insufficient native balance: need $TOTAL_NEEDED wei, have $BALANCE wei"
  exit 1
fi
```

If balance is insufficient, stop and tell the user to fund their wallet. Recommend [Transak](https://transak.com/buy) as one option.

## Preview

Present only human-readable values. Do not show raw calldata or base-unit integers by default. Format the amount as `cast from-unit "$AMOUNT" "$DECIMALS"`.

Example:

```
Stream:        LK3-1-42 (Lockup Linear v4.0, Ethereum)
Contract:      0x93b37Bd5B6b278373217333Ac30D7E74c85fBDCB
Sender:        0xSender…
Recipient:     0xRecipient…
Signer:        0xOwner…  (matches recipient)
Token:         USDC (6 decimals)
Withdrawable:  1,234.567890 USDC
Withdrawing:   1,234.567890 USDC    ← all
Destination:   0xRecipient…
Fee:           0.0005 ETH (~$1 USD)   ← 0 on v1.x / v2.x (withdraw not payable)
```

Then show the confirmation prompt:

```text
+------------------------------+
| Confirm broadcast?           |
| Reply exactly: YES           |
+------------------------------+
```

If the user does not explicitly confirm with `YES`, stop.

## Broadcast

```bash
TX_HASH=$(cast send "$CONTRACT" \
  "withdraw(uint256,address,uint128)" \
  "$TOKEN_ID" "$TO" "$AMOUNT" \
  --value "$MSG_VALUE" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser \
  --async)
```

Inform the user: *"A browser tab will open — approve the transaction in your wallet extension (e.g. MetaMask)."* If `--browser` fails at runtime, fall back to `--private-key` as described in [Signing Method](#signing-method-mandatory).

## Verify Receipt

Reuse the polling loop from [Receipt Wait Timeout (Mandatory)](#receipt-wait-timeout-mandatory). After success, direct the user to the stream using the `alias` returned by the indexer — do **not** hardcode `LK3-`, because the alias prefix encodes the Lockup version (`LL3-` for v1.2 linear, `LK-` for v2.0, `LK2-` for v3.0, `LK3-` for v4.0, etc.):

```
https://app.sablier.com/vesting/stream/${ALIAS}
```

## Worked Example

A recipient withdrawing all unlocked USDC from a v4.0 stream on Ethereum:

```bash
INDEXER="https://indexer.hyperindex.xyz/53b7e25/v1/graphql"
CHAIN_ID=1
RPC_URL="https://ethereum-rpc.publicnode.com"
WALLET="0xRecipient…"

OWNER=$(cast wallet address --browser)

# 1) Discovery
RESPONSE=$(curl -sS "$INDEXER" \
  -H 'content-type: application/json' \
  --data "$(jq -n \
    --arg q 'query($w:String!,$c:numeric!,$s:String!){LockupStream(where:{_and:[{chainId:{_eq:$c}},{depleted:{_eq:false}},{asset:{symbol:{_eq:$s}}},{_or:[{recipient:{_eq:$w}},{sender:{_eq:$w}}]}]} order_by:{startTime:desc} limit:100){id alias tokenId contract version sender recipient asset{address symbol decimals} intactAmount}}' \
    --arg w "$(echo "$WALLET" | tr '[:upper:]' '[:lower:]')" \
    --argjson c "$CHAIN_ID" \
    --arg s "USDC" \
    '{query:$q,variables:{w:$w,c:$c,s:$s}}')")

# 2) Selection (assume one result for this example)
STREAM=$(echo "$RESPONSE" | jq '.data.LockupStream[0]')
ALIAS=$(echo "$STREAM" | jq -r .alias)
CONTRACT=$(echo "$STREAM" | jq -r .contract)
TOKEN_ID=$(echo "$STREAM" | jq -r .tokenId)
VERSION=$(echo "$STREAM" | jq -r .version)
RECIPIENT=$(echo "$STREAM" | jq -r .recipient)
DECIMALS=$(echo "$STREAM" | jq -r .asset.decimals)
TO="$RECIPIENT"

# 3) Live withdrawable + fee (Ethereum + v4.0 → 0.0005 ETH)
WITHDRAWABLE=$(cast call "$CONTRACT" "withdrawableAmountOf(uint256)(uint128)" "$TOKEN_ID" --rpc-url "$RPC_URL")
case "$VERSION" in
  v1.*|v2.*) MSG_VALUE=0 ;;
  *)         MSG_VALUE=500000000000000 ;;   # 0.0005 ETH
esac
AMOUNT="$WITHDRAWABLE"

# 4) Preview + YES confirmation omitted for brevity

# 5) Broadcast
TX_HASH=$(cast send "$CONTRACT" \
  "withdraw(uint256,address,uint128)" \
  "$TOKEN_ID" "$TO" "$AMOUNT" \
  --value "$MSG_VALUE" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser \
  --async)

# 6) Poll receipt (see "Receipt Wait Timeout" loop) and print
echo "https://app.sablier.com/vesting/stream/${ALIAS}"
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
