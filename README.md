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

> **Transaction executed through KeeperHub:** _pending — first verified transaction is landing in
> Phase 1. This line will carry an explorer link before anything else is built._

This README will not claim a result it cannot show. Every hash below will be a real, resolvable
transaction on the chain named next to it.

| What | Chain | Hash | Run id |
| ---- | ----- | ---- | ------ |
| _first verified transfer_ | Sepolia `11155111` | _pending_ | _pending_ |

---

## Status

Phase 1 — foundations. See [`implementation.md`](./implementation.md) for the full plan,
and [`docs/limits.md`](./docs/limits.md) for an honest account of what is not built yet.

| Component | State |
| --------- | ----- |
| Request Network integration | not started |
| `trueup-bridge` (webhook verify + classify) | not started |
| KeeperHub `request-network` plugin | scoped, not started |
| KeeperHub workflows W1–W4 | not started |
| Agent workflow authoring (MCP) | not started |
| Receipt bundle | not started |

---

## Setup

```bash
# Node 24 and pnpm 10 are required
node --version   # v24.x
pnpm --version   # 10.x

pnpm install
cp .env.example .env   # then fill it in — never commit .env
```

Nothing runs end to end yet; this section is updated as each phase lands.

---

## Contact

Built by [@JUICEWRLD998](https://github.com/JUICEWRLD998) for the KeeperHub Agent Economy hackathon.

## License

Apache-2.0 — matching the licence of the project we are integrating into.
