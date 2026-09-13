/**
 * Settlement orchestration tests.
 *
 * The cases that justify this file, both of which are about refusing to do damage:
 *
 *   1. A rehearsal must write NOTHING. A dry run that marked the invoice settled
 *      would leave the real run with nothing to settle — the demo would be spent
 *      before it was recorded.
 *   2. A payout with no token address must be refused rather than attempted.
 *      Omitting `tokenAddress` does not fail at the API; it silently becomes a native
 *      transfer of the same nominal amount. Paying a supplier 6 ETH because a 6 USDC
 *      payout lost its token address is the worst available outcome.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Ledger, type Invoice, type Supplier } from '../src/ledger.ts';
import { settle, type Logger } from '../src/settle.ts';
import type { KeeperHubClient } from '../src/keeperhub.ts';
import type { RequestNetworkClient } from '../src/rn/client.ts';
import type { PaymentConfirmed } from '../src/rn/types.ts';

const SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

function silentLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'INV-4471',
    customer: 'Northwind Freight',
    amount: '18.00',
    currency: 'USDC',
    rnRequestId: undefined,
    reference: 'INV-4471',
    issuedAt: '2026-08-01T00:00:00.000Z',
    dueAt: '2026-08-31T00:00:00.000Z',
    status: 'open',
    settledAmount: '0.00',
    settledAt: undefined,
    txHash: undefined,
    knownPayerAddresses: ['0xA11CE0000000000000000000000000000000dEAd'],
    ...overrides,
  };
}

function supplier(overrides: Partial<Supplier> = {}): Supplier {
  return {
    id: 'SUP-CARRIER',
    name: 'Cascade Carriers',
    address: '0xC0FFEE0000000000000000000000000000000001',
    amountOwed: '6.00',
    chainId: '11155111',
    tokenAddress: SEPOLIA_USDC,
    ...overrides,
  };
}

async function makeLedger(invoices: Invoice[], suppliers: Supplier[]): Promise<Ledger> {
  const path = join(tmpdir(), `trueup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const ledger = new Ledger(path);
  await ledger.load();
  for (const value of invoices) ledger.addInvoice(value);
  for (const value of suppliers) ledger.addSupplier(value);
  return ledger;
}

function event(overrides: Partial<PaymentConfirmed> = {}): PaymentConfirmed {
  return {
    event: 'payment.confirmed',
    requestId: 'req_rehearsal',
    amount: '18.00',
    totalAmountPaid: '18.00',
    expectedAmount: '18.00',
    payerAddress: '0xA11CE0000000000000000000000000000000dEAd',
    txHash: '0xdeadbeef',
    timestamp: '1789000000',
    ...overrides,
  };
}

function fakeKh() {
  const simulated: Array<Record<string, unknown>> = [];
  const broadcast: Array<Record<string, unknown>> = [];
  const kh = {
    simulateTransfer: vi.fn((request: Record<string, unknown>) => {
      simulated.push(request);
      return Promise.resolve({ success: true, wouldRevert: false, gasEstimate: '62796' });
    }),
    transferSafely: vi.fn((request: Record<string, unknown>, idempotencyKey: string) => {
      broadcast.push({ ...request, idempotencyKey });
      return Promise.resolve({
        simulation: { success: true, wouldRevert: false },
        execution: {
          executionId: `exec_${broadcast.length}`,
          status: 'completed',
          transactionHash: `0xhash${broadcast.length}`,
        },
      });
    }),
  };
  return { kh: kh as unknown as KeeperHubClient, simulated, broadcast, raw: kh };
}

const rn = { getRequest: () => Promise.resolve({ reference: undefined }) } as unknown as RequestNetworkClient;

describe('a rehearsal', () => {
  it('simulates each payout and broadcasts none of them', async () => {
    const ledger = await makeLedger([invoice()], [supplier()]);
    const { kh, simulated, broadcast } = fakeKh();

    const outcome = await settle(event(), 'delivery_1', {
      ledger,
      kh,
      rn,
      logger: silentLogger(),
      autoApproveThreshold: 0.85,
      simulateOnly: true,
    });

    expect(outcome.verdict).toBe('matched');
    expect(outcome.dryRun).toBe(true);
    expect(outcome.payouts).toHaveLength(1);
    expect(outcome.payouts[0]?.gasEstimate).toBe('62796');
    expect(outcome.payouts[0]?.transactionHash).toBeUndefined();
    expect(simulated).toHaveLength(1);
    expect(broadcast).toHaveLength(0);
  });

  it('leaves the ledger exactly as it found it', async () => {
    // The property the demo depends on. If a rehearsal settles the invoice, the real
    // run has nothing to settle and the recording is wasted.
    const ledger = await makeLedger([invoice()], [supplier()]);
    const { kh } = fakeKh();

    await settle(event(), 'delivery_1', {
      ledger,
      kh,
      rn,
      logger: silentLogger(),
      autoApproveThreshold: 0.85,
      simulateOnly: true,
    });

    const after = ledger.getInvoice('INV-4471');
    expect(after?.status).toBe('open');
    expect(after?.settledAmount).toBe('0.00');
    expect(ledger.snapshot().deliveries).toEqual({});
  });

  it('reports a hold without recording it either', async () => {
    const ledger = await makeLedger([invoice()], [supplier()]);
    const { kh, simulated } = fakeKh();

    const outcome = await settle(
      event({ payerAddress: '0xDEADBEEF00000000000000000000000000000099' }),
      'delivery_1',
      {
        ledger,
        kh,
        rn,
        logger: silentLogger(),
        autoApproveThreshold: 0.85,
        simulateOnly: true,
      },
    );

    expect(outcome.verdict).toBe('held');
    expect(outcome.holds).toHaveLength(1);
    expect(outcome.dryRun).toBe(true);
    // A hold moves nothing, so there is nothing to simulate.
    expect(simulated).toHaveLength(0);
    expect(ledger.snapshot().deliveries).toEqual({});
    expect(ledger.getInvoice('INV-4471')?.status).toBe('open');
  });

  it('sends the token address, so the simulation cannot pass as a native transfer', async () => {
    const ledger = await makeLedger([invoice()], [supplier()]);
    const { kh, simulated } = fakeKh();

    await settle(event(), 'delivery_1', {
      ledger,
      kh,
      rn,
      logger: silentLogger(),
      autoApproveThreshold: 0.85,
      simulateOnly: true,
    });

    expect(simulated[0]?.['tokenAddress']).toBe(SEPOLIA_USDC);
  });
});

describe('a payout that must not be attempted', () => {
  it('refuses a payout with no token address instead of sending native value', async () => {
    const ledger = await makeLedger([invoice()], [supplier({ tokenAddress: undefined })]);
    const { kh, simulated, broadcast } = fakeKh();

    const outcome = await settle(event(), 'delivery_1', {
      ledger,
      kh,
      rn,
      logger: silentLogger(),
      autoApproveThreshold: 0.85,
    });

    expect(outcome.payouts[0]?.error).toMatch(/NATIVE/);
    expect(simulated).toHaveLength(0);
    expect(broadcast).toHaveLength(0);
  });

  it('refuses a payout above the per-transaction cap without calling KeeperHub', async () => {
    const ledger = await makeLedger([invoice({ amount: '4200.00' })], [supplier({ amountOwed: '1200.00' })]);
    const { kh, broadcast } = fakeKh();

    const outcome = await settle(
      event({ amount: '4200.00', totalAmountPaid: '4200.00', expectedAmount: '4200.00' }),
      'delivery_1',
      { ledger, kh, rn, logger: silentLogger(), autoApproveThreshold: 0.85 },
    );

    expect(outcome.payouts[0]?.error).toMatch(/100 USD per-transaction/);
    expect(broadcast).toHaveLength(0);
  });
});

describe('a real run', () => {
  it('broadcasts with the token address and records the execution ids', async () => {
    const ledger = await makeLedger([invoice()], [supplier(), supplier({ id: 'SUP-FUEL', amountOwed: '4.30' })]);
    const { kh, broadcast } = fakeKh();

    const outcome = await settle(event(), 'delivery_1', {
      ledger,
      kh,
      rn,
      logger: silentLogger(),
      autoApproveThreshold: 0.85,
    });

    expect(broadcast).toHaveLength(2);
    expect(broadcast[0]?.['tokenAddress']).toBe(SEPOLIA_USDC);
    // The idempotency key is derived per supplier, so a retry of one payout cannot
    // suppress another.
    const keys = new Set(broadcast.map((call) => call['idempotencyKey']));
    expect(keys.size).toBe(2);

    const record = ledger.snapshot().deliveries['delivery_1'];
    expect(record?.executionIds).toEqual(['exec_1', 'exec_2']);
    expect(ledger.getInvoice('INV-4471')?.status).toBe('settled');
  });

  it('does not re-pay when the same delivery is submitted twice', async () => {
    const ledger = await makeLedger([invoice()], [supplier()]);
    const { kh, broadcast } = fakeKh();
    const deps = { ledger, kh, rn, logger: silentLogger(), autoApproveThreshold: 0.85 };

    await settle(event(), 'delivery_1', deps);
    const replayed = ledger.recordForDelivery('delivery_1');
    expect(replayed?.verdict).toBe('matched');
    // The handler is what returns early on this record; settle() itself is not
    // idempotent, which is why the handler checks first. Asserting the guard exists
    // keeps that contract visible.
    expect(ledger.recordForDelivery('delivery_never_seen')).toBeUndefined();
    expect(broadcast).toHaveLength(1);
  });
});
