# TrueUp — Implementation Plan

**Hackathon:** KeeperHub — The Agent Economy Hackathon (DoraHacks)
**Track:** Main — Best Integration into a Live Project ($4,000 ranked: $2,000 / $1,200 / $800)
**Bounty:** Best KeeperHub Feature ($1,000, two winners at $500) — requires a **separate BUIDL**
**Hard deadline:** **Sep 18, 2026, 12:00 CEST (10:00 UTC)** — nothing accepted after
**Plan written:** 2026-09-13 · **Working time available:** 5 days

> Timezone note: Sep 18 12:00 CEST = Sep 18 10:00 UTC. Convert to local and then **subtract at least 3 hours** as your real submission target. Aim to submit Sep 17 evening local.

---

## 0. Status & how to use this file

This document is the single source of truth for the build. Read §2 before changing scope. Read §11 before you consider anything finished.

| Day | Date | Goal | Exit criterion |
|---|---|---|---|
| D1 | Sep 13 | First real transaction through KeeperHub + RN API access confirmed | A tx hash on Sepolia in the README |
| D2 | Sep 14 | Integration closed loop: RN webhook → KeeperHub execution | Money shot recorded once, unstaged |
| D3 | Sep 15 | Agent layer (MCP) + failure paths | Replay + partial payment handled |
| D4 | Sep 16 | Receipt bundle + polish + bounty PR opened | PR raised, video outlined |
| D5 | Sep 17 | Video, README, candid limits, submit | **Two** BUIDLs submitted |

Falling behind is expected and planned for. Cut in the order given in §14, never by cutting the two things the submission _requires_ (working demo video + a transaction executed through KeeperHub).

---

## 1. What we're building

**Name:** TrueUp
**One-liner:** The execution layer that turns a live invoice into a settled, reconciled on-chain payment — the agent authors it, KeeperHub executes it, and the live project's own signed webhook is the receipt.

The integration is with **Request Network** (`request.network`) — a live, non-custodial stablecoin payments protocol founded 2017, community-funded, 0.9% per transaction capped at $500, accepting payments across 8 networks. It is a real deployed product with a documented REST API, integrating merchants, and a public dashboard. It satisfies the brief's definition of "live" without argument.

**The loop we close:**

```
Invoice exists (RN)  →  payer sends stablecoin (RN settles)
                     →  RN fires signed webhook
                     →  reference ok?  →  reconcile + record      (KeeperHub)
                     →  reference missing/wrong?  →  match, then act (KeeperHub)
                     →  supplier payouts execute atomically        (KeeperHub, Tempo)
                     →  every run gets an ID, a hash, an audit row (KeeperHub Runs)
```

Request Network solves the **accepting** side well. It stops at settlement. It does not execute the *consequences* of settlement deterministically — and that gap is exactly where KeeperHub's thesis becomes load-bearing rather than decorative.

---

## 2. Why this wins (rubric mapping)

Map every hour of work to the five main-track criteria. If a task doesn't move one of these, it isn't in scope.

| Criterion | How TrueUp scores it | Evidence we must produce |
|---|---|---|
| **Integration depth** — real named project, specific to it | Not a wrapper. Touches RN's actual mechanics: ERC-7828 composite `destinationId`, payment references that travel with the transfer, HMAC-SHA256 webhook signatures, partial-payment semantics, batch payouts | The payment payloads in our code match RN's documented schema, field for field |
| **Execution through KeeperHub** — did value move, can we see it | Inbound settlement detection **and** outbound atomic supplier payout both run through KeeperHub | Tx hashes + `run` IDs in the README, plus the mandatory submission link |
| **Reliability & observability** — survives non-happy paths | Duplicate webhook replay, mis-referenced payment, partial payment, preflight failure, stuck-tx recovery all handled explicitly | A staged live failure in the demo video; idempotency keys visible in logs |
| **Usefulness & originality** — real problem for real users | "We get paid in stablecoins and cannot close our books" is a genuine, felt, unglamorous pain | The unattributed→matched→settled→paid narrative |
| **Developer experience & code quality** — another team could pick it up | Typed, tested, documented; a reusable `request-network` plugin that fills a real gap in KeeperHub's catalog | `pnpm type-check && pnpm test` clean; README a newcomer can follow |

**Why the field looks like this.** Every organizer-named example is already claimed:

| Live project | Existing submission / signal | Status |
|---|---|---|
| Wayfinder | `mystiquemide/nyrvok` (pushed Sep 11, TypeScript) | active — claims circuit breaker + ERC-8004 reputation |
| Almanak | `Cubiczan/almanak-keeperhub-chp` | submitted |
| Lucid / Daydreams | `ahmardchain/lucid-keeperhub-settlement` + issues #2329, #2395 | most advanced — 13 recorded settlements, filed 2 feature issues |
| ElizaOS, OpenClaw, Relay.link, Euler, ether.fi, cbETH, Renzo | filed as bounty issues by other builders | bounty field crowded |

Wayfinder, Almanak and Lucid are contested. Request Network is **untouched**. Do not get drawn into an execution-firewall build — that is the median reading of the brief and at least one team is already further along it than you can get in five days.

---

## 3. Verified facts

Everything in this section was checked against live sources during planning on 2026-09-13. Anything not verified is in §4, not here. Do not let unverified assumptions leak into code without checking first.

### 3.1 KeeperHub — surfaces

- **MCP server:** `https://app.keeperhub.com/mcp` (HTTP transport). Claude Code: `claude mcp add --transport http --scope user keeperhub https://app.keeperhub.com/mcp`, then `/mcp` for OAuth. Headless/CI uses a Bearer `kh_` key via `--header`. Local stdio (`kh serve --mcp`) is deprecated.
- **Per-workflow MCP server:** `/mcp/w/<slug>` registers exactly one tool — the workflow — with its real `inputSchema`. Cross-org calls allowed for *listed* workflows; unlisted → 404, paid → HTTP 402 with an x402 challenge.
- **REST API:** base `https://app.keeperhub.com/api`, OpenAPI at `/api/openapi`. Noted areas: Authentication, Headless Onboarding, Workflows, Executions, Direct Execution, Analytics, Integrations, Projects, Tags, Chains, User, Organizations, API Keys, Errors.
- **CLI `kh`:** `kh auth`, `kh config`, `kh chain list`, `kh doctor`, `kh execute contract-call|transfer|status`, `kh plugin`, `kh project`, `kh read`, `kh run cancel|logs|status`, `kh tag`, `kh template deploy|list`, `kh wallet ...`, `kh workflow create|delete|disable|enable|get|go-live|list|run|update`, `kh action`, `kh billing`, `kh org`, `kh completion`.
- **Key types are not interchangeable:** `kh_` = organization key (`/api/keys`, avatar → API Keys → Organisation) for REST/MCP/plugin; `wfb_` = user key at `/api/api-keys`, webhook-trigger auth only. Validate with `GET /api/keys` (200 valid, 401 not). `GET /api/chains` is public.

### 3.2 KeeperHub — workflow model

- **Triggers:** Manual, Schedule (interval/cron/timezone), Webhook (generated URL, optional auth headers), Event (contract address + signature), Block (network + interval; `1` = every block), **Transfer** (payment arriving at a watched address, with optional memo filter — exact `0x` + 64-hex match, or a plaintext prefix).

  > The **Transfer trigger with memo filter** is the single most important node for this project. It is what lets KeeperHub attribute an inbound payment without a human.
