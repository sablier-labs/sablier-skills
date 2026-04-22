# EVM CLI Stream Execution

## Overview

This guide is runbook-first: plan the stream, run preflight checks, preview the transaction, require explicit confirmation, then broadcast and verify.

## Execution Sequence

Use this sequence for every state-changing operation:

1. Complete [Intake & Planning Inputs](#intake--planning-inputs): mode, shape, variant, chain, and arguments.
2. Run all [Preflight Checks](#preflight-checks), including allowance/balance checks and `MSG_VALUE` setup.
3. Build and show a human-readable transaction preview (no broadcast).
4. Require explicit user confirmation.
5. Broadcast with `cast send`.
6. Wait/poll up to 5 minutes for the confirmed receipt, then derive the created stream ID or IDs from Lockup create events.
7. Direct the user to the stream page on [app.sablier.com](https://app.sablier.com).

If ERC-20 allowance is insufficient, execute an `approve` transaction first, wait/poll up to 5 minutes for its confirmed receipt, then resume at step 2.

## Mandatory Guardrails

### CLI Prerequisites Check

Before running any commands, verify the required tools are installed:

```bash
for cmd in cast jq; do
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
- `jq` — required for parsing transaction receipts.

### Signing Method (Mandatory)

For any signing command (`cast send`), use this hierarchy:

1. **`--browser` (preferred)** - delegates signing to the user's browser wallet extension (MetaMask, Rabby, etc.). A local server starts on port 9545 and opens a browser tab where the user approves the transaction. Private keys never touch the terminal or chat. Inform the user: *"A browser tab will open - approve the transaction in your wallet extension (e.g. MetaMask)."*
2. **`--private-key` (fallback)** - only if `--browser` fails at runtime (e.g. no browser available, extension error). In that case, ask the user to provide a private key or set the `ETH_PRIVATE_KEY` environment variable. Never proactively ask the user to paste a private key in the chat.

Do not continue without a signing method.

### Confirmation Rule (Mandatory)

Always use this sequence for state-changing transactions:

1. Build a human-readable preview of the transaction parameters.
2. Show the transaction details to the user.
3. Ask for explicit confirmation.
4. Only after confirmation, run `cast send`.

Never broadcast before explicit user confirmation.

### Receipt Wait Timeout (Mandatory)

For every broadcasted transaction (`approve`, Lockup single-stream creation, and `batch`), wait/poll for a confirmed receipt for up to **5 minutes** before treating the transaction as failed or unconfirmed.

Use this polling pattern for receipt verification:

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

# Check transaction status (1 = success, 0 = reverted)
TX_STATUS=$(echo "$RECEIPT" | jq -r '.status')
if [ "$TX_STATUS" != "0x1" ]; then
  echo "Transaction reverted: $TX_HASH"
  exit 1
fi
```

After polling:

- If the receipt is still unavailable after 5 minutes, stop, tell the user the transaction may still be pending, and share the transaction hash for manual follow-up.
- If `status` is not `0x1`, the transaction reverted — stop, show the transaction hash, and ask the user to investigate on a block explorer.

## Intake & Planning Inputs

Choose the transaction shape in this order before building calldata.

### 1) Choose Mode

Infer the creation mode from the user's request:

| Signal                                  | Mode                 |
| --------------------------------------- | -------------------- |
| One recipient, one stream               | **Single Stream**    |
| Multiple recipients or multiple streams | **Batch of Streams** |
| "create streams for 5 recipients"       | **Batch of Streams** |
| "create a stream for Alice"             | **Single Stream**    |

- If ambiguous, ask the user to clarify.

- For batch requests exceeding **50 streams**, route to `sablier-create-airdrop`. If this skill is unavailable, recommend installing it with:

  ```bash
  npx skills add sablier-labs/sablier-skills --skill sablier-create-airdrop
  ```

### 2) Choose Shape

This reference supports five vesting shapes: **Linear**, **Cliff**, **Unlock in Steps**, **Monthly Unlocks**, and **Timelock**. Choose one based on the user's description.

- If the vesting shape cannot be inferred from the user's instructions, default to **Linear**.
- If the user mentions a **cliff** but no other shape, default to **Cliff**.
- If the inferred shape is not among the five listed above, inform the user that this skill does not currently support that shape and suggest they request it as a feature. In the meantime, direct them to the [vesting gallery](https://app.sablier.com/vesting/gallery) in the Sablier UI.

### 3) Choose Variant

- **`Durations` variants** (`createWithDurationsLL`, `createWithDurationsLT`): use when the user does not specify a specific start time. The stream starts immediately upon transaction confirmation.
- **`Timestamps` variants** (`createWithTimestampsLL`, `createWithTimestampsLT`): use when the user specifies a specific start time (for example, "starting March 15" or "beginning at Unix timestamp 1710460800").

### 4) Resolve Chain and `SablierLockup`

Use [Supported Chains](#supported-chains) to resolve chain metadata, RPC endpoints, and `SablierLockup` contract addresses.

If the requested chain is not listed:

1. Check [Sablier Lockup deployments](https://docs.sablier.com/guides/lockup/deployments) for the contract address.
2. If still unresolved, ask the user to provide both the RPC URL and `SablierLockup` contract address.

### 5) Collect Required Inputs

Collect these before building any transaction:

- `chain` (ID and name)
- sender wallet address (resolved via `cast wallet address --browser` or provided by the user)
- signing method (`--browser` preferred, `--private-key` fallback)
- native gas balance (`ETH` etc.)
- `SablierLockup` contract address
- recipient count and number of streams
- token, deposit amount, and approval requirements
- function signature and arguments (see [Entrypoint Catalog](#entrypoint-catalog))

## Preflight Checks

Run these checks before previewing or broadcasting any state-changing transaction.

### Creation Fee (`MSG_VALUE`)

The creation fee is approximately **~$1 USD** worth of the chain's native asset. Calculate it dynamically before each transaction.

**Procedure:**

Look up the `MSG_VALUE` for the chain's native asset from this table:

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

- Use the same fee for both **Single Stream** and **Batch of Streams** transactions.
- Before sending, verify the wallet has enough native token for both `MSG_VALUE` and gas.

### Allowance and Token Balance

For stream creation:

1. **ERC-20 allowance.** Check `allowance(owner, lockup)`. The required allowance depends on mode:
   - **Single Stream:** `DEPOSIT_AMOUNT`
   - **Batch of Streams:** sum of `DEPOSIT_AMOUNT` across all streams
     If allowance is below the required total, send an `approve` transaction to raise allowance before attempting stream creation.
2. **ERC-20 token balance.** Check `balanceOf(owner)` is at least the total deposit amount (single-stream deposit or the sum of all batch deposits). If balance is insufficient, stop execution and inform the user they need more tokens (for example, purchase via Uniswap) before continuing.

### Native Gas Balance for Every Transaction

Before broadcasting each transaction, estimate the gas cost and verify the sender can cover both gas and the creation fee (`MSG_VALUE`):

```bash
# Estimate gas for the transaction (returns gas units)
GAS_ESTIMATE=$(cast estimate "$LOCKUP" "$FUNCTION_SIG" $FUNCTION_ARGS \
  --value "$MSG_VALUE" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER")

# Get current gas price (in wei)
GAS_PRICE=$(cast gas-price --rpc-url "$RPC_URL")

# Total native token needed = (gas estimate × gas price) + MSG_VALUE
TOTAL_NEEDED=$(echo "$GAS_ESTIMATE * $GAS_PRICE + $MSG_VALUE" | bc)
```

Compare `TOTAL_NEEDED` against the sender's native balance. Run this check before each broadcast (`approve` and stream creation). If balance is insufficient, stop and tell the user to fund their wallet first. Recommend buying via [Transak](https://transak.com/buy).

### Read-Only Validation Commands

Resolve the sender address first via the browser wallet, then run read-only checks:

```bash
# Resolve sender address from browser wallet (opens a browser tab for the user to connect)
OWNER=$(cast wallet address --browser)

# Check native gas token balance (ETH/POL/BNB/etc.)
cast balance "$OWNER" --rpc-url "$RPC_URL"

# Check token balance
cast call "$TOKEN" "balanceOf(address)(uint256)" "$OWNER" --rpc-url "$RPC_URL"

# Check token allowance
cast call "$TOKEN" "allowance(address,address)(uint256)" "$OWNER" "$LOCKUP" --rpc-url "$RPC_URL"
```

## Execution Runbook

### Shared Setup

#### 1) Resolve RPC URL, signing method, and sender address

```bash
CHAIN_ID="<resolved-chain-id>"
RPC_URL="<resolved-or-user-provided-rpc>"

# Resolve sender address from browser wallet (opens a browser tab for the user to connect)
OWNER=$(cast wallet address --browser)
```

#### 2) Run preflight checks and handle `approve` if needed

Run all checks from [Preflight Checks](#preflight-checks), calculate `MSG_VALUE` per the [Creation Fee](#creation-fee-msg_value) section, and re-run the native gas check before each broadcast (`approve` and stream creation). If an ERC-20 `approve` transaction is needed, execute it, wait/poll up to 5 minutes for the confirmed receipt per [Receipt Wait Timeout (Mandatory)](#receipt-wait-timeout-mandatory), then continue to step 3.

### Single Stream Flow

#### 3) Preview Transaction (No Broadcast)

Build calldata internally if needed to validate the exact transaction before signing, but do not show the raw calldata in the default preview:

```bash
CALLDATA=$(cast calldata "$FUNCTION_SIG" $FUNCTION_ARGS)
```

Present a human-readable summary.

Default preview rule: show only human-readable values in the user-facing preview. Do not show raw calldata or token base-unit integers unless the user explicitly asks for the exact machine values in a separate follow-up.

- **Contract:** `$LOCKUP`
- **Function:** chosen `create*` entrypoint
- **Recipient, token, amount, shape, duration/timestamps**. In the preview, the amount field must show only the human-readable token amount, for example `(0.1 USDC)`.
- **Creation fee:** ~$1 USD in native token (`MSG_VALUE`)
- **Expected UI slug after confirmation:** `LK3-${CHAIN_ID}-<streamId>`

#### 4) Require Explicit Confirmation

Use a clear confirmation flow:

⚠️ Final confirmation required

```text
+------------------------------+
| Confirm broadcast?           |
| Reply exactly: YES           |
+------------------------------+
```

If the user does not explicitly confirm with `YES`, stop.

#### 5) Broadcast After Confirmation

A browser tab will open for the user to approve the transaction in their wallet extension.

```bash
TX_HASH=$(cast send "$LOCKUP" "$FUNCTION_SIG" $FUNCTION_ARGS \
  --value "$MSG_VALUE" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser \
  --async)
```

If `--browser` fails at runtime, ask the user to provide a private key and retry with `--private-key`.

#### 6) Verify Receipt and Extract the Created Stream ID

```bash
CREATE_LL_TOPIC0="0xbc42cec3f2bd75ce97894dacc83ec6c4b682220d349b5a52d5743e7b46eba2d0"
CREATE_LT_TOPIC0="0xb5286ba059f8139658108ff5a9617e2ba55bd80fb2dd93063f9f9bc0e65c4c2a"
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

STREAM_IDS=$(echo "$RECEIPT" | jq -r \
  --arg lockup "$(echo "$LOCKUP" | tr '[:upper:]' '[:lower:]')" \
  --arg create_ll "$CREATE_LL_TOPIC0" \
  --arg create_lt "$CREATE_LT_TOPIC0" '
  .logs[]
  | select((.address | ascii_downcase) == $lockup)
  | select(.topics[0] == $create_ll or .topics[0] == $create_lt)
  | .topics[1]
' | while read -r STREAM_ID_HEX; do
  cast to-dec "$STREAM_ID_HEX"
done)

STREAM_ID=$(printf '%s\n' "$STREAM_IDS" | sed -n '1p')
```

#### 7) Direct User to the Stream

After successful receipt verification within the 5-minute timeout:

- If `STREAM_ID` is empty, stop and tell the user no Lockup create event was found in the confirmed receipt.
- Present the direct link to the stream:

```
https://app.sablier.com/vesting/stream/LK3-${CHAIN_ID}-${STREAM_ID}
```

### Batch Flow

#### 3) Encode Individual Create Calls

For each stream, ABI-encode the full `create*` calldata using `cast calldata`:

```bash
CALL_1=$(cast calldata "$FUNCTION_SIG" $ARGS_STREAM_1)
CALL_2=$(cast calldata "$FUNCTION_SIG" $ARGS_STREAM_2)
CALL_3=$(cast calldata "$FUNCTION_SIG" $ARGS_STREAM_3)
# ... repeat for each stream
```

Each `CALL_N` is a complete calldata blob (4-byte selector + ABI-encoded arguments).

#### 4) Preview Batch Transaction (No Broadcast)

Present a human-readable summary.

Apply the same default preview rule: do not show `CALL_N` blobs or token base-unit integers unless the user explicitly asks for the exact machine values in a separate follow-up.

- **Contract:** `$LOCKUP`
- **Function:** `batch(bytes[])`
- **Number of streams**, each with: recipient, human-readable amount only (for example `(0.1 USDC)`), shape, duration
- **Creation fee:** ~$1 USD in native token (`MSG_VALUE`) for the entire batch
- **Expected UI slug after confirmation:** `LK3-${CHAIN_ID}-<streamId>`

#### 5) Require Explicit Confirmation

Apply the same confirmation rule as Single Stream: show transaction details, then show the same boxed `Reply exactly: YES` confirmation prompt before broadcast.

#### 6) Broadcast After Confirmation

A browser tab will open for the user to approve the transaction in their wallet extension.

```bash
TX_HASH=$(cast send "$LOCKUP" "batch(bytes[])" "[$CALL_1,$CALL_2,$CALL_3]" \
  --value "$MSG_VALUE" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser \
  --async)
```

If `--browser` fails at runtime, ask the user to provide a private key and retry with `--private-key`.

#### 7) Verify Receipt and Extract Created Stream IDs

```bash
CREATE_LL_TOPIC0="0xbc42cec3f2bd75ce97894dacc83ec6c4b682220d349b5a52d5743e7b46eba2d0"
CREATE_LT_TOPIC0="0xb5286ba059f8139658108ff5a9617e2ba55bd80fb2dd93063f9f9bc0e65c4c2a"
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

STREAM_IDS=$(echo "$RECEIPT" | jq -r \
  --arg lockup "$(echo "$LOCKUP" | tr '[:upper:]' '[:lower:]')" \
  --arg create_ll "$CREATE_LL_TOPIC0" \
  --arg create_lt "$CREATE_LT_TOPIC0" '
  .logs[]
  | select((.address | ascii_downcase) == $lockup)
  | select(.topics[0] == $create_ll or .topics[0] == $create_lt)
  | .topics[1]
' | while read -r STREAM_ID_HEX; do
  cast to-dec "$STREAM_ID_HEX"
done)
```

#### 8) Direct User to the Sablier App

After successful receipt verification within the 5-minute timeout:

- If `STREAM_IDS` is empty, stop and tell the user no Lockup create events were found in the confirmed receipt.
- Present one link per stream using the confirmed IDs:

```bash
printf '%s\n' "$STREAM_IDS" | while read -r STREAM_ID; do
  echo "https://app.sablier.com/vesting/stream/LK3-${CHAIN_ID}-${STREAM_ID}"
done
```

## Entrypoint Catalog

Maps each vesting shape to the correct `SablierLockup` function and calldata encoding. Refer to ABI definitions in [lockup-v4.0-abi.json](../assets/lockup-v4.0-abi.json) for exact tuple encoding.

### Shape-to-Function Mapping

| Shape           | `Durations` Variant     | `Timestamps` Variant     | `shape` String      |
| --------------- | ----------------------- | ------------------------ | ------------------- |
| Linear          | `createWithDurationsLL` | `createWithTimestampsLL` | `"linear"`          |
| Cliff           | `createWithDurationsLL` | `createWithTimestampsLL` | `"cliff"`           |
| Unlock in Steps | `createWithDurationsLT` | `createWithTimestampsLT` | `"tranchedStepper"` |
| Monthly Unlocks | `createWithDurationsLT` | `createWithTimestampsLT` | `"tranchedMonthly"` |
| Timelock        | `createWithDurationsLL` | `createWithTimestampsLL` | `"linearTimelock"`  |

Use `Durations` variants when the stream should start immediately upon confirmation. Use `Timestamps` variants when the user provides specific start or unlock times.

### `createWithDurationsLL`

Used for **Linear**, **Cliff**, and **Timelock** when no specific start time is given.

```
createWithDurationsLL(
  (address sender, address recipient, uint128 depositAmount, address token, bool cancelable, bool transferable, string shape),
  (uint128 start, uint128 cliff),
  uint40 granularity,
  (uint40 cliff, uint40 total)
)
```

**Arguments:**

1. **params** tuple - `(sender, recipient, depositAmount, token, cancelable, transferable, shape)`
2. **unlockAmounts** tuple - `(start, cliff)` - amounts unlocked instantly at stream start and at cliff time
3. **granularity** - streaming granularity in seconds; use `0` (defaults to 1-second granularity on-chain)
4. **durations** tuple - `(cliff, total)` - durations in seconds

**Shape-specific encoding:**

| Shape    | `unlockAmounts`          | `durations`                                        |
| -------- | ------------------------ | -------------------------------------------------- |
| Linear   | `(0, 0)`                 | `(0, totalDuration)` - no cliff                    |
| Cliff    | `(0, cliffUnlockAmount)` | `(cliffDuration, totalDuration)`                   |
| Timelock | `(0, 0)`                 | `(0, lockDuration)` - entire amount unlocks at end |

### `createWithTimestampsLL`

Used for **Linear**, **Cliff**, and **Timelock** when the user specifies a start time.

```
createWithTimestampsLL(
  (address sender, address recipient, uint128 depositAmount, address token, bool cancelable, bool transferable, (uint40 start, uint40 end) timestamps, string shape),
  (uint128 start, uint128 cliff),
  uint40 granularity,
  uint40 cliffTime
)
```

**Arguments:**

1. **params** tuple - `(sender, recipient, depositAmount, token, cancelable, transferable, (startTimestamp, endTimestamp), shape)`
2. **unlockAmounts** tuple - `(start, cliff)` - amounts unlocked instantly at stream start and at cliff time
3. **granularity** - streaming granularity in seconds; use `0` (defaults to 1-second granularity on-chain)
4. **cliffTime** - Unix timestamp for the cliff; set to `0` if no cliff

**Shape-specific encoding:**

| Shape    | `unlockAmounts`          | `cliffTime`          |
| -------- | ------------------------ | -------------------- |
| Linear   | `(0, 0)`                 | `0`                  |
| Cliff    | `(0, cliffUnlockAmount)` | cliff Unix timestamp |
| Timelock | `(0, 0)`                 | `0`                  |

### `createWithDurationsLT`

Used for **Unlock in Steps** and **Monthly Unlocks** when no specific start time is given.

```
createWithDurationsLT(
  (address sender, address recipient, uint128 depositAmount, address token, bool cancelable, bool transferable, string shape),
  (uint128 amount, uint40 duration)[]
)
```

**Arguments:**

1. **params** tuple - `(sender, recipient, depositAmount, token, cancelable, transferable, shape)`
2. **tranchesWithDuration** array - each element is `(amount, duration)` where `amount` is the token amount unlocked in that tranche and `duration` is the tranche length in seconds

**Shape-specific encoding:**

| Shape           | Tranche Construction                                                                 |
| --------------- | ------------------------------------------------------------------------------------ |
| Unlock in Steps | Equal amounts, equal durations (for example, 4 tranches of 250 tokens every 90 days) |
| Monthly Unlocks | Equal amounts, 30-day durations (use 2592000 seconds per tranche)                    |

### `createWithTimestampsLT`

Used for **Unlock in Steps** and **Monthly Unlocks** when the user specifies a start time.

```
createWithTimestampsLT(
  (address sender, address recipient, uint128 depositAmount, address token, bool cancelable, bool transferable, (uint40 start, uint40 end) timestamps, string shape),
  (uint128 amount, uint40 timestamp)[]
)
```

**Arguments:**

1. **params** tuple - `(sender, recipient, depositAmount, token, cancelable, transferable, (startTimestamp, endTimestamp), shape)`
2. **tranches** array - each element is `(amount, timestamp)` where `amount` is the token amount unlocked and `timestamp` is the Unix timestamp at which it unlocks

**Shape-specific encoding:**

| Shape           | Tranche Construction                                                           |
| --------------- | ------------------------------------------------------------------------------ |
| Unlock in Steps | Equal amounts at equally spaced timestamps                                     |
| Monthly Unlocks | Equal amounts at monthly timestamps (tranche N unlocks at start + N × 30 days) |

### `batch`

Used to create **multiple streams in a single transaction**. Each element in the `calls` array is a fully ABI-encoded `create*` calldata.

```
batch(bytes[] calls)
```

**Arguments:**

1. **calls** - `bytes[]` array where each element is the output of `cast calldata` for a `create*` function

## Worked Examples

These examples intentionally use raw integers and ABI-ready arguments because they are for command construction. Do not copy these machine values into the default transaction preview; show human-readable token amounts first, and provide exact machine values separately only if the user explicitly asks.

### Single Stream: `createWithDurationsLL`

A single cliff stream of 1000 USDC (6 decimals) with a 90-day cliff and 365-day total duration on Ethereum mainnet:

```bash
LOCKUP="<lockup-address>"    # From Supported Chains table
CHAIN_ID="1"                 # Ethereum mainnet
TOKEN="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"  # USDC on Ethereum
# Calculate MSG_VALUE per the "Creation Fee" section
SENDER=$(cast wallet address --browser)
RECIPIENT="0x..."

TX_HASH=$(cast send "$LOCKUP" \
  "createWithDurationsLL((address,address,uint128,address,bool,bool,string),(uint128,uint128),uint40,(uint40,uint40))" \
  "($SENDER,$RECIPIENT,1000000000,$TOKEN,true,true,cliff)" \
  "(0,0)" \
  "0" \
  "(7776000,31536000)" \
  --value "$MSG_VALUE" \
  --rpc-url "$RPC_URL" \
  --from "$SENDER" \
  --browser \
  --async)
```

Notes:

- `1000000000` = 1000 USDC in 6-decimal base units
- `cliff` selects the Cliff shape
- `(0,0)` = no start unlock and no lump-sum cliff unlock amount
- `(7776000,31536000)` = 90-day cliff and 365-day total duration, both in seconds
- `MSG_VALUE` = ~$1 USD worth of native token (see [Creation Fee](#creation-fee-msg_value))
- After confirmation, wait/poll up to 5 minutes for the confirmed receipt, then extract the real `streamId` from the Lockup create event and build the final app link as `https://app.sablier.com/vesting/stream/LK3-${CHAIN_ID}-${STREAM_ID}`

### Batch of Streams: 3x `createWithDurationsLL`

A batch of three linear streams of 1000 USDC each to different recipients, with a 365-day duration and no cliff, on Ethereum mainnet:

```bash
LOCKUP="<lockup-address>"    # From Supported Chains table
CHAIN_ID="1"                 # Ethereum mainnet
TOKEN="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"  # USDC on Ethereum
# Calculate MSG_VALUE per the "Creation Fee" section
SENDER=$(cast wallet address --browser)
FUNCTION_SIG="createWithDurationsLL((address,address,uint128,address,bool,bool,string),(uint128,uint128),uint40,(uint40,uint40))"

# Encode each create call
CALL_1=$(cast calldata "$FUNCTION_SIG" \
  "($SENDER,0xRecipient1,1000000000,$TOKEN,true,true,linear)" "(0,0)" "0" "(0,31536000)")
CALL_2=$(cast calldata "$FUNCTION_SIG" \
  "($SENDER,0xRecipient2,1000000000,$TOKEN,true,true,linear)" "(0,0)" "0" "(0,31536000)")
CALL_3=$(cast calldata "$FUNCTION_SIG" \
  "($SENDER,0xRecipient3,1000000000,$TOKEN,true,true,linear)" "(0,0)" "0" "(0,31536000)")

TX_HASH=$(cast send "$LOCKUP" "batch(bytes[])" "[$CALL_1,$CALL_2,$CALL_3]" \
  --value "$MSG_VALUE" \
  --rpc-url "$RPC_URL" \
  --from "$SENDER" \
  --browser \
  --async)
```

Notes:

- ERC-20 approval must cover the total deposit: `3 × 1000000000 = 3000000000` base units (3000 USDC)
- `linear` selects the Linear shape
- `MSG_VALUE` = ~$1 USD worth of native token for the entire batch
- All three streams use the same `SablierLockup` contract and the same `batch()` entrypoint
- After confirmation, wait/poll up to 5 minutes for the confirmed receipt, then extract all `streamId` values and build one final link per stream as `https://app.sablier.com/vesting/stream/LK3-${CHAIN_ID}-${STREAM_ID}`
- For more than 50 streams, route to `sablier-create-airdrop`

## Supported Chains

Use this registry to resolve chain metadata, RPC endpoints, native asset pricing, and `SablierLockup` contract addresses:

UI support note:

- The Lockup v4.0 UI alias is `LK3`, so supported vesting links use `https://app.sablier.com/vesting/stream/LK3-${CHAIN_ID}-${STREAM_ID}`.

| Chain         | Chain ID   | Native Asset | SablierLockup                                | RPC URL                                          |
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
