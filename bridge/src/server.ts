/**
 * HTTP entry point.
 *
 * Routes:
 *   POST /webhooks/request-network   Request Network's signed settlement webhook
 *                                    (HMAC over the raw bytes — no shared token)
 *   POST /invoices                   register a receivable and its payables
 *   GET  /invoices                   read the book back
 *   POST /webhooks/keeperhub-fallback  a workflow asking the engine to decide
 *   GET  /healthz, /readyz           liveness and configuration
 *
 * The webhook path verifies an HMAC signature over the exact bytes it received.
 * Every other non-public route requires `x-trueup-admin-token` to match
 * `BRIDGE_ADMIN_TOKEN`; when that variable is unset they refuse with 503 rather
 * than running open. The settlement logic lives in `settle.ts`, `classify.ts` and
 * `intake.ts` so it can be tested without a socket.
 *
 * Response codes are chosen around Request Network's retry behaviour (3 retries,
 * 4 attempts, at 1s / 5s / 15s):
 *   200 — handled. Never retry.
 *   401 — the delivery could not be verified. Retrying will not help.
 *   500 — we failed transiently. Let them retry.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig, describeReadiness, requireSecret, type Config } from './env.ts';
import { IntakeError, IntakeRequestSchema, registerInvoice } from './intake.ts';
import { KeeperHubClient } from './keeperhub.ts';
import { Ledger, type Invoice } from './ledger.ts';
import { RequestNetworkClient } from './rn/client.ts';
import { GenericEventSchema, PaymentConfirmedSchema } from './rn/types.ts';
import { isTestDelivery, readDeliveryId, readHeader, SIGNATURE_HEADER, verifySignature } from './rn/verify.ts';
import { settle, type Logger, type SettleDeps } from './settle.ts';

const MAX_BODY_BYTES = 1_000_000;

/** The admin token header. Named so the operator can see it in logs and docs. */
const ADMIN_HEADER = 'x-trueup-admin-token';

/**
 * The intake body is the invoice payload plus one control flag. Declared here
 * rather than in `intake.ts` because "create the Request Network request too" is
 * a property of the HTTP call, not of what an invoice is.
 */
const IntakeBodySchema = IntakeRequestSchema.extend({
  createPaymentRequest: z.boolean().optional(),
});

function consoleLogger(): Logger {
  return {
    info: (message, fields) => console.log(`[info]  ${message}`, fields ?? ''),
    warn: (message, fields) => console.warn(`[warn]  ${message}`, fields ?? ''),
    error: (message, fields) => console.error(`[error] ${message}`, fields ?? ''),
  };
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export interface ServerDeps {
  readonly config: Config;
  readonly ledger: Ledger;
  readonly kh: KeeperHubClient;
  readonly rn: RequestNetworkClient;
  readonly logger: Logger;
}

/**
 * Constant-time comparison of two secrets.
 *
 * Both sides are hashed first so the buffers are always 32 bytes: `timingSafeEqual`
 * throws on a length mismatch, and a length check would itself leak the length of
 * the expected token. Hashing also means a long or short guess costs the same.
 */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined || provided.length === 0) {
    return false;
  }
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Guards the operator-facing routes. Returns false when a response was already
 * sent, so callers write `if (!requireAdmin(...)) return;`.
 *
 * An unset token disables the routes (503) rather than opening them. The intake
 * endpoint decides who gets paid, so "nobody configured a token" must not mean
 * "anyone who can reach the port may register a payout address".
 */
function requireAdmin(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): boolean {
  const expected = deps.config.bridge.adminToken;
  if (expected === undefined || expected.length === 0) {
    deps.logger.error('refused an operator request: BRIDGE_ADMIN_TOKEN is not configured', {
      path: req.url,
    });
    sendJson(res, 503, {
      error: 'admin_api_disabled',
      detail:
        'BRIDGE_ADMIN_TOKEN is not set, so the operator API is disabled rather than open. ' +
        'Set it in .env and restart the bridge.',
    });
    return false;
  }
  if (!tokenMatches(readHeader(req.headers, ADMIN_HEADER), expected)) {
    deps.logger.warn('rejected an operator request with a missing or wrong token', {
      path: req.url,
    });
    sendJson(res, 401, {
      error: 'invalid_admin_token',
      detail: `Send the value of BRIDGE_ADMIN_TOKEN in the ${ADMIN_HEADER} header.`,
    });
    return false;
  }
  return true;
}

