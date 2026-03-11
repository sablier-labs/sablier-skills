# EVM CLI Campaign Execution

## Overview

This guide is runbook-first: plan the campaign, generate the Merkle tree, run preflight checks, preview the transactions, require explicit confirmation, then deploy and fund.

**Prerequisites:** This runbook requires `cast`, `jq`, and `node` (checked in [CLI Prerequisites](#cli-prerequisites-check)). Merkle tree generation uses the local helper in `skills/sablier-create-airdrop/scripts` plus a single Pinata JWT for IPFS publication (see [merkle-tree.md](merkle-tree.md)).

## Execution Sequence

Use this sequence for every campaign creation:

1. Complete [Intake & Planning Inputs](#intake--planning-inputs): campaign type, chain, inputs, and Merkle tree generation.
2. Run all [Preflight Checks](#preflight-checks), including token balance and native gas balance.
3. Build and show a human-readable transaction preview (no broadcast).
4. Require explicit user confirmation.
5. Deploy the campaign via the factory with `cast send`, wait/poll up to 5 minutes for the confirmed receipt.
6. Fund the campaign by transferring tokens to the deployed campaign address, wait/poll up to 5 minutes for the confirmed receipt.
7. Direct the user to the campaign page on [app.sablier.com](https://app.sablier.com).

## Mandatory Guardrails

### CLI Prerequisites Check

Before running any commands, verify the required tools are installed:

```bash
for cmd in cast jq node; do
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
- `jq` — required for parsing JSON responses from the local generator and transaction receipts.
- `node` — required for the local Merkle generator.

### Signing Method (Mandatory)

For any signing command (`cast send`), use this hierarchy:

1. **`--browser` (preferred)** - delegates signing to the user's browser wallet extension (MetaMask, Rabby, etc.). A local server starts on port 9545 and opens a browser tab where the user approves the transaction. Private keys never touch the terminal or chat. Inform the user: *"A browser tab will open - approve the transaction in your wallet extension (e.g. MetaMask)."*
2. **`--private-key` (fallback)** - only if `--browser` fails at runtime (e.g. no browser available, extension error). In that case, ask the user to provide a private key or set the `ETH_PRIVATE_KEY` environment variable. Never proactively ask the user to paste a private key in the chat.

Do not continue without a signing method.

### Confirmation Rule (Mandatory)

Always use this sequence for state-changing transactions:

1. Build a human-readable preview of all transaction parameters.
2. Show the transaction details to the user.
3. Ask for explicit confirmation.
4. Only after confirmation, execute the transactions.

Never broadcast before explicit user confirmation.

### Receipt Wait Timeout (Mandatory)

For every broadcasted transaction (factory deploy and token funding), wait/poll for a confirmed receipt for up to **5 minutes** before treating the transaction as failed or unconfirmed.

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

Complete these steps in order before building calldata.

### 1) Choose Campaign Type

Use the [decision tree in SKILL.md](../SKILL.md#choosing-a-campaign-type) to select the campaign type:

| Signal                                                              | Campaign Type |
| ------------------------------------------------------------------- | ------------- |
| "airdrop tokens immediately", "instant distribution"                | **Instant**   |
| "airdrop with vesting", "linear vesting airdrop", "cliff + vesting" | **MerkleLL**  |
| "airdrop with monthly unlocks", "quarterly vesting", "step unlocks" | **MerkleLT**  |

- If ambiguous, ask the user to clarify using the decision tree.

### 2) Resolve Chain and Factory

Look up the factory contract address for the chosen campaign type and target chain at the [Airdrop Deployments page](https://docs.sablier.com/guides/airdrops/deployments.md).

Each campaign type has a dedicated factory:

| Campaign Type | Factory Contract              |
| ------------- | ----------------------------- |
| Instant       | `SablierFactoryMerkleInstant` |
| Linear (LL)   | `SablierFactoryMerkleLL`      |
| Tranched (LT) | `SablierFactoryMerkleLT`      |

Also look up:

- **SablierLockup address** — required by MerkleLL and MerkleLT campaigns (look up at [Lockup Deployments](https://docs.sablier.com/guides/lockup/deployments.md))

If the requested chain is not listed, ask the user to provide both the RPC URL and the factory address.

### 3) Collect Required Inputs

Collect these from the user before generating the Merkle tree or building any transaction:

- `chain` (ID and name — from step 2; store the numeric chain ID as `CHAIN_ID` for the final campaign URL)
- `token` address
- sender wallet address (resolved via `cast wallet address --browser` or provided by the user)
- signing method (`--browser` preferred, `--private-key` fallback)
- factory contract address (from step 2)
- `campaignName`
- `campaignStartTime` (Unix timestamp when claims open; `0` for immediate)
- `expiration` (Unix timestamp; `0` for never)
- `initialAdmin` (address authorized to clawback; defaults to sender if not specified)

**Type-specific inputs:**

| Campaign Type | Additional Inputs                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instant       | None                                                                                                                                                                                |
| MerkleLL      | `lockup` address, `cancelable`, `transferable`, `shape`, `totalDuration`, `cliffDuration`, `cliffUnlockPercentage` (UD60x18), `startUnlockPercentage` (UD60x18), `vestingStartTime` |
| MerkleLT      | `lockup` address, `cancelable`, `transferable`, `shape`, `tranchesWithPercentages` array (each: `unlockPercentage` as UD2x18, `duration`), `vestingStartTime`                       |

### 4) Collect Recipient Data and Generate Merkle Tree

Follow the full process in [merkle-tree.md](merkle-tree.md): collect the CSV, validate it, run the local generator, and parse the response. This step requires `TOKEN` and `RPC_URL` from steps 2–3.

This step produces four values used throughout the rest of the runbook:

- `MERKLE_ROOT` — for the factory's `merkleRoot` parameter
- `IPFS_CID` — for the factory's `ipfsCID` parameter
- `AGGREGATE_AMOUNT` — total tokens in base units, for `aggregateAmount` and funding
- `RECIPIENT_COUNT` — for `recipientCount`

Do not proceed to preflight checks without all four values.

## Important Notes

**`aggregateAmount` is not enforced onchain.** The Merkle tree leaf amounts are what enforce correctness. If the campaign is funded with less than the true aggregate, later claims will fail. Always fund the campaign with at least the full aggregate amount.

**Token amounts must be in the token's smallest unit.** For example, for an 18-decimal token, 1.0 token = `1000000000000000000`. For a 6-decimal token like USDC, 1.0 USDC = `1000000`.

**`initialAdmin` can differ from the campaign creator.** The `initialAdmin` is the address authorized to clawback unclaimed tokens — it does not have to be the same address that deploys the campaign. If the user does not specify an admin, default to the sender address.

**Creation and funding are decoupled** — the campaign contract can exist before tokens are deposited. However, claims will fail if the campaign has insufficient token balance, so always fund before `campaignStartTime`.

## Campaign Lifecycle

```
1. CREATE    → Deploy campaign via factory
2. FUND      → Transfer tokens to the campaign contract
3. CLAIMS    → Recipients claim with Merkle proofs (after campaignStartTime)
4. CLAWBACK  → (optional) Admin recovers unclaimed tokens after expiration
```

**Clawback** is allowed up until 7 days have passed since the first claim, and after the campaign has expired. It is blocked in between.

## Preflight Checks

Run these checks before previewing or broadcasting any transaction.

### Token Balance

Check `balanceOf(owner)` is at least the `aggregateAmount`. If balance is insufficient, stop execution and inform the user they need more tokens (for example, purchase via Uniswap) before continuing.

### Native Gas Balance for Every Transaction

Before broadcasting, estimate the gas cost and verify the sender can cover gas for both transactions (factory call and token funding):

```bash
# Estimate gas for the factory call
GAS_ESTIMATE=$(cast estimate "$FACTORY" "$FUNCTION_SIG" $FUNCTION_ARGS \
  --rpc-url "$RPC_URL" \
  --from "$OWNER")

# Get current gas price (in wei)
GAS_PRICE=$(cast gas-price --rpc-url "$RPC_URL")

# Total native token needed ≈ gas estimate × gas price × 2 transactions
# This is a rough estimate — the actual gas per transaction varies
TOTAL_NEEDED=$(echo "$GAS_ESTIMATE * $GAS_PRICE * 2" | bc)
```

Compare `TOTAL_NEEDED` against the sender's native balance. If balance is insufficient, stop and tell the user to fund their wallet first. Recommend buying via [Transak](https://transak.com/buy).

### Read-Only Validation Commands

```bash
# Resolve sender address from browser wallet (opens a browser tab for the user to connect)
OWNER=$(cast wallet address --browser)

# Check native gas token balance (ETH/POL/BNB/etc.)
cast balance "$OWNER" --rpc-url "$RPC_URL"

# Check token balance
cast call "$TOKEN" "balanceOf(address)(uint256)" "$OWNER" --rpc-url "$RPC_URL"
```

## Execution Runbook

### 1) Resolve RPC URL, signing method, and sender address

```bash
RPC_URL="<resolved-or-user-provided-rpc>"

# Resolve sender address from browser wallet (opens a browser tab for the user to connect)
OWNER=$(cast wallet address --browser)
```

### 2) Run preflight checks

Run all checks from [Preflight Checks](#preflight-checks).

### 3) Preview All Transactions (No Broadcast)

Present a human-readable summary of both transactions:

**Transaction 1 — Deploy Campaign:**

- **Contract:** `$FACTORY`
- **Function:** `createMerkle*` (type-specific)
- **Campaign name, type, token, start time, expiration**
- **Merkle root, IPFS CID, recipient count, aggregate amount**
- **Vesting parameters** (for LL/LT)

**Transaction 2 — Fund Campaign:**

- **Contract:** `$TOKEN`
- **Function:** `transfer(address,uint256)`
- **To:** deployed campaign address
- **Amount:** `$AGGREGATE_AMOUNT`

### 4) Require Explicit Confirmation

Use a clear confirmation flow:

⚠️ Final confirmation required

```text
+------------------------------+
| Confirm broadcast?           |
| Reply exactly: YES           |
+------------------------------+
```

If the user does not explicitly confirm with `YES`, stop.

### 5) Deploy Campaign

First, predict the campaign address using the factory's `compute*` function:

```bash
CAMPAIGN=$(cast call "$FACTORY" "$COMPUTE_SIG" $COMPUTE_ARGS --rpc-url "$RPC_URL")
```

Then deploy. A browser tab will open for the user to approve the transaction in their wallet extension.

```bash
TX_HASH=$(cast send "$FACTORY" "$FUNCTION_SIG" $FUNCTION_ARGS \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser \
  --async)
```

Wait/poll up to 5 minutes for the confirmed receipt per [Receipt Wait Timeout (Mandatory)](#receipt-wait-timeout-mandatory) before proceeding.

If `--browser` fails at runtime, ask the user to provide a private key and retry with `--private-key`. The same fallback applies to the funding transaction below.

### 6) Fund the Campaign

Transfer the aggregate token amount to the deployed campaign address:

```bash
TX_HASH=$(cast send "$TOKEN" "transfer(address,uint256)" "$CAMPAIGN" "$AGGREGATE_AMOUNT" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser \
  --async)
```

Wait/poll up to 5 minutes for the confirmed receipt.

### 7) Direct User to the Campaign

After both transactions are confirmed, present the direct link to the campaign:

```
https://app.sablier.com/airdrops/campaign/${CAMPAIGN}-${CHAIN_ID}
```

## Entrypoint Catalog

Maps each campaign type to the correct factory function and calldata encoding. Refer to the per-factory ABI definitions for exact tuple encoding:

- [factory-merkle-instant-v2.0-abi.json](../assets/factory-merkle-instant-v2.0-abi.json)
- [factory-merkle-LL-v2.0-abi.json](../assets/factory-merkle-LL-v2.0-abi.json)
- [factory-merkle-LT-v2.0-abi.json](../assets/factory-merkle-LT-v2.0-abi.json)

### `createMerkleInstant`

Deploys a campaign where tokens transfer immediately to recipients on claim.

```
createMerkleInstant(
  (string campaignName, uint40 campaignStartTime, uint40 expiration, address initialAdmin, string ipfsCID, bytes32 merkleRoot, address token),
  uint256 aggregateAmount,
  uint256 recipientCount
)
```

**Arguments:**

1. **params** tuple — campaign configuration
2. **aggregateAmount** — total tokens to distribute (informational, not enforced onchain)
3. **recipientCount** — number of recipients (informational)

### `createMerkleLL`

Deploys a campaign where each claim creates a Lockup Linear stream with the specified vesting schedule.

```
createMerkleLL(
  (string campaignName, uint40 campaignStartTime, bool cancelable, uint40 cliffDuration, uint256 cliffUnlockPercentage, uint40 expiration, address initialAdmin, string ipfsCID, address lockup, bytes32 merkleRoot, string shape, uint256 startUnlockPercentage, address token, uint40 totalDuration, bool transferable, uint40 vestingStartTime),
  uint256 aggregateAmount,
  uint256 recipientCount
)
```

**Key parameters:**

- **cliffDuration** — seconds; `0` for no cliff
- **cliffUnlockPercentage** — `UD60x18` from PRBMath (`uint256`, `1e18` = 100%); fraction unlocked after cliff
- **startUnlockPercentage** — `UD60x18` (`uint256`, `1e18` = 100%); fraction unlocked immediately at stream start
- **lockup** — `SablierLockup` contract address (look up at [Lockup Deployments](https://docs.sablier.com/guides/lockup/deployments.md))
- **vestingStartTime** — `0` means vesting starts at each individual claim's `block.timestamp`; non-zero means all recipients vest from the same absolute timestamp

**Validation rules:**

- `totalDuration > 0`
- If `cliffDuration > 0`: `cliffDuration < totalDuration`
- If `cliffDuration == 0`: `cliffUnlockPercentage` must be `0`
- `startUnlockPercentage + cliffUnlockPercentage <= 1e18`

### `createMerkleLT`

Deploys a campaign where each claim creates a Lockup Tranched stream with percentage-based unlock steps.

```
createMerkleLT(
  (string campaignName, uint40 campaignStartTime, bool cancelable, uint40 expiration, address initialAdmin, string ipfsCID, address lockup, bytes32 merkleRoot, string shape, address token, (uint64 unlockPercentage, uint40 duration)[] tranchesWithPercentages, bool transferable, uint40 vestingStartTime),
  uint256 aggregateAmount,
  uint256 recipientCount
)
```

**Key parameters:**

- **tranchesWithPercentages** — array of `(unlockPercentage, duration)` tuples. `unlockPercentage` uses `UD2x18` from PRBMath (`uint64`, `1e18` = 100%). `duration` is seconds.
- **lockup** — `SablierLockup` contract address
- **vestingStartTime** — same behavior as MerkleLL

**Note on percentage types:** MerkleLT uses `UD2x18` (`uint64`), while MerkleLL uses `UD60x18` (`uint256`). Both use `1e18 = 100%`.

**Validation rules:**

- At least one tranche
- All tranche percentages must sum to exactly 100% (`1e18`)
- All tranche durations must be > 0

Use the factory's helper to verify percentages sum to 100%:

```bash
cast call "$FACTORY" "isPercentagesSum100((uint64,uint40)[])" "$TRANCHES" --rpc-url "$RPC_URL"
```

### Deterministic Addresses (`compute*`)

Each factory exposes a `compute*` function to predict the campaign address before deployment. Use this to know the campaign address for funding without parsing event logs.

**`computeMerkleInstant`:**

```
computeMerkleInstant(
  address campaignCreator,
  (string campaignName, uint40 campaignStartTime, uint40 expiration, address initialAdmin, string ipfsCID, bytes32 merkleRoot, address token)
) → address
```

**`computeMerkleLL`:**

```
computeMerkleLL(
  address campaignCreator,
  (string campaignName, uint40 campaignStartTime, bool cancelable, uint40 cliffDuration, uint256 cliffUnlockPercentage, uint40 expiration, address initialAdmin, string ipfsCID, address lockup, bytes32 merkleRoot, string shape, uint256 startUnlockPercentage, address token, uint40 totalDuration, bool transferable, uint40 vestingStartTime)
) → address
```

**`computeMerkleLT`:**

```
computeMerkleLT(
  address campaignCreator,
  (string campaignName, uint40 campaignStartTime, bool cancelable, uint40 expiration, address initialAdmin, string ipfsCID, address lockup, bytes32 merkleRoot, string shape, address token, (uint64 unlockPercentage, uint40 duration)[] tranchesWithPercentages, bool transferable, uint40 vestingStartTime)
) → address
```

The `campaignCreator` is the `msg.sender` of the `createMerkle*` call — use the sender's wallet address. The params tuple is identical to the one passed to the corresponding `createMerkle*` function.

## Worked Example

These examples intentionally use raw integers and ABI-ready arguments because they are for command construction. Do not copy these machine values into the default transaction preview; show human-readable token amounts first, and provide exact machine values separately only if the user explicitly asks.

### Instant Campaign: `createMerkleInstant`

Deploy an instant airdrop of 10,000 USDC (6 decimals) to 50 recipients on Ethereum mainnet:

```bash
FACTORY="<factory-merkle-instant-address>"   # From Airdrop Deployments page
RPC_URL="<resolved-or-user-provided-rpc>"
TOKEN="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"  # USDC on Ethereum
OWNER=$(cast wallet address --browser)

# Install the local generator once
npm install --prefix "skills/sablier-create-airdrop/scripts"

# Generate the Merkle tree locally (see merkle-tree.md for full setup)
CSV_FILE="/path/to/recipients.csv"   # User-provided file path
DECIMALS=$(cast call "$TOKEN" "decimals()(uint8)" --rpc-url "$RPC_URL")
GENERATOR_OUTPUT=$(PINATA_JWT="$PINATA_JWT" \
  node "skills/sablier-create-airdrop/scripts/generate-merkle-campaign.mjs" \
    --csv-file "$CSV_FILE" \
    --decimals "$DECIMALS")
MERKLE_ROOT=$(echo "$GENERATOR_OUTPUT" | jq -r '.root')
IPFS_CID=$(echo "$GENERATOR_OUTPUT" | jq -r '.cid')
AGGREGATE_AMOUNT=$(echo "$GENERATOR_OUTPUT" | jq -r '.total')
RECIPIENT_COUNT=$(echo "$GENERATOR_OUTPUT" | jq -r '.recipients')

# Campaign starts in 24 hours, no expiration
START_TIME=$(echo "$(date +%s) + 86400" | bc)

# Predict campaign address via compute function
COMPUTE_SIG="computeMerkleInstant(address,(string,uint40,uint40,address,string,bytes32,address))"
CAMPAIGN=$(cast call "$FACTORY" "$COMPUTE_SIG" \
  "$OWNER" \
  "(\"My Airdrop\",$START_TIME,0,$OWNER,\"$IPFS_CID\",$MERKLE_ROOT,$TOKEN)" \
  --rpc-url "$RPC_URL")

# 1. Deploy campaign
FUNCTION_SIG="createMerkleInstant((string,uint40,uint40,address,string,bytes32,address),uint256,uint256)"
TX_HASH=$(cast send "$FACTORY" "$FUNCTION_SIG" \
  "(\"My Airdrop\",$START_TIME,0,$OWNER,\"$IPFS_CID\",$MERKLE_ROOT,$TOKEN)" \
  "$AGGREGATE_AMOUNT" "$RECIPIENT_COUNT" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser \
  --async)
# Wait/poll up to 5 minutes for confirmed receipt

# 2. Fund campaign
TX_HASH=$(cast send "$TOKEN" "transfer(address,uint256)" "$CAMPAIGN" "$AGGREGATE_AMOUNT" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser \
  --async)
# Wait/poll up to 5 minutes for confirmed receipt
```

Notes:

- `aggregateAmount` is informational — the Merkle tree leaf amounts enforce correctness
- Fund the campaign before `campaignStartTime` so claims don't fail

## Supported Chains

Use this registry to resolve chain metadata and RPC endpoints. Look up factory addresses at the [Airdrop Deployments page](https://docs.sablier.com/guides/airdrops/deployments.md). Look up `SablierLockup` addresses (needed by MerkleLL and MerkleLT) at the [Lockup Deployments page](https://docs.sablier.com/guides/lockup/deployments.md).

| Chain         | Chain ID   | Native Asset | RPC URL                                          |
| ------------- | ---------- | ------------ | ------------------------------------------------ |
| Ethereum      | `1`        | ETH          | `https://ethereum-rpc.publicnode.com`            |
| Abstract      | `2741`     | ETH          | `https://api.mainnet.abs.xyz`                    |
| Arbitrum      | `42161`    | ETH          | `https://arb1.arbitrum.io/rpc`                   |
| Avalanche     | `43114`    | AVAX         | `https://api.avax.network/ext/bc/C/rpc`          |
| Base          | `8453`     | ETH          | `https://mainnet.base.org`                       |
| Berachain     | `80094`    | BERA         | `https://rpc.berachain.com`                      |
| Blast         | `81457`    | ETH          | `https://rpc.blast.io`                           |
| BNB Chain     | `56`       | BNB          | `https://bsc-dataseed1.bnbchain.org`             |
| Chiliz        | `88888`    | CHZ          | `https://rpc.chiliz.com`                         |
| Core Dao      | `1116`     | CORE         | `https://rpc.coredao.org`                        |
| Denergy       | `369369`   | WATT         | `https://rpc.d.energy`                           |
| Gnosis        | `100`      | xDAI         | `https://rpc.gnosischain.com`                    |
| HyperEVM      | `999`      | HYPE         | `https://rpc.hyperliquid.xyz/evm`                |
| Lightlink     | `1890`     | ETH          | `https://replicator.phoenix.lightlink.io/rpc/v1` |
| Linea Mainnet | `59144`    | ETH          | `https://rpc.linea.build`                        |
| Mode          | `34443`    | ETH          | `https://mainnet.mode.network`                   |
| Monad         | `143`      | MON          | `https://rpc.monad.xyz`                          |
| Morph         | `2818`     | ETH          | `https://rpc.morphl2.io`                         |
| OP Mainnet    | `10`       | ETH          | `https://mainnet.optimism.io`                    |
| Polygon       | `137`      | POL          | `https://polygon-bor-rpc.publicnode.com`         |
| Scroll        | `534352`   | ETH          | `https://rpc.scroll.io`                          |
| Sei Network   | `1329`     | SEI          | `https://evm-rpc.sei-apis.com`                   |
| Sonic         | `146`      | S            | `https://rpc.soniclabs.com`                      |
| Superseed     | `5330`     | ETH          | `https://mainnet.superseed.xyz`                  |
| Unichain      | `130`      | ETH          | `https://mainnet.unichain.org`                   |
| XDC           | `50`       | XDC          | `https://rpc.xinfin.network`                     |
| ZKsync Era    | `324`      | ETH          | `https://mainnet.era.zksync.io`                  |
| Sepolia       | `11155111` | ETH          | `https://ethereum-sepolia-rpc.publicnode.com`    |

Ethereum can also be referred to as "Mainnet".
