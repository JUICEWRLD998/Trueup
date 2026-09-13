# What still breaks, and what is not built

Written to be read by a judge, an auditor, or whoever picks this up next. It is
updated as the build progresses, and it errs toward naming problems rather than
hiding them. The organisers' submission form asks what still breaks or is
unfinished and notes that a candid answer has never hurt a submission — this file
is the honest source for that answer.

_Last updated: Phase 2 (2026-09-13)._

---

## Phase 2 status

Phase 1 built the foundations. Phase 2 closes the loop: a real settlement reaching
the bridge and becoming executed supplier payouts. State as of this update:

| Component | State | Evidence |
| --------- | ----- | -------- |
| Webhook signature verification | built | 14 tests, including forgery, tampering, re-serialisation, and base64 encoding |
| Reconciliation scoring | built | 19 tests, including the ambiguity refusal |
| ERC-7828 destination parsing | built | last-colon split so CAIP-2 colons survive |
| Ledger + idempotency store | built | atomic JSON writes |
| KeeperHub API client | **built and exercised live** | 17 tests; a real transfer executed on Sepolia |
| Request Network API client | **built, payment creation verified live** | `POST /v2/secure-payments` returned 201 and `GET /v2/request/{id}` read back `reference: INV-4471` |
| HTTP bridge | built, smoke-tested | forged signature rejected 401; replayed delivery acknowledged, not re-executed |
| **Live transaction through KeeperHub** | **done** | hash in the README, receipt `success`, verified on-chain |
| Receipt bundle | **built and tested, not yet wired to a run** | 23 tests; `receipt.ts` projects allowlisted fields and refuses credential-shaped keys |
| Whole-loop dry run | **built, run live** | `scripts/demo-rehearsal.ts` — matched INV-4471 at 0.95, 3 payouts simulated clean, ledger unchanged |
| Request Network webhook registered | **not done** | `RN_WEBHOOK_SECRET` is empty; registration needs a logged-in dashboard session (see below) |
| KeeperHub workflows W1–W4 | **not built** | — |
| `request-network` plugin | **not built** | — |
| Agent layer over MCP | **not built** | — |

**Tests: 143 across 10 files.** `pnpm type-check` is clean.

What has moved: 1.00 USDC on Sepolia through KeeperHub in Phase 1, and three
supplier payouts simulated clean through KeeperHub in Phase 2 without broadcasting.
**No mainnet value has moved, and no real settlement has yet reached the bridge** —
the payment destination and webhook are still to be configured, so the bridge has
never received a signed delivery from Request Network.


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

### Phase 2: four things the live services told us that the docs did not

All four were found by running against the real APIs. Two were bugs in our code, one
is a constraint on the demo's numbers, and one is a limitation of the platform's own
auth surface. The first three are fixed; the fourth has to be worked around.

**1. `auth.request.network` is cookie-only, so a webhook cannot be registered from
code.** Every route in `docs/reference/request-network-auth-openapi.json` — all 24,
including `POST /v1/webhook` — carries a `Cookie` parameter for a `session_token`
session, and the spec declares **no** security schemes. A live call carrying
`x-client-id` returns `401 Unauthorized` (verified 2026-09-13). Our client used to
send exactly that header, so `registerWebhook` could never have succeeded.

**Workaround:** register the webhook once from the dashboard. `registerWebhook` now
takes an optional `cookieHeader` and, with no cookie, fails locally with a message
naming the real cause instead of returning a misleading 401. There is a test for both
paths. Note the corollary: `implementation.md` §3.9's "or programmatically via POST
https://auth.request.network/v1/client-ids" is wrong for the same reason.

**A useful surprise:** the secret is **not** shown once. `GET /v1/webhook` lists every
webhook with its `secret` for an authenticated session, so a lost signing secret is
recoverable rather than fatal. The docs' "shown once" wording is about the create
response, not the resource.

**2. The payment destination resolves to mainnet USDC, and its payee is not the
KeeperHub org wallet.** Creating a payment with the Client ID alone succeeded
(`201`, `requestIds`), which proves the Client ID is bound to a destination and that
`RN_DESTINATION_ID` can legitimately be omitted. But reading the request back shows
`"network": "mainnet"`, `"paymentCurrency": "USDC"`, payee
`0x866df327df560c24d2ba0f85afd95cbff43cf06c` — while `KH_ORG_WALLET` is
`0x495b365a62908ea47bcfda84d84f38f1c370e816`.

This matters more than it looks. The design has KeeperHub's Transfer trigger watching
the org wallet for the inbound settlement, so a destination pointing somewhere else
means W1 never fires and the loop cannot close. `implementation.md` §4.2 chose
Sepolia with FAU precisely to keep the demo free; the existing destination does the
opposite. **Unresolved** — it needs a Sepolia destination whose payout wallet is the
KeeperHub org wallet, then a new Client ID bound to it.

**3. The demo's original figures could not have been paid on any write path.** The
seed data shipped a 4,200 USDC invoice paying three suppliers 1,200 / 860 / 2,140,
against a platform ceiling of **100 USD per single stablecoin outflow**
(`lib/execute/spend-cap-defaults.ts:73`). Live proof, from a `simulate: true` dry run:

```
HTTP 400  wouldRevert: true  failureKind: "validation"
"Stablecoin transfer of 1200.00 USDC exceeds the 100.00 USD per-transaction limit"
```

