# Contributing

Use this file for local setup and validation. The repo does not have a root `package.json`; maintenance is split between Markdown formatting and the local airdrop helper.

## Setup

Install formatting dependencies:

```bash
just install-deps
```

The airdrop helper targets Node.js 20 or newer.

## Validate

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
