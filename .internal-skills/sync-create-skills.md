# Sync Create Skills

Review the workflow docs for `sablier-create-vesting`, `sablier-create-open-ended-stream`, and `sablier-create-airdrop`, detect drift in the generic workflow language, and patch only the divergences that are not product-specific.

Work only in these six files:

- `skills/sablier-create-vesting/SKILL.md`
- `skills/sablier-create-vesting/references/evm-cli.md`
- `skills/sablier-create-open-ended-stream/SKILL.md`
- `skills/sablier-create-open-ended-stream/references/evm-cli.md`
- `skills/sablier-create-airdrop/SKILL.md`
- `skills/sablier-create-airdrop/references/evm-cli.md`

## Workflow

1. Read the six files above and diff across all three skills:
   - `SKILL.md` files against each other
   - `references/evm-cli.md` files against each other
2. Compare only the generic workflow sections. Treat these as in scope:
   - confirmation flow and stop/continue wording
   - preview-before-broadcast wording
   - shared `cast` guardrails and signing-method wording
   - generic routing wording such as execution intent, onchain integration intent, and non-onchain integration handling
   - shared user-facing phrasing that appears in matching workflow steps across all three skills
3. Treat these as out of scope unless multiple files already carry the same concept and only wording drifted:
   - product names, contract names, event names, URLs, slugs, and resource links
   - Flow rate calculation, the `"per month"` caveat, deposit semantics, and Flow-specific unsupported features
   - Lockup vesting shapes, schedule variants, Solana handling, and Lockup-specific unsupported features
   - Merkle campaign types, Merkle tree generation, claim mechanics, and Airdrop-specific unsupported features
   - `references/evm-onchain.md` and every file outside the six target files
4. When a generic section has diverged, normalize all skills to one phrasing. Reuse the clearest wording already present in any skill. Do not introduce new policy unless it is necessary to remove an actual ambiguity.
5. Prefer minimal patches. Do not rewrite whole sections just to make them look symmetrical if the remaining differences are product-specific.
6. If no generic drift exists, make no edits and report that the workflow sections are already aligned.

## Alignment Rules

- Keep `sablier-create-vesting` as the tiebreaker only when all current phrasings are equally clear.
- If another skill already has better generic wording, copy that wording into the matching sections instead of forcing vesting wording everywhere.
- Keep the single confirmation contract as `Reply exactly: YES` unless all three skills are intentionally being changed together.
- Keep the Flow `"per month"` caveat informational and product-specific. Do not copy it into vesting or airdrop.
- Preserve any product-specific differences in inputs, constraints, calculations, event parsing, UI URLs, or supported-chain behavior.

## Verification

After editing, run:

```bash
just mdformat-check skills/sablier-create-open-ended-stream skills/sablier-create-vesting skills/sablier-create-airdrop
git diff --check -- skills/sablier-create-open-ended-stream/SKILL.md skills/sablier-create-open-ended-stream/references/evm-cli.md skills/sablier-create-vesting/SKILL.md skills/sablier-create-vesting/references/evm-cli.md skills/sablier-create-airdrop/SKILL.md skills/sablier-create-airdrop/references/evm-cli.md
```

Re-read the touched sections and confirm that all three skills match on generic workflow language and still differ only where the products require it.
