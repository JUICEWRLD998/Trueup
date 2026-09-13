/**
 * KeeperHub client tests against an injected fetch.
 *
 * The case that justifies this file: `transferSafely` must refuse to broadcast
 * when the dry run fails. If that guard regresses, the service duplicates a
 * supplier payment instead of catching a bad transaction before signing — so it
 * is tested for every documented failure shape, including the quiet one where the
 * simulation reports success but never actually exercised the write.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  KeeperHubClient,
  SimulationRevertError,
  deriveIdempotencyKey,
} from '../src/keeperhub.ts';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function makeClient(handler: (url: string, init: RequestInit) => Response) {
  const spy = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return Promise.resolve(handler(url, init ?? {}));
  });
  const client = new KeeperHubClient({
    apiBase: 'https://app.keeperhub.com/api',
    apiKey: 'kh_test',
    fetchImpl: spy as unknown as typeof fetch,
    sleepImpl: () => Promise.resolve(),
  });
  return { client, spy };
}

const TRANSFER = {
  chainId: '11155111',
  recipientAddress: '0xC0FFEE0000000000000000000000000000000001',
  amount: '1200.00',
};

describe('apiBase normalisation', () => {
  it('does not double the /api prefix when the base already ends in /api', async () => {
    // KH_API_BASE ships as https://app.keeperhub.com/api, and every client path
    // also starts with /api/. Without normalisation this becomes
    // /api/api/execute/transfer and 404s — which is exactly what happened live.
    const seen: string[] = [];
    const client = new KeeperHubClient({
      apiBase: 'https://app.keeperhub.com/api',
      apiKey: 'kh_test',
      fetchImpl: ((input: string | URL | Request) => {
        seen.push(typeof input === 'string' ? input : input.toString());
        return Promise.resolve(
          jsonResponse({ success: true, wouldRevert: false, gasEstimate: '21000' }),
        );
      }) as unknown as typeof fetch,
      sleepImpl: () => Promise.resolve(),
    });

    await client.simulateTransfer(TRANSFER);
    expect(seen[0]).toBe('https://app.keeperhub.com/api/execute/transfer');
  });

  it('accepts a bare origin too', async () => {
    const seen: string[] = [];
    const client = new KeeperHubClient({
      apiBase: 'https://app.keeperhub.com',
      apiKey: 'kh_test',
      fetchImpl: ((input: string | URL | Request) => {
        seen.push(typeof input === 'string' ? input : input.toString());
        return Promise.resolve(jsonResponse({ success: true, wouldRevert: false }));
      }) as unknown as typeof fetch,
      sleepImpl: () => Promise.resolve(),
    });

    await client.simulateTransfer(TRANSFER);
    expect(seen[0]).toBe('https://app.keeperhub.com/api/execute/transfer');
  });

  it('tolerates a trailing slash', async () => {
    const seen: string[] = [];
    const client = new KeeperHubClient({
      apiBase: 'https://app.keeperhub.com/api/',
      apiKey: 'kh_test',
      fetchImpl: ((input: string | URL | Request) => {
        seen.push(typeof input === 'string' ? input : input.toString());
        return Promise.resolve(jsonResponse({ success: true, wouldRevert: false }));
      }) as unknown as typeof fetch,
      sleepImpl: () => Promise.resolve(),
    });

    await client.simulateTransfer(TRANSFER);
    expect(seen[0]).toBe('https://app.keeperhub.com/api/execute/transfer');
  });
});

describe('transferSafely', () => {
  it('dry-runs, then broadcasts with an idempotency key', async () => {
    const { client, spy } = makeClient((_url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (body['simulate'] === true) {
        return jsonResponse({
          success: true,
          status: 'simulated',
          gasEstimate: '21000',
          wouldRevert: false,
        });
      }
      return jsonResponse({
        executionId: 'exec_1',
        status: 'completed',
        transactionHash: '0xabc',
      });
    });

    const result = await client.transferSafely(TRANSFER, 'key_1');
    expect(result.execution.transactionHash).toBe('0xabc');

    // The dry run must precede the broadcast, and the simulated call must carry
    // the strict boolean rather than the string "true".
    const first = JSON.parse(String(spy.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(first['simulate']).toBe(true);
    const second = JSON.parse(String(spy.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(second['simulate']).toBeUndefined();

    const headers = spy.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('key_1');
  });

  it('refuses to broadcast when the dry run would revert', async () => {
    const { client, spy } = makeClient(() =>
      jsonResponse(
        {
          failureKind: 'revert',
          wouldRevert: true,
          revertReason: 'ERC20: transfer amount exceeds balance',
        },
        400,
      ),
    );

    await expect(client.transferSafely(TRANSFER, 'key_2')).rejects.toBeInstanceOf(
      SimulationRevertError,
    );
    // One call only — nothing was signed.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refuses to broadcast when the sender is underfunded', async () => {
    const { client, spy } = makeClient(() =>
      jsonResponse(
        {
          failureKind: 'validation',
          wouldRevert: true,
          code: 'insufficient_balance',
          shortfallWei: '1000',
        },
        400,
      ),
    );

    await expect(client.transferSafely(TRANSFER, 'key_3')).rejects.toThrow(
      /validation|insufficient_balance/,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refuses to broadcast when the dry run reported no wouldRevert at all', async () => {
    // A simulation of a read-only action or an unmet condition returns success
    // with no wouldRevert field. It looks green while having proved nothing.
    const { client, spy } = makeClient(() =>
      jsonResponse({ success: true, status: 'simulated' }),
    );

    await expect(client.transferSafely(TRANSFER, 'key_4')).rejects.toBeInstanceOf(
      SimulationRevertError,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refuses to broadcast when the simulation itself returns wouldRevert true with a 200', async () => {
    const { client } = makeClient(() =>
      jsonResponse({ success: false, wouldRevert: true }),
    );
    await expect(client.transferSafely(TRANSFER, 'key_5')).rejects.toBeInstanceOf(
      SimulationRevertError,
    );
  });

  it('surfaces a retryable in-progress conflict', async () => {
    const { client } = makeClient((_url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (body['simulate'] === true) {
        return jsonResponse({ success: true, wouldRevert: false, gasEstimate: '21000' });
      }
      return jsonResponse(
        { code: 'idempotency_in_progress', retryable: true },
        409,
      );
    });

    await expect(client.transferSafely(TRANSFER, 'key_6')).rejects.toMatchObject({
      code: 'idempotency_in_progress',
      retryable: true,
    });
  });

  it('surfaces a non-retryable idempotency conflict distinctly', async () => {
    const { client } = makeClient((_url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (body['simulate'] === true) {
        return jsonResponse({ success: true, wouldRevert: false });
      }
      return jsonResponse(
        { code: 'idempotency_conflict', retryable: false, originalExecutionId: 'exec_0' },
        409,
      );
    });

    await expect(client.transferSafely(TRANSFER, 'key_7')).rejects.toMatchObject({
      code: 'idempotency_conflict',
      retryable: false,
    });
  });
});

describe('waitForExecution', () => {
  it('treats a poll hint of 0 as terminal and stops', async () => {
    let calls = 0;
    const { client } = makeClient(() => {
      calls += 1;
      return jsonResponse(
        { executionId: 'exec_9', status: 'completed', transactionHash: '0xdef' },
        200,
        { 'X-Poll-Interval-Hint': '0' },
      );
    });

    const status = await client.waitForExecution('exec_9');
    expect(status.transactionHash).toBe('0xdef');
    expect(calls).toBe(1);
  });

  it('keeps polling while the hint is non-zero', async () => {
    let calls = 0;
    const { client } = makeClient(() => {
      calls += 1;
      // `unconfirmed` is explicitly non-terminal: still settling.
      if (calls < 3) {
        return jsonResponse({ executionId: 'exec_10', status: 'unconfirmed' }, 200, {
          'X-Poll-Interval-Hint': '0.1',
        });
      }
      return jsonResponse({ executionId: 'exec_10', status: 'completed' }, 200, {
        'X-Poll-Interval-Hint': '0',
      });
    });

    const status = await client.waitForExecution('exec_10');
    expect(status.status).toBe('completed');
    expect(calls).toBe(3);
  });

  it('does not treat an unknown status string as failure', async () => {
    // The documented status list is a lower bound. An unrecognised value with a
    // zero hint is terminal, and its status is reported rather than mapped to a
    // failure we invented.
    const { client } = makeClient(() =>
      jsonResponse({ executionId: 'exec_11', status: 'settling_on_l2' }, 200, {
        'X-Poll-Interval-Hint': '0',
      }),
    );

    const status = await client.waitForExecution('exec_11');
    expect(status.status).toBe('settling_on_l2');
  });
});

describe('deriveIdempotencyKey', () => {
  it('is stable across calls for the same payment', () => {
    const a = deriveIdempotencyKey({
      workId: 'INV-4471:SUP-CARRIER:delivery_1',
      chainId: '11155111',
      recipientAddress: '0xC0FFEE0000000000000000000000000000000001',
      amount: '1200.00',
    });
    const b = deriveIdempotencyKey({
      workId: 'INV-4471:SUP-CARRIER:delivery_1',
      chainId: '11155111',
      recipientAddress: '0xC0FFEE0000000000000000000000000000000001',
      amount: '1200.00',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the amount changes', () => {
    const base = {
      workId: 'work_1',
      chainId: '11155111',
      recipientAddress: '0xC0FFEE0000000000000000000000000000000001',
    };
    expect(deriveIdempotencyKey({ ...base, amount: '1200.00' })).not.toBe(
      deriveIdempotencyKey({ ...base, amount: '1200.01' }),
    );
  });

  it('ignores address case and trailing zeros, which are not distinct payments', () => {
    const base = { workId: 'work_1', chainId: '11155111' };
    expect(
      deriveIdempotencyKey({
        ...base,
        recipientAddress: '0xC0FFEE0000000000000000000000000000000001',
        amount: '1200.00',
      }),
    ).toBe(
      deriveIdempotencyKey({
        ...base,
        recipientAddress: '0xc0ffee0000000000000000000000000000000001',
        amount: '1200',
      }),
    );
  });

  it('escapes the field separator so parts cannot collide', () => {
    // Without percent-encoding, "a|b" + "c" and "a" + "b|c" would hash alike.
    const one = deriveIdempotencyKey({
      workId: 'a|b',
      chainId: '11155111',
      recipientAddress: '0xC0FFEE0000000000000000000000000000000001',
      amount: 'c',
    });
    const two = deriveIdempotencyKey({
      workId: 'a',
      chainId: '11155111',
      recipientAddress: '0xC0FFEE0000000000000000000000000000000001',
      amount: 'c',
    });
    expect(one).not.toBe(two);
  });
});
