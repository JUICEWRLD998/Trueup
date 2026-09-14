/**
 * Invoice intake — how a real receivable enters the system.
 *
 * Until this existed, the only way invoices and their payables got into the
 * ledger was `scripts/seed-demo.ts` reading `fixtures/invoices.json`. That is a
 * demo harness, not a product surface: it can only load the three invoices
 * written into it, and every rule about what makes an invoice payable lived in a
 * test asserting against that one file.
 *
 * This module is the product surface. One implementation, three callers — the
 * HTTP endpoint (`POST /invoices`), the CLI (`scripts/add-invoice.ts`), and the
 * tests — so a rule cannot be enforced on one path and skipped on another.
 *
 * The rules are refusals, and each one refuses because the alternative is money
 * moving wrongly:
 *
 *   1. A payable with no token address would become a NATIVE transfer of the same
 *      nominal amount (KeeperHub does not error on the omission).
 *   2. A payable above the per-transaction stablecoin cap cannot be signed at all,
 *      so accepting it means a settlement that half-pays and half-fails.
 *   3. Payables that do not sum to the invoice leave an obligation stranded or
 *      over-collect from the settlement.
 *   4. Re-registering a settled invoice would rewrite history that the delivery
 *      records already reference.
 */

import { z } from 'zod';
import { STABLECOIN_PER_TRANSACTION_CAP_USD } from './keeperhub.ts';
import { compareDecimalStrings, addDecimalStrings, type Invoice, type Ledger, type Payable } from './ledger.ts';

/**
 * KeeperHub bounds a batch payout's *total* as well as each call inside it
 * (`spend-cap-defaults.ts:88`). Intake refuses a set of payables the platform
 * would refuse, rather than discovering it per payout at settlement time.
 */
export const BATCH_TOTAL_CAP_USD = 2000;

/**
 * Currencies the per-transaction cap is defined for. A payroll in an unlisted
 * token is not refused because it is unusual — it is refused because we cannot
 * state the limit that applies to it, and paying past an unknown limit is the
 * failure this product exists to prevent.
 */
export const STABLECOIN_CURRENCIES = ['USDC', 'FAU', 'USDT', 'DAI', 'EURC'] as const;

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte hex address');

const decimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string, e.g. "18.00"');

const isoDate = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO-8601 date');

const chainId = z.string().regex(/^\d+$/, 'must be a numeric chain id as a string');

export const PayableInputSchema = z.object({
  id: z.string().min(1),
  supplierId: z.string().min(1),
  supplierName: z.string().min(1),
  address,
  /** Payout amount for this payable. */
  amountOwed: decimal,
  chainId,
  /**
   * Required. Omitting it is not an error at KeeperHub — it silently becomes a
   * native transfer of the same nominal amount under a different, far smaller cap.
   */
  tokenAddress: address,
});

export const InvoiceInputSchema = z.object({
  id: z.string().min(1),
  customer: z.string().min(1),
  amount: decimal,
  currency: z.string().min(1),
  /** Sent to Request Network so it travels with the payment. */
  reference: z.string().min(1),
  issuedAt: isoDate,
  dueAt: isoDate,
  /** At least one: a settlement with no known payer cannot be matched at all. */
  knownPayerAddresses: z.array(address).min(1),
});

export const IntakeRequestSchema = z.object({
  invoice: InvoiceInputSchema,
  payables: z.array(PayableInputSchema).min(1),
});

export type IntakeRequest = z.infer<typeof IntakeRequestSchema>;

export interface IntakeResult {
  readonly invoice: Invoice;
  readonly payables: readonly Payable[];
  /** What we did to an existing record, if anything. */
  readonly notes: readonly string[];
}

export interface IntakeDeps {
  readonly ledger: Ledger;
  /**
   * Creates the Request Network payment request for an invoice and returns the
   * id to link it to. Omitted (CLI, local use) means the invoice is registered
   * without a payment link, which is a legitimate state — the request can be
   * created later.
   */
  readonly createRequest?: ((invoice: Invoice) => Promise<string>) | undefined;
}

