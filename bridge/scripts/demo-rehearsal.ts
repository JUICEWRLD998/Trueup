/**
 * The money shot, without the money.
 *
 * Runs the real settlement path — the same `settle()` the webhook handler calls, the
 * same `classify()` weights, the same per-transaction cap check, and KeeperHub's real
 * dry-run endpoint — with `simulateOnly` set. KeeperHub estimates gas and checks for
 * reverts without signing or broadcasting, and nothing is written back to the ledger.
 *
 * This exists for two reasons. First, it is the only way to rehearse the loop before
 * Request Network's webhook is registered. Second, the demo's Sepolia wallet holds a
 * finite amount of USDC: rehearsing a payout by actually paying it would spend the
 * funds the recording needs, and then the recording would have nothing left to do.
 *
 * It picks the first open invoice by id unless told otherwise, so it is not written
 * around one specific fixture — with real invoices in the ledger it rehearses those.
 *
 * What it does NOT prove: signature verification, and the fact that a real webhook
 * arrives at all. `/webhooks/request-network` covers those, and the forged-signature
 * path is covered by tests/verify.test.ts.
 *
 * Run from bridge/:
 *   pnpm exec tsx scripts/demo-rehearsal.ts
 *   pnpm exec tsx scripts/demo-rehearsal.ts --invoice INV-4472
 *   pnpm exec tsx scripts/demo-rehearsal.ts --reference INV-9999   # the wrong-reference case
 *
 * Seed first, or the invoice is already settled and there is nothing to match:
 *   pnpm exec tsx scripts/seed-demo.ts --reset
 */

