# AGENTS.md

## Skills scope

When the user refers to **creating, updating, or deleting skills** in this repository, they mean the skills under `@skills/` in this repo — **not** globally installed skills (e.g. those in `~/.claude/skills` or any other global skill location).

Always operate on `skills/` within this repo unless the user explicitly says otherwise.

## Setup

The repo does not have a root `package.json`; maintenance is split between Markdown formatting and the local airdrop helper.

Install formatting dependencies:

```bash
just install-deps
```

The airdrop helper targets Node.js 20 or newer.

## Commands

Check or write Markdown formatting:

```bash
just mdformat-check .
just mdformat-write .
```

Run the local test suite:

```bash
cd skills/sablier-create-airdrop/scripts
npm test
```
