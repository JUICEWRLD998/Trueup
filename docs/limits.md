# What still breaks, and what is not built

Written to be read by a judge, an auditor, or whoever picks this up next. It is
updated as the build progresses, and it errs toward naming problems rather than
hiding them. The organisers' submission form asks what still breaks or is
unfinished and notes that a candid answer has never hurt a submission — this file
is the honest source for that answer.

_Last updated: Phase 1 (2026-09-13)._

---

## Phase 1 status

Phase 1 is foundations: repository, ledger, Request Network client, KeeperHub
client, reconciliation engine, HTTP bridge, and tests. The following are **built
and tested**:

| Component | State | Evidence |
| --------- | ----- | -------- |
| Webhook signature verification | built | 14 tests, including forgery, tampering, re-serialisation, and base64 encoding |
| Reconciliation scoring | built | 19 tests, including the ambiguity refusal |
| ERC-7828 destination parsing | built | last-colon split so CAIP-2 colons survive |
| Ledger + idempotency store | built | atomic JSON writes |
| KeeperHub API client | **built and exercised live** | 17 tests; a real transfer executed on Sepolia |
| Request Network API client | built, Client ID verified live | `GET /v2/currencies` authenticates with our Client ID |
| HTTP bridge | built, smoke-tested | forged signature rejected 401; unverified delivery held, not paid |
| **Live transaction through KeeperHub** | **done** | hash in the README, receipt `success`, verified on-chain |
| KeeperHub workflows W1–W4 | **not built** | — |
| `request-network` plugin | **not built** | — |
| Agent layer over MCP | **not built** | — |
| Receipt bundle | **not built** | — |

Testnet value has moved through KeeperHub: 1.00 USDC on Sepolia, dry-run first,
receipt verified. **No mainnet value has moved, and the Request Network settlement
leg has not yet been exercised** — the payment destination and webhook are still to
be configured, so the bridge has not received a real settlement webhook.

---

## Design decisions that are constraints, not preferences

### Only single-call writes can be dry-run today

KeeperHub issue **#2427** documents that `simulate: true` runs `estimateGas` and
`call` against live state, so in a bundle like `approve` then `deposit`, the
second call reverts on allowance during simulation and only the first call of any
bundle can be dry-run. The organisers' theme sentence says "you dry run it without
touching the chain"; for a two-call bundle that is only half true today.

**Our response:** payout paths use single-call writes only. If an approval is
genuinely required, it runs as its own workflow with its own dry run. This is
stated here because it is a real limitation of the underlying platform that shapes
our design, not a limitation we introduced.

### `matchesRegex` cannot be used in Conditions

KeeperHub issue **#2407**: `matchesRegex` compiles to `new RegExp(...).test(...)`,
which both the Condition validator and the interpreter reject.

**Our response:** matching happens in TypeScript in this bridge, where it is
testable. Workflow Conditions use `contains`, `startsWith` and equality.

### HMAC verification cannot live in a Code node

KeeperHub's Code node sandbox exposes only `console`, `fetch` and
`crypto.randomUUID` across its boundary. `crypto.subtle` is unavailable.

**Our response:** the bridge verifies the signature outside the engine and passes
an already-verified, already-classified event into a workflow. See
`docs/architecture.md` for why this is a better architecture rather than a
workaround.

### Two API quirks found by running against the live service

Both were found by pointing the client at the real API rather than a fake. Neither
is in the documentation, and both would have cost hours on demo day.

**1. `tokenConfig` breaks token transfer simulation.** Sending
`tokenConfig: '{"decimals":6,"symbol":"fUSDC"}'` alongside `tokenAddress` makes the
dry run fail with:

```
"revertReason": "Simulating a token transfer requires a resolvable `tokenAddress` or `tokenConfig`"
```

The message is self-contradictory — it rejects the request while claiming both fields
are acceptable. With `tokenAddress` alone, the identical transfer simulates clean
(`success: true`, `wouldRevert: false`, `gasEstimate: 62796`). **We send
`tokenAddress` only.** Verified live on Sepolia, 2026-09-13.

