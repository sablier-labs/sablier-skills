---
name: sync-create-skills
description: Review and synchronize the generic workflow sections of `sablier-create-vesting` and `sablier-create-open-ended-stream`. Use when Codex needs to check for drift between those two Sablier skills, align shared execution wording, or fix divergences in their `SKILL.md` and `references/evm-cli.md` files while preserving product-specific differences.
---

# Sync Create Skills

## Overview

Review the paired workflow docs for `sablier-create-vesting` and `sablier-create-open-ended-stream`, detect drift in the generic workflow language, and patch only the divergences that are not product-specific.

Work only in these four files in this repository:

- `skills/sablier-create-vesting/SKILL.md`
- `skills/sablier-create-vesting/references/evm-cli.md`
- `skills/sablier-create-open-ended-stream/SKILL.md`
- `skills/sablier-create-open-ended-stream/references/evm-cli.md`

## Workflow

1. Read the four files above and diff the paired documents:
   - `SKILL.md` against `SKILL.md`
   - `references/evm-cli.md` against `references/evm-cli.md`
2. Compare only the generic workflow sections. Treat these as in scope:
   - confirmation flow and stop/continue wording
   - preview-before-broadcast wording
   - shared `cast` guardrails and signing-method wording
   - generic routing wording such as execution intent, onchain integration intent, and non-onchain integration handling
   - shared user-facing phrasing that appears in matching workflow steps in both skills
3. Treat these as out of scope unless both files already carry the same concept and only wording drifted:
   - product names, contract names, event names, URLs, slugs, and resource links
   - Flow rate calculation, the `"per month"` caveat, deposit semantics, and Flow-specific unsupported features
   - Lockup vesting shapes, schedule variants, Solana handling, and Lockup-specific unsupported features
   - `references/evm-onchain.md` and every file outside the four target files
4. When a generic section has diverged, normalize both sides to one phrasing. Reuse the clearest wording already present in either skill. Do not introduce new policy unless it is necessary to remove an actual ambiguity.
5. Prefer minimal patches. Do not rewrite whole sections just to make them look symmetrical if the remaining differences are product-specific.
6. If no generic drift exists, make no edits and report that the paired workflow sections are already aligned.

## Alignment Rules

- Keep `sablier-create-vesting` as the tiebreaker only when both current phrasings are equally clear.
- If `sablier-create-open-ended-stream` already has better generic wording, copy that wording into the matching vesting section instead of forcing vesting wording everywhere.
- Keep the single confirmation contract as `Reply exactly: YES` unless both skills are intentionally being changed together.
- Keep the Flow `"per month"` caveat informational and product-specific. Do not copy it into vesting.
- Preserve any product-specific differences in inputs, constraints, calculations, event parsing, UI URLs, or supported-chain behavior.

## Verification

After editing, run:

```bash
just mdformat-check skills/sablier-create-open-ended-stream skills/sablier-create-vesting
git diff --check -- skills/sablier-create-open-ended-stream/SKILL.md skills/sablier-create-open-ended-stream/references/evm-cli.md skills/sablier-create-vesting/SKILL.md skills/sablier-create-vesting/references/evm-cli.md
```

Re-read the touched sections and confirm that the two skills now match on generic workflow language and still differ only where the products require it.