- **Web3 actions:** reads `web3/check-balance`, `web3/check-token-balance`, `web3/get-spl-token-balance`, `web3/read-contract` (no wallet). Writes `web3/transfer-funds`, `web3/transfer-token`, `web3/write-contract` (wallet required).
- **`network` takes chain IDs as strings** — `"1"`, `"11155111"`, `"8453"`, `"42161"`, `"137"`. `tokenConfig` is a token-select value, not a bare address. There is no per-action `walletId`. For contract actions, `abiFunction` is the plain name for unique functions, full signature for overloaded ones.
- **System actions:** HTTP request, conditional branching, For Each, Collect, template rendering. **Math:** sum/count/average/median/min/max/product.
- **Condition nodes** branch on `sourceHandle` `"true"`/`"false"`; For Each uses `"loop"`/`"done"`. Everything else omits `sourceHandle`.
- **Templating:** `{{@nodeId:Label.field}}`. Supported operators: `==`/`===`, relational, `contains`, `startsWith`, `endsWith`, `matchesRegex`, emptiness and existence checks.
- **Failure handling:** failed steps retry with configurable behaviour; failed runs log full error context in the Runs panel.

### 3.3 KeeperHub — dry run, then execute (the core mechanic)

- All three direct-execution tools take an optional `simulate` flag. **It must be the JSON boolean `true`, not the string `"true"`.**
- Simulation estimates gas and catches reverts **without signing or broadcasting**. It **never returns a transaction hash.**
- Correct sequence: `simulate: true` → check `success: true` **and** `wouldRevert: false` → repeat the identical call **without** `simulate`, with a **unique `idempotency_key`** → poll `get_direct_execution_status` with bounded backoff until `completed` or `failed`.
- **Simulation is EVM-only.** Solana chain IDs `101` will `failed` and `103` reject before any API call (`simulation_unsupported_chain`, a hard stop). `execute_transfer` still broadcasts on Solana.
- Dry-run failure classification: string `code` + `wouldRevert: true` = attributed preflight failure (e.g. `insufficient_balance`, still `failureKind: "validation"`); `failureKind: "revert"` + `wouldRevert: true` = genuine revert. Augmented messages begin `Simulation preflight failed` / `Simulation reverted` and name the stage, reason, sender and low-level call target — **for an ERC-20 transfer that target is the token contract, not the recipient.**
- MCP errors use `isError: true` with a text content block. REST codes: 401, 404, 400 (bad params or dry-run failure), 500.
- `validate_workflow` checks structural and Web3 correctness before create/execute. `prepare_test_pin_data` returns the JSON Schema each node expects as pin data.
- Cold start: `create_workflow` / `ai_generate_workflow` may return `code: upstream_cold_start` on 502/503/504 with `retryAfterSeconds` — retry with the **same** `idempotency_key`. DNS/connection errors are explicitly *not* cold-start signals. Most calls have a 55s fetch timeout; execute-family tools disable that cap so on-chain work isn't cut off.

### 3.4 KeeperHub — Code plugin (sandbox)

Relevant because it is where matching logic *could* live, and because its limits are real.

- Runs user JavaScript in a `node:vm` sandbox in a **separate disposable process**; top-level `return` and `await` work. Templates are resolved by the engine *before* execution and JSON-stringified, so code receives actual values inline.
- Inputs: `code` (required), `timeout` (1–120s, default 60). Outputs: `success`, `result`, `logs`, `error`, `line`.
- **Only `console`, `fetch`, `crypto.randomUUID` cross the boundary.** No `require`, `import`, `process`, `fs`, `setTimeout`, `setInterval`, no `Request`/`Response` constructors, no Node built-ins.
- **`crypto.subtle` is unavailable.**

  > **Consequence: you cannot verify RN's HMAC-SHA256 webhook signature inside a Code node.** This is why we put a small verifier service in front (see §5). Do not discover this on D3.
- `fetch` has an `AbortController` deadline matching the timeout plus a wall-clock `Promise.race`. Body is read in full before resolving (no streaming); >96 MB fails.
- **SSRF protection:** block checks run **on the resolved IP, not the hostname** — DNS is consulted at request time. Loopback, link-local (including cloud metadata), RFC 1918, CGNAT, IPv6 unique-local, multicast, reserved/documentation, benchmarking and broadcast ranges are denied, along with non-http(s) schemes and NAT64-wrapped equivalents. Blocks surface as `sandbox fetch: SSRF blocked (hostname -> resolved_ip)`.

### 3.5 KeeperHub — Tempo (the atomic payout rail)

- Tempo is a stablecoin-native EVM chain: payments carry a **protocol-level 32-byte memo**, fees are paid in stablecoins (not a native gas token), fast settlement.
- Mainnet chain ID `4217` (explorer `explore.mainnet.tempo.xyz`); testnet `42431` (explorer `explore.testnet.tempo.xyz`).
- **Actions:** Transfer with Memo (optional on-chain expiry), **Batch Payout** (many recipients in one atomic transaction, each with its own memo), **Sign & Hold Payment** (sign now, broadcast later — manually or scheduled, bounded by a deadline), Swap Stablecoins (native DEX).
- **Transfer trigger** fires on an incoming stablecoin payment to a watched address, with optional memo filter.
- Accounts are EOAs; **Safe smart accounts are not available on Tempo.**
- Capability contrast vs other EVM chains: native/indexed memos vs an app-level convention; native atomic batch payout vs multicall; deferred payments bounded by an on-chain settlement deadline vs account abstraction plus extra infrastructure.

### 3.6 KeeperHub — agentic wallet & payments

- Skill + npm package `@keeperhub/wallet`; custody is server-side in a Turnkey **sub-organisation**.
- Paid workflows settle via **x402 on Base USDC** (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) or **MPP on Tempo USDC.e** (`0x20c000000000000000000000b9537d11c60e8b50`). Each call carries a USDC payment.
- **x402 mechanics:** the wallet signs an EIP-3009 `TransferWithAuthorization` letting a facilitator move USDC; the facilitator submits the tx and pays gas. MPP is the equivalent on Tempo (facilitator settles the USDC.e transfer and covers Tempo fees). Either way the wallet debits only the USDC amount — no gas out of pocket. Typical workflows cost under $0.05 per call.
- **Spending tiers** via a `PreToolUse` hook reading `~/.keeperhub/safety.json`: **auto** ≤ `auto_approve_max_usd`, **ask** between auto and block, **block** above `block_threshold_usd` or for a contract absent from `allowlisted_contracts`. Defaults 5 / 50 / 100 USD.
  - Known trap: `ask_threshold_usd` is parsed and range-checked but **not consulted** when deciding. Editing `auto_approve_max_usd` above 50, or `block_threshold_usd` below 50, without also writing `ask_threshold_usd` **throws at hook construction** — and because the installer registers it with `matcher: "*"`, that **blocks the whole session**, not just wallet calls.
- **Server-side Turnkey policies** (not user-configurable): contract allowlist (Base USDC + Tempo USDC.e only), per-transfer cap 100 USDC, approval cap 100 USDC, chain allowlist (Base 8453, Tempo 4217/42431), **daily spend cap 200 USDC per UTC day** → overflow returns `429 DAILY_CAP_EXCEEDED` with `Retry-After` to next UTC midnight.
- Recipient pinning: `/sign` requires a `workflowSlug` and derives the expected recipient from the workflow's organisation wallet, rejecting mismatches with `403 PAYTO_MISMATCH`. The doc flags this as application code checking records, not an enclave policy.
- The hook is **stateless** — it sees one payment at a time, so repeated sub-threshold payments all pass individually; only the server-side daily cap bounds that.

### 3.7 KeeperHub — marketplace (our plugin's future home)

