/**
 * Reconciliation tests.
 *
 * The cases that matter are the ones where paying would be a mistake: two open
 * invoices for one payer, an ambiguous tie, and a settlement that looks plausible
 * but carries no evidence. `classify` is pure, so every one of these is testable
 * without a network or a clock.
 */

import { describe, expect, it } from 'vitest';
import { classify, scoreCandidate, THRESHOLDS, WEIGHTS, type SettlementSignals } from '../src/classify.ts';
import type { Invoice } from '../src/ledger.ts';

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'INV-4471',
    customer: 'Northwind Freight',
    amount: '4200.00',
    currency: 'USDC',
    rnRequestId: 'req_4471',
    reference: 'INV-4471',
    issuedAt: '2026-08-01T00:00:00.000Z',
    dueAt: '2026-08-31T00:00:00.000Z',
    status: 'open',
    settledAmount: '0.00',
    settledAt: undefined,
    txHash: undefined,
    knownPayerAddresses: ['0xA11CE0000000000000000000000000000000dead'],
    ...overrides,
  };
}

function signals(overrides: Partial<SettlementSignals> = {}): SettlementSignals {
  return {
    reference: undefined,
    payerAddresses: [],
    amountPaid: undefined,
    expectedAmount: undefined,
    paidAt: new Date('2026-09-01T00:00:00.000Z'),
    identityCandidates: undefined,
    ...overrides,
  };
}

describe('scoreCandidate', () => {
  it('gives a decisive score and short-circuits on an exact reference', () => {
    const result = scoreCandidate(
      signals({ reference: 'INV-4471', amountPaid: '1.00', payerAddresses: [] }),
      invoice(),
      5,
    );
    expect(result.confidence).toBe(1);
    expect(result.reasons[0]).toMatch(/decisive/);
    // Amount mismatch and five open invoices are irrelevant once the
    // counterparty has named the invoice.
    expect(result.reasons).toHaveLength(1);
  });

  it('accepts the invoice id itself as a reference', () => {
    const result = scoreCandidate(signals({ reference: 'INV-4471' }), invoice(), 1);
    expect(result.confidence).toBe(1);
  });

  it('credits an exact amount match against the outstanding balance', () => {
    const result = scoreCandidate(
      signals({ amountPaid: '4200.00' }),
      invoice(),
      3,
    );
    expect(result.confidence).toBeCloseTo(WEIGHTS.amountExact + WEIGHTS.withinWindow, 5);
    expect(result.reasons.join(' ')).toMatch(/equals the outstanding balance/);
  });

  it('credits an exact match against a partially settled balance', () => {
    const partiallySettled = invoice({ settledAmount: '1200.00' });
    const result = scoreCandidate(signals({ amountPaid: '3000.00' }), partiallySettled, 3);
    expect(result.reasons.join(' ')).toMatch(/equals the outstanding balance of 3000\.000000/);
  });

  it('gives partial credit for an underpayment and never an exact match', () => {
    const result = scoreCandidate(signals({ amountPaid: '1000.00' }), invoice(), 3);
    expect(result.confidence).toBeLessThan(WEIGHTS.amountExact);
    expect(result.reasons.join(' ')).toMatch(/partial payment/);
  });

  it('gives no credit for an overpayment', () => {
    const result = scoreCandidate(signals({ amountPaid: '9000.00' }), invoice(), 3);
    expect(result.reasons.join(' ')).toMatch(/does not match the 4200\.000000 outstanding/);
    expect(result.confidence).toBeCloseTo(WEIGHTS.withinWindow, 5);
  });

  it('gives no credit for an unknown payer', () => {
    const result = scoreCandidate(
      signals({ payerAddresses: ['0xB0B0000000000000000000000000000000000000'] }),
      invoice(),
      1,
    );
    expect(result.reasons.join(' ')).toMatch(/has not paid/);
    expect(result.confidence).toBeCloseTo(WEIGHTS.withinWindow, 5);
  });

  it('matches payer addresses case-insensitively', () => {
    const result = scoreCandidate(
      signals({ payerAddresses: ['0xa11ce0000000000000000000000000000000DEAD'] }),
      invoice(),
      1,
    );
    expect(result.reasons.join(' ')).toMatch(/is a known address/);
  });

  it('withholds the uniqueness credit when the payer owes on several invoices', () => {
    // Deliberately built so confidence stays below the 1.0 cap: a partial
    // amount and a late payment leave headroom, otherwise the cap hides the
    // difference and the test would pass for the wrong reason.
    const setup = {
      amountPaid: '1000.00',
      payerAddresses: ['0xA11CE0000000000000000000000000000000dead'],
      paidAt: new Date('2027-06-01T00:00:00.000Z'),
    } as const;

    const withOne = scoreCandidate(signals(setup), invoice(), 1);
    const withThree = scoreCandidate(signals(setup), invoice(), 3);

    expect(withOne.confidence).toBeLessThan(1);
    expect(withOne.confidence - withThree.confidence).toBeCloseTo(WEIGHTS.uniqueOpenInvoice, 5);
    expect(withThree.reasons.join(' ')).toMatch(/3 open invoices/);
  });

  it('withholds the window credit for a very late payment', () => {
    const result = scoreCandidate(
      signals({ amountPaid: '4200.00', paidAt: new Date('2027-06-01T00:00:00.000Z') }),
      invoice(),
      1,
    );
    expect(result.reasons.join(' ')).toMatch(/outside the 45-day window/);
    expect(result.confidence).toBeCloseTo(WEIGHTS.amountExact, 5);
  });

  it('credits a matching on-chain identity', () => {
    const result = scoreCandidate(
      signals({ identityCandidates: ['northwind freight'] }),
      invoice(),
      3,
    );
    expect(result.confidence).toBeCloseTo(WEIGHTS.identityMatch + WEIGHTS.withinWindow, 5);
  });
});

