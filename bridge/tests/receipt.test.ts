/**
 * Receipt bundle tests.
 *
 * The bundle is the artifact that answers "can we see it?" for the judges, so the
 * properties that matter are: it is bounded, it is ordered and reproducible, and
 * it cannot leak a credential. The secret test is the one that earns this file —
 * an export that spreads an API response eventually emails an auth header to
 * somebody, and this is where that gets caught.
 */

import { describe, expect, it } from 'vitest';
import {
  assertNoSecrets,
  assertSupportedVersion,
  buildReceiptBundle,
  BUNDLE_VERSION,
  fingerprint,
  MAX_RECEIPTS,
  ReceiptBundleError,
  toReceipt,
} from '../src/receipt.ts';
import type { ExecutionStatusResponse } from '../src/keeperhub.ts';

function status(overrides: Partial<ExecutionStatusResponse> = {}): ExecutionStatusResponse {
  return {
    executionId: 'exec_1',
    status: 'completed',
    type: 'transfer',
    network: '11155111',
    transactionHash: '0xabc',
    transactionLink: 'https://sepolia.etherscan.io/tx/0xabc',
    sponsored: false,
    retryCount: 0,
    gasUsedWei: '74539574420183',
    receipts: [
      {
        hash: '0xabc',
        chainId: 11155111,
        verified: true,
        receiptStatus: 'success',
        blockNumber: 11698386,
        gasUsed: '61967',
      },
    ],
    result: { secretish: 'this must not reach the bundle' },
    error: null,
    ...overrides,
  } as ExecutionStatusResponse;
}

const DECISION = {
  verdict: 'attributed' as const,
  confidence: 1,
  invoiceId: 'INV-4471',
  reasons: ['reference matched exactly (decisive)'],
};

function bundleInput(executionIds: string[], receipts: ExecutionStatusResponse[]) {
  return {
    source: 'request-network' as const,
    deliveryId: 'delivery_ulid_1',
    requestId: '01b13f21bc590538c3d0e9da044583c949fc7e9fff5052dc948178f44552efdf01',
    webhookBodySha256: fingerprint('{"event":"payment.confirmed"}'),
    receivedAt: '2026-09-13T20:58:44.000Z',
    decision: DECISION,
    executionIds,
    receipts,
  };
}

describe('toReceipt', () => {
  it('projects only allowlisted fields', () => {
    const receipt = toReceipt(status());
    expect(receipt.executionId).toBe('exec_1');
    expect(receipt.transactionHash).toBe('0xabc');
    expect(receipt.blockNumber).toBe('11698386');
    expect(receipt.gasUsed).toBe('61967');
    expect(receipt.verified).toBe(true);
    expect(receipt.receiptStatus).toBe('success');
  });

  it('drops the execution result payload', () => {
    // `result` can carry arbitrary plugin output, and spreading it is how a
    // secret reaches an export.
    const receipt = toReceipt(status()) as unknown as Record<string, unknown>;
    expect(receipt['result']).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain('secretish');
  });

  it('drops the error field', () => {
    const receipt = toReceipt(status({ error: 'internal host 10.0.0.5 refused' })) as unknown as Record<
      string,
      unknown
    >;
    expect(receipt['error']).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain('10.0.0.5');
  });

  it('handles a missing receipt entry without throwing', () => {
    const receipt = toReceipt(status({ receipts: [] }));
    expect(receipt.blockNumber).toBeUndefined();
    expect(receipt.gasUsed).toBe('74539574420183');
  });
});

describe('fingerprint', () => {
  it('is stable and does not retain the body', () => {
    const a = fingerprint('{"event":"payment.confirmed"}');
    const b = fingerprint('{"event":"payment.confirmed"}');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different bodies', () => {
    expect(fingerprint('a')).not.toBe(fingerprint('b'));
  });
});

