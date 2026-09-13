/**
 * Request Network API client.
 *
 * Endpoints and field names are taken from Request Network's published API
 * reference:
 *
 *   POST {api}/v2/secure-payments   create a payment request (headers: x-client-id)
 *   GET  {api}/v2/request/{id}      status of a payment request
 *   POST {auth}/v1/webhook          register a webhook; secret returned ONCE
 *
 * Two details that are easy to get wrong:
 *   - `reference` is a TOP-LEVEL field of the create body, not per-request. It is
 *     how we attach our own invoice id to the payment.
 *   - The webhook registration response contains the signing secret exactly once.
 *     It is never returned again, so it is surfaced loudly to the caller.
 */

import { z } from 'zod';

const SecurePaymentResponse = z
  .object({
    requestIds: z.array(z.string().min(1)).min(1),
    securePaymentUrl: z.string().optional(),
    token: z.string().optional(),
    feePlan: z.unknown().optional(),
  })
  .passthrough();

export type SecurePaymentResponse = z.infer<typeof SecurePaymentResponse>;

const PaymentSummary = z
  .object({
    amount: z.string().optional(),
    txHash: z.string().optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const RequestStatusResponse = z
  .object({
    requestId: z.string().optional(),
    status: z.string().optional(),
    hasBeenPaid: z.boolean().optional(),
    paymentReference: z.string().optional(),
    reference: z.string().nullish(),
    txHash: z.string().nullish(),
    amountInUsd: z.string().nullish(),
    payments: z.array(PaymentSummary).optional(),
  })
  .passthrough();

export type RequestStatus = z.infer<typeof RequestStatusResponse>;

const WebhookRegistrationResponse = z
  .object({
    id: z.string().min(1),
    secret: z.string().min(1),
  })
  .passthrough();

export type WebhookRegistrationResponse = z.infer<typeof WebhookRegistrationResponse>;

export interface RnClientOptions {
  readonly apiBase: string;
  readonly authBase: string;
  readonly clientId: string | undefined;
  /** Injectable for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export class RequestNetworkError extends Error {
  override readonly name = 'RequestNetworkError';
  readonly status: number;
  readonly body: string;

  constructor(operation: string, status: number, body: string) {
    super(`Request Network ${operation} failed with HTTP ${status}: ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

export interface CreateSecurePaymentInput {
  /** Composite `<interopAddress>:<tokenAddress>`. Falls back to config when omitted. */
  readonly destinationId?: string | undefined;
  /** Human-readable amount, e.g. `"4200.00"`. */
  readonly amount: string;
  /** Our invoice id. Attached so it travels with the payment. */
  readonly reference: string;
  readonly payerIdentifier?: string | undefined;
  readonly redirectUrl?: string | undefined;
}

export class RequestNetworkClient {
  private readonly apiBase: string;
  private readonly authBase: string;
  private readonly clientId: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RnClientOptions) {
    this.apiBase = options.apiBase.replace(/\/$/, '');
    this.authBase = options.authBase.replace(/\/$/, '');
    this.clientId = options.clientId;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private requireClientId(operation: string): string {
    if (this.clientId === undefined || this.clientId.length === 0) {
      throw new Error(
        `Cannot ${operation}: RN_CLIENT_ID is not configured. Create a payment ` +
          `destination in the Request Network dashboard first, then create a client id.`,
      );
    }
    return this.clientId;
  }

  /** Creates a payment request. Returns the ids Request Network assigned. */
  async createSecurePayment(
    input: CreateSecurePaymentInput,
  ): Promise<SecurePaymentResponse> {
    const clientId = this.requireClientId('create a secure payment');

    const body = {
      requests: [
        {
          ...(input.destinationId === undefined
            ? {}
            : { destinationId: input.destinationId }),
          amount: input.amount,
        },
      ],
      reference: input.reference,
      ...(input.payerIdentifier === undefined
        ? {}
        : { payerIdentifier: input.payerIdentifier }),
      ...(input.redirectUrl === undefined ? {} : { redirectUrl: input.redirectUrl }),
    };

    const response = await this.fetchImpl(`${this.apiBase}/v2/secure-payments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-client-id': clientId,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new RequestNetworkError('createSecurePayment', response.status, text);
    }

    return SecurePaymentResponse.parse(JSON.parse(text));
  }

  /**
   * Reads the authoritative state of a payment request. This is where `reference`
   * lives — the webhook does not carry it — which makes this the confirmation
   * step when a settlement needs to be attributed.
   */
  async getRequest(requestId: string): Promise<RequestStatus> {
    const clientId = this.requireClientId('read a payment request');

    const response = await this.fetchImpl(
      `${this.apiBase}/v2/request/${encodeURIComponent(requestId)}`,
      {
        method: 'GET',
        headers: { 'x-client-id': clientId },
      },
    );

    const text = await response.text();
    if (!response.ok) {
      throw new RequestNetworkError('getRequest', response.status, text);
    }

    return RequestStatusResponse.parse(JSON.parse(text));
  }

  /**
   * Registers a webhook URL. The returned secret is the ONLY time Request Network
   * discloses it — persist it immediately or the integration cannot verify a
   * single delivery and must be re-registered.
   */
  async registerWebhook(url: string): Promise<WebhookRegistrationResponse> {
    const clientId = this.requireClientId('register a webhook');

    const response = await this.fetchImpl(`${this.authBase}/v1/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-client-id': clientId,
      },
      body: JSON.stringify({ url }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new RequestNetworkError('registerWebhook', response.status, text);
    }

    return WebhookRegistrationResponse.parse(JSON.parse(text));
  }
}