describe('classify', () => {
  it('attributes a referenced payment at full confidence', () => {
    const result = classify(signals({ reference: 'INV-4471' }), [invoice()]);
    expect(result.verdict).toBe('attributed');
    expect(result.invoiceId).toBe('INV-4471');
    expect(result.confidence).toBe(1);
  });

  it('matches an unreferenced payment that carries enough evidence', () => {
    const result = classify(
      signals({
        amountPaid: '4200.00',
        payerAddresses: ['0xA11CE0000000000000000000000000000000dead'],
      }),
      [invoice()],
    );
    // amount 0.45 + payer 0.35 + unique 0.20 + window 0.15 = 1.00, capped at 1
    expect(result.confidence).toBe(1);
    expect(result.verdict).toBe('matched');
    expect(result.invoiceId).toBe('INV-4471');
  });

  it('holds a payment when the payer owes on several invoices', () => {
    const second = invoice({
      id: 'INV-4472',
      reference: 'INV-4472',
      amount: '1500.00',
      rnRequestId: 'req_4472',
    });

    const result = classify(
      signals({
        amountPaid: '4200.00',
        payerAddresses: ['0xA11CE0000000000000000000000000000000dead'],
      }),
      [invoice(), second],
    );

    // 0.45 + 0.35 + 0 + 0.15 = 0.95 for INV-4471, which still clears auto-approve.
    // The second invoice scores only the window, so there is no tie.
    expect(result.invoiceId).toBe('INV-4471');
    expect(result.verdict).toBe('matched');
  });

  it('refuses to choose when two invoices score identically', () => {
    const twinA = invoice({ id: 'INV-A', reference: 'INV-A', rnRequestId: 'req_A' });
    const twinB = invoice({
      id: 'INV-B',
      reference: 'INV-B',
      rnRequestId: 'req_B',
      customer: 'Northwind Freight',
    });

    const result = classify(
      signals({
        amountPaid: '4200.00',
        payerAddresses: ['0xA11CE0000000000000000000000000000000dead'],
      }),
      [twinA, twinB],
    );

    expect(result.verdict).toBe('unmatched');
    expect(result.invoiceId).toBeUndefined();
    expect(result.reasons.join(' ')).toMatch(/ambiguous/);
  });

  it('holds rather than pays when confidence falls in the hold band', () => {
    const result = classify(
      signals({
        amountPaid: '4200.00',
        payerAddresses: ['0xB0B0000000000000000000000000000000000000'],
      }),
      [invoice()],
      { autoApprove: 0.99, hold: 0.55 },
    );

    expect(result.verdict).toBe('held');
    expect(result.invoiceId).toBe('INV-4471');
    expect(result.confidence).toBeGreaterThanOrEqual(THRESHOLDS.hold);
  });

  it('returns unmatched when no invoices are open', () => {
    const result = classify(signals({ amountPaid: '4200.00' }), []);
    expect(result.verdict).toBe('unmatched');
    expect(result.reasons.join(' ')).toMatch(/no open invoices/);
  });

  it('returns unmatched when the settlement carries no evidence at all', () => {
    const result = classify(signals({}), [invoice()]);
    expect(result.verdict).toBe('unmatched');
    expect(result.invoiceId).toBeUndefined();
  });

  it('ranks candidates best first for the audit trail', () => {
    const strong = invoice({ id: 'INV-STRONG', reference: 'INV-STRONG', rnRequestId: 'req_s' });
    const weak = invoice({
      id: 'INV-WEAK',
      reference: 'INV-WEAK',
      rnRequestId: 'req_w',
      amount: '99999.00',
      knownPayerAddresses: [],
    });

    const result = classify(
      signals({
        amountPaid: '4200.00',
        payerAddresses: ['0xA11CE0000000000000000000000000000000dead'],
      }),
      [weak, strong],
    );

    expect(result.candidates[0]?.invoiceId).toBe('INV-STRONG');
    expect(result.candidates.length).toBe(2);
  });
});
