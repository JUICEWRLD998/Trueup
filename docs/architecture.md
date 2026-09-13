# Architecture

Why TrueUp is shaped the way it is. The short version: the boundary between the
probabilistic layer and the deterministic one is the whole product, so the code
respects that boundary even when a shortcut would be easier.

---

## The two sides

**Request Network is the source of truth for a debt.** It creates the invoice as a
payment request, watches for the transfer, and tells us when it settled. It is
excellent at the accepting side and it stops at settlement.

**KeeperHub is the only actor in the stack that can execute the consequences of a
settlement without re-interpreting it.** Nonce management for stuck transactions,
gas estimation, private routing against MEV, retries with exponential backoff,
non-custodial Turnkey wallets, and an audit trail of every run.

The gap between those two statements is the product.

---

## Data flow

```
payer ──settles USDC──► Request Network ──HMAC-signed webhook──► trueup-bridge
                                                                       │
                                              ┌────────────────────────┤
                                              │                        │
                                      verify signature          idempotency
                                      over RAW bytes            (delivery id)
                                              │                        │
                                              └───────────┬────────────┘
                                                          ▼
                                                  read authoritative
                                                  request state
                                                  (GET /v2/request/{id})
                                                          │
                                                          ▼
                                                  reconcile: score every
                                                  open invoice
                                                          │
                        ┌─────────────────────────────────┼──────────────────────┐
                        │                                 │                      │
                  ≥ 0.85 confident               0.55 – 0.85               < 0.55
                        │                                 │                      │
                   pay suppliers                    Sign & Hold            move nothing
                   (dry run first)                  for release            alert a human
                        │                                 │                      │
                        └─────────────────────────────────┴──────────────────────┘
                                                          │
                                                          ▼
                                                  KeeperHub Runs
                                                  run id · tx hash · audit row
```

---

## Why the bridge is not a webhook handler

Four reasons, in order of how much they matter.

### 1. Signing verification cannot run inside a workflow node

KeeperHub's Code node executes JavaScript in a `node:vm` sandbox in a separate
disposable process. Only `console`, `fetch` and `crypto.randomUUID` cross the
boundary. **`crypto.subtle` is unavailable**, so an HMAC-SHA256 cannot be computed
inside a workflow.

That is not a limitation to work around — it is the correct place to draw the line.
Signature verification is a security boundary. It belongs in dedicated code with
dedicated tests, not in a node inside a visual workflow whose graph a user can edit.

### 2. It keeps the workflows replayable

The theme sentence is "nothing is inferred at execution time." If a workflow had to
parse and interpret a raw third-party payload to decide what to do, it would be
inferring. Instead the bridge verifies and classifies, then hands the workflow an
already-decided instruction. The workflow's behaviour is a function of its input,
not of a parser's judgement.

### 3. Idempotency needs to be shared across the whole decision

A redelivered webhook must not pay a supplier twice. That guarantee has to hold
across the signature check, the classification and every payout in the batch — so it
cannot live inside any one of them. It lives in the ledger, which all three consult.

### 4. One place to change if the signing scheme changes

If Request Network moves to base64, adds a timestamp, or rotates the secret, one
service changes and no workflow does.

---

## The dry run, enforced in code

KeeperHub's dry run is the mechanism the whole submission rests on, so no caller is
allowed to skip it. `KeeperHubClient.transferSafely` is the only exported way to
move funds, and it:

1. calls `execute/transfer` with `"simulate": true` — a strict JSON boolean, never
   the string `"true"`, which the API rejects with a 400;
2. refuses to continue if the dry run reported `wouldRevert: true` (HTTP 400,
   `failureKind: "revert"`) or failed validation (`failureKind: "validation"`, e.g.
   `insufficient_balance`) — both of which mean nothing was signed;
3. refuses to continue if the response carries **no** `wouldRevert` field at all,
   because that means the dry run did not actually exercise the write. Proceeding on
   an unevaluated transaction would defeat the point of having a dry run;
4. only then repeats the identical request without `simulate`, with a derived
   idempotency key.

Step 3 is the subtle one. A simulation of a read-only action or an unmet condition
returns `success: true` with no `wouldRevert` and no hash — it looks successful while
having proved nothing. Treating that as a green light is exactly the mistake the
platform's design is meant to prevent.

---

## Reconciliation without guessing

The scoring function is **pure**: signals in, verdict and reasons out. No I/O, no
clock, no randomness. That makes every branch testable and every past decision
reproducible — which is what an audit trail actually requires.

Weights are declared in one place in `classify.ts` with a reason attached to each,
because they are the product's argument rather than an implementation detail:

| Signal | Weight | Why |
| --- | --- | --- |
| exact reference | decisive (1.0) | the counterparty named the invoice; nothing outranks that |
| amount equals outstanding | 0.45 | strong evidence, not conclusive |
| known payer | 0.35 | history is evidence, not proof |
| payer owes on exactly one invoice | 0.20 | removes the dangerous ambiguity |
| inside the expected window | 0.15 | a late payment is weaker evidence, scored as such |
| on-chain identity matches | 0.10 | optional layer, deliberately not decisive |

**Three refusals matter more than the weights:**

- A settlement scoring below 0.85 is **held** for human release, not paid.
- Two candidates scoring **identically** is treated as ambiguous and refused, even
  if both are high. This is an explicit test case.
- Below 0.55, nothing moves at all and a human is told.

Paying the wrong invoice is worse than paying late. The brake is a feature, and it
is the strongest available answer to "what if the agent gets it wrong?"

---

## The idempotency chain

Three independent layers stop a payment happening twice:

1. **Delivery id** — Request Network sends `x-request-network-delivery`, a ULID that
   is stable across its retries (3 retries, 4 attempts). Keyed in the ledger; a
   redelivery is acknowledged with 200 and does nothing.
2. **Idempotency key** — KeeperHub's `Idempotency-Key` header, derived per
   settlement/supplier pair and SHA-256 hashed following the documented canonical
   form. Replayed for 24 hours. The two 409 codes mean opposite things:
   `idempotency_in_progress` is retryable with the same key, `idempotency_conflict`
   is terminal and means rotate.
3. **Ledger state** — the settlement record is written before the response returns,
   so even a crash mid-request leaves the delivery marked as handled.

---

## Reading execution status

The documented status list (`pending`, `running`, `unconfirmed`, `completed`,
`failed`) is explicitly a lower bound, and the docs warn that funneling unknown
values into a failure branch "reports a failure for a run that is still settling."

So terminality is decided by the `X-Poll-Interval-Hint` response header: `0` means
terminal. Status strings are recorded for the audit trail and never used as the
control flow. `unconfirmed` is non-terminal — it is still settling.

---

## Storage

`data/ledger.json`, written atomically via temp file and rename, with writes
serialised inside the process. No native dependency, no migration, and a judge can
read the state directly.

This is a deliberate five-day-build choice and it is named as a limitation in
`limits.md`. The production swap is Postgres with a unique constraint on the
delivery id — the in-memory interface in `ledger.ts` is what that swap preserves.
