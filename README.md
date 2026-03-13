# Sablier Skills

AI agent skills for interacting with the [Sablier Protocol](https://sablier.com), the onchain token distribution protocol for token vesting and airdrop distributions. The skills cover protocol context, fixed-schedule vesting, open-ended payroll streams, and Merkle airdrop creation.

## Install

Install the full catalog:

```bash
npx skills add sablier-labs/sablier-skills
```

Install a single skill:

```bash
npx skills add sablier-labs/sablier-skills --skill sablier-create-vesting
```

Preview the catalog before installing:

```bash
npx skills add sablier-labs/sablier-skills -l
```

Pass `-g` to install globally.

## Use

Once installed, call a skill explicitly or let the agent route automatically.

```text
Use sablier-create-vesting: Create a 4-year vesting stream with a 12-month cliff on Arbitrum for 0x...

Use sablier-create-airdrop: Create an instant Merkle airdrop on Ethereum from this CSV.

Use sablier-create-open-ended-stream: Stream 1 USDC per day on Base to 0x...

Use sablier-protocol: Explain the difference between Lockup, Flow, and Airdrops.
```

## Included Skills

| Skill                              | Use it for                                                           | Scope                        |
| ---------------------------------- | -------------------------------------------------------------------- | ---------------------------- |
| `sablier-create-airdrop`           | Create Merkle airdrop campaigns from recipient CSVs                  | Sablier Airdrops, EVM        |
| `sablier-create-open-ended-stream` | Create open-ended token payment streams with a configurable rate     | Sablier Flow, EVM            |
| `sablier-create-vesting`           | Create fixed-schedule vesting streams with upfront funding           | Sablier Lockup, EVM + Solana |
| `sablier-protocol`                 | Explain the Sablier product surface and common distribution patterns | Advisory / context           |

## Repo Structure

```text
skills/
  sablier-create-airdrop/
  sablier-create-open-ended-stream/
  sablier-create-vesting/
  sablier-protocol/
justfile
README.md
```

Each skill directory contains `SKILL.md` and may also ship:

- `assets/` for ABIs and other static data
- `references/` for execution notes and product-specific guidance
- `scripts/` for local helpers; today only `sablier-create-airdrop` includes code

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, formatting, and test commands.

## Airdrop Helper

`skills/sablier-create-airdrop/scripts/generate-merkle-campaign.mjs` validates `address,amount` CSVs, builds a Standard Merkle Tree artifact, uploads the campaign payload to Pinata, and prints CLI-ready JSON with:

- `root`
- `cid`
- `total`
- `recipients`
- `artifactPath`

Example:

```bash
cd skills/sablier-create-airdrop/scripts
PINATA_JWT=... node generate-merkle-campaign.mjs \
  --csv-file recipients.csv \
  --decimals 18
```

## Resources

- [Sablier Documentation](https://docs.sablier.com)
- [Sablier App (EVM)](https://app.sablier.com)
- [Sablier App (Solana)](https://solana.sablier.com)

## License

MIT
