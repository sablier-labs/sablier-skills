# Merkle Tree Generation

## Recommended: Merkle API

Use the [Sablier Merkle API](https://github.com/sablier-labs/merkle-api) to generate Merkle trees, upload to IPFS, and retrieve proofs. The API handles tree construction, leaf encoding, and IPFS storage.

### Input Format

The API accepts a CSV with two columns: `address` and `amount` (in human-readable units — the API handles decimal conversion).

```csv
address,amount
0x1111111111111111111111111111111111111111,1000
0x2222222222222222222222222222222222222222,500
```

### Output

The API returns:
- `root` — the Merkle root (`bytes32`) for the campaign's `merkleRoot` parameter
- `ipfsCID` — the IPFS CID where the full tree is stored, for the campaign's `ipfsCID` parameter
- Eligibility endpoint — look up a recipient's index, amount, and proof for claiming

## Leaf Encoding (Reference)

Each leaf encodes three values — `(index, recipient, amount)` — and is **double-hashed** with keccak256 for second preimage resistance. The Merkle API handles this automatically.