- Listing is set from the editor: **slug** (permanent — cannot be changed after publish), **price** (USDC per call; most utility workflows sit $0.001–$0.10), **input schema**, **output schema**.
- Three pre-flight checks: the workflow completes with the fields you expose; **caller-supplied values flow through the Manual trigger** (hardcoded values are baked in at build time and ignore the caller); the workflow is **active** (inactive ones reject calls).
- Revenue split **30% platform / 70% creator**, paid as USDC on Base or USDC.e on Tempo, no auto-bridging.
- Both protocols are offered on every paid call; the **caller's** wallet determines which is used.
- Quota relief: a paid call at **≥ $0.05 USDC** does not consume the org's monthly execution limit — gated on actual payment receipt, hard cutoff ($0.049 gives nothing). Editor runs, schedules, block/event/webhook triggers and direct API calls still count.
- Discovery: listed workflows are registered under KeeperHub's entry on the **x402, MPP and ERC-8004 registries**; agents browse those, find KeeperHub as provider, see the workflow as a callable resource. Meta-tools `search_workflows` and `call_workflow`; callable URL `https://app.keeperhub.com/api/mcp/workflows/<slug>/call`. Public registry pages: x402scan.com, mppscan.com, 8004scan.io.
- Failed executions return an error and the caller **is not charged**.

### 3.8 KeeperHub — repo, stack, contribution

- **Apache-2.0.** `KeeperHub/keeperhub`. Stack: Next.js 16 App Router, React 19, TypeScript 5, shadcn/ui + Radix + Tailwind 4, PostgreSQL via Drizzle, **Workflow DevKit** as the engine, Better Auth, Vercel AI SDK, Turnkey wallets, Node 24, pnpm, Biome.
- Long-running services: App, Schedule Dispatcher, Block Dispatcher, Event Tracker, Executor, WASM sandbox, Metrics Collector. Ephemeral: short-lived workflow-runner K8s Job, Reaper CronJob, daily Execution Digest CronJob. All trigger services publish to one shared SQS queue consumed by the executor; `EXECUTION_MODE` = `isolated` | `complex` | `process`.
- Top-level dirs include `plugins/`, `protocols/`, `keeperhub-events/`, `keeperhub-executor/`, `keeperhub-scheduler/`, `keeperhub-metrics-collector/`, `sandbox/`, `specs/`, `tests/`. Also `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, `ISSUES.md`.
- **Plugin scaffolding: `pnpm create-plugin` then `pnpm discover-plugins`.** Compare an existing plugin (e.g. `webhook`) against scaffold output — that is the fastest way to learn the contract. *(Reported from the README; confirm against `CONTRIBUTING.md` before relying on it.)*
- Quality gates: `pnpm test` (Vitest), `pnpm test:e2e` (Playwright), `pnpm type-check`, `pnpm check`, `pnpm fix`. Prometheus metrics at `/api/metrics`.
- **Existing plugins (note the gap):** Aave V3/V4, Aerodrome, Ajna, Compound, CoW Swap, Curve, Ethena, Frax Ether V2, Lido, Morpho, Pendle, Rocket Pool, Sky, Spark, Superfluid, Uniswap, Yearn V3, Hyperliquid, Robinhood, Web3, Tempo, Safe, Blockscout, LayerZero, Chainlink, Chronicle, Wrapped, Code, Math, Data, Discord, Slack, Telegram, SendGrid, Webhook.

  > **There is no invoicing, receivable or governance plugin.** `request-network` fills a genuinely empty category rather than adding an 18th DeFi protocol. This is a real argument for both rubrics — say it out loud to the judges.

### 3.9 Request Network — the live side

- **Positioning:** non-custodial, open-source payments protocol for accepting and sending stablecoins. Community-owned foundation, founded **2017**, funded by its community rather than VCs. Claims coverage of 95% of stablecoin supply. **0.9% per transaction, capped at $500 per payment**, no setup or monthly fees. Explicitly not a PSP: "It does not hold funds, process money on your behalf, or act as an intermediary."
- **Live signals:** working dashboard login, published API docs, REQ token page, dated 2026 announcements (Safe smart-account integration for batch payouts; removal of the TRON gas requirement for USDT), press coverage, named integrations (Allora, TAQ, Kryptos, 0finance, Blockscout). *No user/volume numbers are published — evidence is integration logos and dated posts, not metrics. Do not overclaim "millions of merchants" to the judges.*
- **Networks:** Ethereum `1`, Arbitrum One `42161`, Optimism `10`, Base `8453`, Polygon `137`, BNB Smart Chain `56`, **Tron `728126428`** (TRC-20, `T...` addresses). **Testnet: Sepolia `11155111`** with FAU, USDC, USDT.
- **Feature matrix:** single incoming ✓, single outgoing payout ✓, **batch incoming/outgoing — EVM only, Tron rejected with HTTP 400** ✓/✗, conversion payments (fiat-denominated) ✓, cross-chain swap-to-pay (via **Li.Fi**) ✓, recurring payments ✓.
- **Payment types:** Native & ERC20, Conversion (fiat-denominated, paid in crypto), Crosschain, Batch, Recurring, Partial.
- **Credentials — only two, plus one non-secret identifier:**
  - `RN_CLIENT_ID` → sent as `x-client-id` header. Created in the dashboard **after a payment destination exists**, or programmatically via `POST https://auth.request.network/v1/client-ids`.
  - `RN_WEBHOOK_SECRET` → returned **once** in the response body of `POST https://auth.request.network/v1/webhook`. Used server-side to compute **HMAC-SHA256 over the raw webhook body** and compare to the `x-request-network-signature` header. **Never client-side.**
  - **Destination ID** — not a credential, not a secret; copied from the dashboard or created via `POST /v1/payee-destination`. Required in the request body unless the Client ID is bound to a payee destination. *When in doubt, send it.*
- **Create a payment (happy path):**

  ```http
  POST https://api.request.network/v2/secure-payments
  x-client-id: <RN_CLIENT_ID>
  Content-Type: application/json

  { "requests": [ { "destinationId": "<humanReadableInteropAddress>:<tokenAddress>", "amount": "10" } ] }
  ```

  → `201` with `requestIds: [...]`.
