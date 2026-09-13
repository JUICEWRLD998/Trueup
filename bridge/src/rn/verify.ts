/**
 * Request Network webhook signature verification.
 *
 * Request Network signs the RAW request body with HMAC-SHA256 and sends the
 * digest, hex-encoded, in the `x-request-network-signature` header. The
 * comparison must be constant-time, and it must run against the exact bytes
 * received — re-serialising the parsed JSON will produce a different digest and
 * a false rejection.
 *
 * This lives outside the KeeperHub workflow engine on purpose. KeeperHub's Code
 * node sandbox exposes only `console`, `fetch` and `crypto.randomUUID`, so
 * `crypto.subtle` is unavailable inside a workflow and an HMAC cannot be
 * verified there. See docs/architecture.md.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-request-network-signature';
export const DELIVERY_HEADER = 'x-request-network-delivery';
export const RETRY_COUNT_HEADER = 'x-request-network-retry-count';
export const TEST_HEADER = 'x-request-network-test';

export type VerifyResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'missing_signature'
        | 'missing_secret'
        | 'malformed_signature'
        | 'digest_mismatch';
      readonly detail: string;
    };

/** Computes the hex-encoded HMAC-SHA256 of the raw body. */
export function computeSignature(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Verifies a webhook delivery.
 *
 * `rawBody` must be the untouched bytes from the request stream, not
 * `JSON.stringify(parsedBody)`.
 */
export function verifySignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string | undefined,
): VerifyResult {
  if (secret === undefined || secret.length === 0) {
    return {
      ok: false,
      reason: 'missing_secret',
      detail: 'RN_WEBHOOK_SECRET is not configured, so no delivery can be verified.',
    };
  }

  if (signatureHeader === undefined || signatureHeader.trim() === '') {
    return {
      ok: false,
      reason: 'missing_signature',
      detail: `No ${SIGNATURE_HEADER} header on the request.`,
    };
  }

  const received = signatureHeader.trim();
  const expected = computeSignature(rawBody, secret);

  // A hex SHA-256 digest is exactly 64 characters. Anything else is not a digest
  // we can compare — most likely a base64 encoding, which the published sample
  // code has been inconsistent about. Say which it is rather than reporting a
  // generic mismatch, because "wrong encoding" and "forged request" need
  // different responses from an operator.
  if (!/^[0-9a-fA-F]{64}$/.test(received)) {
    return {
      ok: false,
      reason: 'malformed_signature',
      detail:
        `Signature header is not a hex SHA-256 digest (got ${received.length} chars, ` +
        `expected 64). If Request Network is sending base64, this integration ` +
        `needs updating — do not treat this as a forged request without checking.`,
    };
  }

  const receivedBytes = Buffer.from(received, 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');

  if (receivedBytes.length !== expectedBytes.length) {
    return {
      ok: false,
      reason: 'malformed_signature',
      detail: `Digest length mismatch: received ${receivedBytes.length} bytes, expected ${expectedBytes.length}.`,
    };
  }

  if (!timingSafeEqual(receivedBytes, expectedBytes)) {
    return {
      ok: false,
      reason: 'digest_mismatch',
      detail: 'Digest does not match the raw body. The delivery is forged or the secret is wrong.',
    };
  }

  return { ok: true };
}

/**
 * Header access that works with Node's `IncomingHttpHeaders`, which types values
 * as `string | string[] | undefined`.
 */
export function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The delivery id is a ULID that is stable across Request Network's retries
 * (3 retries, 4 attempts in total). It is the correct idempotency key: the same
 * settled payment redelivered must not produce a second payout.
 */
export function readDeliveryId(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  return readHeader(headers, DELIVERY_HEADER);
}

/**
 * Request Network flags test deliveries with `x-request-network-test`. They must
 * never move money, so this is checked before any execution is attempted.
 */
export function isTestDelivery(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  return readHeader(headers, TEST_HEADER) === 'true';
}