Every payout the demo was written around would have been refused before a signature
was produced, and the money shot would have shown three blocked payouts and no value
moved. Nothing in the build failed while that was true. **Fixed** by scaling the
figures by 1/100 — invoice 18.00, suppliers 6.00 / 4.30 / 7.70, which sum to the
invoice and fit the 19 USDC the Sepolia wallet actually holds. `tests/fixtures.test.ts`
now enforces those invariants, including the sum, so a re-scale fails a test instead
of a recording.

Worth knowing for anyone reusing this: batch payout does **not** escape the limit.
`stablecoin-cap.ts:418` bounds every call inside a batch at the same per-call figure —
"Summing alone would let one large recipient hide under a generous batch total" — and
adds a 2,000 USD per-transaction total on top (`spend-cap-defaults.ts:88`).

**4. A payout with no token address silently becomes a native transfer.** Omitting
`tokenAddress` from `POST /api/execute/transfer` is not an error; it sends native
value of the same nominal amount, under a 0.02 ETH/day cap instead of the stablecoin
one. Our payout path built exactly that body, so every supplier payout would have been
a native transfer — either refused for exceeding the native cap, or worse, sent.
**Fixed** in two places: the suppliers now carry a token address and a chain id, and
`settle.ts` refuses any payout without one rather than letting a token payout become a
native one.

### A rehearsal must not write anything, and one did

`settle()` marked the invoice settled *before* checking whether it was a rehearsal, so
a dry run left the invoice looking paid **in the running process**. The next real
settlement would then find no open invoice, classify `unmatched`, and pay nobody — on
camera, with the money untouched and no error anywhere.

Found by `tests/settle.test.ts` ("leaves the ledger exactly as it found it"), fixed by
moving the ledger write below the rehearsal return. `scripts/demo-rehearsal.ts` now
prints a `ledger INV-4471: 0.00/open -> 0.00/open (unchanged)` line on every run, and
exits non-zero if that is ever false.

### The Transfer trigger is Tempo-only, and W1 was designed around it

Found by reading the platform's own source rather than by running it, which is why it
is not in the list above.

`implementation.md` §3.2 called the **Transfer trigger with memo filter** "the single
most important node for this project", and §5.1 built W1 `inbound-reconcile` on it:
a Transfer trigger watching the organisation wallet, then a Condition on whether the
payment carried a reference. That node is **Tempo-only**:

- `lib/mcp/workflow-schema-constants.ts`, `TRIGGERS.Transfer` — *"Fires when a TIP-20
  TransferWithMemo payment lands on a watched Tempo address"*, `network` required as
  `'Tempo chain ID ("4217" mainnet, "42431" Moderato)'`.
- `components/workflow/config/trigger-config.tsx:398` — `allowedChainIds: ["4217", "42431"]`.
- `lib/workflow/store.ts:20` — `TEMPO_PAYMENT = "Transfer", // keeperhub custom field`.

So it is not a generic EVM ERC-20 watcher, and it cannot watch a Sepolia address.

This is not a small correction. Request Network settles on Ethereum, Arbitrum,
Optimism, Base, Polygon, BNB Smart Chain, Tron and Sepolia — **Tempo is not one of
them**. The memo-filtered Transfer trigger therefore cannot be driven by an RN
settlement at all, and the plan's "attribute an inbound payment without a human"
mechanism has no RN-reachable form.

What is available instead, on Sepolia:

| Option | How it works | Cost |
| ------ | ------------ | ---- |
| **Event** trigger (`network`, `contractAddress`, `contractABI`, `eventName`) | Fires on every `Transfer` of the watched token contract; a Condition checks `args.to` against the org wallet; the unattributed branch asks the bridge to decide | No memo filter exists, and it fires on **every** transfer of that token, so the Condition and execution quota carry the filtering |
| RN's signed webhook, with KeeperHub owning the outbound leg | What the bridge already does — the classification and the payouts run through KeeperHub, the inbound anchor is RN's own signature | KeeperHub is not on the inbound *detection* path, which is one of the evidence items §2 claims for the rubric |

Neither is wrong; they trade the rubric's "both directions through KeeperHub" claim
against a noisy trigger with no reference to match on. What is not available is the
design as written.

**Decision (2026-09-13):** keep Request Network's signed webhook as the inbound
anchor, and keep KeeperHub on the outbound leg — the supplier payouts, the runs, the
ids and the audit trail. Record the D2 loop on that basis first, and revisit W1 once
the loop is known to work end to end rather than hoping it does. The cost is stated
plainly: §2 claims "inbound settlement detection **and** outbound atomic supplier
payout both run through KeeperHub" as rubric evidence, and under this decision
inbound *detection* is Request Network's webhook. The outbound half, and the
observability, are KeeperHub's. Say it that way to the judges rather than implying a
Transfer trigger that the platform cannot run on Sepolia.

Worth noting in its favour: ERC-20 transfers carry no memo field at all, so on Sepolia
*every* inbound payment is genuinely unattributed. That is the project's premise rather
than a problem, and it is the reason the attribution decision belongs in the bridge —
tested TypeScript — rather than in a workflow Condition.

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

9. **Testnet versus mainnet: the answer is that the *existing* destination is
   mainnet.** `implementation.md` §4.2 demonstrated that Sepolia secure payments work
   in Request Network's own examples, but the destination our Client ID is bound to
   resolves to `mainnet` with `paymentCurrency: USDC`. So the question is no longer
   "does the API support testnets" — it is "which destination do we point the demo
   at", and today's answer is a mainnet one. Resolving it means creating a Sepolia
   destination whose payout wallet is the KeeperHub org wallet. Until then, a payment
   created with this Client ID is a request for **real** USDC.

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
