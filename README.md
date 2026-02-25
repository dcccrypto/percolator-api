# @percolator/api

> REST API for the Percolator perpetual futures trading engine on Solana.

[![CI](https://github.com/dcccrypto/percolator-api/actions/workflows/ci.yml/badge.svg)](https://github.com/dcccrypto/percolator-api/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

## Overview

The Percolator API provides read-only access to market data, trades, funding rates, open interest, insurance fund, and platform statistics. It powers the [percolator.trade](https://percolator.trade) frontend and is available for third-party integrations.

## Features

- **Market Data** — Real-time market metadata, pricing, and order book snapshots
- **Trade History** — Trade logs with volume analytics
- **Funding Rates** — Current and historical funding rate calculations
- **Open Interest** — Per-market and aggregate OI tracking
- **Insurance Fund** — Fund balance and history
- **Platform Stats** — TVL, volume, users, and more
- **WebSocket** — Live price and trade streaming
- **OpenAPI Spec** — Full API documentation at `/docs`

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────┐
│   Frontend   │────▶│  @percolator │────▶│  Solana   │
│   Next.js    │     │     /api     │     │  RPC      │
└─────────────┘     └──────┬───────┘     └──────────┘
                           │
                    ┌──────▼───────┐
                    │   Supabase   │
                    │   (cache)    │
                    └──────────────┘
```

## Quick Start

```bash
# Install dependencies
pnpm install

# Copy environment variables
cp .env.example .env

# Development (with hot reload)
pnpm dev

# Build
pnpm build

# Production
pnpm start

# Tests
pnpm test
```

## API Endpoints

| Method | Endpoint               | Description                    |
|--------|------------------------|--------------------------------|
| GET    | `/health`              | Health check                   |
| GET    | `/docs`                | OpenAPI documentation          |
| GET    | `/v1/markets`          | List all markets               |
| GET    | `/v1/markets/:address` | Single market details          |
| GET    | `/v1/prices`           | Current prices                 |
| GET    | `/v1/prices/history`   | Price history (OHLCV)          |
| GET    | `/v1/trades`           | Trade history                  |
| GET    | `/v1/funding`          | Current funding rates          |
| GET    | `/v1/funding/history`  | Funding rate history           |
| GET    | `/v1/open-interest`    | Open interest data             |
| GET    | `/v1/insurance`        | Insurance fund info            |
| GET    | `/v1/stats`            | Platform statistics            |
| GET    | `/v1/crank`            | Crank status                   |
| WS     | `/ws`                  | WebSocket for live updates     |

## Dependencies

| Package             | Purpose                          |
|---------------------|----------------------------------|
| `@percolator/sdk`   | On-chain program interaction     |
| `@percolator/shared` | Shared utilities and types      |
| `hono`              | Web framework                    |
| `@solana/web3.js`   | Solana RPC client               |
| `@supabase/supabase-js` | Database/cache layer        |
| `ws`                | WebSocket server                |

## Docker

```bash
# Build
docker build -t percolator-api .

# Run
docker run -p 4000:4000 --env-file .env percolator-api
```

## Deployment

Configured for Railway deployment via `railway.toml`. See [Railway docs](https://docs.railway.com/) for setup.

## Related Packages

- [`@percolator/sdk`](https://github.com/dcccrypto/percolator-sdk) — TypeScript SDK
- [`@percolator/shared`](https://github.com/dcccrypto/percolator-shared) — Shared utilities
- [`percolator-prog`](https://github.com/dcccrypto/percolator-prog) — Solana program (Rust)

## License

[Apache License 2.0](LICENSE)
