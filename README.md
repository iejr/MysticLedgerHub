# MysticLedgerHub

Multi-wallet, multi-chain cryptocurrency transaction and balance tracking service built on Firebase Cloud Functions.

Fetches, normalizes, and caches blockchain transaction history and wallet balances across 14 EVM chains, with historical USD pricing and CSV export.

## Architecture

```
index.ts                        HTTP endpoints (Cloud Functions v2)
  |
application/                    Orchestration
  TransactionFetcherService     Multi-wallet tx discovery + enrichment
  BalanceFetcherService         Multi-wallet balance queries
  |
domain/                         Business logic
  ConfigService                 Chain/token/wallet config + Uniswap token DB
  PriceService                  Historical USD pricing (cache-aside)
  BlockService                  Timestamp <-> block number resolution
  CacheService                  Unified cache middleware (read/write gating)
  CsvService                    CSV export generation
  AlchemyParser                 Trace -> UnifiedTransaction parsing
  |
infra/                          External service adapters
  AlchemyAdapter                Alchemy JSON-RPC + REST APIs
  MoralisAdapter                Moralis wallet history API
  FirestoreAdapter              Firestore collections
  Throttler                     Rate limiting (p-queue)
  BaseAdapter                   HTTP client with retry (axios + p-retry)
```

## Endpoints

### POST `/fetchTransactions`

Fetch transaction history across wallets and chains.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `addresses` | string[] | wallets.yaml | Wallet addresses to query |
| `chains` | string[] | global config | Chains to fetch from |
| `startDate` | ISO 8601 | - | Start of date range |
| `endDate` | ISO 8601 | - | End of date range |
| `fromBlock` | number | - | Start block (overrides startDate) |
| `toBlock` | number | - | End block (overrides endDate) |
| `useCache` | boolean | true | Read from cache |
| `dryRun` | boolean | false | Skip all cache writes |
| `exportCsv` | boolean | false | Return CSV instead of JSON |

**Response:** `{ count, transactions[] }` or CSV download.

**How it works:**
1. Resolves date range to block numbers per chain (via `BlockService`)
2. Discovers relevant tx hashes via `alchemy_getAssetTransfers`
3. Fetches full traces via `trace_transaction` batch calls
4. Parses traces into `UnifiedTransaction` with native + token transfers
5. Enriches with block timestamps, token metadata, USD prices
6. Filters spam tokens (only known tokens from system config + Uniswap list pass)
7. Updates `wallet_tokens` cache for future balance queries
8. Caches canonical + raw transactions in Firestore

### POST `/fetchBalances`

Fetch token balances for wallets, optionally at a historical point in time.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `addresses` | string[] | wallets.yaml | Wallet addresses to query |
| `timestamp` | ISO 8601 | - | Point-in-time snapshot |
| `blockNumber` | number | latest | Block number (all chains) |
| `chainBlockNumbers` | Record\<string, number\> | - | Per-chain block numbers |
| `includeUsd` | boolean | global config | Include USD pricing |
| `useCache` | boolean | true | Read from cache |
| `dryRun` | boolean | false | Skip all cache writes |
| `exportCsv` | boolean | false | Return CSV instead of JSON |

**Response:** `{ count, balances[] }` or CSV download.

**How it works:**
1. If `timestamp` provided, resolves to per-chain block numbers via `BlockService`
2. For each wallet+chain: merges base tokens (tokens.yaml) with tokens from tx history (`wallet_tokens`)
3. Batches `eth_getBalance` + `eth_call(balanceOf)` requests per chain
4. Enriches with USD pricing at block time
5. Caches results in Firestore

## Supported Chains

| Chain | EVM ID | Native | Block Time | Notes |
|-------|--------|--------|------------|-------|
| ethereum | 1 | ETH | 12.1s | |
| arbitrum | 42161 | ETH | 0.25s | Non-linear blocks |
| avalanche | 43114 | AVAX | 1.0s | |
| base | 8453 | ETH | 2.0s | |
| bnb | 56 | BNB | 0.45s | Non-linear blocks |
| optimism | 10 | ETH | 2.0s | |
| polygon | 137 | POL | 2.1s | |
| zkSync | 324 | ETH | 1.0s | Non-linear blocks |
| abstract | 2741 | ETH | 0.5s | Non-linear blocks |
| zora | 7777777 | ETH | 2.0s | |
| blast | 81457 | ETH | 2.0s | |
| scroll | 534352 | ETH | 3.0s | |
| linea | 59144 | ETH | 2.2s | |
| ink | 57073 | ETH | 1.0s | |

Chains marked "Non-linear blocks" use binary search instead of interpolation for timestamp-to-block resolution.

## Token Support

**System tokens** (`tokens.yaml`) — always queried in balance fetch:
ETH, USDC, USDT, POL, JPYC (with per-chain contract addresses).

**Uniswap token list** (`tokens.uniswap.json`) — used for spam filtering during transaction discovery. Any token in this list passes the ERC-20 filter.

**Wallet tokens** (Firestore `wallet_tokens`) — tokens discovered from transaction history. Merged with system tokens during balance fetch so wallets automatically query tokens they've interacted with.

## Caching

All caching is managed through `CacheService`, a middleware wrapping Firestore with two flags:

