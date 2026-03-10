# Merkle Tree Generation

This reference covers the full process: collecting recipient data, running the Merkle API, and extracting the values needed for campaign deployment. The agent handles every step — the only user-provided inputs are the recipient CSV and Pinata credentials.

## 1) Collect Recipient Data

The agent must obtain a CSV with `address` and `amount` columns.

**Primary — file path:** Ask the user for a path to a CSV on their filesystem. Read the file and verify it exists and is non-empty before proceeding.

**Fallback — inline data:** For small recipient lists (roughly 20 or fewer), the user may paste CSV rows directly in chat. Write the data to a temporary file:

```bash
cat > /tmp/recipients.csv << 'EOF'
address,amount
0x1111111111111111111111111111111111111111,1000
0x2222222222222222222222222222222222222222,500
EOF
```

Set `CSV_FILE` to the file path and proceed.

### CSV Format

- Header row must be exactly `address,amount`
- Amounts in **human-readable units** (not base units) — the API handles decimal conversion
- Addresses must be valid EIP-55 checksummed Ethereum addresses
- No duplicate addresses allowed
- All amounts must be positive and non-zero
- Decimal places in amounts must not exceed the token's `decimals` value

Example:

```csv
address,amount
0x9ad7CAD4F10D0c3f875b8a2fd292590490c9f491,100.0
0xf976aF93B0A5A9F55A7f285a3B5355B8575Eb5bc,200.0
0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC,50.5
```

### Pre-submission Validation

Before submitting to the API, verify:

1. The file exists and is readable.
2. The header row is exactly `address,amount`.
3. There is at least one data row after the header.
4. All addresses match the `0x[0-9a-fA-F]{40}` pattern.
5. All amounts are numeric and positive.

If any check fails, show the user the specific error and ask them to fix the CSV.

## 2) Resolve Token Decimals

Query the token's `decimals` from the chain — this is required by the API:

```bash
DECIMALS=$(cast call "$TOKEN" "decimals()(uint8)" --rpc-url "$RPC_URL")
```

## 3) Start the Merkle API

The [Sablier Merkle API](https://github.com/sablier-labs/merkle-api) generates the Merkle tree, uploads it to IPFS via [Pinata](https://www.pinata.cloud/), and returns the root and CID. The agent sets up and runs the API locally.

### Check if already running

```bash
curl -s http://localhost:3030/api/health | jq -r '.status'
```

If the health check returns `"success"`, skip to [step 4](#4-submit-csv-and-parse-response).

### Prerequisites

Verify the Rust toolchain is installed:

```bash
if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust toolchain not found. Install from https://rustup.rs"
  exit 1
fi
```

If `cargo` is not available, stop and tell the user to install Rust from [https://rustup.rs](https://rustup.rs).

### Obtain Pinata Credentials

The API uploads Merkle tree data to IPFS via Pinata. Pinata does not support programmatic account creation — the user must create a free account once at [pinata.cloud](https://www.pinata.cloud/) and provide the credentials.

Ask the user for these three values (all found in the Pinata dashboard under API Keys):

- `PINATA_API_KEY`
- `PINATA_SECRET_API_KEY`
- `PINATA_ACCESS_TOKEN` (JWT)

### Clone and Build

```bash
MERKLE_API_DIR="/tmp/sablier-merkle-api"
MERKLE_API_LOG="/tmp/sablier-merkle-api.log"

if [ ! -d "$MERKLE_API_DIR" ]; then
  git clone https://github.com/sablier-labs/merkle-api.git "$MERKLE_API_DIR"
fi

cat > "$MERKLE_API_DIR/.env" << EOF
PINATA_API_KEY=$PINATA_API_KEY
PINATA_SECRET_API_KEY=$PINATA_SECRET_API_KEY
PINATA_ACCESS_TOKEN=$PINATA_ACCESS_TOKEN
PINATA_API_SERVER=https://api.pinata.cloud
IPFS_GATEWAY=https://gateway.pinata.cloud
MERKLE_API_BEARER_TOKEN=
EOF
```

Build the project first. The initial compilation takes several minutes — inform the user and show progress:

```bash
(cd "$MERKLE_API_DIR" && cargo build --release 2>&1) | tail -5
```

If `cargo build` fails, stop and show the error output.

### Start the Server

```bash
(cd "$MERKLE_API_DIR" && cargo run --release > "$MERKLE_API_LOG" 2>&1) &
```

Wait for the server to be ready:

```bash
HEALTHY=false
for i in $(seq 1 15); do
  if curl -s http://localhost:3030/api/health | jq -e '.status == "success"' > /dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  sleep 2
done

if [ "$HEALTHY" != "true" ]; then
  echo "Merkle API failed to start. Log output:"
  cat "$MERKLE_API_LOG"
  exit 1
fi
```

If the server fails to start, show the log output and diagnose. Common issues:

- Invalid Pinata credentials → ask the user to verify at [pinata.cloud](https://www.pinata.cloud/)
- Port 3030 already in use → check with `lsof -i :3030`

Set `MERKLE_API_URL="http://localhost:3030"`.

## 4) Submit CSV and Parse Response

```bash
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "${MERKLE_API_URL}/api/create?decimals=${DECIMALS}" \
  -F "data=@${CSV_FILE}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
```

**On success (HTTP 200):**

The API returns:

```json
{
  "status": "Upload successful",
  "total": "10000000000",
  "recipients": "50",
  "root": "0x1234abcd...",
  "cid": "Qm..."
}
```

Parse the response:

```bash
MERKLE_ROOT=$(echo "$BODY" | jq -r '.root')
IPFS_CID=$(echo "$BODY" | jq -r '.cid')
AGGREGATE_AMOUNT=$(echo "$BODY" | jq -r '.total')
RECIPIENT_COUNT=$(echo "$BODY" | jq -r '.recipients')
```

- `root` — the Merkle root (`bytes32`) for the campaign's `merkleRoot` parameter.
- `cid` — the IPFS CID for the campaign's `ipfsCID` parameter.
- `total` — the aggregate amount already converted to the token's base units. Use directly as `aggregateAmount`.
- `recipients` — the recipient count. Use directly as `recipientCount`.

**On validation error (HTTP 400):**

```json
{
  "status": "Invalid csv file.",
  "errors": ["Row 3: invalid address", "Row 5: amount exceeds decimals"]
}
```

Show the errors to the user and ask them to fix the CSV before retrying.

**On server error (HTTP 500) or API unreachable:**

Diagnose before stopping:

- Is the server running? `curl -s ${MERKLE_API_URL}/api/health`
- Are the Pinata credentials valid? Ask the user to verify at [pinata.cloud](https://www.pinata.cloud/).
- Is the CSV valid per the [format above](#csv-format)?

Do not proceed with campaign deployment until the Merkle API returns a successful response with all four values.

## Leaf Encoding (Reference)

Each leaf encodes three values — `(index, recipient, amount)` — and is **double-hashed** with keccak256 for second preimage resistance. The Merkle API handles this automatically.
