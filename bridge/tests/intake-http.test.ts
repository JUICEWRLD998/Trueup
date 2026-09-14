/**
 * The HTTP surface: registering a receivable, reading the book back, and the
 * token that guards both.
 *
 * Two properties are worth the socket:
 *
 *   1. An unset BRIDGE_ADMIN_TOKEN disables the operator routes (503) instead of
 *      opening them. Intake decides who gets paid, so "nobody configured a token"
 *      must never mean "anyone who can reach the port may register a payout
 *      address".
 *   2. A refused invoice names its reasons, so an operator fixes the payload
 *      rather than guessing which rule it broke.
 *
 * The settlement webhook is NOT tested here — it authenticates with Request
 * Network's HMAC over the raw bytes, and `tests/verify.test.ts` covers that.
 */

import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/env.ts';
import type { KeeperHubClient } from '../src/keeperhub.ts';
import { Ledger } from '../src/ledger.ts';
import type { RequestNetworkClient } from '../src/rn/client.ts';
import { createServer } from '../src/server.ts';
import type { Logger } from '../src/settle.ts';

const SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const TOKEN = 'test-admin-token-0123456789';

function silentLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function config(adminToken: string | undefined): Config {
  return {
    rn: {
      clientId: 'client_1',
      webhookSecret: 'secret',
      destinationId: undefined,
      apiBase: 'https://api.request.network',
      authBase: 'https://auth.request.network',
    },
    kh: {
      apiKey: 'kh_test',
      apiBase: 'https://app.keeperhub.com/api',
      mcpUrl: 'https://app.keeperhub.com/mcp',
      orgWallet: undefined,
      chainId: '11155111',
    },
    bridge: {
      port: 0,
      publicUrl: undefined,
      matchAutoApproveThreshold: 0.85,
      dryRun: false,
      adminToken,
    },
  };
}

function invoiceBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

const running: Server[] = [];

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/** Response bodies are `unknown`; the shape is asserted per test. */
async function jsonOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/**
 * `null` means "no token configured". Not `undefined` — an explicit `undefined`
 * to a defaulted parameter selects the default, which would silently test the
 * configured case twice.
 */
async function start(adminToken: string | null = TOKEN) {
  const dir = await mkdtemp(join(tmpdir(), 'trueup-http-'));
  const ledger = new Ledger(join(dir, 'ledger.json'));
  await ledger.load();

  const createSecurePayment = vi.fn(() =>
    Promise.resolve({ requestIds: ['req_live_1'], securePaymentUrl: 'https://pay.example/1' }),
  );
  const rn = {
    createSecurePayment,
    getRequest: vi.fn(),
  } as unknown as RequestNetworkClient;

  const server = createServer({
    config: config(adminToken === null ? undefined : adminToken),
    ledger,
    kh: {} as KeeperHubClient,
    rn,
    logger: silentLogger(),
  });
  running.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    ledger,
    createSecurePayment,
  };
}

function post(url: string, body: unknown, token?: string) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { 'x-trueup-admin-token': token }),
    },
    body: JSON.stringify(body),
  });
}

describe('the operator API', () => {
  it('refuses (503) rather than running open when no token is configured', async () => {
    const { base, ledger } = await start(null);

    const response = await post(`${base}/invoices`, invoiceBody());
    expect(response.status).toBe(503);
    expect((await jsonOf<{ error: string }>(response)).error).toBe('admin_api_disabled');
    // The important half: nothing was written.
    expect(ledger.snapshot().invoices).toEqual({});
  });

  it('rejects a request with a missing or wrong token', async () => {
    const { base, ledger } = await start();

    expect((await post(`${base}/invoices`, invoiceBody())).status).toBe(401);
    expect((await post(`${base}/invoices`, invoiceBody(), 'wrong-token-000000000')).status).toBe(401);
    expect(ledger.snapshot().invoices).toEqual({});
  });

  it('registers an invoice and reads it back with its payables', async () => {
    const { base } = await start();

    const created = await post(`${base}/invoices`, invoiceBody(), TOKEN);
    expect(created.status).toBe(201);
    const body = await jsonOf<{ invoice: { id: string }; payables: unknown[] }>(created);
    expect(body.invoice.id).toBe('INV-5001');
    expect(body.payables).toHaveLength(2);

    const listed = await fetch(`${base}/invoices`, {
      headers: { 'x-trueup-admin-token': TOKEN },
    });
    expect(listed.status).toBe(200);
    const book = await jsonOf<{
      invoices: Array<{ id: string; payables: Array<{ id: string }> }>;
      settlements: unknown[];
    }>(listed);
    const found = book.invoices.find((i) => i.id === 'INV-5001');
    expect(found?.payables.map((p) => p.id)).toEqual(['PAY-5001-CARRIER', 'PAY-5001-FUEL']);
    // Nothing has settled, so there are no settlement records yet.
    expect(book.settlements).toEqual([]);
  });

  it('refuses an invoice whose payables do not sum to it, and says why', async () => {
    const { base, ledger } = await start();
    const body = invoiceBody();
    const payables = (body.payables as Array<Record<string, unknown>>).slice(0, 1);

    const response = await post(`${base}/invoices`, { ...body, payables }, TOKEN);

    expect(response.status).toBe(422);
    const payload = await jsonOf<{ error: string; reasons: string[] }>(response);
    expect(payload.error).toBe('invoice_refused');
    expect(payload.reasons.join(' ')).toMatch(/collected and never paid out/);
    expect(ledger.snapshot().invoices).toEqual({});
  });

  it('refuses a malformed payload with the field that is wrong', async () => {
    const { base } = await start();
    const body = invoiceBody();
    const payables = body.payables as Array<Record<string, unknown>>;
    payables[0] = { ...(payables[0] as Record<string, unknown>), address: 'not-an-address' };

    const response = await post(`${base}/invoices`, { ...body, payables }, TOKEN);

    expect(response.status).toBe(422);
    const payload = await jsonOf<{ error: string; issues: string[] }>(response);
    expect(payload.error).toBe('invalid_invoice_payload');
    expect(payload.issues.join(' ')).toMatch(/payables\.0\.address/);
  });

  it('creates the Request Network request when asked, and links it to the invoice', async () => {
    const { base, ledger, createSecurePayment } = await start();

    const response = await post(
      `${base}/invoices`,
      invoiceBody({ createPaymentRequest: true }),
      TOKEN,
    );

    expect(response.status).toBe(201);
    expect(createSecurePayment).toHaveBeenCalledTimes(1);
    expect(ledger.getInvoice('INV-5001')?.rnRequestId).toBe('req_live_1');
    expect(ledger.invoiceForRequest('req_live_1')?.id).toBe('INV-5001');
  });

  it('does not call Request Network unless asked', async () => {
    const { base, createSecurePayment } = await start();

    await post(`${base}/invoices`, invoiceBody(), TOKEN);

    expect(createSecurePayment).not.toHaveBeenCalled();
  });

  it('guards the KeeperHub workflow callback with the same token', async () => {
    const { base } = await start();

    expect((await post(`${base}/webhooks/keeperhub-fallback`, { requestId: 'x' })).status).toBe(401);
    const ok = await post(`${base}/webhooks/keeperhub-fallback`, { requestId: 'x' }, TOKEN);
    expect(ok.status).toBe(202);
  });

  it('leaves health and readiness public, because they disclose nothing', async () => {
    const { base } = await start();

    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    const body = await jsonOf<{ readiness: string[] }>(ready);
    expect(body.readiness.join('\n')).toMatch(/BRIDGE_ADMIN_TOKEN/);
  });
});