- **`destinationId` is a composite value:** the payee destination's `humanReadableInteropAddress` — an **ERC-7828** address, e.g. `0x6923...C7D7@eip155:1#1f969856` — joined with `:` to the **token's contract address**. Parse and construct this deliberately in code; it is the detail that proves the integration is specific rather than generic.
- **Webhook is the source of truth:** RN calls the merchant's server-to-server on completion; the merchant does not poll or watch the chain.
- **Reference travels with the money** → per-payment audit trail tied to the on-chain transfer. Combined with the webhook, this gives reconciliation a real anchor instead of a heuristic guess.
- **Amounts are enforced exactly** — over- and underpayment are rejected; a link locks once payment initiates and stays locked until settlement. *(So "wrong amount" is a payer-side blocked case, not an unattributed one — design the demo's partial-payment case as a genuinely partial request, not an overpayment.)*
- Wallet screening is optional per link (Hypernative: sanctions/AML) and runs **before** the recipient address is revealed. Useful as a compliance talking point.
- **API reference:** `https://api.request.network/open-api`. Docs index: `https://docs.request.network/llms.txt`.
- **Orchestrators:** RN documents an orchestrator model for platforms reselling payments to their own customers — a real post-hackathon expansion path for us.

### 3.10 Environment & testnet

| Network | chainId | USDC | Faucets |
|---|---|---|---|
| Ethereum Sepolia | `11155111` | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | ETH (Google Cloud), USDC (Circle) |
| Base Sepolia | `84532` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | ETH (Coinbase CDP portal), USDC (Circle) |

Mainnet USDC (for reference only): Ethereum `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, Arbitrum `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, Optimism `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85`, Polygon `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`.

Experimental (avoid for writes — broadcasts "can hang"): 0G `16661`, 0G Galileo testnet `16602`. Live list: `GET /api/chains`.

**Demo gotchas that will bite you:**
- Funding goes to the **organization wallet from `GET /api/user`**, not the address you signed in with.
- Add **native gas first**, then test USDC.
- Safe first transaction: `execute_transfer` with `simulate: true` → proceed only on `success: true` **and** `wouldRevert: false` → repeat without `simulate` with a **fresh** idempotency key.
- **Rate limits:** MCP 120/min per org; public MCP `tools/call` 10/min per IP; direct execution 60/min per API key. Overruns → `429` + `Retry-After`; back off with a cap and reuse idempotency keys on writes.

### 3.11 Open KeeperHub issues relevant to us

Read these before building. Two are direct obstacles; several are bounty candidates.

| # | Title | Why it matters to us |
|---|---|---|
| **2427** | simulate a sequence of calls against the state the earlier calls produce | **Obstacle.** Today only the *first* call of a bundle can be dry-run — `approve` then `deposit` reverts on allowance during simulation. **Do not put sequential-call simulation on the demo's critical path.** Design around single-call writes |
| **2432** | successful Solana SPL transfers are reconciled as terminally failed | Correctness. Avoid Solana in the demo |
| **2425** | 38 actions declared on L2 chains where the contract does not implement them | Avoid exotic L2 protocol actions |
| **2407** | `matchesRegex` compiles to `new RegExp(...).test(...)`, rejected by the Condition validator and interpreter | **Do not use `matchesRegex` in Conditions** — it is broken |
| **2408** | With `failOnError: false`, a reverted `web3/write-contract` finalises as `success` with no hash and no error | **Undermines the "auditable record" premise.** Strong bounty candidate |
| **2431** | `validate_workflow` passes a write-contract node whose signer routing is unset | Validate with a real execute, not just validate_workflow |
| **2395** | export bounded direct-execution receipt evidence as JSON | **Still open but labelled `accepted`** and carrying 4 comments — the strongest bounty candidate, because acceptance means a maintainer already wants the shape. Design confirmed: read-only `POST /api/execute/receipts/export` taking `{ executionIds }` (≤50, ordered) and returning versioned JSON of allowlisted receipt fields, excluding raw payloads and credentials. Agreed with our receipt bundle exactly |
| **2398** | Permission Cards for agent actions | Great narrative, large scope. Not us |
| **2329** | add a Lucid Agents connector | Already filed by a competitor |
| **2426** | accept raw calldata on `POST /api/execute/contract-call` | Useful escape hatch if our ABI path is blocked |
| **2359** | template tokens inside array config fields are never rendered but always reported | Avoid templating inside arrays |
| **2373** | a held idempotency key is never released once the reconciler proves definite failure | Affects retry design |
| **2380** | README docs section: 3 of 5 links 404 + a `keeperhub/` path prefix that does not exist | Trivial, low value as a bounty |
| ~~—~~ | ~~`discover-plugins` fails on Windows~~ | **RESOLVED — issue was stale.** `scripts/discover-plugins.ts:172` now uses `pathToFileURL(filePath).href` and exits 0 on Windows. See §4.1 for the two failures that *are* real |

---

## 4. Open questions — resolve on Day 1, before building

Each has a concrete test. Do not write feature code until §4.1 and §4.2 are answered.

### 4.1 Does KeeperHub's plugin toolchain work on Windows? — **RESOLVED: use WSL2**

Verified empirically against repo HEAD `f8c8f18` on Windows 11 (Node v24.14.1, pnpm 10.33.3).

**The issue I planned around is stale.** `discover-plugins` works — `scripts/discover-plugins.ts:172` now uses `pathToFileURL(filePath).href`. #2419 does not reproduce either. `pnpm install`, `pnpm discover-plugins`, `pnpm type-check` and `pnpm check:api-docs` all exit 0.

**Two failures are real, and one of them is in production code:**

| Command | Result | Root cause |
|---|---|---|
| `pnpm install` | works | — |
| `pnpm discover-plugins` | works | 39 integrations, 481 steps, 26 protocols |
| `pnpm type-check` | works | `tsgo --noEmit` |
| `pnpm check:api-docs` | works | zero backslashes written |
| `pnpm check` | **broken** | 2248 errors, **all** category `format`, zero lint errors |
| `pnpm test` | **broken** | `spawn ENAMETOOLONG` — 195 failures from one cause |

1. **`pnpm check` — CRLF.** Git for Windows ships `core.autocrlf=true` in the *system* gitconfig, and the repo has no `.gitattributes` and no Biome `lineEnding`, so Biome expects LF and every file is CRLF. Proven by copying one file with CRLF (format error) and with LF (clean); 40/40 sampled `.ts` files contain CR bytes.

2. **`pnpm test` — ENAMETOOLONG.** `sandbox-child-source.test.ts` (107/151) and `code-run-code.test.ts` (88/94) both do `spawn(process.execPath, ["-e", CHILD_SOURCE])` with ~98KB modules. The Windows argv ceiling measured at **32700 chars OK / 32768 ENAMETOOLONG**. **This affects production code, not just tests:** `plugins/code/steps/run-code.ts:157` and `sandbox/src/run-code.ts:141` use the same pattern.

3. **`pnpm create-plugin` scaffolds, then crashes.** `scripts/create-plugin.ts:274` calls `execFileSync("pnpm", ["discover-plugins"])`, and on Windows `pnpm` → ENOENT, `pnpm.cmd` → EINVAL; only `shell: true` works. Files are written *before* that line, so you get the plugin plus `Error: spawnSync pnpm ENOENT` and exit 1. **Workaround: run `pnpm discover-plugins` manually afterwards.** Also note the wizard is `@inquirer/prompts`, TTY-only — it must be run in a real terminal, not piped.

**Decision: WSL2.** It is already installed (Ubuntu, Default Version 2), and **CI is ubuntu-only — 79 jobs, zero Windows** — so the PR has to pass on Linux regardless. Native Windows is viable but needs three workarounds (`core.autocrlf false` *before* cloning; manual `discover-plugins`; accept 195 failures) and gives us nothing. Docker is the weakest option: `docker` and `make` are both absent from the Windows PATH.

**Contributor rules that shape the PR** (from `CONTRIBUTING.md`, `AGENTS.md` — read these before writing code):
- **PRs target `staging`, not `main`.** Required before a PR: `pnpm check` and `pnpm type-check`.
- Branch naming: `feat/KEEP-123-x` or `fix/issue-NNN-x`. Conventional commits.
- **`ISSUES.md` policy: a behaviour change needs an issue carrying `accepted` before the PR is written** — CI job `pr-issue-link` fails PRs without it. This is why #2395 is the bounty target: it already has `accepted`.
- Plugin rules: **no SDK dependencies (use `fetch`)**, no `dependencies` field in the plugin manifest, `"use step"` files must not export extra functions, and shared logic goes in `*-core.ts`.
- **No Windows or WSL guidance exists anywhere in the repo.** A short docs contribution here would be genuinely useful and is a cheap second bounty.

**Unresolved:** a full `pnpm test` tally (913 files at `fileParallelism: false` exceeded the run budget) and a live interactive `create-plugin` run (needs a real console). Both are unknown rather than assumed.


### 4.2 Does the Request Network API work on a testnet? — **Sepolia is supported; use FAU, not USDC**

Sepolia `11155111` is a supported payment-destination network, and Request Network's own `POST /v2/secure-payments` examples use `@eip155:11155111`. Nothing states a mainnet-only restriction for secure payments.

**But the Sepolia token to use is FAU, not USDC.** Probed the published token list (747 tokens) for `sepolia`:

| Currency id | Symbol | Decimals | Address |
|---|---|---|---|
| **`FAU-sepolia`** | FAU | 18 | `0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C` |
| `fUSDC-sepolia` | fUSDC | 6 | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| `fUSDT-sepolia` | fUSDT | 6 | `0xF046b3CA5ae2879c6bAcC4D42fAF363eE8379F78` |
| `ETH-sepolia-sepolia` | ETH-sepolia | 18 | `0xbb3546497a53cd710beb11b84c5240327f145bcb` |

Request Network's own testnet examples use **FAU** and **`ETH-sepolia-sepolia`** — never USDC-on-Sepolia. Sepolia USDC at `0x1c7D…7238` is Circle's test token; it reconciles to `fUSDC-sepolia` in the token list, not to `USDC-sepolia`. **`USDC-sepolia` does not exist in the list at all.**

**Consequence for the demo:** a payment destination must be registered in a token that exists in Request Network's list. If the Sepolia USDC we already hold cannot be registered as a destination, the options are, in order:
1. Register the destination on Sepolia in **FAU** and fund FAU (their docs' canonical testnet path).
2. Register on **Base** with `USDC-base` (real USDC, `0x8335…2913`) for a few dollars, and keep all KeeperHub value movement on Sepolia. Costs a small real amount.
3. Use **Base Sepolia** (`USDC-base-sepolia`, chain `84532`) and fund that instead — note we are currently unfunded there.

**Test:** create a destination in the dashboard and confirm the token it accepts, then confirm `GET /v2/currencies` returns it with the Client ID configured (the endpoint 401s for anonymous callers, so it must be probed authenticated).

**Fallback if no testnet destination is workable:** use RN for **invoice creation and the signed webhook** and run all KeeperHub **value movement on Sepolia**. The integration stays real; only the settlement leg is simulated. Say so plainly in the submission's "what still breaks" answer — the organisers note candour there "has never hurt a submission".

### 4.3 Remaining unknowns

- **Partial payments:** RN documents the payment type but not its field-level API. Read `/api-features/partial-payments` before designing the partial-payment demo case. If it is not usable, substitute the "wrong reference" case as the primary failure and use a duplicate webhook as the second.
- **RN proxy contracts:** the ERC-20 proxy addresses per chain were not published on the pages fetched. If we need to call RN contracts directly from a KeeperHub `web3/write-contract` node, read `/resources/supported-chains-and-currencies` and `/api-features/payment-types-overview` fully first. **Do not guess addresses.** Prefer the API path, which needs no contract addresses at all.
- **`pnpm create-plugin` output contract:** reported from the README, not verified. Compare against an existing plugin before writing ours.
- **How crowded the hackathon is:** the DoraHacks page is JS-rendered, so only the brief text was readable, not the entrant list. The competitive picture in §2 is GitHub-visible activity only. Ask in the KeeperHub Discord — it is also where office hours run (12:00 CEST, three sessions).
- **Registration:** confirm we are actually registered. Registration opened Aug 26.

---

## 5. Architecture

### 5.1 Component diagram

```
                        ┌──────────────────────────────────────┐
                        │  REQUEST NETWORK (live project)      │
                        │  · payment destination (ERC-7828)    │
                        │  · POST /v2/secure-payments          │
                        │  · payer settles on Base/Sepolia     │
                        └───────────────┬──────────────────────┘
                                        │ HMAC-SHA256 signed webhook
                                        │ (x-request-network-signature)
                                        ▼
                        ┌──────────────────────────────────────┐
                        │  trueup-bridge  (Node 24 / TS)       │
                        │  1. verify HMAC over RAW body        │
                        │  2. persist event  (idempotency)     │
                        │  3. classify:                        │
                        │       reference ok  → record         │
                        │       unattributed  → match          │
                        │       partial       → stage hold     │
                        │  4. call KeeperHub                   │
                        └───────────────┬──────────────────────┘
                                        │ REST direct execution / MCP
                                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │  KEEPERHUB  — the execution layer                         │
        │                                                           │
        │  W1  inbound-reconcile                                    │
        │      Transfer trigger (watched addr + memo filter)        │
        │        → Condition (reference present?)                   │
        │        → true : record + notify                           │
        │        → false: Code node match → payout                  │
        │                                                           │
        │  W2  supplier-payout                                      │
        │      simulate:true → wouldRevert:false → execute_transfer │
        │        → idempotency_key → poll status → receipt          │
        │                                                           │
        │  W3  atomic-batch-payout   (Tempo 4217/42431)             │
        │      Batch Payout, one memo per invoice                   │
        │                                                           │
        │  W4  hold-and-release      (low confidence path)          │
        │      Sign & Hold Payment → org-owner release              │
        │                                                           │
        │  Turnkey wallets · nonce mgmt · smart gas est. ·          │
        │  private routing vs MEV · retries w/ exponential backoff  │
        │  Keeper Runs: IDs, logs, status, audit trail              │
        └───────────────────────────────────────────────────────────┘
                                        │
                                        ▼
                        ┌──────────────────────────────────────┐
                        │  AGENT (Claude, over MCP)            │
                        │  ai_generate_workflow → validate →   │
                        │  review → dry run → execute_workflow │
                        └──────────────────────────────────────┘
                                        │
                                        ▼
                        ┌──────────────────────────────────────┐
                        │  receipt bundle (JSON)               │
                        │  run IDs + tx hashes + webhook body  │
                        │  + reconciliation verdict            │
                        └──────────────────────────────────────┘
```

### 5.2 Why the bridge service exists (and why that is a strength, not a compromise)

A Code node **cannot** verify RN's HMAC-SHA256 signature — `crypto.subtle` is unavailable and only `console`, `fetch` and `crypto.randomUUID` cross the sandbox boundary. So a small verifier service is the correct architecture, not a workaround:

- **Signature verification belongs outside the workflow engine.** KeeperHub's Webhook trigger supports a static auth header, not an HMAC over a raw body.
- The bridge keeps the KeeperHub workflows **deterministic and replayable** — it passes an already-verified, already-classified event into a workflow. Nothing is inferred at execution time, which is precisely the theme.
- If RN ever changes its signing scheme, one service changes, not five workflows.

**Say this in the pitch.** It demonstrates we understood the boundary between the probabilistic layer and the deterministic one — the exact distinction the brief is built on.

### 5.3 Reconciliation model

A payment is matched to an invoice by a **weighted, explainable score**, not a black box:

| Signal | Weight | Source |
|---|---|---|
| Payment reference matches invoice ID exactly | decisive | RN webhook / Transfer trigger memo filter |
| Payee accounted, payer known from prior settlements | high | local ledger |
| Amount equals invoice total, or a valid partial | high | RN payload |
| Payer's ERC-8004 identity matches the invoiced customer | medium | ERC-8004 registry (optional layer) |
| Paid within the invoice's expected window | medium | local ledger |
| Payer is a known counterparty to a *single* open invoice | medium | local ledger |

- Confidence **high** → record + trigger payout automatically.
- Confidence **low** → **Sign & Hold Payment**, org owner releases. *This is the responsible-money path and a judge-pleasing design decision.*
- No score above threshold → do not guess. Alert a human. **"We refuse to guess" is a feature, and it is the strongest possible answer to "what if the agent gets it wrong?"**

Every verdict stores the signals and weights that produced it, so the audit trail explains *why*, not just *what*.

---

## 6. Repository layout

Two repositories. The bridge is ours; the plugin lives in a KeeperHub fork.

```
trueup/                          # our repo — the main-track submission
├── README.md                    # ← judges read this FIRST. Tx hash near the top.
├── implementation.md            # this file
├── docs/
│   ├── architecture.md
│   ├── demo-script.md
│   ├── judge-qa.md
│   └── limits.md                # candid "what still breaks"
├── bridge/                      # RN webhook verifier + classifier
│   ├── src/
│   │   ├── server.ts            # HTTP entry
│   │   ├── verify.ts            # HMAC-SHA256 over RAW body
│   │   ├── classify.ts          # reconciliation scoring
│   │   ├── keeperhub.ts         # typed KeeperHub client
│   │   ├── ledger.ts            # invoices + settlements (SQLite is fine)
│   │   └── types.ts
│   └── tests/
│       ├── verify.test.ts       # forged signature, replayed body
│       └── classify.test.ts     # exact / partial / ambiguous / no-match
├── agent/
│   ├── prompts/                 # workflow-authoring prompts
│   └── mcp.md                   # MCP wiring + exact tool sequence
├── fixtures/
│   ├── invoices.json            # 3 seeded invoices
│   └── webhooks/                # captured RN payloads for offline replay
├── scripts/
│   ├── demo-seed.ts
│   └── demo-run.ts              # the scripted money shot
└── artifacts/
    └── receipt-bundle.json      # the deliverable proof

keeperhub/                       # fork — bounty submission
└── plugins/request-network/     # the PR
    ├── index.ts
    ├── actions/                 # create-payment-request, get-request-status,
    │                            # attach-reference, batch-payout
    ├── schema.ts
    └── *.test.ts
```

---

## 7. Phase plan

### Day 1 — Sep 13 — Foundations and the mandatory transaction

**Objective:** close §4.1 and §4.2, and get a real tx hash into the README. Nothing clever today.

- [ ] **Hour 1 — Repo + secrets.** Create `trueup`. `.env.example` listing `RN_CLIENT_ID`, `RN_WEBHOOK_SECRET`, `RN_DESTINATION_ID`, `KH_API_KEY`, `KH_ORG_WALLET`. `.gitignore` covering `.env`. **Do not commit secrets** — see §13.
- [ ] **Hour 2 — Resolve §4.1.** Clone `KeeperHub/keeperhub`, install, run the plugin toolchain. If Windows fails: switch that repo to **WSL2** and move on. Record the outcome in `docs/limits.md`.
- [ ] **Hour 3 — KeeperHub credentials.** Create an org API key (avatar → API Keys → Organisation) → `kh_...`. Verify with `GET /api/keys` (expect 200) and `GET /api/chains`. Read the **organization wallet** from `GET /api/user` — this is what gets funded, not the sign-in address.
- [ ] **Hour 4 — Fund it.** Sepolia ETH from Google Cloud faucet, then Sepolia USDC from Circle. **Gas first, USDC second.** Confirm with `kh wallet balance`.
- [ ] **Hour 5 — The mandatory transaction.** `execute_transfer` with `simulate: true` → confirm `success: true` **and** `wouldRevert: false` → repeat without `simulate` with a fresh `idempotency_key` → poll `get_direct_execution_status` to `completed`. Capture the explorer link.
- [ ] **Hour 6 — Resolve §4.2.** RN dashboard → create a payment destination → Client ID → register webhook (`POST /v1/webhook`, **save the secret immediately, it is shown once**) → create one payment and see whether Sepolia works.
- [ ] **Hour 7 — README.** Thesis in three sentences, architecture diagram from §5.1, **tx hash link**, "what's not built yet". Commit.
- [ ] **Hour 8 — Discord.** Register/confirm registration. Post in the builder channel introducing the integration and ask which surfaces they most want to see exercised. Office hours are the cheapest source of rubric intel you will get all week.

**D1 exit criterion:** repository public, README carries a link to a transaction executed through KeeperHub. The submission is now *valid* even if everything after today fails. That is the point of today.

### Day 2 — Sep 14 — Close the loop

**Objective:** RN webhook → KeeperHub execution, end to end, once.

- [ ] **Morning — `bridge/` skeleton.** HTTP server, raw-body capture, HMAC-SHA256 verify against `x-request-network-signature`, 401 on mismatch. **Test with a forged signature before testing the happy path.**
- [ ] **Morning — idempotency.** Persist every event by RN `requestId` + body hash. A replayed webhook returns 200 and does nothing. This is rubric points and a demo beat.
- [ ] **Midday — `keeperhub.ts`.** Typed client wrapping: `execute_transfer`, `execute_contract_call`, `get_direct_execution_status`, `execute_workflow`, `get_execution`. Enforce the simulate → verify → execute-with-idempotency-key sequence **in one function** so no caller can skip the dry run by accident.
- [ ] **Afternoon — W1 `inbound-reconcile`.** Transfer trigger on the org wallet with a memo filter → Condition on reference presence. Build via MCP (`list_action_schemas` → `create_workflow` → `validate_workflow` → `execute_workflow`) so the agent-authored workflow is genuinely agent-authored, not hand-built and described as such.
- [ ] **Afternoon — exposure.** Cloudflare tunnel or ngrok so RN can reach the bridge. Note the URL in `.env`.
- [ ] **Evening — the money shot, once.** Real payment, wrong reference, unattributed → matched → settled → paid. Record it raw. Do not polish yet; the first capture is for finding what breaks.

**D2 exit criterion:** one unedited screen recording of the full loop. The demo is now *known to work* rather than hoped to work.

### Day 3 — Sep 15 — Agent layer and failure paths

**Objective:** make it robust, then make it agentic.

- [ ] **Morning — W2 `supplier-payout`.** Single-call writes only. **Do not build a sequential `approve`→`transfer` bundle** — issue #2427 means only the first call dry-runs. If an approval is genuinely required, do it as its own workflow with its own dry run.
- [ ] **Morning — W3 `atomic-batch-payout` on Tempo.** Batch Payout, one 32-byte memo per invoice. Try testnet `42431` first; fall back to chain `4217` with a small real amount.
- [ ] **Midday — partial payment.** Read `/api-features/partial-payments` first (§4.3). Route low-confidence or partial settlements to **W4 `hold-and-release`** via Sign & Hold Payment. Stage this live in the demo.
- [ ] **Afternoon — failure paths, explicitly:**
  - forged webhook signature → rejected, 401, logged
  - replayed webhook → 200, no duplicate payout
  - `simulate: true` returns `wouldRevert: true` → **nothing is broadcast**, error surfaced
  - insufficient balance → preflight failure classified, no gas burned
  - `429` from rate limits → backoff honouring `Retry-After`, idempotency key reused
- [ ] **Afternoon — observability.** Pull `get_execution` for each run into the bundle: run ID, status, logs, tx hash, block.
- [ ] **Evening — agent demo.** Show a judge-facing prompt authoring a workflow over MCP, then the review step, then the dry run, then execution. **This is the narrative the brief is written around. Give it real screen time.**

### Day 4 — Sep 16 — Receipt bundle, bounty PR, polish

- [ ] **Morning — `artifacts/receipt-bundle.json`.** A bounded, versioned export: run IDs, tx hashes, block numbers, the verified webhook payload, the reconciliation verdict with its signals and weights. This is the "auditable record" made concrete.
- [ ] **Morning — bounty decision.** Pick a PR we genuinely hit during the build, so we have a reproduction. Candidates in §9. Open it against `KeeperHub/keeperhub` with tests and a clear description. Branch from current `main`.
- [ ] **Afternoon — harden the bridge.** Tests green: `verify` (forged, replayed, malformed) and `classify` (exact, partial, ambiguous, no-match). Error handling on every external call. Timeouts.
- [ ] **Afternoon — README for a stranger.** A developer who has never seen this repo should be able to run it. Record setup steps as you actually perform them on a clean clone.
- [ ] **Evening — draft the video script** from `docs/demo-script.md` (§8). Time it. Target 3–4 minutes.

### Day 5 — Sep 17 — Video, limits, submit

- [ ] **Morning — record.** One clean take of the money shot. Have the fallback clip from D2 ready in case the live run misbehaves on camera.
- [ ] **Morning — `docs/limits.md`.** Honest, specific, unhedged. The organizers wrote that a candid answer "has never hurt a submission." Name what is mocked, what is hardcoded, what a production version needs.
- [ ] **Midday — README final pass.** Tx link at the top. Architecture. Run instructions. Limits. Contact.
- [ ] **Afternoon — create BOTH BUIDLs.** Main track and bounty are separate BUIDLs — **a BUIDL can only be applied to one track.** This is easy to lose a prize to.
- [ ] **Afternoon — answer every form question**, including "what still breaks or is unfinished." Keep the answers concrete.
- [ ] **Evening — submit.** Then verify from a logged-out browser that the source link, video and transaction link all resolve. A dead link is an unjudgeable submission.

**Buffer:** submit Sep 17 evening local. The deadline is Sep 18 12:00 CEST — do not spend that morning on anything but verification.

---

## 8. The demo

### 8.1 Script (target 3–4 minutes)

**0:00–0:20 — The problem, stated plainly.**
Show a real spreadsheet or ledger with three open invoices. "We get paid in stablecoins. Money arrives with no reference, and someone spends Friday matching transfers to invoices by hand. You cannot close your books on a maybe."

**0:20–0:50 — The invoice and the compose step.**
Invoice #4471, $4,200, thirty days old. Show the agent authoring the reconciliation workflow over MCP. Then the **review** step. Narrate the theme back: "compose, review, dry run, execute — nothing inferred at execution time."

**0:50–1:40 — The money shot.**
Payer sends USDC on Base with a **wrong reference**. RN fires its signed webhook. The bridge verifies the signature (show the forged-signature test in a terminal tab — one line: rejected). The payment is **unattributed**. Rather than fail, the matcher scores it: amount matches, payer is a known counterparty to exactly one open invoice, within the expected window → **high confidence**. On screen: `unattributed → matched → settled`.

**1:40–2:30 — The dry run, then execution.**
`execute_transfer` with `simulate: true` → show predicted gas and `wouldRevert: false`. Then the identical call **without** `simulate` and a fresh idempotency key. Then the tx hash. **This is the beat that proves the theme.**

**2:30–3:10 — The atomic payout.**
Three suppliers paid in **one** Tempo transaction, each with its own 32-byte memo naming its invoice. One tx, three memos. Say: "one signature, three obligations discharged, each individually attributable."

**3:10–3:50 — Reliability, staged live.**
Replay the webhook. Nothing happens — 200, no second payout, one line of log. "This is the failure that costs a business money, and it is the case nobody demos."

**3:50–4:00 — The receipt and the close.**
`receipt-bundle.json` on screen: run IDs, tx hashes, verified webhook, verdict with weights. "Every run has an ID. Every transfer has a hash. The receipt is the counterparty's own signature. That is a closed loop with no human in it."

### 8.2 Non-negotiable demo rules

1. **The live run is the demo.** A video of a system that also runs in the room beats a slicker video of something that doesn't.
2. **Only one thing is live-risky.** Everything else is pre-seeded, cached or replayed. Never let a rate limit, cold start or faucet decide a prize.
3. **Have the D2 recording as a fallback clip**, cued and ready, in case the live run stalls. Announce nothing; just cut to it.
4. **Stage one failure on purpose.** The rubric explicitly asks about non-happy paths. Do not let them ask.
5. **Show the run panel.** KeeperHub's runs, logs, statuses and error codes are the observable-execution proof.
6. Finalists present **the working build, not slides**, and get asked questions about it. Rehearse the §12 answers out loud.

---

## 9. Bounty BUIDL

**Rubric:** mergeability, value to the platform, code quality and tests, scope and completeness. **Judged on whether they can merge it and build on it.** A separate BUIDL is required.

**Pick the PR you actually hit during the build.** A bug you reproduced while integrating is a bug you can describe with authority, and authority is what gets merged.

Preferred order:

1. **#2395 — bounded direct-execution receipt evidence as JSON.** Highest strategic fit: it is the exact artifact our receipt bundle needs, so we would build it anyway, and it improves the platform for every auditor on it. Mergeable, bounded, testable.
2. **#2408 — `failOnError: false` finalises a reverted `web3/write-contract` as `success`.** A correctness bug that contradicts the platform's central promise (auditable record). High value, clearly in scope, easy to demonstrate.
3. **#2432 — successful Solana SPL transfers reconciled as terminally failed.** Contained correctness fix with a clear reproduction.
4. **`discover-plugins` on Windows** (see §4.1). Only if we had to fix it anyway, and only because it unblocks every Windows contributor. Lower platform value than 1–3.

**Rules for the PR:** branch from current `main`; tests alongside the change; run `pnpm type-check`, `pnpm check`, `pnpm test`; follow `CONTRIBUTING.md` and `AGENTS.md`; a description that states the bug, the reproduction, the fix and the risk. Read `CONTRIBUTING.md` before writing code — the repo has `AGENTS.md`/`CLAUDE.md`, which suggests conventions worth respecting rather than discovering at review time.

---

## 10. Submission checklist

Submission requires **three** things — incomplete submissions cannot be judged:

- [ ] **Source code link** (public, cloneable, README that a stranger can follow)
- [ ] **Short demo video** showing the integration working
- [ ] **Link to a transaction executed through KeeperHub**

Form questions — answer all, concretely:

- [ ] Which project did you integrate with, and what does the integration do?
- [ ] Which KeeperHub surfaces did you use? *(MCP, CLI, x402, MPP, agent-authored workflows, audit trail — we use: MCP, REST direct execution, agent-authored workflows, audit trail, Transfer trigger, Tempo batch payout)*
- [ ] Testnet or mainnet?
- [ ] What still breaks or is unfinished? *(candid — copy from `docs/limits.md`)*
- [ ] Reachable contact: email plus X or Discord handle

Submission mechanics:

- [ ] **Two BUIDLs created** — one main track, one bounty. One BUIDL cannot enter both.
- [ ] Every submission **must incorporate KeeperHub** (ours does centrally)
- [ ] Eligibility: 18+, and not resident or physically located in an OFAC-restricted jurisdiction — sanctions eligibility follows **residence and physical location**, not citizenship alone
- [ ] All links verified from a logged-out browser

---

## 11. Definition of done

Do not call anything finished until every line here is true.

- [ ] A transaction executed through KeeperHub, linked from the README
- [ ] A real, named live project (Request Network) integrated against its **actual** API — `destinationId` composite addresses, `x-client-id`, HMAC webhook signature — not a generic wrapper
- [ ] Value moved **through KeeperHub** in both directions: inbound detection and outbound atomic payout
- [ ] `simulate: true` → `wouldRevert: false` → execute with a fresh idempotency key, visible on screen
- [ ] Idempotency proven against a replayed webhook
- [ ] At least one non-happy path handled and demonstrated
- [ ] Run IDs, logs and statuses captured from KeeperHub Runs
- [ ] `receipt-bundle.json` produced
- [ ] `pnpm type-check` and tests clean in both repos
- [ ] README a stranger can follow
- [ ] Demo video recorded, including one staged failure
- [ ] `docs/limits.md` written honestly
- [ ] Two BUIDLs submitted, all links verified logged out
- [ ] Bounty PR open against `KeeperHub/keeperhub` with tests

---

## 12. Judge attack — rehearse these out loud

1. **"Why does this need KeeperHub? A webhook handler and a viem script would do it."**
   RN settles; it does not execute consequences. KeeperHub brings nonce management for stuck transactions, gas estimation, private routing against MEV, retries with exponential backoff, non-custodial Turnkey wallets and an audit trail. A webhook handler has none of that, and its failure mode is a duplicate supplier payment. This is not a convenience wrapper; it is the difference between a demo and a system that moves real money twice by accident.

2. **"Why not just a webhook handler?"**
   Show the replay: same body, second delivery, no second payout. Then show `simulate: true` refusing a reverting transfer with zero gas burned. Both are engine features, not our code.

3. **"Isn't Request Network just payment links?"**
   No. ERC-7828 composite destination IDs, references that travel with the transfer, batch and recurring and partial payment types, HMAC-signed webhooks, and an orchestrator model. We touch the reference semantics, the signing scheme and the batch API. Name the fields.

4. **"What if the reference is present and correct?"**
   Then the clean path runs: webhook resolves it, KeeperHub records and pays. Show both paths. The unattributed path is the interesting one precisely because the clean path is easy.

5. **"What if your matcher is wrong and you pay the wrong invoice?"**
   Best answer available: it refuses to guess. High confidence pays automatically; low confidence goes to **Sign & Hold Payment** for an org-owner release; below threshold it alerts a human and moves nothing. And every verdict stores the signals and weights that produced it, so the decision is explainable after the fact. We built the brake on purpose.

6. **"Duplicate webhook delivery?"**
   Idempotency on RN `requestId` + body hash, persisted. Replay returns 200 and does nothing. Demonstrated live.

7. **"Who holds the keys?"**
   Turnkey secure enclave via KeeperHub's org wallet. Keys never cross the hardware boundary. No private key in our repo, our env or our logs.

8. **"What stops the agent overspending?"**
   Two independent layers we did not write: client-side tier hook (auto/ask/block) and server-side Turnkey policies — contract allowlist, 100 USDC per-transfer cap, daily 200 USDC cap returning `429 DAILY_CAP_EXCEEDED`. And we know the hook is stateless, so we do not rely on it for cumulative limits.

9. **"Why not Wayfinder or Almanak — the examples they named?"**
   Straight answer: because those are contested and we would rather build something the judges have not seen four times. RN is a live project with a real API and a real, unglamorous problem. Then pivot: and this fills an empty plugin category — the catalog has 18 DeFi protocols and no invoicing or receivables plugin at all.

10. **"Is this a business or a hackathon project?"**
    Businesses invoice and reconcile — non-optional, monthly, and currently manual. We start with stablecoin-native businesses already on RN, ship the plugin into KeeperHub's marketplace to reach them through the registry, and expand into RN's documented **orchestrator** model for platforms reselling payments. The moat is the reconciliation corpus and the reference semantics, not the code — the code is Apache-2.0 and we want it merged.

**Competitive answer, if asked what else is strong:** be generous and specific. Nyrvok on Wayfinder and the Lucid settlement work are both real. Then name the difference in one line: *they are making DeFi execution safer; we are closing an accounting loop that currently has no deterministic close.* Different rubric axis, and the brief's own theme sentence is about determinism, not safety.

---

## 13. Risk register

| # | Risk | Likelihood | Impact | Mitigation | Trigger to act |
|---|---|---|---|---|---|
| 1 | **RN API is mainnet-only** for `secure-payments` | Medium | High — changes the demo's funding story | Resolve D1 hour 6 (§4.2). Fallback: RN for invoice + webhook, KeeperHub value movement on Sepolia. Disclose in "what still breaks" | D1 EOD |
| 2 | **KeeperHub plugin toolchain broken on Windows** | High (open issue) | High — blocks the plugin, blocks the bounty | WSL2 or Docker for the KeeperHub repo only. Recommended over fixing it on D1 | D1 hour 2 |
| 3 | **Sequential simulation still broken (#2427)** | Certain if we build a bundle | High — demo dies on stage | Single-call writes only. Never put `approve`→`transfer` on the critical path | Design time, D3 |
| 4 | **`matchesRegex` is broken (#2407)** | Certain if used | Medium | Use `contains`/`startsWith`/equality in Conditions. Match in JS in the bridge | Design time |
| 5 | Deadline pressure (5 days, 18+ hours of work) | High | High | §14 cut order. D1 guarantees a *valid* submission early | Continuous |
| 6 | Rate limits (MCP 120/min, direct exec 60/min, public `tools/call` 10/min) | Medium | Medium | Cache the demo path; back off on `Retry-After`; never loop the demo | If any 429 appears |
| 7 | RN webhook secret lost (shown **once**) | Medium | High — cannot verify signatures | Save to `.env` **immediately** on creation; back it up somewhere safe | D1 hour 6 |
| 8 | Funding sent to the wrong address | Medium | Medium | Fund the wallet from `GET /api/user`. Gas first, then USDC | D1 hour 4 |
| 9 | Faucet scarcity on Sepolia | Medium | Medium | Get Base Sepolia funds in parallel as a backup rail | D1 hour 4 |
| 10 | Live demo fails on the panel call | Medium | High | D2 fallback recording, cued. Pre-seeded data. One risky action only | D5 |
| 11 | **Submitting only one BUIDL** and losing the bounty | Medium | Medium ($500) | Two BUIDLs is an explicit checklist line (§10) | D5 |
| 12 | Secret committed to a public repo | Low | Fatal | `.gitignore` first. `git status` before every push. Scan the diff for `unknown` before submitting | Every commit |
| 13 | Judges read "payments" as "not DeFi enough" | Medium | High | Make the Tempo atomic batch payout the visual centrepiece — it is unmistakably onchain value movement | Recording D5 |

---

## 14. Cut order

When behind — and you will be — cut from the top. **Never** cut the last two rows.

1. ERC-8004 identity lookup in the matcher (drop the signal; keep the others)
2. Dashboard / UI of any kind — terminal output and a JSON bundle are sufficient evidence
3. Tempo mainnet — use testnet `42431`, or substitute a second Sepolia transfer and explain the swap
4. JS matcher in a Code node — hardcode the matcher in the bridge instead (it lives there anyway)
5. Partial-payment handling — substitute "wrong reference" as the primary failure and "duplicate webhook" as the second
6. The bounty BUIDL — the main track is $2,000 against $500
7. Multi-invoice matching — three seeded invoices is enough to prove the concept
8. **NEVER: the demo video**, or the **transaction executed through KeeperHub**. Both are mandatory; a submission missing either cannot be judged.

---

## 15. Environment quick reference

```bash
# KeeperHub — MCP (interactive, OAuth)
claude mcp add --transport http --scope user keeperhub https://app.keeperhub.com/mcp
# then: /mcp

# KeeperHub — CLI, headless with an org key
kh auth login
kh doctor
kh chain list
kh wallet info
kh wallet balance

# Safe first transaction (the sequence that matters)
#   1. execute_transfer with "simulate": true            → success:true AND wouldRevert:false
#   2. execute_transfer WITHOUT simulate, fresh idempotency_key
#   3. get_direct_execution_status, bounded backoff      → completed | failed

# Chain IDs are strings
#   Ethereum 1 · Sepolia 11155111 · Base 8453 · Base Sepolia 84532
#   Arbitrum 42161 · Polygon 137 · Tempo 4217 · Tempo testnet 42431

# Request Network
#   API    https://api.request.network/v2/secure-payments   (header: x-client-id)
#   Auth   https://auth.request.network/v1/client-ids
#          https://auth.request.network/v1/webhook           (secret shown ONCE)
#          https://auth.request.network/v1/payee-destination
#   OpenAPI https://api.request.network/open-api
#   Docs    https://docs.request.network/llms.txt
#   Signature header: x-request-network-signature  (HMAC-SHA256 over the RAW body)
```

**Links to keep open all week:** `docs.keeperhub.com` · `github.com/KeeperHub/keeperhub/issues` · `discord.gg/keeperhub` (office hours 12:00 CEST, three sessions) · `docs.request.network` · `keeperhub.com/openapi.json`

---

## 16. What is not verified

Stated plainly so nobody builds on sand. Everything in §3 was checked against live sources on 2026-09-13; the following was **not**, and each has a resolution path in §4.

- Whether KeeperHub's `create-plugin` / `discover-plugins` toolchain works on Windows (open issue says it does not; untested by us)
- Whether Request Network's `secure-payments` API supports testnets
- Request Network's partial-payment field-level API
- Request Network's proxy contract addresses per chain (do not guess these; prefer the API path, which needs none)
- The output contract of `pnpm create-plugin` (reported from the README, not verified against an existing plugin)
- Request Network user or volume figures — the project publishes integration logos and dated announcements, not metrics. **Do not quote merchant counts to judges.**
- Wayfinder's Velocity Protocol internals (not needed — we are not integrating it)
- The hackathon's participant and submission counts (the DoraHacks page is JS-rendered; the competitive picture in §2 is GitHub-visible activity only)
- The exact Superfluid CFA buffer semantics (not needed unless the payout rail changes)
