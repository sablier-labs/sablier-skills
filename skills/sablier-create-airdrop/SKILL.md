---
name: sablier-create-airdrop
disable-model-invocation: false
user-invocable: true
argument-hint: <chain_name> <token_address> <airdrop_details>
description: This skill should be used when the user asks to create "token airdrops", "Merkle airdrops", "instant airdrops", "Sablier airdrops", "airstreams", "vested airdrops", "claimable airdrops", "token claim campaigns", "ERC-20 airdrops", "ERC20 airdrops", "BEP-20 airdrops", or "BEP20 airdrops" with Sablier Merkle, wants to distribute tokens to many recipients on Ethereum or EVM-compatible chains using Merkle proofs, needs an agent to run onchain airdrop-campaign-creation transactions on their behalf.
---

# Sablier Merkle Airdrop Creation

## Overview

Create token airdrops using the Sablier Merkle system. A campaign creator deploys a campaign contract via a factory, storing a Merkle root. Anyone can then fund the campaign by transferring tokens to it. Recipients claim individually using Merkle proofs, paying their own gas.

This skill is a coordinator for airdrop campaign creation and execution routing.

## Arguments

| Argument          | Description                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `chain_name`      | EVM chain where to create the airdrop campaign                                                                                                 |
| `token_address`   | ERC-20 token contract address to distribute. Token symbols cannot be resolved to addresses — the user must provide the exact contract address. |
| `airdrop_details` | Campaign type, recipient list, vesting schedule (if applicable)                                                                                |

## Campaign Types

| Type     | Code          | Distribution Method                                                |
| -------- | ------------- | ------------------------------------------------------------------ |
| Instant  | MerkleInstant | Direct token transfer on claim                                     |
| Linear   | MerkleLL      | Creates a Lockup Linear stream per claim (vesting over time)       |
| Tranched | MerkleLT      | Creates a Lockup Tranched stream per claim (discrete unlock steps) |
| VCA      | MerkleVCA     | Linear unlock; early claimers forfeit unvested tokens              |

### Choosing a Campaign Type

```
Q1: Do recipients need vesting after claiming?
├─ No → ✅ Instant
└─ Yes → Q2

Q2: Should unclaimed vested tokens be forfeited if claimed early?
├─ Yes → ✅ MerkleVCA
└─ No → Q3

Q3: Do tokens unlock continuously or in discrete steps?
├─ Continuously (with optional cliff) → ✅ MerkleLL
└─ At discrete intervals (monthly, quarterly, etc.) → ✅ MerkleLT
```

## Workflow

### 1. Confirm product fit before implementation details

1. Verify the user needs Merkle-based token distribution to many recipients.
2. If the user needs fixed-schedule vesting for individual recipients or open-ended payment streaming, route to `sablier-product-selection`. If this skill is unavailable, recommend installing it with:

```bash
npx skills add sablier-labs/sablier-skills --skill sablier-product-selection
```

### 2. Check requested features

Stop and call out unsupported requests before selecting an execution path.

Treat the following as unsupported by this skill and by Sablier Merkle:

- Distributing native tokens (ETH, BNB, AVAX, etc.). Only ERC-20 tokens can be airdropped. If the user wants to airdrop a native token, inform them they must wrap it first (e.g. WETH) and provide the wrapped token contract address.
- Solana airdrops. This skill covers EVM chains only.
- Launching tokens for users. Require the user to explicitly provide an existing token address as input.
- Resolving token symbols (e.g. "USDC") to contract addresses. If the user provides a symbol instead of an address, ask them to provide the exact ERC-20 contract address.

### 3. Clarify airdrop details

If any of the following are missing or ambiguous from the user's input, use the `AskUserQuestion` tool to ask the user to clarify before proceeding:

- Campaign type (Instant, LL, LT, or VCA — use the [decision tree](#choosing-a-campaign-type) if unclear)
- Recipient list (CSV with addresses and amounts, or a file path)
- Token address
- Campaign start time (when claims open)
- Expiration (when unclaimed tokens can be recovered; `0` for never — except VCA which requires expiration)
- Vesting schedule (for LL: duration and cliff; for LT: tranche intervals; for VCA: vesting period)

If the missing detail is the token address, use the `AskUserQuestion` tool to ask for the exact ERC-20 contract address and tell the user they can look it up on a blockchain explorer such as Etherscan.

Do not guess or silently apply defaults for the campaign type, recipient list, or vesting schedule. Only proceed once all required inputs are confirmed.

### 4. Infer intent before selecting references

1. **Execution intent:** user wants the agent to create an airdrop campaign on their behalf (run CLI transactions).
2. **Onchain integration intent:** user wants developer integration guidance.

### 5. Validate chain support before routing

1. Check whether the user's desired chain is listed on [Supported Chains](https://docs.sablier.com/concepts/chains).
2. If the chain is not supported, inform the user and stop execution of this skill.
3. If the user did not mention a chain, ask them to specify the chain.
4. If the user requests Solana, inform them that this skill covers EVM chains only and stop.

### 6. Route in two steps

1. Classify the request as one of:
   - Airdrop campaign creation on the user's behalf
   - Onchain integration guidance
   - Any other integration type (frontend, backend, indexer, etc.)
2. If the request is any other integration type, inform the user that this skill does not support non-onchain integrations and stop.
3. Otherwise, follow the route below.

| Intent                                         | EVM                                             | Solana                       |
| ---------------------------------------------- | ----------------------------------------------- | ---------------------------- |
| Airdrop campaign creation on the user's behalf | Use [evm-cli.md](references/evm-cli.md)         | Not supported by this skill. |
| Onchain integration guidance                   | Use [evm-onchain.md](references/evm-onchain.md) | Not supported by this skill. |

## Important Notes

**`aggregateAmount` is not enforced onchain.** The Merkle tree leaf amounts are what enforce correctness. If the campaign is funded with less than the true aggregate, later claims will fail. Always fund the campaign with at least the full aggregate amount.

**Token amounts must be in the token's smallest unit.** For example, for an 18-decimal token, 1.0 token = `1000000000000000000`. For a 6-decimal token like USDC, 1.0 USDC = `1000000`.

**`initialAdmin` can differ from the campaign creator.** The `initialAdmin` is the address authorized to clawback unclaimed tokens — it does not have to be the same address that deploys the campaign. If the user does not specify an admin, default to the sender address.

## Campaign Lifecycle

```
1. CREATE    → Deploy campaign via factory
2. FEE       → Send creation fee to comptroller
3. FUND      → Transfer tokens to the campaign contract
4. CLAIMS    → Recipients claim with Merkle proofs (after campaignStartTime)
5. CLAWBACK  → (optional) Admin recovers unclaimed tokens after expiration
```

**Clawback** is allowed up until 7 days have passed since the first claim, and after the campaign has expired. It is blocked in between.

**Important:** Creation and funding are decoupled — the campaign contract can exist before tokens are deposited. However, claims will fail if the campaign has insufficient token balance, so always fund before `campaignStartTime`.

## Resources

- [Sablier Documentation](https://docs.sablier.com/llms.txt)
- [EVM Airdrop Deployments](https://docs.sablier.com/guides/airdrops/deployments.md)
- [Sablier Airdrops Monorepo](https://github.com/sablier-labs/airdrops)
- [Merkle API (tree generation + eligibility)](https://github.com/sablier-labs/merkle-api)
- [EVM Integration Examples](https://github.com/sablier-labs/evm-examples)
