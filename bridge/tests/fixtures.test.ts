/**
 * Fixture invariants and the demo's expected verdicts.
 *
 * These are not unit tests of a function; they are tests of the demo's
 * preconditions — and they exist because those preconditions were silently false.
 * The seed data shipped a 4,200 invoice paying three suppliers 1,200 / 860 / 2,140,
 * while KeeperHub bounds a single stablecoin outflow at 100 USD. Every payout the
 * demo was written around would have been refused by the per-call cap before a
 * signature was produced (verified live 2026-09-13, HTTP 400: "Stablecoin transfer
 * of 1200.00 USDC exceeds the 100.00 USD per-transaction limit"). The money shot
 * would have rendered as three blocked payouts and no value moved.
 *
 * Nothing in the build failed when that was true. It was found by hand, so it is
 * pinned here instead: re-scaling the fixtures, or changing a weight in
 * `classify.ts`, now fails a test rather than a recording.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify, type SettlementSignals } from '../src/classify.ts';
import { STABLECOIN_PER_TRANSACTION_CAP_USD } from '../src/keeperhub.ts';
import type { Invoice } from '../src/ledger.ts';

interface FixtureInvoice {
  id: string;
  customer: string;
  amount: string;
  currency: string;
  reference: string;
  issuedAt: string;
  dueAt: string;
  knownPayerAddresses: string[];
}

interface Fixture {
  invoices: FixtureInvoice[];
  suppliers: Array<{
    id: string;
    name: string;
    address: string;
    amountOwed: string;
    chainId: string;
    tokenAddress: string;
  }>;
}

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), '..', 'fixtures', 'invoices.json'), 'utf8'),
) as Fixture;

/** Builds a ledger-shaped invoice from the fixture, so `classify` can score it. */
function asInvoice(seed: FixtureInvoice): Invoice {
  return {
    id: seed.id,
    customer: seed.customer,
    amount: seed.amount,
    currency: seed.currency,
    rnRequestId: undefined,
    reference: seed.reference,
    issuedAt: seed.issuedAt,
    dueAt: seed.dueAt,
    status: 'open',
    settledAmount: '0.00',
    settledAt: undefined,
    txHash: undefined,
    knownPayerAddresses: seed.knownPayerAddresses,
  };
}

const invoices = fixture.invoices.map(asInvoice);
const invoice4471 = invoices.find((i) => i.id === 'INV-4471') as Invoice;

