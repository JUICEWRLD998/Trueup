/**
 * Seeds the ledger with the demo invoices and suppliers.
 *
 * Run from bridge/:  pnpm exec tsx scripts/seed-demo.ts
 *
 * Deliberately re-runnable — it replaces the seed records and leaves any recorded
 * settlements alone, so replaying it mid-demo does not destroy the audit trail.
 *
 * Because it preserves settlement state on purpose, it cannot put the demo back to
 * a clean slate. `--reset` is the explicit way to ask for that: it clears invoices,
 * suppliers, settlements and the request index first. Without it, an invoice left
 * `settled` by an earlier smoke test stays settled and the money shot has nothing
 * to settle.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Ledger, type Invoice, type Supplier } from '../src/ledger.ts';
import { loadConfig } from '../src/env.ts';

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
  suppliers: Array<{
    id: string;
    name: string;
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

  if (process.argv.includes('--reset')) {
    const before = ledger.snapshot();
    console.log(
      `resetting ledger: ${Object.keys(before.invoices).length} invoice(s), ` +
        `${Object.keys(before.deliveries).length} settlement(s) discarded`,
    );
    ledger.reset();
  }

  for (const seed of fixture.invoices) {
    const existing = ledger.getInvoice(seed.id);
    const invoice: Invoice = {
      id: seed.id,
      customer: seed.customer,
      amount: seed.amount,
      currency: seed.currency,
      rnRequestId: existing?.rnRequestId,
      reference: seed.reference,
      issuedAt: seed.issuedAt,
      dueAt: seed.dueAt,
      status: existing?.status ?? 'open',
      settledAmount: existing?.settledAmount ?? '0.00',
      settledAt: existing?.settledAt,
      txHash: existing?.txHash,
      knownPayerAddresses: seed.knownPayerAddresses,
    };
    ledger.addInvoice(invoice);
    console.log(`seeded invoice ${invoice.id} — ${invoice.amount} ${invoice.currency} from ${invoice.customer}`);
  }

  for (const seed of fixture.suppliers) {
    // The fixture names the chain and the token, because the payout path will not
    // guess either: no token address becomes a NATIVE transfer, and the wrong chain
    // pays a real address on a network nobody is watching. Warn when the fixture and
    // the environment disagree rather than silently preferring one.
    if (seed.chainId !== config.kh.chainId) {
      console.warn(
        `  WARNING: supplier ${seed.id} is on chain ${seed.chainId} but KH_CHAIN_ID is ` +
          `${config.kh.chainId}. The payout follows the supplier, not the environment.`,
      );
    }
    const supplier: Supplier = {
      id: seed.id,
      name: seed.name,
      address: seed.address,
      amountOwed: seed.amountOwed,
      chainId: seed.chainId,
      tokenAddress: seed.tokenAddress,
    };
    ledger.addSupplier(supplier);
    console.log(
      `seeded supplier ${supplier.id} — ${supplier.amountOwed} to ${supplier.name} ` +
        `(chain ${supplier.chainId}, token ${supplier.tokenAddress})`,
    );
  }

  await ledger.save();
  console.log(`\nledger written to ${resolve(process.cwd(), 'data', 'ledger.json')}`);
}

main().catch((error: unknown) => {
  console.error('seed failed:', error);
  process.exitCode = 1;
});
