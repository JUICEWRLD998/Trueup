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
 *
 * The same reasoning applies to the payable/invoice binding: the seed used to be a
 * flat supplier list with no invoice on it, so any invoice that settled paid every
 * counterparty in the book. That is asserted here too, and the fixture deliberately
 * puts one supplier on two invoices so the assertion has something to catch.
 */

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify, type SettlementSignals } from '../src/classify.ts';
import { validateIntake, IntakeRequestSchema, type IntakeRequest } from '../src/intake.ts';
import { STABLECOIN_PER_TRANSACTION_CAP_USD } from '../src/keeperhub.ts';
import { Ledger, type Invoice } from '../src/ledger.ts';

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

interface FixturePayable {
  id: string;
  invoiceId: string;
  supplierId: string;
  supplierName: string;
  address: string;
  amountOwed: string;
  chainId: string;
  tokenAddress: string;
}

interface Fixture {
  invoices: FixtureInvoice[];
  payables: FixturePayable[];
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
const payablesOf = (invoiceId: string): FixturePayable[] =>
  fixture.payables.filter((payable) => payable.invoiceId === invoiceId);

describe('fixture shapes the demo depends on', () => {
  it('binds every payable to an invoice that exists', () => {
    // An unbound payable — or a lookup that ignored the invoice — means settling any
    // invoice pays whichever counterparties are in the book.
    const ids = new Set(fixture.invoices.map((invoice) => invoice.id));
    for (const payable of fixture.payables) {
      expect(ids.has(payable.invoiceId)).toBe(true);
      expect(payable.invoiceId).not.toBe('');
    }
  });

  it('puts one supplier on two invoices, so the binding is actually exercised', () => {
    const bySupplier = new Map<string, Set<string>>();
    for (const payable of fixture.payables) {
      const set = bySupplier.get(payable.supplierId) ?? new Set<string>();
      set.add(payable.invoiceId);
      bySupplier.set(payable.supplierId, set);
    }
    const shared = [...bySupplier.entries()].filter(([, set]) => set.size > 1);
    expect(shared.length).toBeGreaterThan(0);
  });

  it('gives every payable a token address and a chain, so no payout can become native', () => {
    // Omitting the token address does not fail at the API — it silently becomes a
    // native transfer of the same nominal amount, under a 0.02 ETH/day cap. A
    // fixture without one is a demo that pays suppliers in the wrong asset.
    for (const payable of fixture.payables) {
      expect(payable.tokenAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(payable.chainId).toMatch(/^\d+$/);
    }
  });

  it('uses 40-hex-digit addresses everywhere', () => {
    // The fixture's INV-4473 payer shipped as 41 hex digits for two phases and
    // nothing noticed, because everything downstream only compared addresses as
    // strings. An address that is not 40 hex digits is not an address, and intake
    // would refuse it — so the demo data would not be registrable through the
    // product's own path.
    for (const invoice of fixture.invoices) {
      for (const payer of invoice.knownPayerAddresses) {
        expect(payer).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    }
    for (const payable of fixture.payables) {
      expect(payable.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(payable.tokenAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it('keeps every payout under the per-call stablecoin cap', () => {
    // The cap is a platform constant, not a preference. Above it, nothing is signed.
    for (const payable of fixture.payables) {
      expect(Number(payable.amountOwed)).toBeLessThanOrEqual(
        STABLECOIN_PER_TRANSACTION_CAP_USD,
      );
    }
  });

  it('keeps each invoice\u2019s payouts within the batch total cap, which bounds their sum', () => {
    for (const invoice of fixture.invoices) {
      const total = payablesOf(invoice.id).reduce((sum, p) => sum + Number(p.amountOwed), 0);
      expect(total).toBeLessThanOrEqual(2000);
    }
  });

  it('has each invoice\u2019s payables sum exactly to that invoice', () => {
    // If they do not, the settlement either leaves an obligation unpaid or pays out
    // more than it collected — both worse than failing here. Checked per invoice,
    // because summing the whole book would pass while an individual invoice was wrong.
    for (const invoice of fixture.invoices) {
      const total = payablesOf(invoice.id).reduce((sum, p) => sum + Number(p.amountOwed), 0);
      expect(total).toBeCloseTo(Number(invoice.amount), 6);
    }
  });

  it('keeps three payables on INV-4471, so the batch centrepiece has something to batch', () => {
    expect(payablesOf('INV-4471')).toHaveLength(3);
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

describe('the fixture against the real intake rules', () => {
  it('passes validation exactly as a customer-supplied invoice would', () => {
    // The demo data has to be registrable through the product's own path. If a
    // fixture could only be loaded by the seed script, the demo would be proving
    // something about the seed rather than about the product.
    //
    // Parsed through the same schema `POST /invoices` uses, not just the semantic
    // rules — a malformed address would otherwise pass here and be refused by the
    // HTTP endpoint, which is the gap this test exists to close.
    const ledger = new Ledger(join(tmpdir(), 'unused-fixture-ledger.json'));

    for (const invoice of fixture.invoices) {
      const candidate = {
        invoice: {
          id: invoice.id,
          customer: invoice.customer,
          amount: invoice.amount,
          currency: invoice.currency,
          reference: invoice.reference,
          issuedAt: invoice.issuedAt,
          dueAt: invoice.dueAt,
          knownPayerAddresses: invoice.knownPayerAddresses,
        },
        payables: payablesOf(invoice.id).map((payable) => ({
          id: payable.id,
          supplierId: payable.supplierId,
          supplierName: payable.supplierName,
          address: payable.address,
          amountOwed: payable.amountOwed,
          chainId: payable.chainId,
          tokenAddress: payable.tokenAddress,
        })),
      };

      const parsed = IntakeRequestSchema.safeParse(candidate);
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(parsed.success).toBe(true);

      const request = candidate as IntakeRequest;
      expect(validateIntake(request, ledger).errors).toEqual([]);
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
      // Taken from the fixture rather than hand-typed, so a typo here cannot quietly
      // turn the control case into a test of a stranger's address.
      payerAddresses: control.knownPayerAddresses,
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
