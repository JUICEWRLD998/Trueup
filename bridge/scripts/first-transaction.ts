/**
 * The Day-1 milestone: one real transfer executed through KeeperHub.
 *
 * This is the sequence the whole submission rests on, run against the live API:
 *
 *   1. simulate: true  → expect success and wouldRevert: false
 *   2. the identical call WITHOUT simulate, with a fresh idempotency key
 *   3. poll until terminal, then print the hash and an explorer link
 *
 * It moves testnet value only (Sepolia fUSDC), sized well under the documented
 * 100 USD per-transaction stablecoin cap.
 *
 * Run from bridge/:  pnpm exec tsx scripts/first-transaction.ts [amount]
 */

import { loadConfig } from '../src/env.ts';
import { KeeperHubClient, deriveIdempotencyKey } from '../src/keeperhub.ts';

// Sepolia fUSDC — the token Request Network lists as `fUSDC-sepolia`.
const SEPOLIA_FUSDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

// First fixture supplier address. Sending to a supplier-shaped address keeps the
// transaction meaningful rather than arbitrary.
const RECIPIENT = '0xC0FFEE0000000000000000000000000000000001';

async function main(): Promise<void> {
  const config = loadConfig();
  const amount = process.argv[2] ?? '1.00';

  const kh = new KeeperHubClient({
    apiBase: config.kh.apiBase,
    apiKey: config.kh.apiKey,
  });

  // NOTE: do NOT send tokenConfig alongside tokenAddress. Sending
  // `tokenConfig: '{"decimals":6,"symbol":"fUSDC"}'` makes the API fail the
  // dry run with "Simulating a token transfer requires a resolvable
  // `tokenAddress` or `tokenConfig`" — it contradicts itself and the transfer is
  // then un-simulatable. With tokenAddress alone the same call simulates clean.
  // Verified live on Sepolia, 2026-09-13.
  const request = {
    chainId: config.kh.chainId,
    recipientAddress: RECIPIENT,
    amount,
    tokenAddress: SEPOLIA_FUSDC,
  };

  console.log('=== trueup — first verified transaction ===');
  console.log(`chain     : ${config.kh.chainId}`);
  console.log(`token     : fUSDC ${SEPOLIA_FUSDC}`);
  console.log(`amount    : ${amount}`);
  console.log(`recipient : ${RECIPIENT}`);

  // --- 1. Dry run. Nothing is signed, nothing is broadcast, no hash exists. ---
  console.log('\n--- step 1: simulate (no signing, no broadcast) ---');
  const simulation = await kh.simulateTransfer(request);
  console.log(JSON.stringify(simulation, null, 2));

  if (simulation.wouldRevert !== false) {
    console.error(
      `\nRefusing to broadcast: expected wouldRevert === false, got ${JSON.stringify(simulation.wouldRevert)}.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log('dry run clean: success + wouldRevert === false');

  // --- 2. Broadcast. Fresh idempotency key, stable for this logical payment. ---
  const idempotencyKey = deriveIdempotencyKey({
    workId: `first-transaction:${config.kh.chainId}:${RECIPIENT}`,
    chainId: config.kh.chainId,
    recipientAddress: RECIPIENT,
    amount,
  });
  console.log(`\n--- step 2: execute (simulate omitted, idempotency key ${idempotencyKey.slice(0, 16)}…) ---`);

  const execution = await kh.executeTransfer(request, idempotencyKey);
  console.log(JSON.stringify(execution, null, 2));

  console.log(`\nexecutionId: ${execution.executionId}`);
  if (execution.transactionHash) {
    console.log(`transactionHash: ${execution.transactionHash}`);
  } else {
    console.log('no hash in the execute response — reading it from the status endpoint');
  }

  // --- 3. Poll to a terminal state. Terminality is the poll hint, not the status string. ---
  console.log('\n--- step 3: poll status ---');
  const status = await kh.waitForExecution(execution.executionId);
  console.log(JSON.stringify(status, null, 2));

  const hash = status.transactionHash ?? execution.transactionHash;
  const link =
    status.transactionLink ??
    (hash !== undefined ? `https://sepolia.etherscan.io/tx/${hash}` : undefined);

  console.log('\n=== result ===');
  console.log(`status          : ${status.status}`);
  console.log(`transactionHash : ${hash ?? '(none)'}`);
  console.log(`explorer        : ${link ?? '(none)'}`);
  if (status.receipts !== undefined && status.receipts.length > 0) {
    for (const receipt of status.receipts) {
      console.log(
        `receipt         : hash=${receipt.hash} block=${String(receipt.blockNumber)} status=${String(receipt.receiptStatus)} verified=${String(receipt.verified)}`,
      );
    }
  }
  console.log(`run id          : ${status.executionId}`);
  if (status.retryCount !== undefined) {
    console.log(`retryCount      : ${status.retryCount}`);
  }

  if (hash === undefined) {
    console.error('\nNo transaction hash was produced — treat this as a failed milestone.');
    process.exitCode = 1;
  } else {
    console.log('\nPut the explorer link in README.md under "Proof of execution".');
  }
}

main().catch((error: unknown) => {
  console.error('\nfirst-transaction failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
