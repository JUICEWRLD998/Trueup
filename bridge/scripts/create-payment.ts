/**
 * Creates a real Request Network secure payment.
 *
 * The point of this script is to answer one question: can we create a payment
 * with the Client ID alone? Request Network resolves the payee from the Client ID
 * when it is bound to a payment destination, in which case `destinationId` may be
 * omitted from the request body. If that holds we do not need the operator to
 * copy the interop address out of the dashboard.
 *
 * Creates the payment only. It does not pay it, and it moves nothing.
 *
 * The reference defaults to a WRONG one on purpose. `settle()` reads the reference
 * back from Request Network and treats an exact match as decisive, so a request
 * carrying `INV-4471` classifies as `attributed` and never reaches the scoring path
 * the demo is about. An unmatched reference ("the payer sent it with the wrong
 * reference") is what makes the payment genuinely unattributed and forces the
 * matcher to earn its verdict.
 *
 * Run from bridge/:  pnpm exec tsx scripts/create-payment.ts [amount] [reference]
 */

import { loadConfig } from '../src/env.ts';
import { RequestNetworkClient } from '../src/rn/client.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new RequestNetworkClient({
    apiBase: config.rn.apiBase,
    authBase: config.rn.authBase,
    clientId: config.rn.clientId,
  });

  const amount = process.argv[2] ?? '18.00';
  const reference = process.argv[3] ?? 'PO-9001';

  console.log('=== create secure payment ===');
  console.log(`clientId : ${config.rn.clientId?.slice(0, 12)}…`);
  console.log(`amount   : ${amount}`);
  console.log(`reference: ${reference}`);
  console.log(
    `destinationId: ${config.rn.destinationId ?? '(omitted — letting the Client ID resolve the payee)'}`,
  );

  try {
    const created = await client.createSecurePayment({
      // Omit destinationId entirely when unset so the bound destination resolves.
      ...(config.rn.destinationId === undefined
        ? {}
        : { destinationId: config.rn.destinationId }),
      amount,
      reference,
    });

    console.log('\n--- created ---');
    console.log(JSON.stringify(created, null, 2));

    for (const requestId of created.requestIds) {
      console.log(`\nrequestId: ${requestId}`);
      if (created.securePaymentUrl !== undefined) {
        console.log(`payment url: ${created.securePaymentUrl}`);
      }
    }

    // Read it straight back, which also proves our read path authenticates.
    const first = created.requestIds[0];
    if (first !== undefined) {
      console.log('\n--- read back via GET /v2/request/{id} ---');
      const status = await client.getRequest(first);
      console.log(JSON.stringify(status, null, 2));
      console.log(`\nstatus   : ${String(status.status)}`);
      console.log(`reference: ${String(status.reference)}`);
      console.log(`paid?    : ${String(status.hasBeenPaid)}`);
    }
  } catch (error) {
    console.log('\nFAILED');
    console.log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('create-payment failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
