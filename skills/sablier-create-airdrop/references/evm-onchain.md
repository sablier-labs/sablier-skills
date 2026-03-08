# EVM On-Chain Integration

On-chain integration means creating Merkle airdrop campaigns directly from a Solidity smart contract by calling factory functions. Each campaign type has a dedicated factory contract: `SablierFactoryMerkleInstant`, `SablierFactoryMerkleLL`, `SablierFactoryMerkleLT`, and `SablierFactoryMerkleVCA`. The factory deploys a campaign contract via CREATE2, returning a deterministic address.

MerkleLL and MerkleLT campaigns use percentage-based types from the [PRBMath](https://github.com/PaulRBerg/prb-math) library: `UD60x18` (`uint256`, `1e18` = 100%) for MerkleLL/VCA percentages, and `UD2x18` (`uint64`, `1e18` = 100%) for MerkleLT tranche percentages.

Each factory also exposes a `compute*` function to predict the campaign address before deployment.

## References

- **Sablier documentation (LLM-optimized):** <https://docs.sablier.com/llms.txt>
- **Deployed factory addresses:** <https://docs.sablier.com/guides/airdrops/deployments.md>
- **Solidity examples:** <https://github.com/sablier-labs/evm-examples>
- **Merkle API:** <https://github.com/sablier-labs/merkle-api>
