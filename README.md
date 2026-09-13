# TrueUp

**The execution layer that turns a live invoice into a settled, reconciled on-chain payment.**

Getting paid in stablecoins is a solved problem. *Closing the books* is not. Money arrives
with no reference or the wrong one, partial payments land unexplained, and someone spends
Friday afternoon in a block explorer matching transfers to invoices by hand. TrueUp closes
that loop: an agent composes the reconciliation workflow, you review it, you dry run it
without touching the chain, and then that exact workflow executes — settling the receivable,
paying the suppliers, and producing an auditable receipt.

Built for **KeeperHub — The Agent Economy Hackathon** (DoraHacks).

---

## The integration

TrueUp integrates with **[Request Network](https://request.network)** — a live, non-custodial
stablecoin payments protocol founded in 2017, running across 8 networks with a public REST API,
a dashboard, and HMAC-signed settlement webhooks. It is a real product with real integrators,
not a fixture built for this hackathon.

Request Network solves the **accepting** side well. It stops at settlement — it tells you a debt
settled but does not execute the consequences of that fact. That gap is where KeeperHub becomes
load-bearing rather than decorative.

```
Invoice exists (Request Network)
  → payer settles a stablecoin payment
  → Request Network fires an HMAC-signed webhook
  → reference correct?  → reconcile and record          (KeeperHub)
  → reference missing?  → match it, then act            (KeeperHub)
  → supplier payouts execute, atomically, one memo each (KeeperHub → Tempo)
  → every run gets an ID, a hash, and an audit row      (KeeperHub Runs)
```

Nothing is inferred at execution time. That is the whole point.

---

## Architecture

```
                        ┌──────────────────────────────────────┐
                        │  REQUEST NETWORK (live project)      │
                        │  · payment destination (ERC-7828)    │
                        │  · POST /v2/secure-payments          │
                        │  · payer settles on Base / Sepolia   │
                        └───────────────┬──────────────────────┘
                                        │ HMAC-SHA256 signed webhook
                                        │ (x-request-network-signature)
                                        ▼
                        ┌──────────────────────────────────────┐
                        │  trueup-bridge  (Node 24 / TS)       │
                        │  1. verify HMAC over RAW body        │
                        │  2. persist event (idempotency)      │
                        │  3. classify:                        │
                        │       reference ok → record          │
                        │       unattributed → match           │
                        │       partial      → stage hold      │
                        │  4. call KeeperHub                   │
                        └───────────────┬──────────────────────┘
                                        │ REST direct execution / MCP
                                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │  KEEPERHUB — the execution layer                          │
        │                                                           │
        │  W1  inbound-reconcile                                    │
        │      Transfer trigger (watched addr + memo filter)         │
        │        → Condition (reference present?)                    │
        │        → true : record + notify                            │
        │        → false: match → payout                             │
        │                                                           │
        │  W2  supplier-payout                                      │
        │      simulate:true → wouldRevert:false → execute_transfer  │
        │        → idempotency_key → poll status → receipt           │
        │                                                           │
        │  W3  atomic-batch-payout   (Tempo 4217 / 42431)            │
        │      Batch Payout — one 32-byte memo per invoice           │
        │                                                           │
        │  W4  hold-and-release      (low-confidence path)           │
        │      Sign & Hold Payment → org-owner release               │
        │                                                           │
        │  Turnkey wallets · nonce management · smart gas estimation │
        │  private routing vs MEV · retries w/ exponential backoff   │
        │  Keeper Runs: ids, logs, status, audit trail               │
        └───────────────────────────────────────────────────────────┘
                                        │
                                        ▼
                        ┌──────────────────────────────────────┐
                        │  AGENT (over MCP)                    │
                        │  ai_generate_workflow → validate →   │
                        │  review → dry run → execute_workflow │
                        └──────────────────────────────────────┘
                                        │
                                        ▼
                        ┌──────────────────────────────────────┐
                        │  receipt bundle (JSON)               │
                        │  run ids + tx hashes + webhook body  │
                        │  + reconciliation verdict + weights  │
                        └──────────────────────────────────────┘
```

### Why a bridge service exists

This is an architecture decision, not a workaround. KeeperHub's Code node sandbox exposes only
`console`, `fetch` and `crypto.randomUUID` across its boundary — **`crypto.subtle` is unavailable**,
so Request Network's HMAC-SHA256 signature cannot be verified inside a workflow node. Signing
verification belongs outside the engine, which also keeps the KeeperHub workflows deterministic
and replayable: the bridge passes an already-verified, already-classified event into a workflow.
If the signing scheme ever changes, one service changes, not five workflows.

---

## Reconciliation model

A payment is matched to an invoice by a weighted, **explainable** score — never a black box:

| Signal                                            | Weight    | Source                     |
| ------------------------------------------------- | --------- | -------------------------- |
| Payment reference matches invoice id exactly       | decisive  | webhook / Transfer trigger |
| Payer is a known counterparty to one open invoice  | medium    | local ledger               |
| Amount equals the invoice total, or a valid partial| high      | Request Network payload    |
| Paid inside the invoice's expected window          | medium    | local ledger               |
| Payer's ERC-8004 identity matches the customer     | medium    | ERC-8004 registry          |

- **High confidence** → record and pay automatically.
- **Low confidence** → KeeperHub **Sign & Hold Payment**, released by an organisation owner.
- **Below threshold** → move nothing, alert a human.

TrueUp refuses to guess. We built the brake on purpose, and every verdict stores the signals and
weights that produced it, so the decision is explainable after the fact.

---

## Proof of execution

**Transaction executed through KeeperHub:**
[`0xa29ff44d1ff2fac1bae82a9177d3bad895c30b7170fcc8b41cb11ca27f4ea554`](https://sepolia.etherscan.io/tx/0xa29ff44d1ff2fac1bae82a9177d3bad895c30b7170fcc8b41cb11ca27f4ea554)

This README does not claim a result it cannot show. Every hash below is a real, resolvable
transaction on the chain named next to it.

| What | Chain | Hash | Run id | Receipt |
| ---- | ----- | ---- | ------ | ------- |
| 1.00 USDC → supplier, dry-run then executed | Sepolia `11155111` | [`0xa29ff4…a554`](https://sepolia.etherscan.io/tx/0xa29ff44d1ff2fac1bae82a9177d3bad895c30b7170fcc8b41cb11ca27f4ea554) | `l6bsd6lpn9fy8d7p6899i` | `success`, block 11698386, gas 61967 |

Executed in this exact order — the sequence the whole submission rests on:

1. `POST /api/execute/transfer` with `"simulate": true` → `success: true`, `wouldRevert: false`,
   `gasEstimate: 62796`. No signature, no broadcast, no hash.
2. The identical call **without** `simulate`, with a derived idempotency key.
3. Polled to terminal via `X-Poll-Interval-Hint`, then read the receipt.

Reproduce it with `pnpm exec tsx scripts/first-transaction.ts` from `bridge/`.

---

## Status

**Phase 1 — foundations, complete.** The bridge is built and covered by 71 tests.
Nothing has moved real value yet: the API clients are written against published
contracts but have not been run against the live services. See
[`implementation.md`](./implementation.md) for the plan and
[`docs/limits.md`](./docs/limits.md) for an itemised account of what is not built.

| Component | State |
| --------- | ----- |
| Webhook signature verification (HMAC over raw bytes) | **built** — 14 tests |
| Reconciliation engine (weighted, explainable, refuses to guess) | **built** — 19 tests |
| ERC-7828 destination parsing | **built** — 12 tests |
| Ledger + delivery idempotency | **built** — 12 tests |
| KeeperHub client (dry run enforced before every broadcast) | **built** — 14 tests |
| Request Network API client | **built**, not yet exercised live |
| HTTP bridge (`/webhooks/request-network`, `/readyz`) | **built**, smoke-tested |
| KeeperHub workflows W1–W4 | not built |
| `request-network` plugin (bounty PR) | not built |
| Agent workflow authoring over MCP | not built |
| Receipt bundle | not built |
| **First live transaction through KeeperHub** | **not yet** |

### Notable engineering decision from Phase 1

`KeeperHubClient.transferSafely` is the only exported way to move funds. It runs the
dry run first and refuses to broadcast in three cases: the dry run reported
`wouldRevert: true`; it failed validation (for example `insufficient_balance`); or it
returned **no `wouldRevert` field at all**, which means it never actually exercised
the write. That third case is the quiet one — a simulation of a read-only action
returns `success: true` while having proved nothing. Treating it as a green light is
precisely the mistake the platform's design exists to prevent.

---

## Setup

```bash
# Node 24 and pnpm 10 are required
node --version   # v24.x
pnpm --version   # 10.x

cd bridge
pnpm install
cp ../.env.example .env   # then fill it in — never commit .env

pnpm test         # 71 tests
pnpm type-check
pnpm dev          # starts the bridge; GET /readyz lists which keys are missing
```

Seed the demo data with `pnpm exec tsx scripts/seed-demo.ts`.

Nothing runs end to end yet — the live path needs Request Network and KeeperHub
credentials. `GET /readyz` names exactly which are absent.

---

## Contact

Built by [@JUICEWRLD998](https://github.com/JUICEWRLD998) for the KeeperHub Agent Economy hackathon.

## License

Apache-2.0 — matching the licence of the project we are integrating into.