| Mode | Reads | Writes | Use case |
|------|-------|--------|----------|
| `useCache=true` (default) | enabled | enabled | Normal operation |
| `useCache=false` | disabled | enabled | Force re-fetch, populate cache |
| `dryRun=true` | disabled | disabled | Test without side effects |

**Firestore collections:**

| Collection | Key pattern | Purpose |
|------------|-------------|---------|
| `canonical_transactions` | `{chain}_{txHash}` | Enriched parsed transactions |
| `raw_transactions` | `{chain}_{txHash}` | Raw trace data |
| `discovered_token_transfers` | `{chain}_{txHash}` | ERC-20 transfers from discovery phase |
| `block_mappings` | `{chain}_ts_{ts}` / `{chain}_num_{block}` | Bidirectional timestamp/block mapping |
| `balances` | `{wallet}_{chain}_{tokenId}_{block}` | Balance snapshots |
| `token_prices` | `{tokenId}_{timestamp}` | Historical USD prices |
| `wallet_tokens` | `{wallet}_{chain}` | Tokens each wallet has interacted with |

## Configuration

### `functions/src/config/wallets.yaml`

```yaml
global:
  chains: [ethereum, arbitrum, base, optimism, polygon, ...]
  includeUsd: true

wallets:
  - address: "0x..."
    label: "My Wallet"
    chains: [base]  # optional per-wallet chain override

auxiliaryAddresses:
  - address: "0x..."
    label: "Related Contract"
```

A `wallets.sample.yaml` is provided as a template (`wallets.yaml` is gitignored).

### `functions/src/config/chains.yaml`

```yaml
ethereum:
  evmChainId: 1
  name: Ethereum Mainnet
  nativeSymbol: ETH
  averageBlockTime: 12.1
  linearBlockTime: true    # false -> uses binary search
  startBlock: 20000000
  explorerUrl: https://etherscan.io/
```

### `functions/src/config/tokens.yaml`

```yaml
tokens:
  - id: usdc
    name: USD Coin
    symbol: USDC
    decimals: 6
    type: erc20
    chains:
      ethereum:
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
      base:
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

chains:
  ethereum:
    allowlist: [native-eth, usdc, usdt, jpyc]
```

## Setup

### Prerequisites

- Node.js 22
- Firebase CLI (`npm install -g firebase-tools`)
- Firebase project with Firestore enabled

### Install

```bash
cd functions
npm install
```

### Environment Variables

Set these before running locally or deploy as Firebase secrets:

```bash
export ALCHEMY_API_KEY=your_alchemy_key
export MORALIS_API_KEY=your_moralis_key
```

### Configure Wallets

```bash
cp functions/src/config/wallets.sample.yaml functions/src/config/wallets.yaml
# Edit wallets.yaml with your addresses
```

### Run Locally

```bash
cd functions
npm run serve
```

Starts Firebase emulator on `http://localhost:5001` with Firestore on port 8080.

### Deploy

```bash
cd functions
npm run deploy
```

## Example Requests

### Fetch transactions for specific wallets

```bash
curl -X POST http://localhost:5001/mystic-ledger-hub/us-central1/fetchTransactions \
  -H "Content-Type: application/json" \
  -d '{
    "addresses": ["0xbb41bf870661D7fc33E0c0806D349B354eFa5208"],
    "chains": ["base", "ethereum"],
    "startDate": "2025-01-01T00:00:00Z",
    "endDate": "2025-03-31T23:59:59Z"
  }'
```

### Fetch historical balances at a specific date

```bash
curl -X POST http://localhost:5001/mystic-ledger-hub/us-central1/fetchBalances \
  -H "Content-Type: application/json" \
  -d '{
    "addresses": ["0xbb41bf870661D7fc33E0c0806D349B354eFa5208"],
    "timestamp": "2025-06-30T00:00:00Z",
    "includeUsd": true
  }'
```

### Export transactions as CSV

```bash
curl -X POST http://localhost:5001/mystic-ledger-hub/us-central1/fetchTransactions \
  -H "Content-Type: application/json" \
  -d '{
    "chains": ["base"],
    "startDate": "2025-01-01T00:00:00Z",
    "exportCsv": true
  }' -o transactions.csv
```

### Dry run (no cache side effects)

```bash
curl -X POST http://localhost:5001/mystic-ledger-hub/us-central1/fetchBalances \
  -H "Content-Type: application/json" \
  -d '{
    "addresses": ["0xbb41bf870661D7fc33E0c0806D349B354eFa5208"],
    "dryRun": true
  }'
```

## Tech Stack

| Package | Version | Purpose |
|---------|---------|---------|
| firebase-functions | ^7.1.1 | Cloud Functions v2 runtime |
| firebase-admin | ^13.7.0 | Firestore access |
| ethers | ^6.16.0 | EVM data encoding/formatting |
| axios | ^1.13.6 | HTTP client |
| p-queue | ^9.1.0 | Request throttling |
| p-retry | ^7.1.1 | Retry with exponential backoff |
| js-yaml | ^4.1.1 | YAML config parsing |
| zod | ^4.3.6 | Runtime type validation |
| TypeScript | ^5.9.3 | |
