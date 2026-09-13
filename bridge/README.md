# trueup-bridge

Verifies Request Network settlement webhooks, decides which invoice each payment
pays, and moves the money through KeeperHub.

See [`../docs/architecture.md`](../docs/architecture.md) for why it is a separate
service rather than a KeeperHub workflow, and [`../docs/limits.md`](../docs/limits.md)
for what is not built yet.

## Requirements

- Node 24 (`node --version` → v24.x)
- pnpm 10

## Setup

```bash
pnpm install
cp ../.env.example .env      # then fill it in
```

`GET /readyz` reports which variables are still missing, so you can start the
service before the secrets exist and see exactly what is absent.

## Run

```bash
pnpm dev          # watch mode
pnpm start        # once
pnpm type-check
pnpm test
```

Seed the demo invoices and suppliers:

```bash
pnpm exec tsx scripts/seed-demo.ts
```

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/webhooks/request-network` | Receives Request Network settlement webhooks |
| `GET` | `/healthz` | Liveness |
| `GET` | `/readyz` | Which configuration is present and which is missing |

### Response codes on the webhook

Chosen around Request Network's retry behaviour (3 retries, 4 attempts, at
1s / 5s / 15s):

| Code | Meaning |
| --- | --- |
| `200` | Handled. Never retry — including the case where we deliberately did nothing. |
| `401` | Signature could not be verified. Retrying cannot fix it, and we never act on an unverified payment event. |
| `400` | Valid signature, unusable payload. |
| `500` | Transient failure on our side. Retry is safe: the delivery id keeps it idempotent. |

A redelivery of an already-handled event returns `200` with `"replayed": true` and
the original verdict. It never re-executes.

## Layout

```
src/
  env.ts          configuration loading + validation
  ledger.ts       invoices, suppliers, settlements, idempotency store
  classify.ts     reconciliation scoring — pure, testable, no I/O
  settle.ts       orchestration: webhook → decision → payout or hold
  keeperhub.ts    KeeperHub client; simulate-then-execute enforced in transferSafely
  server.ts       HTTP entry: raw body → verify → idempotency → settle
  rn/
    types.ts      webhook payload schemas
    verify.ts     HMAC-SHA256 over the raw body
    client.ts     Request Network API client
    destination.ts ERC-7828 composite destination parsing
tests/
  verify.test.ts  forgery, tampering, re-serialisation, encoding
  classify.test.ts exact, partial, ambiguous, no-evidence
```

## Two implementation notes worth reading before editing

**Signature verification must run against the raw bytes.** `JSON.parse` followed by
`JSON.stringify` produces different bytes and a different digest, so the request body
is read as a `Buffer` and never parsed before verification. There is a test for this.

**`destinationId` is split on the LAST colon.** The composite value is
`<interopAddress>:<tokenAddress>`, and the interop address contains a colon of its own
(`eip155:8453`). Splitting on the first colon silently yields a wrong token address.
There is a test for this.