describe('buildReceiptBundle', () => {
  it('builds a versioned bundle', () => {
    const bundle = buildReceiptBundle(bundleInput(['exec_1'], [status()]));
    expect(bundle.bundleVersion).toBe(BUNDLE_VERSION);
    expect(bundle.executionCount).toBe(1);
    expect(bundle.decision.invoiceId).toBe('INV-4471');
    expect(bundle.decision.reasons).toHaveLength(1);
  });

  it('orders receipts to match the requested ids, for reproducibility', () => {
    const a = status({ executionId: 'exec_a' });
    const b = status({ executionId: 'exec_b' });
    const bundle = buildReceiptBundle(bundleInput(['exec_b', 'exec_a'], [a, b]));
    expect(bundle.receipts.map((r) => r.executionId)).toEqual(['exec_b', 'exec_a']);
  });

  it('refuses to cite an execution it has no status for', () => {
    // A bundle that quietly cites fewer executions than it claims is worse than
    // one that fails, so this must throw rather than omit.
    expect(() =>
      buildReceiptBundle(bundleInput(['exec_1', 'exec_missing'], [status()])),
    ).toThrow(ReceiptBundleError);
  });

  it('refuses more than the documented bound', () => {
    const ids = Array.from({ length: MAX_RECEIPTS + 1 }, (_, i) => `exec_${i}`);
    const receipts = ids.map((id) => status({ executionId: id }));
    expect(() => buildReceiptBundle(bundleInput(ids, receipts))).toThrow(/bound is 50/);
  });

  it('accepts exactly the bound', () => {
    const ids = Array.from({ length: MAX_RECEIPTS }, (_, i) => `exec_${i}`);
    const receipts = ids.map((id) => status({ executionId: id }));
    const bundle = buildReceiptBundle(bundleInput(ids, receipts));
    expect(bundle.executionCount).toBe(MAX_RECEIPTS);
  });

  it('states what it excluded, so a reader need not guess', () => {
    const bundle = buildReceiptBundle(bundleInput(['exec_1'], [status()]));
    expect(bundle.excluded.join(' ')).toMatch(/raw webhook body/);
    expect(bundle.excluded.join(' ')).toMatch(/credentials/);
  });

  it('records a refusal as a decision, not an absence', () => {
    const held = {
      ...bundleInput([], []),
      decision: {
        verdict: 'unmatched' as const,
        confidence: 0.4,
        invoiceId: undefined,
        reasons: ['ambiguous: two invoices scored identically'],
      },
    };
    const bundle = buildReceiptBundle(held);
    expect(bundle.decision.verdict).toBe('unmatched');
    expect(bundle.decision.reasons[0]).toMatch(/ambiguous/);
    expect(bundle.executionCount).toBe(0);
  });

  it('is byte-identical for the same inputs apart from the timestamp', () => {
    const one = buildReceiptBundle(bundleInput(['exec_1'], [status()]));
    const two = buildReceiptBundle(bundleInput(['exec_1'], [status()]));
    const strip = (b: typeof one) => JSON.stringify({ ...b, generatedAt: '' });
    expect(strip(one)).toBe(strip(two));
  });
});

describe('assertNoSecrets', () => {
  it('rejects a forbidden field name', () => {
    expect(() => assertNoSecrets({ authorization: 'Bearer kh_x' })).toThrow(ReceiptBundleError);
    expect(() => assertNoSecrets({ webhookSecret: 'whsec' })).toThrow(ReceiptBundleError);
  });

  it('rejects one nested inside an array', () => {
    expect(() => assertNoSecrets({ items: [{ apiKey: 'x' }] })).toThrow(/apiKey/);
  });

  it('is case and separator insensitive', () => {
    // The bug this guards: the forbidden list contained hyphenated entries
    // ('x-api-key') while keys were normalised by stripping non-letters, so
    // those entries could never match. A check that never fires reads like
    // protection without being any.
    expect(() => assertNoSecrets({ 'X-API-Key': 'x' })).toThrow(/X-API-Key/);
    expect(() => assertNoSecrets({ Api_Key: 'x' })).toThrow();
    expect(() => assertNoSecrets({ PRIVATEKEY: 'x' })).toThrow();
    expect(() => assertNoSecrets({ 'api-key': 'x' })).toThrow();
    expect(() => assertNoSecrets({ x_client_id: 'x' })).toThrow();
  });

  it('allows ordinary fields', () => {
    expect(() => assertNoSecrets({ executionId: 'exec_1', transactionHash: '0xabc' })).not.toThrow();
  });

  it('does not flag benign fields whose names merely begin with a sensitive noun', () => {
    // Suffix matching, not substring matching: `tokenAddress` and `tokenSymbol`
    // are legitimate public receipt fields, and a guard that rejects real output
    // gets deleted by the next maintainer.
    expect(() =>
      assertNoSecrets({ tokenAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', tokenSymbol: 'fUSDC' }),
    ).not.toThrow();
  });

  it('flags a key that ends with a sensitive noun', () => {
    expect(() => assertNoSecrets({ accessToken: 'x' })).toThrow();
    expect(() => assertNoSecrets({ webhookSigningSecret: 'x' })).toThrow();
  });

  it('catches a credential added to a real bundle', () => {
    const bundle = buildReceiptBundle(bundleInput(['exec_1'], [status()]));
    const tampered = { ...bundle, apiKey: 'kh_leaked' };
    expect(() => assertNoSecrets(tampered)).toThrow(/Refusing to emit/);
  });
});

describe('assertSupportedVersion', () => {
  it('accepts the current version', () => {
    expect(() => assertSupportedVersion({ bundleVersion: BUNDLE_VERSION })).not.toThrow();
  });

  it('rejects an unknown version rather than guessing the shape', () => {
    expect(() => assertSupportedVersion({ bundleVersion: 99 })).toThrow(/Unsupported/);
    expect(() => assertSupportedVersion({})).toThrow(/Unsupported/);
  });
});
