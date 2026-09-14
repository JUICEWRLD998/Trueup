/**
 * Settlement orchestration: turn a verified webhook into a decision, and a
 * decision into either a payout or a deliberate non-action.
 *
 * Every path through here writes a SettlementRecord, including the paths that
 * do nothing. A settlement we chose not to act on is a decision, and it belongs
 * in the audit trail with the same weight as a payout.
 */

import { classify, type MatchResult, type SettlementSignals } from './classify.ts';
import { KeeperHubError, deriveIdempotencyKey, DEFAULT_NATIVE_DAILY_CAP_ETH, STABLECOIN_PER_TRANSACTION_CAP_USD, type KeeperHubClient } from './keeperhub.ts';
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
  /**
   * Rehearse the whole path — decision, cap refusal, and KeeperHub's own dry run —
   * without signing, broadcasting, or writing to the ledger.
   *
   * Both halves matter. Not touching the chain is the platform's dry run; not
   * touching the ledger is ours, and it is the half that is easy to forget: a
   * rehearsal that marked the invoice settled would leave the money shot with
   * nothing left to settle.
   */
  readonly simulateOnly?: boolean | undefined;
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
  /** True when this outcome came from a rehearsal rather than a real run. */
  readonly dryRun?: boolean | undefined;
}

interface PayoutIntent {
  readonly supplierId: string;
  readonly supplierName: string;
  readonly address: string;
  readonly amount: string;
  readonly chainId: string;
  /**
   * ERC-20 contract to pay in.
   *
   * Carried through explicitly because omitting it does not fail — it silently
   * becomes a NATIVE transfer of the same nominal amount, which is a different asset
   * under a different (far smaller) daily cap. A supplier expecting 6 USDC would
   * instead be sent 6 ETH and the payout would be refused for exceeding the native
   * cap, or worse, succeed if it did not.
   */
  readonly tokenAddress: string | undefined;
  readonly idempotencyKey: string;
  // Declared as `| undefined` because `exactOptionalPropertyTypes` is on and
  // these are built from possibly-absent values.
  readonly executionId?: string | undefined;
  readonly transactionHash?: string | undefined;
  /** Present on a rehearsal only: what the dry run predicted the transfer would cost. */
  readonly gasEstimate?: string | undefined;
  readonly error?: string | undefined;
}

/** Parses the amount string from a webhook into the paid total. */
function paidAmountOf(event: PaymentConfirmed): string | undefined {
  return event.totalAmountPaid ?? event.amount;
}

/**
 * Why a payout must not be attempted, or `undefined` when it is safe to try.
 *
 * Two refusals, both cheaper than the failure they prevent:
 *
 *   1. No token address. Omitting `tokenAddress` does not error — KeeperHub treats it
 *      as a native transfer of the same nominal amount, which is a different asset
 *      under a 0.02 ETH/day cap. Silently paying suppliers in ETH instead of USDC is
 *      worse than refusing.
 *   2. Above the per-transaction stablecoin cap. KeeperHub will not sign it, so
 *      attempting it burns a round trip and produces a failed execution.
 *
 * Shared by the real path and the rehearsal so a dry run cannot pass something the
 * real run would refuse — which would make the rehearsal worse than useless.
 */
function payoutRefusal(intent: { amount: string; tokenAddress: string | undefined }): string | undefined {
  if (intent.tokenAddress === undefined || intent.tokenAddress.trim() === '') {
    return (
      `payout of ${intent.amount} carries no token address, so it would be a NATIVE ` +
      `transfer — a different asset under a ${DEFAULT_NATIVE_DAILY_CAP_ETH} ETH/day cap. ` +
      `Give the supplier a token address instead of letting a token payout become a native one.`
    );
  }
  if (Number(intent.amount) <= STABLECOIN_PER_TRANSACTION_CAP_USD) {
    return undefined;
  }
  return (
    `payout of ${intent.amount} exceeds KeeperHub's ` +
    `${STABLECOIN_PER_TRANSACTION_CAP_USD} USD per-transaction stablecoin cap; ` +
    `split the payment or raise the cap for this org before retrying`
  );
}

/**
 * Why a matched invoice cannot be paid, when it has no payables configured.
 *
 * Not the same as an unmatched settlement: the money arrived and the invoice is
 * real, but nothing says who to pay. Recording that as a success — or as a quiet
 * no-op — loses an obligation with no error anywhere, so it is treated as a hold.
 */
