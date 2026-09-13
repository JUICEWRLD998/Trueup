/**
 * Request Network client tests against an injected fetch.
 *
 * Two cases justify this file, and both were found by pointing the client at the
 * live service rather than at a fake:
 *
 *   1. `registerWebhook` cannot authenticate with `x-client-id`. Every
 *      `auth.request.network` route is a session-cookie route. The old code sent a
 *      header that is certain to 401, so it must now refuse locally with a message
 *      that names the real cause instead of returning a misleading 401.
 *
 *   2. `createSecurePayment` may omit `destinationId` entirely, because a Client ID
 *      bound to a payee destination resolves the payee itself. Verified live: the
 *      create succeeded with the header alone.
 */

import { describe, expect, it, vi } from 'vitest';
import { RequestNetworkClient, RequestNetworkError } from '../src/rn/client.ts';

const CLIENT_ID = '11111111-2222-3333-4444-555555555555';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function makeClient(handler: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const spy = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(handler(url, init ?? {}));
  });
  const client = new RequestNetworkClient({
    apiBase: 'https://api.request.network',
    authBase: 'https://auth.request.network',
    clientId: CLIENT_ID,
    fetchImpl: spy as unknown as typeof fetch,
  });
  return { client, spy, calls };
}

function headersOf(call: Call): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

function bodyOf<T>(call: Call): T {
  return JSON.parse(String(call.init.body)) as T;
}

