/**
 * Settlement orchestration: turn a verified webhook into a decision, and a
 * decision into either a payout or a deliberate non-action.
 *
 * Every path through here writes a SettlementRecord, including the paths that
 * do nothing. A settlement we chose not to act on is a decision, and it belongs
 * in the audit trail with the same weight as a payout.
 */

import { classify, type MatchResult, type SettlementSignals } from './classify.ts';
import { KeeperHubError, deriveIdempotencyKey, STABLECOIN_PER_TRANSACTION_CAP_USD, type KeeperHubClient } from './keeperhub.ts';
import type { Ledger } from './ledger.ts';
import type { RequestNetworkClient } from './rn/client.ts';
import { isPartiallyPaid, type PaymentConfirmed } from './rn/types.ts';

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface SettleDeps {
  readonly ledger: Ledger;
  readonly kh: KeeperHubClient;
  readonly rn: RequestNetworkClient;
  readonly logger: Logger;
  readonly autoApproveThreshold: number;
}

export interface SettleOutcome {
  readonly deliveryId: string;
  readonly requestId: string;
  readonly verdict: MatchResult['verdict'];
  readonly invoiceId: string | undefined;
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly payouts: readonly PayoutIntent[];
  readonly holds: readonly PayoutIntent[];
}

interface PayoutIntent {
  readonly supplierId: string;
  readonly supplierName: string;
  readonly address: string;
  readonly amount: string;
  readonly chainId: string;
  readonly idempotencyKey: string;
  // Declared as `| undefined` because `exactOptionalPropertyTypes` is on and
  // these are built from possibly-absent values.
  readonly executionId?: string | undefined;
  readonly transactionHash?: string | undefined;
  readonly error?: string | undefined;
}

/** Parses the amount string from a webhook into the paid total. */
function paidAmountOf(event: PaymentConfirmed): string | undefined {
  return event.totalAmountPaid ?? event.amount;
}

