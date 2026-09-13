/**
 * Ledger — invoices, settlements, and the idempotency record that stops a
 * redelivered webhook from paying a supplier twice.
 *
 * Storage is an append-only JSON file written atomically (temp file + rename).
 * That is a deliberate choice for a five-day build: it has no native dependency,
 * a judge can read the state directly, and it is honest about its limits. The
 * production swap is Postgres with a unique constraint on the delivery id — noted
 * in docs/limits.md. The in-memory interface below is what that swap preserves.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface Invoice {
  readonly id: string;
  readonly customer: string;
  /** Human-readable decimal amount, e.g. `"4200.00"`. */
  readonly amount: string;
  readonly currency: string;
  /** Request Network request id once a payment request has been created. */
  rnRequestId: string | undefined;
  /** Our reference, sent to Request Network so it travels with the payment. */
  readonly reference: string;
  readonly issuedAt: string;
  readonly dueAt: string;
  status: 'open' | 'settled' | 'cancelled';
  /** Paid so far, as a decimal string. Supports partial settlement. */
  settledAmount: string;
  settledAt: string | undefined;
  txHash: string | undefined;
  /** Known payer addresses for this customer. Used as a matching signal. */
  readonly knownPayerAddresses: string[];
}

export interface Supplier {
  readonly id: string;
  readonly name: string;
  /** Payout address. */
  readonly address: string;
  /** Amount owed, as a decimal string. */
  readonly amountOwed: string;
  readonly chainId: string;
  readonly tokenAddress: string | undefined;
}

export interface SettlementRecord {
  /** Request Network delivery id (ULID) — the idempotency key. */
  readonly deliveryId: string;
  readonly requestId: string;
  readonly invoiceId: string | undefined;
  readonly receivedAt: string;
  readonly verdict: 'attributed' | 'matched' | 'held' | 'unmatched' | 'ignored';
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly txHash: string | undefined;
  /** KeeperHub execution ids produced while acting on this settlement. */
  executionIds: string[];
}

export interface LedgerState {
  invoices: Record<string, Invoice>;
  suppliers: Record<string, Supplier>;
  /** Keyed by delivery id. Presence means the delivery has been handled. */
  deliveries: Record<string, SettlementRecord>;
  /** Keyed by Request Network request id, for lookups from a payload. */
  requestIndex: Record<string, string>;
}

function emptyState(): LedgerState {
  return { invoices: {}, suppliers: {}, deliveries: {}, requestIndex: {} };
}

export class Ledger {
  private state: LedgerState = emptyState();
  private readonly path: string;
  /** Serialises writes so two concurrent deliveries cannot interleave. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<LedgerState>;
      this.state = {
        invoices: parsed.invoices ?? {},
        suppliers: parsed.suppliers ?? {},
        deliveries: parsed.deliveries ?? {},
        requestIndex: parsed.requestIndex ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = emptyState();
        return;
      }
      throw error;
    }
  }

  private async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const dir = dirname(this.path);
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.${Date.now()}-ledger.tmp`);
      await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      await rename(tmp, this.path);
    });
    await this.writeChain;
  }

  snapshot(): LedgerState {
    return this.state;
  }

  /**
   * Discards all state, in memory and on the next `save()`.
   *
   * Only `seed-demo.ts --reset` calls this. It exists because seeding is
   * deliberately non-destructive — an invoice left `settled` by an earlier run
   * stays settled — so returning the demo to a clean slate has to be something
   * you ask for explicitly rather than a side effect of re-running the seed.
   */
  reset(): void {
    this.state = emptyState();
  }

  // --- invoices -----------------------------------------------------------

  addInvoice(invoice: Invoice): void {
    this.state.invoices[invoice.id] = invoice;
  }

  getInvoice(id: string): Invoice | undefined {
    return this.state.invoices[id];
  }

  /** Invoices that are still expecting money. */
  openInvoices(): Invoice[] {
    return Object.values(this.state.invoices).filter((i) => i.status === 'open');
  }

  linkRequest(requestId: string, invoiceId: string): void {
    this.state.requestIndex[requestId] = invoiceId;
    const invoice = this.state.invoices[invoiceId];
    if (invoice !== undefined) {
      invoice.rnRequestId = requestId;
    }
  }

  invoiceForRequest(requestId: string): Invoice | undefined {
    const id = this.state.requestIndex[requestId];
    return id === undefined ? undefined : this.state.invoices[id];
  }

  applySettlement(
    invoiceId: string,
    amount: string,
    txHash: string | undefined,
    settledAt: string,
  ): void {
    const invoice = this.state.invoices[invoiceId];
    if (invoice === undefined) {
      return;
    }
    invoice.settledAmount = addDecimalStrings(invoice.settledAmount, amount);
    invoice.txHash = txHash ?? invoice.txHash;
    if (compareDecimalStrings(invoice.settledAmount, invoice.amount) >= 0) {
      invoice.status = 'settled';
      invoice.settledAt = settledAt;
    }
  }

  // --- suppliers ----------------------------------------------------------

  addSupplier(supplier: Supplier): void {
    this.state.suppliers[supplier.id] = supplier;
  }

  suppliersForInvoice(): Supplier[] {
    return Object.values(this.state.suppliers);
  }

  // --- settlements / idempotency -----------------------------------------

  /**
   * Returns the existing record if this delivery has already been handled.
   * The caller must not act again when this returns a record — that is the
   * entire point of storing it.
   */
  recordForDelivery(deliveryId: string): SettlementRecord | undefined {
    return this.state.deliveries[deliveryId];
  }

  async recordSettlement(record: SettlementRecord): Promise<void> {
    this.state.deliveries[record.deliveryId] = record;
    await this.persist();
  }

  async appendExecutionId(deliveryId: string, executionId: string): Promise<void> {
    const record = this.state.deliveries[deliveryId];
    if (record !== undefined && !record.executionIds.includes(executionId)) {
      record.executionIds.push(executionId);
      await this.persist();
    }
  }

  async save(): Promise<void> {
    await this.persist();
  }
}

/**
 * Adds two decimal strings as scaled integers, so that float rounding cannot
 * silently mis-state how much of an invoice has been paid.
 */
export function addDecimalStrings(a: string, b: string): string {
  const scale = 1_000_000n;
  const total = toScaled(a, scale) + toScaled(b, scale);
  return fromScaled(total, scale);
}

/** Returns -1, 0 or 1. Comparison is exact, not floating point. */
export function compareDecimalStrings(a: string, b: string): number {
  const scale = 1_000_000n;
  const left = toScaled(a, scale);
  const right = toScaled(b, scale);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function toScaled(value: string, scale: bigint): bigint {
  const trimmed = value.trim();
  if (trimmed === '') return 0n;
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Not a decimal number: ${JSON.stringify(value)}`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const digits = scale.toString().length - 1;
  const padded = fraction.padEnd(digits, '0').slice(0, digits);
  const result = BigInt(whole) * scale + BigInt(padded === '' ? '0' : padded);
  return negative ? -result : result;
}

function fromScaled(value: bigint, scale: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / scale;
  const fraction = magnitude % scale;
  const digits = scale.toString().length - 1;
  const fractionText = fraction.toString().padStart(digits, '0');
  const sign = negative ? '-' : '';
  return `${sign}${whole}.${fractionText}`;
}