export function createServer(deps: ServerDeps) {
  return createHttpServer((req, res) => {
    void handleRequest(req, res, deps).catch((error: unknown) => {
      deps.logger.error('unhandled error in request handler', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_error' });
      }
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const url = req.url ?? '/';

  if (req.method === 'GET' && url === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url === '/readyz') {
    sendJson(res, 200, { readiness: describeReadiness(deps.config) });
    return;
  }

  // --- The book: register a receivable, or read it back. -------------------
  // This is the product's input path. Before it existed, the only way an invoice
  // and its payables reached the ledger was the demo seed reading a fixture file.
  if (url === '/invoices' || url.startsWith('/invoices?') || url.startsWith('/invoices/')) {
    if (!requireAdmin(req, res, deps)) {
      return;
    }

    if (req.method === 'GET') {
      const state = deps.ledger.snapshot();
      sendJson(res, 200, {
        invoices: Object.values(state.invoices).map((invoice) => ({
          id: invoice.id,
          customer: invoice.customer,
          amount: invoice.amount,
          currency: invoice.currency,
          reference: invoice.reference,
          status: invoice.status,
          settledAmount: invoice.settledAmount,
          rnRequestId: invoice.rnRequestId ?? null,
          payables: deps.ledger.payablesForInvoice(invoice.id).map((payable) => ({
            id: payable.id,
            supplierId: payable.supplierId,
            supplierName: payable.supplierName,
            address: payable.address,
            amountOwed: payable.amountOwed,
            chainId: payable.chainId,
            tokenAddress: payable.tokenAddress ?? null,
          })),
        })),
        settlements: Object.values(state.deliveries),
      });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed', allow: 'GET, POST' });
      return;
    }

    const raw = await readRawBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { error: 'invalid_json' });
      return;
    }

    const body = IntakeBodySchema.safeParse(parsed);
    if (!body.success) {
      sendJson(res, 422, {
        error: 'invalid_invoice_payload',
        issues: body.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
      return;
    }

    const { createPaymentRequest, ...intakeRequest } = body.data;

    try {
      const result = await registerInvoice(intakeRequest, {
        ledger: deps.ledger,
        createRequest:
          createPaymentRequest === true
            ? async (invoice: Invoice) => {
                const created = await deps.rn.createSecurePayment({
                  // Omit destinationId when unset so the bound destination resolves.
                  ...(deps.config.rn.destinationId === undefined
                    ? {}
                    : { destinationId: deps.config.rn.destinationId }),
                  amount: invoice.amount,
                  reference: invoice.reference,
                });
                const first = created.requestIds[0];
                if (first === undefined) {
                  throw new Error('Request Network returned no request id');
                }
                return first;
              }
            : undefined,
      });

      deps.logger.info('registered an invoice', {
        invoiceId: result.invoice.id,
        payables: result.payables.length,
        notes: result.notes,
      });

      sendJson(res, 201, {
        ok: true,
        invoice: result.invoice,
        payables: result.payables,
        notes: result.notes,
      });
    } catch (error) {
      if (error instanceof IntakeError) {
        // 422: the payload is well-formed but not payable. Every reason is listed.
        deps.logger.warn('refused an invoice', { errors: error.errors });
        sendJson(res, 422, { error: 'invoice_refused', reasons: error.errors });
        return;
      }
      deps.logger.error('invoice intake failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      sendJson(res, 502, {
        error: 'invoice_intake_failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  // KeeperHub workflow callback. A workflow that decides an inbound payment is
  // unattributed POSTs here, so the reconciliation engine — not a workflow
  // Condition — makes the attribution decision. This keeps the judgement in
  // tested TypeScript rather than in a graph, which is the whole design.
  if (req.method === 'POST' && url.startsWith('/webhooks/keeperhub-fallback')) {
    if (!requireAdmin(req, res, deps)) {
      return;
    }
    const raw = await readRawBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { error: 'invalid_json' });
      return;
    }
    deps.logger.info('keeperhub workflow requested a reconciliation decision', {
      bytes: raw.length,
      body: parsed,
    });
    sendJson(res, 202, {
      ok: true,
      accepted: true,
      note: 'Recorded. The reconciliation engine will decide; this endpoint never moves money itself.',
    });
    return;
  }

  if (req.method !== 'POST' || !url.startsWith('/webhooks/request-network')) {
    sendJson(res, 404, { error: 'not_found', path: url });
    return;
  }

  const rawBody = await readRawBody(req);
  const headers = req.headers;

  // --- 1. Signature. Over the raw bytes, before anything is parsed. ---------
  const verification = verifySignature(
    rawBody,
    readHeader(headers, SIGNATURE_HEADER),
    deps.config.rn.webhookSecret,
  );

  if (!verification.ok) {
    deps.logger.warn('rejected unverified webhook delivery', {
      reason: verification.reason,
      detail: verification.detail,
      deliveryId: readDeliveryId(headers),
    });
    // A forged delivery and a real one we cannot verify both get 401: retrying
    // cannot fix either, and we must never act on an unverified payment event.
    sendJson(res, 401, { error: 'signature_verification_failed', reason: verification.reason });
    return;
  }

  // --- 2. Test deliveries never move money. --------------------------------
  if (isTestDelivery(headers)) {
    deps.logger.info('acknowledged test delivery without action');
    sendJson(res, 200, { ok: true, acted: false, reason: 'test_delivery' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }

  const envelope = GenericEventSchema.safeParse(parsed);
  if (!envelope.success) {
    sendJson(res, 400, { error: 'missing_event_field' });
    return;
  }

  // The delivery id (a ULID, stable across Request Network's retries) is the
  // idempotency key. Falling back to a body hash keeps idempotency working even
  // if the header is absent, at the cost of treating two byte-identical
  // deliveries as one — which is the safer failure direction.
  const deliveryId =
    readDeliveryId(headers) ?? `bodyhash:${hashOf(rawBody)}`;

  // --- 3. Idempotency. A redelivery is acknowledged, never re-executed. ----
  const seen = deps.ledger.recordForDelivery(deliveryId);
  if (seen !== undefined) {
    deps.logger.info('replayed delivery — no action taken', {
      deliveryId,
      originalVerdict: seen.verdict,
      executionIds: seen.executionIds,
    });
    sendJson(res, 200, {
      ok: true,
      acted: false,
      replayed: true,
      verdict: seen.verdict,
      invoiceId: seen.invoiceId,
      executionIds: seen.executionIds,
    });
    return;
  }

  if (envelope.data.event !== 'payment.confirmed') {
    deps.logger.info('ignoring event we do not act on', { event: envelope.data.event });
    sendJson(res, 200, { ok: true, acted: false, reason: 'event_not_handled' });
    return;
  }

  const settlement = PaymentConfirmedSchema.safeParse(parsed);
  if (!settlement.success) {
    deps.logger.warn('payment.confirmed failed schema validation', {
      issues: settlement.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
    sendJson(res, 400, { error: 'invalid_payment_confirmed_payload' });
    return;
  }

  // --- 4. Decide and act. -------------------------------------------------
  try {
    const outcome = await settle(settlement.data, deliveryId, {
      ledger: deps.ledger,
      kh: deps.kh,
      rn: deps.rn,
      logger: deps.logger,
      autoApproveThreshold: deps.config.bridge.matchAutoApproveThreshold,
      simulateOnly: deps.config.bridge.dryRun,
    } satisfies SettleDeps);

    const dryRun = outcome.dryRun === true;

    sendJson(res, 200, {
      ok: true,
      // A rehearsal acts on nothing, however good the verdict looks.
      acted: !dryRun && outcome.payouts.length > 0,
      dryRun,
      verdict: outcome.verdict,
      invoiceId: outcome.invoiceId,
      confidence: outcome.confidence,
      reasons: outcome.reasons,
      payouts: outcome.payouts.map((payout) => ({
        supplierId: payout.supplierId,
        amount: payout.amount,
        executionId: payout.executionId ?? null,
        transactionHash: payout.transactionHash ?? null,
        // Populated instead of a hash when this was a rehearsal.
        gasEstimate: payout.gasEstimate ?? null,
        error: payout.error ?? null,
      })),
      held: outcome.holds.length,
    });
  } catch (error) {
    // 500 so Request Network retries; the delivery id keeps that retry safe.
    deps.logger.error('settlement failed', {
      deliveryId,
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 500, { error: 'settlement_failed' });
  }
}

function hashOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function main(): Promise<void> {
  const config = loadConfig();

  const logger = consoleLogger();
  const ledger = new Ledger('data/ledger.json');
  await ledger.load();
  // Loud, because a migrated ledger is missing payables it used to have, and the
  // only symptom otherwise is a settlement that holds instead of paying.
  for (const note of ledger.migrationNotes()) {
    logger.warn(note);
  }

  const kh = new KeeperHubClient({
    apiBase: config.kh.apiBase,
    apiKey: config.kh.apiKey,
  });
  const rn = new RequestNetworkClient({
    apiBase: config.rn.apiBase,
    authBase: config.rn.authBase,
    clientId: config.rn.clientId,
  });

  const server = createServer({ config, ledger, kh, rn, logger });

  server.listen(config.bridge.port, () => {
    logger.info('trueup-bridge listening', { port: config.bridge.port });
    for (const line of describeReadiness(config)) {
      logger.info(`  ${line}`);
    }
    if (config.bridge.dryRun) {
      logger.warn(
        'BRIDGE_DRY_RUN is on: settlements will be classified and their payouts ' +
          'simulated through KeeperHub, but nothing will be signed, broadcast, or ' +
          'written to the ledger. Turn it off for the real run.',
      );
    }
    if (config.rn.webhookSecret === undefined) {
      logger.warn(
        'RN_WEBHOOK_SECRET is unset, so every delivery will be rejected with 401. ' +
          'Register the webhook and store the secret it returns.',
      );
    }
  });
}

// Only start when executed directly, so tests can import without binding a port.
// Comparing resolved filesystem paths avoids the Windows path/URL mismatch that
// a naive `import.meta.url.endsWith(argv[1])` check produces.
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error('failed to start trueup-bridge:', error);
    process.exitCode = 1;
  });
}

// Referenced so `requireSecret` stays part of the public surface for scripts.
export { requireSecret };