describe('fixture shapes the demo depends on', () => {
  it('gives every supplier a token address and a chain, so no payout can become native', () => {
    // Omitting the token address does not fail at the API — it silently becomes a
    // native transfer of the same nominal amount, under a 0.02 ETH/day cap. A
    // fixture without one is a demo that pays suppliers in the wrong asset.
    for (const supplier of fixture.suppliers) {
      expect(supplier.tokenAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(supplier.chainId).toMatch(/^\d+$/);
    }
  });

  it('keeps every supplier payout under the per-call stablecoin cap', () => {
    // The cap is a platform constant, not a preference. Above it, nothing is signed.
    for (const supplier of fixture.suppliers) {
      expect(Number(supplier.amountOwed)).toBeLessThanOrEqual(
        STABLECOIN_PER_TRANSACTION_CAP_USD,
      );
    }
  });

  it('keeps the payouts within the batch total cap, which bounds their sum', () => {
    const total = fixture.suppliers.reduce((sum, s) => sum + Number(s.amountOwed), 0);
    expect(total).toBeLessThanOrEqual(2000);
  });

  it('has the suppliers sum exactly to the invoice they settle', () => {
    // If they do not, the demo either leaves an obligation unpaid or pays out more
    // than it collected — both worse than failing here.
    const total = fixture.suppliers.reduce((sum, s) => sum + Number(s.amountOwed), 0);
    expect(total).toBeCloseTo(Number(invoice4471.amount), 6);
  });

  it('keeps three suppliers, so the batch centrepiece has something to batch', () => {
    expect(fixture.suppliers).toHaveLength(3);
  });

  it('shares a payer between INV-4471 and INV-4472 so the ambiguity guard is reachable', () => {
    const other = fixture.invoices.find((i) => i.id === 'INV-4472') as FixtureInvoice;
    const shared = invoice4471.knownPayerAddresses.filter((address) =>
      other.knownPayerAddresses.includes(address),
    );
    expect(shared).toHaveLength(1);
  });

  it('gives INV-4473 a distinct payer so the clean control case is genuinely clean', () => {
    const control = fixture.invoices.find((i) => i.id === 'INV-4473') as FixtureInvoice;
    const shared = invoice4471.knownPayerAddresses.filter((address) =>
      control.knownPayerAddresses.includes(address),
    );
    expect(shared).toHaveLength(0);
  });

  it('gives every invoice a reference equal to its id', () => {
    // The clean path needs a reference that matches; the "wrong reference" case is
    // a deliberate mutation of one, not an accident of the fixture.
    for (const invoice of fixture.invoices) {
      expect(invoice.reference).toBe(invoice.id);
    }
  });
});

describe("the demo's expected verdicts", () => {
  const settledAt = new Date('2026-09-13T20:00:00.000Z');

  it('matches the unattributed settlement to INV-4471 and pays it', () => {
    // This is the money shot: no reference on the payment, but the amount equals the
    // outstanding balance, the payer is known, and it landed inside the window.
    const signals: SettlementSignals = {
      reference: undefined,
      payerAddresses: ['0xA11CE0000000000000000000000000000000dEAd'],
      amountPaid: invoice4471.amount,
      expectedAmount: invoice4471.amount,
      paidAt: settledAt,
    };

    const result = classify(signals, invoices, { autoApprove: 0.85, hold: 0.55 });

    expect(result.verdict).toBe('matched');
    expect(result.invoiceId).toBe('INV-4471');
    expect(result.confidence).toBeCloseTo(0.95, 9);
    expect(result.reasons.join(' ')).toMatch(/equals the outstanding balance/);
    expect(result.reasons.join(' ')).toMatch(/no reference on the settlement/);
  });

  it('does not hand the same settlement to INV-4472', () => {
    // INV-4472 shares the payer, so it scores on the payer signal and the window.
    // It must lose to the invoice whose amount actually matches.
    const signals: SettlementSignals = {
      reference: undefined,
      payerAddresses: ['0xA11CE0000000000000000000000000000000dEAd'],
      amountPaid: invoice4471.amount,
      expectedAmount: invoice4471.amount,
      paidAt: settledAt,
    };

    const result = classify(signals, invoices, { autoApprove: 0.85, hold: 0.55 });
    const runnerUp = result.candidates[1];

    expect(runnerUp?.invoiceId).toBe('INV-4472');
    expect(runnerUp?.confidence).toBeLessThan(0.85);
  });

  it('attributes the clean control case decisively on an exact reference', () => {
    const control = invoices.find((i) => i.id === 'INV-4473') as Invoice;
    const signals: SettlementSignals = {
      reference: 'INV-4473',
      payerAddresses: ['0xB0b0000000000000000000000000000000000F00D'],
      amountPaid: control.amount,
      expectedAmount: control.amount,
      paidAt: settledAt,
    };

    const result = classify(signals, invoices, { autoApprove: 0.85, hold: 0.55 });

    expect(result.verdict).toBe('attributed');
    expect(result.invoiceId).toBe('INV-4473');
    expect(result.confidence).toBe(1);
  });

  it('holds rather than pays when the payer is unknown and the amount is all it has', () => {
    // The brake. An unknown payer matching on amount alone scores 0.60 — above the
    // hold threshold, below auto-approve — so it stages for release instead of paying.
    const signals: SettlementSignals = {
      reference: undefined,
      payerAddresses: ['0xDEADBEEF00000000000000000000000000000099'],
      amountPaid: invoice4471.amount,
      expectedAmount: invoice4471.amount,
      paidAt: settledAt,
    };

    const result = classify(signals, invoices, { autoApprove: 0.85, hold: 0.55 });

    expect(result.verdict).toBe('held');
    expect(result.confidence).toBeCloseTo(0.6, 9);
  });
});
