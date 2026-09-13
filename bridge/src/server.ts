/**
 * HTTP entry point.
 *
 * This layer does three things and nothing else: read the raw bytes, verify the
 * signature over those exact bytes, and hand a verified event to the settlement
 * orchestrator. All the interesting logic lives in `settle.ts` and `classify.ts`
 * so that it can be tested without a socket.
 *
 * Response codes are chosen around Request Network's retry behaviour (3 retries,
 * 4 attempts, at 1s / 5s / 15s):
 *   200 — handled. Never retry.
 *   401 — the delivery could not be verified. Retrying will not help.
 *   500 — we failed transiently. Let them retry.
 */

import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, describeReadiness, requireSecret, type Config } from './env.ts';
import { KeeperHubClient } from './keeperhub.ts';
import { Ledger } from './ledger.ts';
import { RequestNetworkClient } from './rn/client.ts';
import { GenericEventSchema, PaymentConfirmedSchema } from './rn/types.ts';
import { isTestDelivery, readDeliveryId, readHeader, SIGNATURE_HEADER, verifySignature } from './rn/verify.ts';
import { settle, type Logger, type SettleDeps } from './settle.ts';

const MAX_BODY_BYTES = 1_000_000;

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
    } satisfies SettleDeps);

    sendJson(res, 200, {
      ok: true,
      acted: outcome.payouts.length > 0,
      verdict: outcome.verdict,
      invoiceId: outcome.invoiceId,
      confidence: outcome.confidence,
      reasons: outcome.reasons,
      payouts: outcome.payouts.map((payout) => ({
        supplierId: payout.supplierId,
        amount: payout.amount,
        executionId: payout.executionId ?? null,
        transactionHash: payout.transactionHash ?? null,
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
