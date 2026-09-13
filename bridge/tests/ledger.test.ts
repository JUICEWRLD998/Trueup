/**
 * Ledger tests.
 *
 * Money is summed as scaled integers, never as floats. This file exists to keep
 * it that way: a ledger that drifts by a rounding error is a ledger nobody can
 * reconcile against, which is the opposite of the product's purpose.
 */

import { describe, expect, it } from 'vitest';
import {
  addDecimalStrings,
  compareDecimalStrings,
  Ledger,
  type Invoice,
} from '../src/ledger.ts';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'INV-1',
    customer: 'Northwind Freight',
    amount: '4200.00',
    currency: 'USDC',
    rnRequestId: undefined,
    reference: 'INV-1',
    issuedAt: '2026-08-01T00:00:00.000Z',
    dueAt: '2026-08-31T00:00:00.000Z',
    status: 'open',
    settledAmount: '0.00',
    settledAt: undefined,
    txHash: undefined,
    knownPayerAddresses: [],
    ...overrides,
  };
}

describe('decimal arithmetic', () => {
  it('adds without floating point drift', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in float arithmetic.
    expect(addDecimalStrings('0.1', '0.2')).toBe('0.300000');
  });

  it('accumulates many small payments exactly', () => {
    let total = '0.00';
    for (let i = 0; i < 10; i += 1) {
      total = addDecimalStrings(total, '0.01');
    }
    expect(total).toBe('0.100000');
  });

  it('compares exactly', () => {
    expect(compareDecimalStrings('4200.00', '4200')).toBe(0);
    expect(compareDecimalStrings('4199.99', '4200')).toBe(-1);
    expect(compareDecimalStrings('4200.01', '4200')).toBe(1);
  });

  it('treats trailing zeros as equal', () => {
    expect(compareDecimalStrings('1200.000000', '1200')).toBe(0);
  });

  it('rejects a value that is not a number', () => {
    expect(() => addDecimalStrings('abc', '1')).toThrow();
  });
});

describe('Ledger', () => {
  it('marks an invoice settled when payments cover the amount', () => {
    const ledger = new Ledger(join(tmpdir(), 'unused.json'));
    ledger.addInvoice(invoice());
    ledger.applySettlement('INV-1', '4200.00', '0xabc', '2026-09-01T00:00:00.000Z');

    const updated = ledger.getInvoice('INV-1');
    expect(updated?.status).toBe('settled');
    expect(updated?.txHash).toBe('0xabc');
  });

  it('leaves an invoice open on a partial payment', () => {
    const ledger = new Ledger(join(tmpdir(), 'unused.json'));
    ledger.addInvoice(invoice());
    ledger.applySettlement('INV-1', '1000.00', '0xabc', '2026-09-01T00:00:00.000Z');

    const updated = ledger.getInvoice('INV-1');
    expect(updated?.status).toBe('open');
    expect(updated?.settledAmount).toBe('1000.000000');
    expect(ledger.openInvoices()).toHaveLength(1);
  });

  it('settles across two partial payments', () => {
    const ledger = new Ledger(join(tmpdir(), 'unused.json'));
    ledger.addInvoice(invoice());
    ledger.applySettlement('INV-1', '2000.00', '0xa', '2026-09-01T00:00:00.000Z');
    ledger.applySettlement('INV-1', '2200.00', '0xb', '2026-09-02T00:00:00.000Z');
    expect(ledger.getInvoice('INV-1')?.status).toBe('settled');
  });

  it('indexes a request id back to its invoice', () => {
    const ledger = new Ledger(join(tmpdir(), 'unused.json'));
    ledger.addInvoice(invoice());
    ledger.linkRequest('req_4471', 'INV-1');

    expect(ledger.invoiceForRequest('req_4471')?.id).toBe('INV-1');
    expect(ledger.getInvoice('INV-1')?.rnRequestId).toBe('req_4471');
    expect(ledger.invoiceForRequest('req_unknown')).toBeUndefined();
  });

  it('persists and reloads state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trueup-ledger-'));
    const path = join(dir, 'ledger.json');

    const first = new Ledger(path);
    await first.load();
    first.addInvoice(invoice());
    await first.recordSettlement({
      deliveryId: 'delivery_1',
      requestId: 'req_4471',
      invoiceId: 'INV-1',
      receivedAt: '2026-09-01T00:00:00.000Z',
      verdict: 'matched',
      confidence: 1,
      reasons: ['test'],
      txHash: '0xabc',
      executionIds: ['exec_1'],
    });
    await first.save();

    const second = new Ledger(path);
    await second.load();
    expect(second.getInvoice('INV-1')?.amount).toBe('4200.00');
    // The idempotency record surviving a restart is what stops a redelivered
    // webhook from paying twice after a redeploy.
    expect(second.recordForDelivery('delivery_1')?.executionIds).toEqual(['exec_1']);
  });

  it('starts empty when the ledger file does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trueup-missing-'));
    const ledger = new Ledger(join(dir, 'does-not-exist.json'));
    await ledger.load();
    expect(ledger.openInvoices()).toEqual([]);
  });

  it('appends an execution id once and not twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trueup-append-'));
    const path = join(dir, 'ledger.json');
    const ledger = new Ledger(path);
    await ledger.load();
    await ledger.recordSettlement({
      deliveryId: 'delivery_2',
      requestId: 'req_1',
      invoiceId: undefined,
      receivedAt: '2026-09-01T00:00:00.000Z',
      verdict: 'unmatched',
      confidence: 0,
      reasons: [],
      txHash: undefined,
      executionIds: [],
    });

    await ledger.appendExecutionId('delivery_2', 'exec_a');
    await ledger.appendExecutionId('delivery_2', 'exec_a');
    expect(ledger.recordForDelivery('delivery_2')?.executionIds).toEqual(['exec_a']);
  });
});
