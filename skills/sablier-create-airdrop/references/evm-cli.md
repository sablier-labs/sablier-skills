# EVM CLI Campaign Execution

## Overview

Use this reference when the user wants the agent to execute EVM transactions on their behalf, such as creating Sablier Merkle airdrop campaigns directly from the terminal.

This guide is runbook-first: plan the campaign, generate the Merkle tree, run preflight checks, preview the transaction, require explicit confirmation, then deploy, pay the fee, fund, and verify.

## Execution Sequence

Use this sequence for every campaign creation:

1. Complete [Intake & Planning Inputs](#intake--planning-inputs): campaign type, Merkle tree, chain, and arguments.
2. Run all [Preflight Checks](#preflight-checks), including token balance and native gas balance.
3. Build and show a human-readable transaction preview (no broadcast).
4. Require explicit user confirmation.
5. Deploy the campaign via the factory with `cast send`.
6. Send the creation fee to the Sablier treasury.
7. Fund the campaign by transferring tokens to the deployed campaign address.
8. Verify and direct the user to [app.sablier.com](https://app.sablier.com).

## Mandatory Guardrails

### Cast CLI and Browser Wallet Capability Check

Before running any `cast` command, verify the CLI is installed and supports `--browser`:

```bash
if ! command -v cast >/dev/null 2>&1; then
  echo "cast CLI not found. Install Foundry: https://getfoundry.sh/"
  exit 1
fi

if ! cast send --help 2>&1 | grep -q -- '--browser'; then
  echo "Your cast version does not support --browser."
  echo "Upgrade Foundry: https://getfoundry.sh/"
  exit 1
fi
```

If the check fails, stop and ask the user to install or upgrade Foundry at <https://getfoundry.sh/>.

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

## Intake & Planning Inputs

Complete these steps in order before building calldata.

### 1) Choose Campaign Type

Use the [decision tree in SKILL.md](#choosing-a-campaign-type) to select the campaign type:

| Signal | Campaign Type |
| --- | --- |
| "airdrop tokens immediately", "instant distribution" | **Instant** |
| "airdrop with vesting", "linear vesting airdrop", "cliff + vesting" | **MerkleLL** |
| "airdrop with monthly unlocks", "quarterly vesting", "step unlocks" | **MerkleLT** |
| "early claimers forfeit", "variable claim", "incentivize waiting" | **MerkleVCA** |

- If ambiguous, ask the user to clarify using the decision tree.

### 2) Generate Merkle Tree

The Merkle tree must be generated before deploying the campaign. See [merkle-tree.md](merkle-tree.md) for the full process.

**Summary:**

1. Prepare a CSV with `address` and `amount` columns (human-readable amounts — the API handles decimal conversion).
2. Submit the CSV to the [Sablier Merkle API](https://github.com/sablier-labs/merkle-api).
3. Receive `merkleRoot` and `ipfsCID` from the API response.

These two values are required inputs for all factory functions. Do not proceed without them.

### 3) Resolve Chain and Factory

Look up the factory contract address for the chosen campaign type and target chain at the [Airdrop Deployments page](https://docs.sablier.com/guides/airdrops/deployments.md).

Each campaign type has a dedicated factory:

| Campaign Type | Factory Contract |
| --- | --- |
| Instant | `SablierFactoryMerkleInstant` |
| Linear (LL) | `SablierFactoryMerkleLL` |
| Tranched (LT) | `SablierFactoryMerkleLT` |
| VCA | `SablierFactoryMerkleVCA` |

Also look up:
- **Sablier treasury address** — for the creation fee transfer
- **SablierLockup address** — required by MerkleLL and MerkleLT campaigns (look up at [Lockup Deployments](https://docs.sablier.com/guides/lockup/deployments.md))

If the requested chain is not listed, ask the user to provide the factory address.

### 4) Collect Required Inputs

Collect these before building any transaction:

- `chain` (ID and name)
- sender wallet address (resolved via `cast wallet address --browser` or provided by the user)
- signing method (`--browser` preferred, `--private-key` fallback)
- factory contract address (from step 3)
- Sablier treasury address (from step 3)
- `merkleRoot` and `ipfsCID` (from step 2)
- `token` address
- `aggregateAmount` (total tokens to distribute, in token base units)
- `recipientCount`
- `campaignName`
- `campaignStartTime` (Unix timestamp when claims open; `0` for immediate)
- `expiration` (Unix timestamp; `0` for never — except VCA which requires expiration)
- `initialAdmin` (address authorized to clawback; defaults to sender if not specified)

**Type-specific inputs:**

| Campaign Type | Additional Inputs |
| --- | --- |
| Instant | None |
| MerkleLL | `lockup` address, `cancelable`, `transferable`, `shape`, `totalDuration`, `cliffDuration`, `cliffUnlockPercentage` (UD60x18), `startUnlockPercentage` (UD60x18), `vestingStartTime` |
| MerkleLT | `lockup` address, `cancelable`, `transferable`, `shape`, `tranchesWithPercentages` array (each: `unlockPercentage` as UD2x18, `duration`), `vestingStartTime` |
| MerkleVCA | `unlockPercentage` (UD60x18), `vestingStartTime`, `vestingEndTime` |

## Preflight Checks

Run these checks before previewing or broadcasting any transaction.

### Token Balance

Check `balanceOf(owner)` is at least the `aggregateAmount`. If balance is insufficient, stop execution and inform the user they need more tokens (for example, purchase via Uniswap) before continuing.

### Native Gas Balance for Every Transaction

Before broadcasting, estimate the gas cost and verify the sender can cover gas for all three transactions (factory call, fee transfer, and token funding):

```bash
# Estimate gas for the factory call
GAS_ESTIMATE=$(cast estimate "$FACTORY" "$FUNCTION_SIG" $FUNCTION_ARGS \
  --rpc-url "$RPC_URL" \
  --from "$OWNER")

# Get current gas price (in wei)
GAS_PRICE=$(cast gas-price --rpc-url "$RPC_URL")

# Total native token needed ≈ (gas estimate × gas price × 3 transactions) + FEE_AMOUNT
# This is a rough estimate — the actual gas per transaction varies
TOTAL_NEEDED=$(echo "$GAS_ESTIMATE * $GAS_PRICE * 3 + $FEE_AMOUNT" | bc)
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

## Creation Fee

The creation fee is approximately **~$2 USD** worth of the chain's native asset. The factory functions are **not payable** — send the fee as a separate native token transfer to the Sablier treasury.

**Procedure:**

1. Look up the `CoinGecko ID` for the chain's native asset from the [Supported Chains](#supported-chains) table.
2. Use the `coingecko-api` skill to fetch the current USD price of the native asset by its CoinGecko ID. If this skill is unavailable, recommend installing it with:

   ```bash
   npx skills add sablier-labs/agent-skills --skill coingecko-api
   ```

3. Calculate the fee amount in wei:

   ```bash
   # "ether" here means the 18-decimal unit, not the ETH asset — all EVM native assets use 18 decimals
   FEE_AMOUNT=$(cast to-wei $(echo "scale=18; 2 / $PRICE" | bc) ether)
   ```

4. Look up the Sablier treasury address at the [Airdrop Deployments page](https://docs.sablier.com/guides/airdrops/deployments.md).

## Execution Runbook

### 1) Resolve RPC URL, signing method, and sender address

```bash
RPC_URL="<resolved-or-user-provided-rpc>"

# Resolve sender address from browser wallet (opens a browser tab for the user to connect)
OWNER=$(cast wallet address --browser)
```

### 2) Run preflight checks

Run all checks from [Preflight Checks](#preflight-checks). Calculate `FEE_AMOUNT` per the [Creation Fee](#creation-fee) section.

### 3) Preview All Transactions (No Broadcast)

Present a human-readable summary of all three transactions:

**Transaction 1 — Deploy Campaign:**
- **Contract:** `$FACTORY`
- **Function:** `createMerkle*` (type-specific)
- **Campaign name, type, token, start time, expiration**
- **Merkle root, IPFS CID, recipient count, aggregate amount**
- **Vesting parameters** (for LL/LT/VCA)

**Transaction 2 — Creation Fee:**
- **To:** Sablier treasury
- **Amount:** ~$2 USD in native token (`FEE_AMOUNT`)

**Transaction 3 — Fund Campaign:**
- **Contract:** `$TOKEN`
- **Function:** `transfer(address,uint256)`
- **To:** deployed campaign address
- **Amount:** `$AGGREGATE_AMOUNT`

### 4) Require Explicit Confirmation

Use a clear confirmation prompt, for example:

- `Confirm broadcast of all 3 transactions? Reply exactly: YES`

If the user does not explicitly confirm, stop.

### 5) Deploy Campaign

First, predict the campaign address using the factory's `compute*` function:

```bash
CAMPAIGN=$(cast call "$FACTORY" "$COMPUTE_SIG" $COMPUTE_ARGS --rpc-url "$RPC_URL")
```

Then deploy. A browser tab will open for the user to approve the transaction in their wallet extension.

```bash
cast send "$FACTORY" "$FUNCTION_SIG" $FUNCTION_ARGS \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser
```

If `--browser` fails at runtime, ask the user to provide a private key and retry with `--private-key`.

### 6) Send Creation Fee

```bash
cast send "$TREASURY" \
  --value "$FEE_AMOUNT" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser
```

### 7) Fund the Campaign

Transfer the aggregate token amount to the deployed campaign address:

```bash
cast send "$TOKEN" "transfer(address,uint256)" "$CAMPAIGN" "$AGGREGATE_AMOUNT" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser
```

### 8) Verify and Direct User to the Sablier App

Verify the campaign deployment receipt:

```bash
cast receipt "$TX_HASH" --rpc-url "$RPC_URL"
```

After successful deployment and funding, inform the user they can view and manage the campaign at [app.sablier.com](https://app.sablier.com).

## Entrypoint Catalog

Maps each campaign type to the correct factory function and calldata encoding. Refer to ABI definitions in [merkle-factory-v2.0-abi.json](../assets/merkle-factory-v2.0-abi.json) for exact tuple encoding.

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
- **cliffUnlockPercentage** — `UD60x18` from [PRBMath](https://github.com/PaulRBerg/prb-math) (`uint256`, `1e18` = 100%); fraction unlocked after cliff
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

- **tranchesWithPercentages** — array of `(unlockPercentage, duration)` tuples. `unlockPercentage` uses `UD2x18` from [PRBMath](https://github.com/PaulRBerg/prb-math) (`uint64`, `1e18` = 100%). `duration` is seconds.
- **lockup** — `SablierLockup` contract address
- **vestingStartTime** — same behavior as MerkleLL

**Note on percentage types:** MerkleLT uses `UD2x18` (`uint64`), while MerkleLL and MerkleVCA use `UD60x18` (`uint256`). Both use `1e18 = 100%`.

**Validation rules:**

- At least one tranche
- All tranche percentages must sum to exactly 100% (`1e18`)
- All tranche durations must be > 0

Use the factory's helper to verify percentages sum to 100%:

```bash
cast call "$FACTORY" "isPercentagesSum100((uint64,uint40)[])" "$TRANCHES" --rpc-url "$RPC_URL"
```

### `createMerkleVCA`

Deploys a campaign where recipients can claim at any time during the vesting period but only receive the vested portion — unvested tokens are forfeited. Waiting until the end yields the full amount.

```
createMerkleVCA(
  (string campaignName, uint40 campaignStartTime, uint40 expiration, address initialAdmin, string ipfsCID, bytes32 merkleRoot, address token, uint256 unlockPercentage, uint40 vestingEndTime, uint40 vestingStartTime),
  uint256 aggregateAmount,
  uint256 recipientCount
)
```

**Key parameters:**

- **unlockPercentage** — `UD60x18` from [PRBMath](https://github.com/PaulRBerg/prb-math) (`uint256`, `1e18` = 100%); fraction available immediately
- **vestingStartTime** — must be > 0 (required)
- **vestingEndTime** — must be > `vestingStartTime` (required)
- **expiration** — must be > 0 and >= `vestingEndTime + 1 week` (recipients need time to claim after vesting ends)

**Validation rules:**

- `vestingStartTime > 0`
- `vestingEndTime > vestingStartTime`
- `expiration > 0`
- `expiration >= vestingEndTime + 1 week`
- `unlockPercentage <= 1e18`

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

**`computeMerkleVCA`:**

```
computeMerkleVCA(
  address campaignCreator,
  (string campaignName, uint40 campaignStartTime, uint40 expiration, address initialAdmin, string ipfsCID, bytes32 merkleRoot, address token, uint256 unlockPercentage, uint40 vestingEndTime, uint40 vestingStartTime)
) → address
```

The `campaignCreator` is the `msg.sender` of the `createMerkle*` call — use the sender's wallet address. The params tuple is identical to the one passed to the corresponding `createMerkle*` function.

## Worked Example

### Instant Campaign: `createMerkleInstant`

Deploy an instant airdrop of 10,000 USDC (6 decimals) to 50 recipients on Ethereum mainnet:

```bash
FACTORY="<factory-merkle-instant-address>"   # From Airdrop Deployments page
TOKEN="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"  # USDC on Ethereum
TREASURY="<treasury-address>"                # From Airdrop Deployments page
OWNER=$(cast wallet address --browser)

# From Merkle API
MERKLE_ROOT="0x..."
IPFS_CID="Qm..."

# 10,000 USDC = 10,000 * 1e6 = 10_000_000_000 (6-decimal base units)
AGGREGATE_AMOUNT="10000000000"
RECIPIENT_COUNT="50"

# Campaign starts in 24 hours, no expiration
START_TIME=$(echo "$(date +%s) + 86400" | bc)

# Calculate FEE_AMOUNT per the "Creation Fee" section (~$2 USD)

# 1. Deploy campaign
FUNCTION_SIG="createMerkleInstant((string,uint40,uint40,address,string,bytes32,address),uint256,uint256)"
cast send "$FACTORY" "$FUNCTION_SIG" \
  "(\"My Airdrop\",$START_TIME,0,$OWNER,\"$IPFS_CID\",$MERKLE_ROOT,$TOKEN)" \
  "$AGGREGATE_AMOUNT" "$RECIPIENT_COUNT" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser

# 2. Send creation fee
cast send "$TREASURY" \
  --value "$FEE_AMOUNT" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser

# 3. Fund campaign (predict address first with computeMerkleInstant, or parse from tx logs)
cast send "$TOKEN" "transfer(address,uint256)" "$CAMPAIGN" "$AGGREGATE_AMOUNT" \
  --rpc-url "$RPC_URL" \
  --from "$OWNER" \
  --browser
```

Notes:

- `aggregateAmount` is informational — the Merkle tree leaf amounts enforce correctness
- Fund the campaign before `campaignStartTime` so claims don't fail
- `FEE_AMOUNT` = ~$2 USD worth of native token (see [Creation Fee](#creation-fee))

## Supported Chains

Use this registry to resolve chain metadata, RPC endpoints, and native asset pricing. Look up factory and treasury addresses at the [Airdrop Deployments page](https://docs.sablier.com/guides/airdrops/deployments.md). Look up `SablierLockup` addresses (needed by MerkleLL and MerkleLT) at the [Lockup Deployments page](https://docs.sablier.com/guides/lockup/deployments.md).

| Chain | Chain ID | Native Asset | CoinGecko ID | RPC URL |
| --- | --- | --- | --- | --- |
| Ethereum | `1` | ETH | `ethereum` | `https://ethereum-rpc.publicnode.com` |
| Abstract | `2741` | ETH | `ethereum` | `https://api.mainnet.abs.xyz` |
| Arbitrum | `42161` | ETH | `ethereum` | `https://arb1.arbitrum.io/rpc` |
| Avalanche | `43114` | AVAX | `avalanche-2` | `https://api.avax.network/ext/bc/C/rpc` |
| Base | `8453` | ETH | `ethereum` | `https://mainnet.base.org` |
| Berachain | `80094` | BERA | `berachain` | `https://rpc.berachain.com` |
| Blast | `81457` | ETH | `ethereum` | `https://rpc.blast.io` |
| BNB Chain | `56` | BNB | `binancecoin` | `https://bsc-dataseed1.bnbchain.org` |
| Chiliz | `88888` | CHZ | `chiliz` | `https://rpc.chiliz.com` |
| Core Dao | `1116` | CORE | `coredaoorg` | `https://rpc.coredao.org` |
| Denergy | `369369` | WATT | — | `https://rpc.d.energy` |
| Gnosis | `100` | xDAI | `dai` | `https://rpc.gnosischain.com` |
| HyperEVM | `999` | HYPE | `hyperliquid` | `https://rpc.hyperliquid.xyz/evm` |
| Lightlink | `1890` | ETH | `ethereum` | `https://replicator.phoenix.lightlink.io/rpc/v1` |
| Linea Mainnet | `59144` | ETH | `ethereum` | `https://rpc.linea.build` |
| Mode | `34443` | ETH | `ethereum` | `https://mainnet.mode.network` |
| Monad | `143` | MON | `monad` | `https://rpc.monad.xyz` |
| Morph | `2818` | ETH | `ethereum` | `https://rpc.morphl2.io` |
| OP Mainnet | `10` | ETH | `ethereum` | `https://mainnet.optimism.io` |
| Polygon | `137` | POL | `polygon` | `https://polygon-bor-rpc.publicnode.com` |
| Scroll | `534352` | ETH | `ethereum` | `https://rpc.scroll.io` |
| Sei Network | `1329` | SEI | `sei` | `https://evm-rpc.sei-apis.com` |
| Sonic | `146` | S | `sonic` | `https://rpc.soniclabs.com` |
| Superseed | `5330` | ETH | `ethereum` | `https://mainnet.superseed.xyz` |
| Unichain | `130` | ETH | `ethereum` | `https://mainnet.unichain.org` |
| XDC | `50` | XDC | `xdc-network` | `https://rpc.xinfin.network` |
| ZKsync Era | `324` | ETH | `ethereum` | `https://mainnet.era.zksync.io` |
| Sepolia | `11155111` | ETH | `ethereum` | `https://ethereum-sepolia-rpc.publicnode.com` |

Ethereum can also be referred to as "Mainnet".

> **Note:** Denergy (WATT) is not listed on CoinGecko. Use web search to find the current price of WATT in USD.