export async function settle(
  event: PaymentConfirmed,
  deliveryId: string,
  deps: SettleDeps,
): Promise<SettleOutcome> {
  const { ledger, rn, logger } = deps;
  const requestId = event.requestId;

  // The webhook does not carry our reference, and it carries no payee at all.
  // The authoritative record lives in Request Network, keyed by requestId.
  let reference: string | undefined;
  let expectedAmount = event.expectedAmount;
  let resolvedRequestId = requestId;

  try {
    const status = await rn.getRequest(requestId);
    reference = status.reference ?? undefined;
    if (status.requestId !== undefined && status.requestId !== '') {
      resolvedRequestId = status.requestId;
    }
    if (expectedAmount === undefined && status.payments !== undefined) {
      // Fall back to the sum of recorded payments when the webhook omits totals.
      const total = status.payments.reduce<number>(
        (sum, payment) => sum + Number(payment.amount ?? 0),
        0,
      );
      expectedAmount = String(total);
    }
  } catch (error) {
    // A read failure must not turn into a wrong payment. We lose the reference
    // signal and fall back to amount/payer matching, which is weaker by design.
    logger.warn('could not read request status; matching without a reference', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const payerAddresses = [event.payerAddress, event.payerEoaAddress].filter(
    (value): value is string => value !== undefined && value !== '',
  );

  const signals: SettlementSignals = {
    reference,
    payerAddresses,
    amountPaid: paidAmountOf(event),
    expectedAmount,
    paidAt: event.timestamp === undefined ? new Date() : new Date(Number(event.timestamp) * 1000),
  };

  const openInvoices = ledger.openInvoices();
  const result = classify(signals, openInvoices, {
    autoApprove: deps.autoApproveThreshold,
    hold: 0.55,
  });

  logger.info('classified settlement', {
    deliveryId,
    requestId: resolvedRequestId,
    verdict: result.verdict,
    confidence: result.confidence,
    invoiceId: result.invoiceId,
    partial: isPartiallyPaid(event),
  });

  const base = {
    deliveryId,
    requestId: resolvedRequestId,
    verdict: result.verdict,
    invoiceId: result.invoiceId,
    confidence: result.confidence,
    reasons: result.reasons,
  } as const;

  // Below threshold: record the decision and move nothing.
  if (result.verdict === 'unmatched' || result.invoiceId === undefined) {
    await ledger.recordSettlement({
      deliveryId,
      requestId: resolvedRequestId,
      invoiceId: undefined,
      receivedAt: new Date().toISOString(),
      verdict: 'unmatched',
      confidence: result.confidence,
      reasons: result.reasons,
      txHash: event.txHash,
      executionIds: [],
    });
    return { ...base, verdict: 'unmatched', payouts: [], holds: [] };
  }

  const invoice = ledger.getInvoice(result.invoiceId);
  if (invoice === undefined) {
    // classify() only returns ids it was given, so this is a real inconsistency.
    throw new Error(
      `classify() selected invoice ${result.invoiceId}, which is not in the ledger.`,
    );
  }

  const paid = paidAmountOf(event) ?? '0';
  ledger.applySettlement(invoice.id, paid, event.txHash, new Date().toISOString());

  // Build the payout intents for this invoice's suppliers.
  const suppliers = ledger.suppliersForInvoice();
  const intents: PayoutIntent[] = suppliers.map((supplier) => ({
    supplierId: supplier.id,
    supplierName: supplier.name,
    address: supplier.address,
    amount: supplier.amountOwed,
    chainId: supplier.chainId,
    idempotencyKey: deriveIdempotencyKey({
      workId: `${invoice.id}:${supplier.id}:${deliveryId}`,
      chainId: supplier.chainId,
      recipientAddress: supplier.address,
      amount: supplier.amountOwed,
    }),
  }));

  // A held settlement stages the payout for a human to release; it does not move
  // money. This is the brake, and it is the reason a low-confidence match is
  // safe to leave automated.
  if (result.verdict === 'held') {
    logger.warn('settlement held for human release', {
      deliveryId,
      invoiceId: invoice.id,
      confidence: result.confidence,
      reasons: result.reasons,
    });
    await ledger.recordSettlement({
      deliveryId,
      requestId: resolvedRequestId,
      invoiceId: invoice.id,
      receivedAt: new Date().toISOString(),
      verdict: 'held',
      confidence: result.confidence,
      reasons: result.reasons,
      txHash: event.txHash,
      executionIds: [],
    });
    return { ...base, verdict: 'held', payouts: [], holds: intents };
  }

  // Attributed or matched at or above threshold: pay the suppliers.
  const executed: PayoutIntent[] = [];
  const executionIds: string[] = [];

  for (const intent of intents) {
    const capped = Number(intent.amount) > STABLECOIN_PER_TRANSACTION_CAP_USD;
    if (capped) {
      // KeeperHub refuses to sign a stablecoin transfer above 100 USD on any
      // write path. Attempting it wastes a round trip and produces a failed
      // execution, so we stop here and say why.
      const message =
        `payout of ${intent.amount} exceeds KeeperHub's ` +
        `${STABLECOIN_PER_TRANSACTION_CAP_USD} USD per-transaction stablecoin cap; ` +
        `split the payment or raise the cap for this org before retrying`;
      logger.error('payout blocked by documented stablecoin cap', {
        deliveryId,
        supplierId: intent.supplierId,
        amount: intent.amount,
      });
      executed.push({ ...intent, error: message });
      continue;
    }

    try {
      const { execution } = await deps.kh.transferSafely(
        {
          chainId: intent.chainId,
          recipientAddress: intent.address,
          amount: intent.amount,
        },
        intent.idempotencyKey,
      );
      executionIds.push(execution.executionId);
      executed.push({
        ...intent,
        executionId: execution.executionId,
        transactionHash: execution.transactionHash ?? undefined,
      });
      logger.info('supplier paid through KeeperHub', {
        deliveryId,
        supplierId: intent.supplierId,
        executionId: execution.executionId,
        transactionHash: execution.transactionHash,
      });
    } catch (error) {
      // A single supplier failure must not lose the record of the others.
      const message =
        error instanceof KeeperHubError
          ? `${error.message} (code=${error.code ?? 'none'}, retryable=${error.retryable})`
          : error instanceof Error
            ? error.message
            : String(error);
      logger.error('supplier payout failed', {
        deliveryId,
        supplierId: intent.supplierId,
        error: message,
      });
      executed.push({ ...intent, error: message });
    }
  }

  await ledger.recordSettlement({
    deliveryId,
    requestId: resolvedRequestId,
    invoiceId: invoice.id,
    receivedAt: new Date().toISOString(),
    verdict: result.verdict === 'attributed' ? 'attributed' : 'matched',
    confidence: result.confidence,
    reasons: result.reasons,
    txHash: event.txHash,
    executionIds,
  });
  await ledger.save();

  return { ...base, payouts: executed, holds: [] };
}
