# Demo runbook

Operational steps for recording the D2 loop. The **narrative** script lives in
`implementation.md` §8 — what to say and in what order. This file is the other half:
the exact commands, the numbers that will bite you, and what to do when something
misbehaves on camera.

Written after actually running every step below, including the failures.

---

## The two numbers that decide everything

| Limit | Value | Where it comes from |
| ----- | ----- | ------------------- |
| Per-transaction stablecoin outflow | **100 USD** | `lib/execute/spend-cap-defaults.ts:73`, enforced on every write path; a batch payout bounds each call inside it too (`stablecoin-cap.ts:418`) |
| Sepolia org wallet balance | **~19 USDC** | `pnpm exec tsx scripts/balance.ts` |

So the demo is scaled to fit: invoice **18.00**, suppliers **6.00 / 4.30 / 7.70**. The
three payouts sum to the invoice, each is far under the cap, and the total is under the
balance with roughly a dollar left over.

**That leftover is the problem.** One live run spends essentially the whole wallet, so
there is no second take. Top up Sepolia USDC from <https://faucet.circle.com> *before*
recording, and add a little Sepolia ETH for gas, or accept that the take is once-only.
`tests/fixtures.test.ts` fails if the fixtures drift back over the cap.

---

## Pre-flight (once)

1. **Request Network dashboard** — create a payee destination on **Sepolia
   (11155111)** whose payout wallet is the KeeperHub org wallet
   `0x495b365a62908ea47bcfda84d84f38f1c370e816`, in **FAU**
   (`0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C`). Then create a Client ID bound to
   it and register a webhook pointing at
   `<public-url>/webhooks/request-network`. Put all three values in `.env`.
   *This is the step that cannot be automated:* `auth.request.network` is
   cookie-authenticated, so `registerWebhook` cannot do it server-to-server.
2. `pnpm exec tsx scripts/balance.ts` — confirm gas **and** USDC, in that order.
3. Bridge up (`pnpm dev`) and reachable:
   `curl -s localhost:8787/readyz` must list **ok** for `RN_CLIENT_ID`,
   `RN_WEBHOOK_SECRET`, `KH_API_KEY`, `KH_ORG_WALLET`.
4. Public URL up, and RN can reach it. The tunnel is ephemeral — a `cloudflared`
   restart changes the hostname and the registered webhook URL goes stale, so
   re-register if you restart it.

> **Footgun:** Node's env-file loader does **not** override variables already present in
> the environment. If a shell has `RN_WEBHOOK_SECRET` exported as empty, that empty
> value beats `.env` and every delivery is rejected with `missing_secret` while
> `/readyz` still shows it missing. `unset RN_WEBHOOK_SECRET` or start the bridge from
> a fresh shell.

---

## Rehearse, always

```bash
cd bridge
pnpm exec tsx scripts/seed-demo.ts --reset      # INV-4471 must be open
BRIDGE_DRY_RUN=true pnpm dev                    # in one terminal
pnpm exec tsx scripts/demo-rehearsal.ts         # in another
```

Expect: verdict `matched`, confidence **0.95**, three payouts simulated with real gas
estimates, and `ledger INV-4471: 0.00/open -> 0.00/open (unchanged)`. The script exits
non-zero if any of that is false.

Then exercise the real HTTP path — signature verification, the schema, the reply codes:

```bash
pnpm exec tsx scripts/replay-webhook.ts
```

Expect `delivery 1` → 200 `matched`; `delivery 2` (identical bytes) → 200, re-evaluated;
`delivery 3` (tampered body, original signature) → **401 `digest_mismatch`**. It reads
`/readyz` first and **refuses to run against a live bridge** unless you pass `--live`,
so it cannot spend by accident.

`seed-demo.ts --reset` matters more than it looks: seeding is deliberately
non-destructive, so an invoice left `settled` by an earlier run stays settled and the
money shot has nothing to settle.

---

## The take

1. `pnpm exec tsx scripts/seed-demo.ts --reset`
2. Restart the bridge with `BRIDGE_DRY_RUN` **unset**. The startup banner must say
   `off  BRIDGE_DRY_RUN (live: payouts will be signed and broadcast)`. If it says
   `DRY`, stop — you will record a rehearsal that looks like a payment.
3. Create the invoice in Request Network with a **deliberately wrong reference**:
   `pnpm exec tsx scripts/create-payment.ts 18.00 PO-9001`. A matching reference
   classifies as `attributed` (decisive) and skips the scoring path the demo is about.
4. Have the payer settle it. The webhook lands; the bridge verifies, matches at 0.95,
   and pays three suppliers through KeeperHub.
5. The beats worth screen time, in order: the reason list (explainable, not a black
   box), `simulate: true` → `wouldRevert: false`, then the identical call with a fresh
   idempotency key, then the hashes, then the run in KeeperHub's Runs panel.

### The staged failures

- **Replay** — `pnpm exec tsx scripts/replay-webhook.ts --live` after the settlement
  that just happened, reusing its body. The second delivery returns `200`,
  `"replayed": true`, `"acted": false`, and pays nobody. This only works on a run that
  persisted: a dry run writes nothing, so a redelivery is re-evaluated rather than
  recognised.
- **Forged signature** — delivery 3 of the same script. `401 digest_mismatch`, and
  nothing moves.
- **The cap, live** — `pnpm exec tsx scripts/debug-simulate.ts 0xC0FFEE0000000000000000000000000000000001 1200.00`
  returns HTTP 400 `"…exceeds the 100.00 USD per-transaction limit"` with zero gas
  burned. This is the platform refusing to sign, not our code refusing to try.

---

## When it goes wrong on camera

| Symptom | Cause | Move |
| ------- | ----- | ---- |
| `401 missing_secret` on every delivery | `RN_WEBHOOK_SECRET` empty or shadowed by an exported empty value | `unset RN_WEBHOOK_SECRET`, restart from a fresh shell |
| `401 digest_mismatch` on a *real* delivery | the secret is wrong, or the body was re-serialised before signing | check the secret; our side verifies raw bytes |
| `401 malformed_signature` | header is base64, not hex | do not call it a forgery — it means RN changed its encoding |
| verdict `unmatched`, nothing paid | the invoice is `settled` from an earlier run | `seed-demo.ts --reset` |
| `error: … NATIVE transfer` on a payout | the supplier row lost its token address | check `fixtures/invoices.json` |
| `error: … exceeds the 100 USD` | a payout is over the per-call cap | scale the fixture; do not raise the cap mid-demo |
| `error: … transfer amount exceeds balance` | the org wallet is short | faucet, then accept one take |
| verdict `held` instead of `matched` | the payer is not a known address for the invoice | expected for an unknown payer — it is the brake, and a fine thing to show |

## What to say if asked how W1 is going

Plainly: the Transfer trigger with a memo filter is **Tempo-only**
(`workflow-schema-constants.ts`, `TRIGGERS.Transfer`; `trigger-config.tsx:398` pins
`allowedChainIds: ["4217","42431"]`), and Tempo is not a payment network Request
Network settles on. So inbound *detection* is RN's signed webhook, and KeeperHub owns
execution, runs, ids and the audit trail. See `docs/limits.md` for the full write-up and
the two options that remain open.
