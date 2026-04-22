---
name: sablier-withdraw-vesting
disable-model-invocation: false
user-invocable: true
argument-hint: <chain_name> <wallet_address> <token_symbol> <withdraw_amount>
description: This skill should be used when the user asks to "withdraw vested tokens", "withdraw from Sablier vesting", "claim vested tokens", "claim from Sablier", "pull vested tokens", "claim unlocked tokens", or wants an agent to withdraw unlocked tokens from a Sablier Lockup vesting stream on Ethereum or any EVM-compatible chain on their behalf.
---

# Sablier Vesting Stream Withdrawal

## Overview

Withdraw unlocked tokens from a single Sablier Lockup vesting stream on the user's behalf. The skill discovers the user's streams through the Sablier indexer and then executes `withdraw(uint256,address,uint128)` against the appropriate `SablierLockup` contract.

This skill supports the full range of Lockup releases (v1.0 → v4.0). The withdraw function signature is identical across every release — only the contract address, UI alias prefix, and access-control rules differ. Both the contract and alias come back from the indexer on a per-stream basis; the runbook branches on `version` to apply the correct access rules.

This skill is a coordinator for vesting withdrawal and execution routing.

## Arguments

| Argument          | Description                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chain_name`      | EVM chain where the stream lives (e.g. "Ethereum", "Base", "Polygon").                                                                                                 |
| `wallet_address`  | The user's wallet. Must be the stream's recipient (v1.2+ also allows a third party if `to == recipient`) or, for v1.0/v1.1 streams, the sender.                        |
| `token_symbol`    | Token symbol to narrow the search (e.g. "USDC", "SABL"). If omitted, the skill queries the indexer and lists every token the wallet has an active stream in.           |
| `withdraw_amount` | Either `all` (withdraw everything unlocked so far) or a human-readable amount (e.g. `250.5`).                                                                          |

## Workflow

### 1. Confirm product fit

1. Verify the user wants to withdraw from an existing Sablier vesting stream.
2. If the user wants to **create** a vesting stream instead, route to `sablier-create-vesting`. If that skill is unavailable, recommend installing it with:

   ```bash
   npx skills add sablier-labs/sablier-skills --skill sablier-create-vesting
   ```

### 2. Check requested features

Stop and call out unsupported requests before selecting an execution path.

- **Batch withdrawal across multiple streams is not supported.** This skill withdraws from exactly one stream per invocation. If the user asks to "withdraw from all my streams" or "claim everything", tell them to execute the withdrawals one by one. Do not cite "skill rules" or explain the constraint — just direct them to run the flow again for the next stream.
- **Access-control rules vary by Lockup version** — the runbook enforces them after stream selection:
  - **v1.0 / v1.1** — only the stream's `sender`, `recipient`, or an approved operator can call `withdraw`. If the caller is the `sender`, the tokens must be sent to the `recipient`.
  - **v1.2 onward** — anyone can call `withdraw` as long as the destination (`to`) is the `recipient`. Only the `recipient` or an approved operator can redirect tokens to a third party.
  - If the user's wallet does not satisfy the rule for the selected stream, stop and explain which address must sign.
- **Withdrawing native tokens (ETH, POL, etc.) is not supported.** Sablier streams only hold ERC-20 tokens. If the user mentions "ETH from my stream", they most likely mean WETH — confirm the token symbol before proceeding.

### 3. Clarify the required inputs

Use the `AskUserQuestion` tool to fill any missing inputs. Ask only for what is missing — never re-ask for values the user already provided.

- **Wallet address.** A `0x`-prefixed EVM address — case is not enforced; the runbook lowercases it before querying the indexer. This is the address that will sign the withdraw transaction. Ask for this first — both chain and token can be inferred from the indexer once the wallet is known.
- **Chain name.** Optional. If the user does not know which chain, **do not** send them to an external UI — query the Sablier Streams indexer for every non-depleted stream (as recipient or sender) across all chains, collect the distinct `chainId` values, map them to chain names via the [Supported Chains](references/cli.md#supported-chains) table, and offer them as `AskUserQuestion` options. If exactly one chain has streams, auto-select it and tell the user. See [references/cli.md § Chain discovery](references/cli.md#chain-discovery).
- **Token symbol.** Optional. If the user does not know which token, query the indexer for every non-depleted stream on the resolved chain where the wallet is recipient or sender, and offer the distinct token symbols as `AskUserQuestion` options (see [references/cli.md § Stream discovery](references/cli.md#stream-discovery)).
- **Withdraw amount.** Offer two options via `AskUserQuestion`:
  1. **All unlocked** (recommended default) — withdraw every token unlocked so far.
  2. **Custom amount** — the user specifies a smaller amount in human units.

Do not guess or silently apply defaults for these parameters. Only proceed once all inputs are confirmed.

### 4. Validate chain support

1. Check whether the resolved chain is listed in the [Supported Chains](references/cli.md#supported-chains) table in the execution runbook.
2. If a chain surfaced by the indexer is not in the table, check [Sablier Lockup deployments](https://docs.sablier.com/guides/lockup/deployments) and ask the user for an RPC URL. If still unresolved, stop execution of this skill.

### 5. Route to execution

Hand off to [references/cli.md](references/cli.md) for stream discovery, selection, preview, confirmation, and broadcast.

## Resources

- [Sablier Documentation](https://docs.sablier.com/llms.txt)
- [EVM Lockup Deployments](https://docs.sablier.com/guides/lockup/deployments.md)
- [Sablier Indexer API](https://docs.sablier.com/api/streams/indexers.md)
- [Sablier GraphQL Schema](https://docs.sablier.com/api/streams/graphql/schema.md)
- [Sablier Indexers Repo](https://github.com/sablier-labs/indexers)
- [Sablier EVM Monorepo](https://github.com/sablier-labs/lockup)

## Support

If you encounter any issues or unexpected errors with this skill, please file an issue at
[sablier-labs/sablier-skills](https://github.com/sablier-labs/sablier-skills/issues).
