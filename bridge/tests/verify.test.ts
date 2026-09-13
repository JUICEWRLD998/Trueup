/**
 * Signature verification tests.
 *
 * These come first because this function is the only thing standing between a
 * forged HTTP request and moving money. Every failure mode gets an explicit case:
 * a wrong secret, a tampered body, a missing header, and the encoding mistake
 * that the published Request Network sample code has been inconsistent about.
 */

import { describe, expect, it } from 'vitest';
import {
  computeSignature,
  readDeliveryId,
  readHeader,
  isTestDelivery,
  verifySignature,
} from '../src/rn/verify.ts';

const SECRET = 'whsec_test_do_not_use_in_production';
const BODY = Buffer.from(
  JSON.stringify({ event: 'payment.confirmed', requestId: 'req_abc123', amount: '4200.00' }),
  'utf8',
);

describe('verifySignature', () => {
  it('accepts a correctly signed body', () => {
    const signature = computeSignature(BODY, SECRET);
    expect(verifySignature(BODY, signature, SECRET)).toEqual({ ok: true });
  });

  it('accepts an uppercase hex digest', () => {
    const signature = computeSignature(BODY, SECRET).toUpperCase();
    expect(verifySignature(BODY, signature, SECRET)).toEqual({ ok: true });
  });

  it('rejects a body that was tampered with after signing', () => {
    const signature = computeSignature(BODY, SECRET);
    const tampered = Buffer.from(
      JSON.stringify({ event: 'payment.confirmed', requestId: 'req_abc123', amount: '99999.00' }),
      'utf8',
    );

    const result = verifySignature(tampered, signature, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('digest_mismatch');
    }
  });

  it('rejects a body signed with a different secret', () => {
    const signature = computeSignature(BODY, 'the_wrong_secret');
    const result = verifySignature(BODY, signature, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('digest_mismatch');
    }
  });

  it('rejects a re-serialised body, because only the raw bytes are signed', () => {
    const signature = computeSignature(BODY, SECRET);
    // Same data, different bytes: key order and whitespace differ.
    const reserialised = Buffer.from(
      JSON.stringify({
        amount: '4200.00',
        requestId: 'req_abc123',
        event: 'payment.confirmed',
      }),
      'utf8',
    );

    const result = verifySignature(reserialised, signature, SECRET);
    expect(result.ok).toBe(false);
  });

  it('reports a missing header distinctly from a forged one', () => {
    const result = verifySignature(BODY, undefined, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_signature');
    }
  });

  it('treats an empty header as missing', () => {
    const result = verifySignature(BODY, '   ', SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_signature');
    }
  });

  it('reports a base64 digest as malformed rather than forged', () => {
    // Request Network's published samples have been inconsistent here, so a
    // base64 digest must be distinguishable from an attack.
    const base64 = Buffer.from(computeSignature(BODY, SECRET), 'hex').toString('base64');
    const result = verifySignature(BODY, base64, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed_signature');
      expect(result.detail).toMatch(/base64|64/);
    }
  });

  it('refuses to verify when no secret is configured', () => {
    const signature = computeSignature(BODY, SECRET);
    const result = verifySignature(BODY, signature, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_secret');
    }
  });

  it('refuses to verify against an empty secret', () => {
    const result = verifySignature(BODY, computeSignature(BODY, ''), '');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_secret');
    }
  });
});

describe('header helpers', () => {
  it('reads a plain string header', () => {
    expect(readHeader({ 'x-request-network-delivery': 'ulid_1' }, 'x-request-network-delivery')).toBe(
      'ulid_1',
    );
  });

  it('takes the first value when a header repeats', () => {
    expect(readHeader({ 'x-request-network-delivery': ['ulid_1', 'ulid_2'] }, 'x-request-network-delivery')).toBe(
      'ulid_1',
    );
  });

  it('returns undefined for an absent header', () => {
    expect(readDeliveryId({})).toBeUndefined();
  });

  it('detects a test delivery only on an exact true', () => {
    expect(isTestDelivery({ 'x-request-network-test': 'true' })).toBe(true);
    expect(isTestDelivery({ 'x-request-network-test': 'false' })).toBe(false);
    expect(isTestDelivery({ 'x-request-network-test': 'TRUE' })).toBe(false);
    expect(isTestDelivery({})).toBe(false);
  });
});
