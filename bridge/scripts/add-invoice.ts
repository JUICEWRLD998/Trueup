/**
 * Registers a real invoice and its payables.
 *
 * This is the product's intake path for anyone who would rather not expose the
 * bridge's HTTP port — the same `registerInvoice()` the `POST /invoices` endpoint
 * calls, with the same validation, so neither path can enforce a rule the other
 * skips.
 *
 * The payload is NOT the demo fixture. Write what your business actually owes:
 *
 *   {
 *     "invoice": {
 *       "id": "INV-5001",
 *       "customer": "Northwind Freight",
 *       "amount": "18.00",
 *       "currency": "USDC",
 *       "reference": "INV-5001",
 *       "issuedAt": "2026-09-01T00:00:00.000Z",
 *       "dueAt": "2026-09-30T00:00:00.000Z",
 *       "knownPayerAddresses": ["0xA11CE0000000000000000000000000000000dEAd"]
 *     },
 *     "payables": [
 *       {
 *         "id": "PAY-5001-CARRIER",
 *         "supplierId": "SUP-CARRIER",
 *         "supplierName": "Cascade Carriers",
 *         "address": "0xC0FFEE0000000000000000000000000000000001",
 *         "amountOwed": "18.00",
 *         "chainId": "11155111",
 *         "tokenAddress": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
 *       }
 *     ]
 *   }
 *
 * Run from bridge/:
 *   pnpm exec tsx scripts/add-invoice.ts invoice.json
 *   cat invoice.json | pnpm exec tsx scripts/add-invoice.ts -            # stdin
 *   pnpm exec tsx scripts/add-invoice.ts invoice.json --create-request   # + RN link
 *
 * `--create-request` also creates the Request Network payment request the payer
 * will settle against, and links its id to the invoice. Without it the invoice is
 * recorded with payables and no payment link, which is a legitimate state — but
 * nothing will settle until a request exists, so the script says so.
 */

import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/env.ts';
import { IntakeError, IntakeRequestSchema, registerInvoice } from '../src/intake.ts';
import { Ledger } from '../src/ledger.ts';
import { RequestNetworkClient } from '../src/rn/client.ts';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const source = args.find((arg) => !arg.startsWith('--'));
  if (source === undefined) {
    console.error(
      'usage: pnpm exec tsx scripts/add-invoice.ts <file.json | -> [--create-request]',
    );
    process.exitCode = 1;
    return;
  }

  const createRequest = args.includes('--create-request');
  const raw = source === '-' ? await readStdin() : await readFile(source, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const payload = IntakeRequestSchema.safeParse(parsed);
  if (!payload.success) {
    console.error('payload does not match the intake schema:');
    for (const issue of payload.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const ledger = new Ledger('data/ledger.json');
  await ledger.load();
  for (const note of ledger.migrationNotes()) {
    console.warn(`WARNING: ${note}`);
  }

  const rn = new RequestNetworkClient({
    apiBase: config.rn.apiBase,
    authBase: config.rn.authBase,
    clientId: config.rn.clientId,
  });

  try {
    const result = await registerInvoice(payload.data, {
      ledger,
      createRequest: createRequest
        ? async (invoice) => {
            const created = await rn.createSecurePayment({
              ...(config.rn.destinationId === undefined
                ? {}
                : { destinationId: config.rn.destinationId }),
              amount: invoice.amount,
              reference: invoice.reference,
            });
            const first = created.requestIds[0];
            if (first === undefined) {
              throw new Error('Request Network returned no request id');
            }
            return first;
          }
        : undefined,
    });

    console.log(
      `registered ${result.invoice.id} — ${result.invoice.amount} ${result.invoice.currency} ` +
        `from ${result.invoice.customer}`,
    );
    for (const payable of result.payables) {
      console.log(
        `  ${payable.amountOwed.padStart(8)} -> ${payable.supplierName} (${payable.address}, ` +
          `chain ${payable.chainId}, token ${payable.tokenAddress ?? 'NONE'})`,
      );
    }
    for (const note of result.notes) {
      console.log(`  note: ${note}`);
    }
    if (result.invoice.rnRequestId === undefined) {
      console.log(
        '\nNo Request Network payment request exists for this invoice yet, so nothing can ' +
          'settle it. Re-run with --create-request, or create it in the dashboard.',
      );
    }
  } catch (error) {
    if (error instanceof IntakeError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    console.error('intake failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('add-invoice failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