export class IntakeError extends Error {
  override readonly name = 'IntakeError';
  /** Every reason this payload was refused, not just the first. */
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(`invoice intake refused:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    this.errors = errors;
  }
}

/**
 * Validates a payload against the ledger without changing either.
 *
 * Pure apart from reading the ledger, so it is the one place the rules live and
 * it can be exercised without a socket or a file.
 */
export function validateIntake(
  input: IntakeRequest,
  ledger: Ledger,
): { errors: string[]; notes: string[] } {
  const errors: string[] = [];
  const notes: string[] = [];

  const { invoice, payables } = input;

  // --- the invoice itself -------------------------------------------------
  const existing = ledger.getInvoice(invoice.id);
  if (existing !== undefined && existing.status === 'settled') {
    errors.push(
      `invoice ${invoice.id} is already settled (${existing.settledAmount} of ${existing.amount}); ` +
        `re-registering it would rewrite an obligation the settlement records already reference`,
    );
  } else if (existing !== undefined) {
    notes.push(
      `invoice ${invoice.id} already existed as ${existing.status}; replacing it and its payables`,
    );
  }

  if (!(STABLECOIN_CURRENCIES as readonly string[]).includes(invoice.currency.toUpperCase())) {
    errors.push(
      `currency ${invoice.currency} is not one of ${STABLECOIN_CURRENCIES.join(', ')} — the ` +
        `${STABLECOIN_PER_TRANSACTION_CAP_USD} USD per-transaction cap is defined for stablecoins, ` +
        `and we will not accept a payout whose limit we cannot state`,
    );
  }

  if (compareDecimalStrings(invoice.amount, '0') <= 0) {
    errors.push(`invoice ${invoice.id} has a non-positive amount (${invoice.amount})`);
  }

  if (Date.parse(invoice.dueAt) < Date.parse(invoice.issuedAt)) {
    errors.push(`invoice ${invoice.id} is due (${invoice.dueAt}) before it was issued (${invoice.issuedAt})`);
  }

  // --- the payables -------------------------------------------------------
  const seenPayableIds = new Set<string>();
  for (const payable of payables) {
    if (seenPayableIds.has(payable.id)) {
      errors.push(`payable id ${payable.id} appears more than once`);
    }
    seenPayableIds.add(payable.id);

    if (compareDecimalStrings(payable.amountOwed, '0') <= 0) {
      errors.push(`payable ${payable.id} has a non-positive amount (${payable.amountOwed})`);
    }
    if (compareDecimalStrings(payable.amountOwed, String(STABLECOIN_PER_TRANSACTION_CAP_USD)) > 0) {
      errors.push(
        `payable ${payable.id} pays ${payable.amountOwed}, above KeeperHub's ` +
          `${STABLECOIN_PER_TRANSACTION_CAP_USD} USD per-transaction stablecoin cap — nothing ` +
          `would be signed. Split the payout across invoices or raise the org's cap first`,
      );
    }
  }

  // --- the invariant that makes a settlement whole -------------------------
  const total = payables.reduce((sum, payable) => addDecimalStrings(sum, payable.amountOwed), '0.00');
  if (compareDecimalStrings(total, invoice.amount) !== 0) {
    const short = compareDecimalStrings(total, invoice.amount) < 0;
    errors.push(
      `payables total ${total} but invoice ${invoice.id} is ${invoice.amount} — ` +
        (short
          ? `${invoice.amount} minus ${total} would be collected and never paid out`
          : `${total} minus ${invoice.amount} would be paid out of money never collected`),
    );
  }
  if (compareDecimalStrings(total, String(BATCH_TOTAL_CAP_USD)) > 0) {
    errors.push(`payables total ${total} is above the ${BATCH_TOTAL_CAP_USD} USD batch cap`);
  }

  return { errors, notes };
}

/**
 * Validates and registers an invoice with its payables.
 *
 * Upsert on an open invoice (re-registration replaces the payables), refusal on a
 * settled one. Throws `IntakeError` listing every reason rather than the first,
 * so an operator fixes a payload in one pass.
 */
export async function registerInvoice(
  input: IntakeRequest,
  deps: IntakeDeps,
): Promise<IntakeResult> {
  const { ledger } = deps;
  const { errors, notes } = validateIntake(input, ledger);
  if (errors.length > 0) {
    throw new IntakeError(errors);
  }
  const { invoice, payables } = input;
  const existing = ledger.getInvoice(invoice.id);
  const record: Invoice = {
    id: invoice.id,
    customer: invoice.customer,
    amount: invoice.amount,
    currency: invoice.currency,
    // A re-registration keeps the payment link: the request already exists at
    // Request Network and re-creating it would produce a second payable invoice.
    rnRequestId: existing?.rnRequestId,
    reference: invoice.reference,
    issuedAt: invoice.issuedAt,
    dueAt: invoice.dueAt,
    status: existing?.status ?? 'open',
    settledAmount: existing?.settledAmount ?? '0.00',
    settledAt: existing?.settledAt,
    txHash: existing?.txHash,
    knownPayerAddresses: invoice.knownPayerAddresses,
  };

  const rows: Payable[] = payables.map((payable) => ({
    id: payable.id,
    invoiceId: invoice.id,
    supplierId: payable.supplierId,
    supplierName: payable.supplierName,
    address: payable.address,
    amountOwed: payable.amountOwed,
    chainId: payable.chainId,
    tokenAddress: payable.tokenAddress,
  }));

  // The Request Network call goes first, before anything is mutated: if it fails,
  // the ledger is left exactly as it was rather than holding an invoice whose
  // payment link never got created.
  let requestId = record.rnRequestId;
  if (deps.createRequest !== undefined && requestId === undefined) {
    requestId = await deps.createRequest(record);
    notes.push(`created Request Network payment request ${requestId}`);
  }

  ledger.addInvoice(requestId === undefined ? record : { ...record, rnRequestId: requestId });
  ledger.setPayablesForInvoice(invoice.id, rows);
  if (requestId !== undefined) {
    ledger.linkRequest(requestId, record.id);
  }

  await ledger.save();

  return { invoice: ledger.getInvoice(invoice.id) ?? record, payables: rows, notes };
}
