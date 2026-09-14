/**
 * Invoice intake tests.
 *
 * Intake is where an operator tells this system who to pay. Every rule here is a
 * refusal, and each one refuses because the alternative moves money wrongly:
 *
 *   - a payable with no token address becomes a NATIVE transfer of the same
 *     nominal amount, silently;
 *   - a payable above the per-transaction cap cannot be signed at all;
 *   - payables that do not sum to the invoice either strand an obligation or
 *     over-collect from the settlement;
 *   - re-registering a settled invoice rewrites obligations the settlement
 *     records already reference.
 *
 * The first test is the one that matters most: a registered invoice's payables are
 * readable ONLY through that invoice, which is the property whose absence used to
 * let one settlement pay another invoice's counterparties.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IntakeError, registerInvoice, validateIntake, type IntakeRequest } from '../src/intake.ts';
import { Ledger } from '../src/ledger.ts';

const SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

function request(overrides: Partial<IntakeRequest> = {}): IntakeRequest {
  return {
    invoice: {
      id: 'INV-5001',
      customer: 'Northwind Freight',
      amount: '18.00',
      currency: 'USDC',
      reference: 'INV-5001',
      issuedAt: '2026-09-01T00:00:00.000Z',
      dueAt: '2026-09-30T00:00:00.000Z',
      knownPayerAddresses: ['0xA11CE0000000000000000000000000000000dEAd'],
    },
    payables: [
      {
        id: 'PAY-5001-CARRIER',
        supplierId: 'SUP-CARRIER',
        supplierName: 'Cascade Carriers',
        address: '0xC0FFEE0000000000000000000000000000000001',
        amountOwed: '6.00',
        chainId: '11155111',
        tokenAddress: SEPOLIA_USDC,
      },
      {
        id: 'PAY-5001-FUEL',
        supplierId: 'SUP-FUEL',
        supplierName: 'Pike Fuel Services',
        address: '0xC0FFEE0000000000000000000000000000000002',
        amountOwed: '12.00',
        chainId: '11155111',
        tokenAddress: SEPOLIA_USDC,
      },
    ],
    ...overrides,
  };
}

async function freshLedger(): Promise<Ledger> {
  const dir = await mkdtemp(join(tmpdir(), 'trueup-intake-'));
  const ledger = new Ledger(join(dir, 'ledger.json'));
  await ledger.load();
  return ledger;
}

describe('registering an invoice', () => {
  it('binds every payable to its invoice, and reads them back through it', async () => {
    const ledger = await freshLedger();
    const result = await registerInvoice(request(), { ledger });

    expect(result.invoice.id).toBe('INV-5001');
    expect(ledger.payablesForInvoice('INV-5001')).toHaveLength(2);
    // The point: a second invoice's payables are invisible to the first.
    expect(ledger.payablesForInvoice('INV-9999')).toEqual([]);
    expect(ledger.payablesTotalForInvoice('INV-5001')).toBe('18.000000');
  });

  it('persists, so a restart keeps the book', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trueup-intake-persist-'));
    const first = new Ledger(join(dir, 'ledger.json'));
    await first.load();
    await registerInvoice(request(), { ledger: first });

    const second = new Ledger(join(dir, 'ledger.json'));
    await second.load();
    expect(second.getInvoice('INV-5001')?.amount).toBe('18.00');
    expect(second.payablesForInvoice('INV-5001')).toHaveLength(2);
  });

  it('replaces the payables when an open invoice is re-registered', async () => {
    const ledger = await freshLedger();
    await registerInvoice(request(), { ledger });

    const trimmed = request();
    await registerInvoice(
      {
        ...trimmed,
        payables: [trimmed.payables[0] as IntakeRequest['payables'][number]],
        invoice: { ...trimmed.invoice, amount: '6.00' },
      },
      { ledger },
    );

    expect(ledger.payablesForInvoice('INV-5001')).toHaveLength(1);
    expect(ledger.snapshot().payables['PAY-5001-FUEL']).toBeUndefined();
  });

  it('creates the Request Network request and links it, when asked', async () => {
    const ledger = await freshLedger();
    const createRequest = vi.fn(() => Promise.resolve('req_live_1'));

    const result = await registerInvoice(request(), { ledger, createRequest });

    expect(createRequest).toHaveBeenCalledTimes(1);
    expect(result.invoice.rnRequestId).toBe('req_live_1');
    expect(ledger.invoiceForRequest('req_live_1')?.id).toBe('INV-5001');
  });

  it('does not create a second request for an invoice that already has one', async () => {
    const ledger = await freshLedger();
    const createRequest = vi.fn(() => Promise.resolve('req_live_1'));

    await registerInvoice(request(), { ledger, createRequest });
    await registerInvoice(request(), { ledger, createRequest });

    expect(createRequest).toHaveBeenCalledTimes(1);
    expect(ledger.getInvoice('INV-5001')?.rnRequestId).toBe('req_live_1');
  });

  it('leaves the ledger untouched when creating the request fails', async () => {
    // The ledger must not hold an invoice whose payment link was never created —
    // that is a receivable nothing can settle.
    const ledger = await freshLedger();
    const createRequest = vi.fn(() => Promise.reject(new Error('Request Network is down')));

    await expect(registerInvoice(request(), { ledger, createRequest })).rejects.toThrow(
      /Request Network is down/,
    );

    expect(ledger.getInvoice('INV-5001')).toBeUndefined();
    expect(ledger.snapshot().payables).toEqual({});
  });
});

describe('what intake refuses', () => {
  it('refuses payables that total less than the invoice', async () => {
    const ledger = await freshLedger();
    const short = request();
    const payload: IntakeRequest = {
      ...short,
      payables: [short.payables[0] as IntakeRequest['payables'][number]],
    };

    const errors = validateIntake(payload, ledger).errors;
    expect(errors.join(' ')).toMatch(/collected and never paid out/);
  });

  it('refuses payables that total more than the invoice', async () => {
    const ledger = await freshLedger();
    const over = request();
    const payload: IntakeRequest = {
      ...over,
      payables: [
        { ...(over.payables[0] as IntakeRequest['payables'][number]), amountOwed: '20.00' },
      ],
    };

    expect(validateIntake(payload, ledger).errors.join(' ')).toMatch(/never collected/);
  });

  it('refuses a payout above the platform per-transaction cap', async () => {
    const ledger = await freshLedger();
    const big = request();
    const payload: IntakeRequest = {
      ...big,
      invoice: { ...big.invoice, amount: '1200.00' },
      payables: [
        { ...(big.payables[0] as IntakeRequest['payables'][number]), amountOwed: '1200.00' },
      ],
    };

    expect(validateIntake(payload, ledger).errors.join(' ')).toMatch(/100 USD per-transaction/);
  });

  it('refuses a currency whose cap we cannot state', async () => {
    const ledger = await freshLedger();
    const payload = request();
    const errors = validateIntake(
      { ...payload, invoice: { ...payload.invoice, currency: 'SHIB' } },
      ledger,
    ).errors;

    expect(errors.join(' ')).toMatch(/is not one of USDC/);
  });

  it('refuses a duplicated payable id', async () => {
    const ledger = await freshLedger();
    const duplicated = request();
    const first = duplicated.payables[0] as IntakeRequest['payables'][number];
    const payload: IntakeRequest = {
      ...duplicated,
      payables: [first, { ...first, amountOwed: '12.00' }],
    };

    expect(validateIntake(payload, ledger).errors.join(' ')).toMatch(/appears more than once/);
  });

  it('refuses to rewrite an invoice that is already settled', async () => {
    const ledger = await freshLedger();
    await registerInvoice(request(), { ledger });
    ledger.applySettlement('INV-5001', '18.00', '0xabc', '2026-09-20T00:00:00.000Z');

    await expect(registerInvoice(request(), { ledger })).rejects.toBeInstanceOf(IntakeError);
    expect(validateIntake(request(), ledger).errors.join(' ')).toMatch(/already settled/);
  });

  it('lists every reason, not just the first', async () => {
    const ledger = await freshLedger();
    const broken = request();
    const payload: IntakeRequest = {
      ...broken,
      invoice: { ...broken.invoice, amount: '50.00', currency: 'SHIB' },
      payables: [
        { ...(broken.payables[0] as IntakeRequest['payables'][number]), amountOwed: '6.00' },
      ],
    };

    const errors = validateIntake(payload, ledger).errors;
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.join(' ')).toMatch(/is not one of USDC/);
    expect(errors.join(' ')).toMatch(/collected and never paid out/);
  });
});