function noPayablesReason(invoiceId: string): string {
  return (
    `invoice ${invoiceId} matched, but it has no payables configured, so there is no one ` +
    `to pay and nothing to prove. The inbound payment is recorded; register the invoice's ` +
    `payables (POST /invoices or scripts/add-invoice.ts) before releasing anything.`
  );
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

  // Deduplicated, because Request Network sends both `payerAddress` and
  // `payerEoaAddress` and for an externally-owned payer they are the same value.
  // Passing both through makes every reason line on camera read
  // "payer 0xabc…, 0xabc… is a known address for Northwind Freight".
  const payerAddresses = [
    ...new Set(
      [event.payerAddress, event.payerEoaAddress].filter(
        (value): value is string => value !== undefined && value !== '',
      ),
    ),
  ];

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

  // Build the payout intents from THIS invoice's payables — never from a global
  // list, or settling one invoice pays another invoice's counterparties. Deliberately
  // before the ledger is touched below: a rehearsal builds the same intents and stops.
  const payables = ledger.payablesForInvoice(invoice.id);
  const intents: PayoutIntent[] = payables.map((payable) => ({
    supplierId: payable.supplierId,
    supplierName: payable.supplierName,
    address: payable.address,
    amount: payable.amountOwed,
    chainId: payable.chainId,
    tokenAddress: payable.tokenAddress,
    idempotencyKey: deriveIdempotencyKey({
      workId: `${invoice.id}:${payable.id}:${deliveryId}`,
      chainId: payable.chainId,
      recipientAddress: payable.address,
      amount: payable.amountOwed,
    }),
  }));

  // A matched invoice with no payables is a configuration failure, not a payout.
  // Both branches below report it the same way, so a rehearsal cannot pass
  // something the real run would refuse.
  const unbillable = intents.length === 0;
  const reasons = unbillable ? [...result.reasons, noPayablesReason(invoice.id)] : result.reasons;
  if (unbillable) {
    logger.error('matched invoice has no payables — nothing to pay', {
      deliveryId,
      invoiceId: invoice.id,
      verdict: result.verdict,
    });
  }

  // A rehearsal stops here. It mirrors both branches below — a hold is reported as a
  // hold, a payable settlement has each payout simulated — and it writes nothing: not
  // a transaction, and not the ledger. A rehearsal that marked the invoice settled
  // would leave the real run with no open invoice to match against.
  if (deps.simulateOnly === true) {
    if (result.verdict === 'held' || unbillable) {
      logger.warn(
        unbillable
          ? 'dry run: invoice has no payables, so there is nothing to simulate'
          : 'dry run: settlement would be held for human release',
        {
          deliveryId,
          invoiceId: invoice.id,
          confidence: result.confidence,
        },
      );
      return { ...base, reasons, verdict: 'held', payouts: [], holds: intents, dryRun: true };
    }

    const simulated: PayoutIntent[] = [];
    for (const intent of intents) {
      const refusal = payoutRefusal(intent);
      if (refusal !== undefined) {
        logger.warn('dry run: payout would be refused', {
          deliveryId,
          supplierId: intent.supplierId,
          amount: intent.amount,
          reason: refusal,
        });
        simulated.push({ ...intent, error: refusal });
        continue;
      }
      try {
        const simulation = await deps.kh.simulateTransfer({
          chainId: intent.chainId,
          recipientAddress: intent.address,
          amount: intent.amount,
          tokenAddress: intent.tokenAddress,
        });
        simulated.push({ ...intent, gasEstimate: simulation.gasEstimate });
      } catch (error) {
        simulated.push({
          ...intent,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('dry run complete — nothing signed, nothing broadcast, ledger untouched', {
      deliveryId,
      invoiceId: invoice.id,
      payouts: simulated.length,
      failures: simulated.filter((intent) => intent.error !== undefined).length,
    });

    return { ...base, reasons, payouts: simulated, holds: [], dryRun: true };
  }

  // Past this point we are acting, so record that the inbound payment actually
  // landed. This sits BELOW the rehearsal return on purpose: marking an invoice
  // settled is a real state change, and a dry run that performed it would leave the
  // real run with no open invoice to match against.
  const paid = paidAmountOf(event) ?? '0';
  ledger.applySettlement(invoice.id, paid, event.txHash, new Date().toISOString());

  // A held settlement stages the payout for a human to release; it does not move
  // money. This is the brake, and it is the reason a low-confidence match is
  // safe to leave automated. An invoice with no payables lands here too: the
  // inbound payment is real, but nothing may be paid on a guess about who.
  if (result.verdict === 'held' || unbillable) {
    logger.warn(
      unbillable ? 'settlement held — invoice has no payables' : 'settlement held for human release',
      {
        deliveryId,
        invoiceId: invoice.id,
        confidence: result.confidence,
        reasons,
      },
    );
    await ledger.recordSettlement({
      deliveryId,
      requestId: resolvedRequestId,
      invoiceId: invoice.id,
      receivedAt: new Date().toISOString(),
      verdict: 'held',
      confidence: result.confidence,
      reasons,
      txHash: event.txHash,
      executionIds: [],
    });
    return { ...base, reasons, verdict: 'held', payouts: [], holds: intents };
  }

  // Attributed or matched at or above threshold: pay the suppliers.
  const executed: PayoutIntent[] = [];
  const executionIds: string[] = [];

  for (const intent of intents) {
    const refusal = payoutRefusal(intent);
    if (refusal !== undefined) {
      // Either the amount is above the cap KeeperHub will sign, or there is no token
      // address and this would silently become a native transfer. Both are caught here
      // rather than discovered as a failed execution or a wrong asset.
      logger.error('payout refused before submission', {
        deliveryId,
        supplierId: intent.supplierId,
        amount: intent.amount,
        reason: refusal,
      });
      executed.push({ ...intent, error: refusal });
      continue;
    }

    try {
      const { execution } = await deps.kh.transferSafely(
        {
          chainId: intent.chainId,
          recipientAddress: intent.address,
          amount: intent.amount,
          tokenAddress: intent.tokenAddress,
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
    reasons,
    txHash: event.txHash,
    executionIds,
  });
  await ledger.save();

  return { ...base, reasons, payouts: executed, holds: [] };
}