import { loadConfig } from '../src/env.ts';
import { KeeperHubClient } from '../src/keeperhub.ts';
import { Ledger, type Invoice } from '../src/ledger.ts';
import { RequestNetworkClient } from '../src/rn/client.ts';
import { settle } from '../src/settle.ts';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = {
    info: (message: string, fields?: Record<string, unknown>) =>
      console.log(`${DIM}[info]  ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}${RESET}`),
    warn: (message: string, fields?: Record<string, unknown>) =>
      console.log(`[warn]  ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}`),
    error: (message: string, fields?: Record<string, unknown>) =>
      console.log(`[error] ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}`),
  };

  const ledger = new Ledger('data/ledger.json');
  await ledger.load();

  const requestedId = argValue('--invoice');
  // Sorted, so the choice is the same on every run rather than whatever order the
  // JSON file happens to preserve.
  const candidates = ledger.openInvoices().sort((a, b) => (a.id < b.id ? -1 : 1));
  const invoice: Invoice | undefined =
    requestedId === undefined
      ? candidates[0]
      : ledger.getInvoice(requestedId);

  if (invoice === undefined) {
    const known = Object.values(ledger.snapshot().invoices).map((i) => i.id);
    console.log(
      requestedId === undefined
        ? 'No open invoice is in the ledger. Run: pnpm exec tsx scripts/seed-demo.ts --reset'
        : `Invoice ${requestedId} is not in the ledger. Known: ${known.join(', ') || '(none)'}. ` +
            `Seed with: pnpm exec tsx scripts/seed-demo.ts --reset`,
    );
    process.exitCode = 1;
    return;
  }

  if (invoice.status !== 'open') {
    console.log(
      `${invoice.id} is already ${invoice.status} (settled ${invoice.settledAmount}). ` +
        `Re-seed for a clean rehearsal: pnpm exec tsx scripts/seed-demo.ts --reset`,
    );
    process.exitCode = 1;
    return;
  }

  const payables = ledger.payablesForInvoice(invoice.id);
  if (payables.length === 0) {
    // The same configuration failure `settle()` refuses to pay through. Caught here
    // so the message names the fix instead of the run looking like a verdict.
    console.log(
      `${invoice.id} has no payables, so there is nothing to simulate. Register them with ` +
        `POST /invoices or scripts/add-invoice.ts.`,
    );
    process.exitCode = 1;
    return;
  }

  const payer = invoice.knownPayerAddresses[0];
  if (payer === undefined) {
    throw new Error(`${invoice.id} has no known payer address, so the payer signal cannot fire.`);
  }

  // A synthetic request id by default. `settle()` reads the request back from Request
  // Network for its reference, and an id we do not own fails that read — which is a
  // path worth exercising, and it leaves `reference` undefined exactly like a payment
  // that arrived without one.
  const requestId =
    argValue('--request-id') ?? '01demo0000000000000000000000000000000000000000000000000000rehearsal';
  // Passing --reference bypasses that read entirely: it is the "payer sent the wrong
  // reference" case, and setting it here is the one place this script stands in for
  // Request Network rather than going through it.
  const reference = argValue('--reference');

  console.log(`${BOLD}TrueUp — settlement rehearsal${RESET}\n`);
  console.log(`  invoice     : ${invoice.id} — ${invoice.amount} ${invoice.currency} from ${invoice.customer}`);
  console.log(`  outstanding : ${invoice.settledAmount} settled of ${invoice.amount}`);
  console.log(`  payables    : ${payables.length} (${payables.map((p) => p.id).join(', ')})`);
  console.log(`  payer       : ${payer}`);
  console.log(`  requestId   : ${requestId}`);
  console.log(`  reference   : ${reference ?? '(none — matching on signals only)'}`);
  console.log(`  mode        : ${BOLD}dry run${RESET} — simulate only, nothing signed or broadcast\n`);

  const kh = new KeeperHubClient({ apiBase: config.kh.apiBase, apiKey: config.kh.apiKey });
  const rn = new RequestNetworkClient({
    apiBase: config.rn.apiBase,
    authBase: config.rn.authBase,
    clientId: config.rn.clientId,
  });

  const settledBefore = `${invoice.settledAmount}/${invoice.status}`;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const outcome = await settle(
    {
      event: 'payment.confirmed',
      requestId,
      amount: invoice.amount,
      totalAmountPaid: invoice.amount,
      expectedAmount: invoice.amount,
      payerAddress: payer,
      txHash: '0xrehearsal',
      timestamp: String(nowSeconds),
    },
    `rehearsal:${nowSeconds}`,
    {
      ledger,
      kh,
      rn,
      logger,
      autoApproveThreshold: config.bridge.matchAutoApproveThreshold,
      simulateOnly: true,
    },
  );

  console.log(`\n${BOLD}--- verdict ---${RESET}`);
  console.log(`  verdict     : ${outcome.verdict.toUpperCase()}`);
  console.log(`  invoice     : ${outcome.invoiceId ?? '(none)'}`);
  console.log(`  confidence  : ${outcome.confidence.toFixed(2)}`);
  for (const reason of outcome.reasons) {
    console.log(`    · ${reason}`);
  }

  console.log(`\n${BOLD}--- payouts (simulated) ---${RESET}`);
  for (const payout of outcome.payouts) {
    const state =
      payout.error !== undefined
        ? `REFUSED — ${payout.error}`
        : `would succeed, gasEstimate ${payout.gasEstimate ?? '(none reported)'}`;
    console.log(`  ${payout.supplierId.padEnd(14)} ${payout.amount.padStart(7)} -> ${payout.supplierName}`);
    console.log(`                 ${state}`);
    console.log(`                 idempotency ${payout.idempotencyKey.slice(0, 16)}…`);
  }
  if (outcome.holds.length > 0) {
    console.log(`\n  ${outcome.holds.length} payout(s) staged for release (the brake), not simulated.`);
  }

  // The claim that matters: a rehearsal must leave the ledger exactly as it found it.
  const settledAfter = `${invoice.settledAmount}/${invoice.status}`;
  const untouched = settledBefore === settledAfter;
  console.log(`\n${BOLD}--- state ---${RESET}`);
  console.log(`  ledger ${invoice.id} : ${settledBefore} -> ${settledAfter} ${untouched ? '(unchanged)' : '(CHANGED — BUG)'}`);
  console.log(`  signed          : no`);
  console.log(`  broadcast       : no`);
  console.log(`  value moved     : none`);

  const failed = outcome.payouts.filter((payout) => payout.error !== undefined);
  if (!untouched) {
    console.log('\nA rehearsal mutated the ledger. That would break the real run.');
    process.exitCode = 1;
    return;
  }
  if (outcome.verdict !== 'matched' && outcome.verdict !== 'attributed') {
    console.log(
      `\nThe rehearsal classified this settlement as ${outcome.verdict.toUpperCase()}, so the ` +
        `real run would not pay either. That is the brake working, or a fixture problem — ` +
        `the reasons above say which.`,
    );
    process.exitCode = 1;
    return;
  }
  if (failed.length > 0) {
    console.log(
      `\n${failed.length} of ${outcome.payouts.length} simulated payout(s) would be refused. ` +
        `A dry run that reports a refusal has found something the real run would hit — fix it here, not on camera.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `\n${BOLD}All ${outcome.payouts.length} payouts simulated clean. ` +
      `The loop is ready for the real run once Request Network delivers a webhook.${RESET}`,
  );
}

main().catch((error: unknown) => {
  console.error('rehearsal failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
