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
| `POST` | `/webhooks/keeperhub-fallback` | Placeholder for the deferred W1 workflow: logs a KeeperHub-side "we could not attribute this" report and returns `202`. **Moves nothing**, and makes no decision yet — it exists so the endpoint shape is settled before W1 is authored |
| `GET` | `/healthz` | Liveness |
| `GET` | `/readyz` | Which configuration is present and which is missing, including whether `BRIDGE_DRY_RUN` is on |

### Dry run

`BRIDGE_DRY_RUN` rehearses the whole path without moving anything: the settlement is
classified, each payout is simulated through KeeperHub (gas estimated, reverts caught),
and **nothing is signed, broadcast, or written to the ledger**. Only `1`, `true`, `yes`
or `on` turn it on — the string `false` means false, which the obvious
`z.coerce.boolean()` shorthand gets wrong. The startup banner states the mode either
way, and the webhook response carries `"dryRun": true`.

That last part is not incidental. A dry run that marked the invoice settled would leave
the real run with no open invoice to match against, so the ledger write sits below the
rehearsal return and `tests/settle.test.ts` pins it.

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
  receipt.ts      the auditable record — allowlisted, bounded, versioned
  server.ts       HTTP entry: raw body → verify → idempotency → settle
  rn/
    types.ts      webhook payload schemas
    verify.ts     HMAC-SHA256 over the raw body
    client.ts     Request Network API client
    destination.ts ERC-7828 composite destination parsing
tests/
  verify.test.ts  forgery, tampering, re-serialisation, encoding
  classify.test.ts exact, partial, ambiguous, no-evidence
  fixtures.test.ts the demo's preconditions — caps, sums, expected verdicts
  settle.test.ts  the rehearsal writes nothing; a payout without a token is refused
  receipt.test.ts bounded, ordered, credential-refusing
  client.test.ts  cookie-only webhook auth; destinationId omission
scripts/
  seed-demo.ts        seeds the ledger; --reset returns it to a clean slate
  demo-rehearsal.ts   the whole loop, simulated: nothing signed, ledger untouched
  create-payment.ts   creates an RN payment request (defaults to a wrong reference)
  debug-simulate.ts   raw dry-run output, for diagnosing a refusal
```

## Scripts worth knowing

```bash
pnpm exec tsx scripts/seed-demo.ts --reset   # clean slate for a rehearsal or a take
pnpm exec tsx scripts/demo-rehearsal.ts      # the loop, simulated
pnpm exec tsx scripts/balance.ts             # does the org wallet have enough USDC?
pnpm exec tsx scripts/create-payment.ts 18.00 PO-9001
```

`create-payment.ts` defaults its reference to a deliberately **wrong** one. `settle()`
reads the reference back from Request Network and treats an exact match as decisive, so
a request carrying `INV-4471` would classify as `attributed` and never reach the scoring
path the demo is about.

## Two implementation notes worth reading before editing

**Signature verification must run against the raw bytes.** `JSON.parse` followed by
`JSON.stringify` produces different bytes and a different digest, so the request body
is read as a `Buffer` and never parsed before verification. There is a test for this.

**`destinationId` is split on the LAST colon.** The composite value is
`<interopAddress>:<tokenAddress>`, and the interop address contains a colon of its own
(`eip155:8453`). Splitting on the first colon silently yields a wrong token address.
There is a test for this.
