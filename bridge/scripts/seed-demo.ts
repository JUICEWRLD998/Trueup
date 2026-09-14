/**
 * Seeds the ledger with the demo invoices and their payables.
 *
 * Run from bridge/:  pnpm exec tsx scripts/seed-demo.ts
 *
 * This is a *demo* harness, not the product's input path — real invoices arrive
 * through `POST /invoices` or `scripts/add-invoice.ts`, which share one validation
 * module (`src/intake.ts`). The seed deliberately goes through the same
 * `registerInvoice()` those use, so a fixture that violates a rule (a payout above
 * the platform cap, payables that do not sum to the invoice) fails here with the
 * same reason a real registration would give, instead of loading silently.
 *
 * Deliberately re-runnable — it replaces the seed records and leaves any recorded
 * settlements alone, so replaying it mid-demo does not destroy the audit trail.
 *
 * Because it preserves settlement state on purpose, it cannot put the demo back to
 * a clean slate. `--reset` is the explicit way to ask for that: it clears invoices,
 * payables, settlements and the request index first. Without it, an invoice left
 * `settled` by an earlier smoke test stays settled and the money shot has nothing
 * to settle.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/env.ts';
import { registerInvoice, type IntakeRequest } from '../src/intake.ts';
import { Ledger, type Invoice } from '../src/ledger.ts';

interface Fixture {
  invoices: Array<{
    id: string;
    customer: string;
    amount: string;
    currency: string;
    reference: string;
    issuedAt: string;
    dueAt: string;
    knownPayerAddresses: string[];
  }>;
  payables: Array<{
    id: string;
    invoiceId: string;
    supplierId: string;
    supplierName: string;
    address: string;
    amountOwed: string;
    chainId: string;
    tokenAddress: string;
  }>;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const fixturePath = resolve(process.cwd(), '..', 'fixtures', 'invoices.json');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as Fixture;

  const ledger = new Ledger('data/ledger.json');
  await ledger.load();
  // A migrated ledger is missing payables it used to have, and the only symptom
  // otherwise is a settlement that holds instead of paying. Say it here.
  for (const note of ledger.migrationNotes()) {
    console.warn(`WARNING: ${note}`);
  }

  if (process.argv.includes('--reset')) {
    const before = ledger.snapshot();
    console.log(
      `resetting ledger: ${Object.keys(before.invoices).length} invoice(s), ` +
        `${Object.keys(before.payables).length} payable(s), ` +
        `${Object.keys(before.deliveries).length} settlement(s) discarded`,
    );
    ledger.reset();
  }

  for (const seed of fixture.invoices) {
    const existing = ledger.getInvoice(seed.id);
    if (existing !== undefined && existing.status === 'settled') {
      // Intentionally left alone: a settled invoice has settlement records pointing
      // at it, and intake refuses to rewrite one for that reason. --reset is the
      // explicit way to ask for a clean slate.
      console.log(
        `skipping invoice ${seed.id} — already settled (${existing.settledAmount} of ` +
          `${existing.amount}). Use --reset to return the demo to a clean slate.`,
      );
      continue;
    }

    const payables = fixture.payables.filter((payable) => payable.invoiceId === seed.id);

    // The fixture names the chain and the token, because the payout path will not
    // guess either: no token address becomes a NATIVE transfer, and the wrong chain
    // pays a real address on a network nobody is watching. Warn when the fixture and
    // the environment disagree rather than silently preferring one.
    for (const payable of payables) {
      if (payable.chainId !== config.kh.chainId) {
        console.warn(
          `  WARNING: payable ${payable.id} is on chain ${payable.chainId} but KH_CHAIN_ID is ` +
            `${config.kh.chainId}. The payout follows the payable, not the environment.`,
        );
      }
    }

    const request: IntakeRequest = {
      invoice: {
        id: seed.id,
        customer: seed.customer,
        amount: seed.amount,
        currency: seed.currency,
        reference: seed.reference,
        issuedAt: seed.issuedAt,
        dueAt: seed.dueAt,
        knownPayerAddresses: seed.knownPayerAddresses,
      },
      payables: payables.map((payable) => ({
        id: payable.id,
        supplierId: payable.supplierId,
        supplierName: payable.supplierName,
        address: payable.address,
        amountOwed: payable.amountOwed,
        chainId: payable.chainId,
        tokenAddress: payable.tokenAddress,
      })),
    };

    // No createRequest: seeding never calls Request Network. It records the book,
    // not the payment links.
    const result = await registerInvoice(request, { ledger });
    const record: Invoice = result.invoice;
    console.log(
      `seeded invoice ${record.id} — ${record.amount} ${record.currency} from ${record.customer} ` +
        `(${result.payables.length} payable(s))`,
    );
    for (const payable of result.payables) {
      console.log(
        `  ${payable.id.padEnd(20)} ${payable.amountOwed.padStart(7)} -> ${payable.supplierName} ` +
          `(chain ${payable.chainId}, token ${payable.tokenAddress ?? 'NONE'})`,
      );
    }
    if (record.status !== 'open') {
      console.log(`  note: ${record.id} is ${record.status}, so it will not be settled again.`);
    }
  }

  console.log(`\nledger written to ${resolve(process.cwd(), 'data', 'ledger.json')}`);
}

main().catch((error: unknown) => {
  console.error('seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
