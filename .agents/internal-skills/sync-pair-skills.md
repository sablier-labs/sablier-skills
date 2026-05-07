---
name: sync-pair-skills
description: Review and synchronize the generic workflow sections of paired Sablier skills (create-vesting ↔ create-open-ended-stream and withdraw-vesting ↔ withdraw-open-ended-stream); align shared execution wording, fix divergences, preserve product-specific differences.
---

# Sync Pair Skills

## Overview

Review the paired workflow docs for the two Sablier skill pairs, detect drift in the generic workflow language, and patch only the divergences that are not product-specific.

Two pair groups are in scope:

- **Create pair**:
  - `skills/sablier-create-vesting/SKILL.md`
  - `skills/sablier-create-vesting/references/cli.md`
  - `skills/sablier-create-open-ended-stream/SKILL.md`
  - `skills/sablier-create-open-ended-stream/references/cli.md`
- **Withdraw pair**:
  - `skills/sablier-withdraw-vesting/SKILL.md`
  - `skills/sablier-withdraw-vesting/references/cli.md`
  - `skills/sablier-withdraw-open-ended-stream/SKILL.md`
  - `skills/sablier-withdraw-open-ended-stream/references/cli.md`

The withdraw pair additionally shares helper scripts that must remain byte-identical between the two skills (see [Helper-script byte-identity](#helper-script-byte-identity)).

## Workflow

Run the same comparison procedure twice — once per pair — independently. A change to one pair never implies a change to the other.

For each pair:

1. Read both skills' `SKILL.md` and both skills' `references/cli.md`, then diff:
   - `SKILL.md` against `SKILL.md`
   - `references/cli.md` against `references/cli.md`
2. Compare only the generic workflow sections. Treat these as in scope:
   - confirmation flow and stop/continue wording
   - preview-before-broadcast wording
   - shared `cast` guardrails and signing-method wording
   - generic routing wording such as execution intent, onchain integration intent, and non-onchain integration handling
   - shared user-facing phrasing that appears in matching workflow steps in both skills
3. Treat these as out of scope unless both files already carry the same concept and only wording drifted:
   - product names, contract names, event names, URLs, slugs, and resource links
   - **Create pair, Flow side**: rate calculation, the `"per month"` caveat, deposit semantics, and Flow-specific unsupported features
   - **Create pair, Lockup side**: vesting shapes, schedule variants, Solana handling, and Lockup-specific unsupported features
   - **Withdraw pair, Lockup side**: `withdrawMultiple` version dispatch (v1.0/v1.1 vs v1.2+ vs v2.0+ vs v3.0+), the per-stream skip event `InvalidWithdrawalInWithdrawMultiple`, and any version-specific access-control branches
   - **Withdraw pair, Flow side**: `batch(bytes[])` calldata-encoding step, all-or-nothing batch semantics, the `statusOf != VOIDED` precondition, and the per-product event signatures (`Withdraw` / `WithdrawFromFlowStream`)
   - `references/evm-onchain.md` and every file outside the eight target files
4. When a generic section has diverged, normalize both sides to one phrasing. Reuse the clearest wording already present in either skill. Do not introduce new policy unless it is necessary to remove an actual ambiguity.
5. Prefer minimal patches. Do not rewrite whole sections just to make them look symmetrical if the remaining differences are product-specific.
6. If no generic drift exists in a pair, make no edits to that pair and report that its paired workflow sections are already aligned.

## Helper-script byte-identity

The withdraw pair additionally shares two helper scripts that must remain **byte-identical** between the two skills. The two scripts are intentional copies — the underlying contract selectors (`withdrawableAmountOf(uint256)` and `calculateMinFeeWei(uint256)`) are identical on Lockup v3+ and Flow v2+, and the Multicall3 chain overrides are identical.

Files to keep in lockstep:

- `skills/sablier-withdraw-vesting/scripts/filter-withdrawable.sh` ↔ `skills/sablier-withdraw-open-ended-stream/scripts/filter-withdrawable.sh`
- `skills/sablier-withdraw-vesting/scripts/max-min-fee.sh` ↔ `skills/sablier-withdraw-open-ended-stream/scripts/max-min-fee.sh`

Verification:

```bash
diff -q skills/sablier-withdraw-vesting/scripts/filter-withdrawable.sh skills/sablier-withdraw-open-ended-stream/scripts/filter-withdrawable.sh
diff -q skills/sablier-withdraw-vesting/scripts/max-min-fee.sh skills/sablier-withdraw-open-ended-stream/scripts/max-min-fee.sh
```

Both commands must report no output. If the two copies diverge, propagate the wiser version into both — do not leave them unequal. The create pair has no equivalent shared-script invariant.

## Alignment Rules

- Keep `sablier-*-vesting` as the tiebreaker only when both phrasings are equally clear (same convention for both pairs).
- If the open-ended-stream side already has better generic wording, copy that wording into the matching vesting section instead of forcing vesting wording everywhere.
- Keep the single confirmation contract as `Reply exactly: YES` unless both skills are intentionally being changed together.
- Keep the Flow `"per month"` caveat informational and product-specific to the create pair. Do not copy it into vesting, and do not surface it in the withdraw pair (it has no rate concept).
- Preserve any product-specific differences in inputs, constraints, calculations, event parsing, UI URLs, batch semantics (Lockup `withdrawMultiple` partial-success vs Flow `batch` all-or-nothing), or supported-chain behavior.

## Verification

After editing, run:

```bash
just mdformat-check skills/sablier-create-open-ended-stream skills/sablier-create-vesting skills/sablier-withdraw-open-ended-stream skills/sablier-withdraw-vesting
diff -q skills/sablier-withdraw-vesting/scripts/filter-withdrawable.sh skills/sablier-withdraw-open-ended-stream/scripts/filter-withdrawable.sh
diff -q skills/sablier-withdraw-vesting/scripts/max-min-fee.sh skills/sablier-withdraw-open-ended-stream/scripts/max-min-fee.sh
git diff --check -- skills/sablier-create-open-ended-stream skills/sablier-create-vesting skills/sablier-withdraw-open-ended-stream skills/sablier-withdraw-vesting
```

Re-read the touched sections and confirm that the paired skills now match on generic workflow language and still differ only where the products require it.
