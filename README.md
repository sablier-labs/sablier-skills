# Sablier Skills

AI agent skills for creating token vesting streams, understanding the Sablier protocol, and choosing the right product for onchain token distribution.

## Installation

```bash
# Add all skills
npx skills add sablier-labs/sablier-skills

# Add a specific skill
npx skills add sablier-labs/sablier-skills -s sablier-create-vesting

# Add globally for all projects
npx skills add sablier-labs/sablier-skills -s sablier-create-vesting -g

# Target a specific agent (claude-code, cursor, cline, codex, etc.)
npx skills add sablier-labs/sablier-skills -s sablier-create-vesting -a claude-code

# List available skills before installing
npx skills add sablier-labs/sablier-skills -l
```

## Skills

| Skill                       | Description                                                             |
| --------------------------- | ----------------------------------------------------------------------- |
| `sablier-create-vesting`    | Create token vesting streams using Sablier Lockup on EVM chains         |
| `sablier-product-selection` | Choose the right Sablier product for your token distribution use case   |
| `sablier-protocol`          | Sablier protocol overview: token vesting, airdrops, and onchain payroll |

## Usage

Once installed, skills are automatically available to your AI assistant. Reference them by name in your prompts or let the assistant detect when a skill is relevant.

## Resources

- [Sablier Documentation](https://docs.sablier.com)
- [Sablier App (EVM)](https://app.sablier.com)
- [Sablier App (Solana)](https://solana.sablier.com)

## License

MIT
