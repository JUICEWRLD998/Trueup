/**
 * Request Network webhook payload schemas.
 *
 * Field names here are taken from Request Network's published webhook
 * reference, not invented. Notable properties of the payload that shape the
 * surrounding design:
 *
 *   - There is NO payee/destination field on `payment.confirmed`. The only
 *     reliable join key back to our own record is `requestId`, which is why the
 *     ledger indexes on it.
 *   - `reference` is NOT on the webhook. It exists on `GET /v2/request/{id}`.
 *     At creation time `reference` is a TOP-LEVEL body field, not per-request.
 *   - `requestId` and `requestID` are duplicated in the payload. We normalise to
 *     `requestId` and keep the raw value for the audit trail.
 *   - `subStatus` is an empty string on success.
 *
 * Schemas are `.passthrough()` so that a new field added by Request Network does
 * not cause us to reject an otherwise valid settlement. Rejecting real money is
 * the worst failure mode available to this service.
 */

import { z } from 'zod';

export const KNOWN_EVENTS = [
  'payment.confirmed',
  'payment.partial',
  'payment.failed',
  'client_id.linked',
] as const;

const FeeSchema = z
  .object({
    type: z.string(),
    amount: z.string(),
    currency: z.string(),
  })
  .passthrough();

/** Settlement of a payment request — the event this integration acts on. */
export const PaymentConfirmedSchema = z
  .object({
    event: z.literal('payment.confirmed'),
    requestId: z.string().min(1),
    requestID: z.string().optional(),
    paymentReference: z.string().optional(),
    clientId: z.string().optional(),
    orchestratorId: z.string().nullish(),
    explorer: z.string().optional(),
    amount: z.string().optional(),
    totalAmountPaid: z.string().optional(),
    expectedAmount: z.string().optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    txHash: z.string().optional(),
    payerAddress: z.string().optional(),
    payerEoaAddress: z.string().optional(),
    network: z.string().optional(),
    currency: z.string().optional(),
    paymentCurrency: z.string().optional(),
    isCryptoToFiat: z.boolean().optional(),
    subStatus: z.string().optional(),
    paymentProcessor: z.string().optional(),
    fees: z.array(FeeSchema).optional(),
  })
  .passthrough();

export type PaymentConfirmed = z.infer<typeof PaymentConfirmedSchema>;

/**
 * Envelope for events we do not act on. Kept so the service can acknowledge
 * them without parsing their internals.
 */
export const GenericEventSchema = z
  .object({
    event: z.string().min(1),
  })
  .passthrough();

export type GenericEvent = z.infer<typeof GenericEventSchema>;

/**
 * A settlement is only treated as clean when `subStatus` is empty. Anything
 * else means the payment settled into a state that needs a human to look at it.
 */
export function isCleanSettlement(event: PaymentConfirmed): boolean {
  return event.subStatus === undefined || event.subStatus === '';
}

/**
 * A payment that did not cover the whole request. Request Network reports the
 * paid and expected totals, so we compare them rather than trusting the event
 * name alone — `payment.partial` is documented as a legacy event and cannot be
 * relied on to appear for current secure-payment flows.
 */
export function isPartiallyPaid(event: PaymentConfirmed): boolean {
  const paid = toBigIntOrNull(event.totalAmountPaid ?? event.amount);
  const expected = toBigIntOrNull(event.expectedAmount);
  if (paid === null || expected === null) {
    return false;
  }
  return paid < expected;
}

/**
 * Amounts arrive as decimal strings. We compare them as scaled integers so that
 * float rounding cannot make a partial payment look settled. Four decimal places
 * is finer than any currency Request Network supports in practice.
 */
function toBigIntOrNull(value: string | undefined): bigint | null {
  if (value === undefined || value.trim() === '') {
    return null;
  }
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return null;
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const scaled = `${whole}${fraction.padEnd(4, '0').slice(0, 4)}`;
  const parsed = BigInt(scaled);
  return negative ? -parsed : parsed;
}

export const __testing = { toBigIntOrNull };