**2. `KH_API_BASE` double-prefixed the path.** The documented base is
`https://app.keeperhub.com/api` and every client path also begins `/api/`, so a
naive concatenation produced `/api/api/execute/transfer` and a 404. The client now
normalises the base to a bare origin, so both the documented spelling and a bare
`https://app.keeperhub.com` work, and a misconfigured base cannot silently double
the prefix. Covered by three tests.

### Documented caps we do not try to exceed

- A single stablecoin transfer is capped at **100 USD** per transaction on every
  write path. Over the limit nothing is signed and the request returns a failed
  execution. `settle.ts` checks for this **before** attempting the transfer, so a
  judge never sees a doomed round trip.
- Native value is capped at **0.02 ETH/day** by default, with no uncapped state.
- The agentic wallet's client-side hook is **stateless** — it sees one payment at a
  time, so repeated sub-threshold payments all pass individually. Only the
  server-side daily cap bounds that. We do not rely on the hook for cumulative
  limits.

---

## Known limitations of this build

1. **Storage is a JSON file, not a database.** `data/ledger.json` is written
   atomically (temp file then rename) and writes are serialised within one process.
   It is not safe across multiple processes and offers no transactional guarantee
   beyond the rename. **Production swap:** Postgres with a unique constraint on the
   delivery id, which is exactly what the in-memory interface preserves. Chosen for
   a five-day build so a judge can read the state directly.

2. **Idempotency falls back to a body hash.** The delivery id header
   (`x-request-network-delivery`) is the correct key. If it is absent, we hash the
   raw body instead, which treats two byte-identical deliveries as one. That errs
   toward *not* paying twice, which is the safer direction, but it would also
   collapse two genuinely distinct identical-amount settlements.

3. **The reconciliation weights are a judgement call, not a fitted model.** They are
   declared in one place in `classify.ts` with reasons, so they can be argued with.
   They have not been calibrated against real settlement history because there is
   none yet.

4. **No timestamp or replay window on webhooks.** Request Network documents no
   timestamp header and no tolerance window; replay defence is retries plus the
   delivery id. Our idempotency store covers redelivery but cannot detect a
   genuinely old delivery replayed outside the retry window.

5. **Signature encoding is verified conservatively.** We require a 64-character hex
   digest. Request Network's published sample code has been inconsistent between
   passing a UTF-8 string and decoding hex, so a base64 digest is reported as
   `malformed_signature` with an explicit message rather than as a forgery. If the
   live service turns out to send base64, this needs a one-line change and a note —
   it will not silently mis-verify.

6. **`payerAddress` versus `payerEoaAddress`.** We accept either as a payer signal.
   For smart-account payers they differ, and we do not yet model the relationship
   between them. The webhook carries no payee field at all, so `requestId` is the
   only join key we rely on.

7. **Partial-payment handling is not wired yet.** The schema handles it and
   `isPartiallyPaid` exists, but the hold-and-release path (workflow W4) is not
   built, so a partial settlement currently records and does not stage a hold.

8. **No retry with backoff on the bridge's own outbound calls.** KeeperHub retries
   workflow steps, and its idempotency keys make our retries safe, but the bridge
   itself does not yet retry a failed `getRequest`. A transient read failure
   degrades matching to the weaker amount-and-payer signals rather than failing the
   delivery — which is the conservative behaviour, and is logged.

9. **Testnet versus mainnet is unresolved.** Request Network's docs demonstrate
   Sepolia secure payments, but no page explicitly states the flow works without
   real funds. Several Sepolia payment examples in their own documentation use FAU.
   This must be confirmed in the Discord or with their support before the demo's
   funding story is fixed. See `implementation.md` §4.2.

---

## Things we are deliberately not doing

- **No dashboard.** Terminal output and the receipt JSON are the evidence. A UI
  would consume the remaining time without moving a single rubric criterion.
- **No ERC-8004 identity lookup yet.** The scoring signal exists and is tested; the
  registry lookup is a Day 4 candidate and the first thing cut.
- **No multi-invoice matching beyond one settlement to one invoice.** Three seeded
  invoices prove the concept.
- **No Solana.** KeeperHub issue #2432 documents successful Solana SPL transfers
  being reconciled as terminally failed, so Solana is off the critical path.