describe('createSecurePayment', () => {
  it('sends the client id as a header and the reference at the top level', async () => {
    const { client, calls } = makeClient(() =>
      jsonResponse({ requestIds: ['req_1'], securePaymentUrl: 'https://pay.example/1' }, 201),
    );

    const result = await client.createSecurePayment({ amount: '4200.00', reference: 'INV-4471' });

    expect(result.requestIds).toEqual(['req_1']);
    expect(calls[0]?.url).toBe('https://api.request.network/v2/secure-payments');
    expect(headersOf(calls[0] as Call)['x-client-id']).toBe(CLIENT_ID);
    // `reference` is a top-level field, not per-request. Getting this wrong loses
    // the join key between the settlement and our invoice.
    const body = bodyOf<{ reference: string; requests: Record<string, unknown>[] }>(
      calls[0] as Call,
    );
    expect(body.reference).toBe('INV-4471');
    expect(body.requests[0]?.['amount']).toBe('4200.00');
  });

  it('omits destinationId entirely when it is not configured', async () => {
    // The Client ID is bound to a payee destination, so the payee resolves without
    // it. Sending `destinationId: undefined` would fail JSON round-tripping on some
    // clients, so the field must be absent rather than null.
    const { client, calls } = makeClient(() => jsonResponse({ requestIds: ['req_1'] }, 201));

    await client.createSecurePayment({ amount: '10.00', reference: 'INV-1' });

    const body = bodyOf<{ requests: Record<string, unknown>[] }>(calls[0] as Call);
    expect('destinationId' in (body.requests[0] ?? {})).toBe(false);
  });

  it('includes destinationId when one is configured', async () => {
    const { client, calls } = makeClient(() => jsonResponse({ requestIds: ['req_1'] }, 201));

    await client.createSecurePayment({
      destinationId: '0xabc@eip155:11155111#1:0xtoken',
      amount: '10.00',
      reference: 'INV-1',
    });

    const body = bodyOf<{ requests: Record<string, unknown>[] }>(calls[0] as Call);
    expect(body.requests[0]?.['destinationId']).toBe('0xabc@eip155:11155111#1:0xtoken');
  });

  it('surfaces a non-2xx as RequestNetworkError carrying the status', async () => {
    const { client } = makeClient(() => jsonResponse({ message: 'Unauthorized' }, 401));

    await expect(
      client.createSecurePayment({ amount: '1', reference: 'INV-1' }),
    ).rejects.toBeInstanceOf(RequestNetworkError);
  });

  it('refuses to call the API at all without a client id', async () => {
    const spy = vi.fn();
    const client = new RequestNetworkClient({
      apiBase: 'https://api.request.network',
      authBase: 'https://auth.request.network',
      clientId: undefined,
      fetchImpl: spy as unknown as typeof fetch,
    });

    await expect(client.createSecurePayment({ amount: '1', reference: 'INV-1' })).rejects.toThrow(
      /RN_CLIENT_ID is not configured/,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('getRequest', () => {
  it('reads the authoritative reference, which the webhook does not carry', async () => {
    const { client, calls } = makeClient(() =>
      jsonResponse({ requestId: 'req_1', status: 'created', reference: 'INV-4471' }),
    );

    const status = await client.getRequest('req_1');

    expect(status.reference).toBe('INV-4471');
    expect(headersOf(calls[0] as Call)['x-client-id']).toBe(CLIENT_ID);
  });

  it('encodes the request id so an unexpected character cannot alter the path', async () => {
    const { client, calls } = makeClient(() => jsonResponse({ status: 'created' }));

    await client.getRequest('a/b?c');

    expect(calls[0]?.url).toBe('https://api.request.network/v2/request/a%2Fb%3Fc');
  });

  it('accepts a null reference without throwing', async () => {
    // Request Network returns `reference: null` for a request created without one.
    const { client } = makeClient(() => jsonResponse({ status: 'created', reference: null }));

    const status = await client.getRequest('req_1');

    expect(status.reference).toBeNull();
  });
});

describe('registerWebhook', () => {
  it('refuses locally when no session cookie is supplied, and never sends a request', async () => {
    // The regression this guards: the method used to send `x-client-id` to
    // auth.request.network, which returns 401, and a 401 reads like a bad
    // credential. The real cause is that the route is cookie-authenticated.
    const { client, spy } = makeClient(() => jsonResponse({ id: 'wh_1', secret: 's' }, 201));

    await expect(client.registerWebhook('https://bridge.example/webhooks/request-network')).rejects.toThrow(
      /without a dashboard session/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends the cookie header and the client id in the body, not a header', async () => {
    // The spec marks `clientId` "required when using session auth", which is
    // exactly this call — so the body carries it and there is no x-client-id.
    const { client, calls } = makeClient(() =>
      jsonResponse({ id: '01JMMA4WWFT0VAPBAS0GYH70GQ', secret: 'deadbeef' }, 201),
    );

    const registered = await client.registerWebhook('https://bridge.example/webhooks/request-network', {
      cookieHeader: 'session_token=abc123',
    });

    expect(registered.secret).toBe('deadbeef');
    expect(calls[0]?.url).toBe('https://auth.request.network/v1/webhook');
    const headers = headersOf(calls[0] as Call);
    expect(headers['cookie']).toBe('session_token=abc123');
    expect(headers['x-client-id']).toBeUndefined();
    expect(bodyOf<{ url: string; clientId?: string }>(calls[0] as Call)).toEqual({
      url: 'https://bridge.example/webhooks/request-network',
      clientId: CLIENT_ID,
    });
  });

  it('treats a whitespace-only cookie as absent rather than sending an empty header', async () => {
    const { client, spy } = makeClient(() => jsonResponse({ id: 'wh_1', secret: 's' }, 201));

    await expect(client.registerWebhook('https://x.example', { cookieHeader: '   ' })).rejects.toThrow(
      /without a dashboard session/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('surfaces an expired session as RequestNetworkError with the status', async () => {
    const { client } = makeClient(() => jsonResponse({ message: 'Unauthorized' }, 401));

    await expect(
      client.registerWebhook('https://x.example', { cookieHeader: 'session_token=stale' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a response with no secret rather than returning an unusable registration', async () => {
    const { client } = makeClient(() => jsonResponse({ id: 'wh_1' }, 201));

    await expect(
      client.registerWebhook('https://x.example', { cookieHeader: 'session_token=abc' }),
    ).rejects.toThrow();
  });
});
