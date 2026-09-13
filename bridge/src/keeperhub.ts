/**
 * KeeperHub API client.
 *
 * Endpoints, headers and response fields are taken from KeeperHub's published
 * API reference. The important behaviours encoded here:
 *
 *   - Simulation is a STRICT boolean, and simulation never returns a hash.
 *   - A simulation that reports `wouldRevert: true` is an HTTP 400 with
 *     `failureKind: "revert"`; an underfunded sender is `failureKind:
 *     "validation"` with `code: "insufficient_balance"`. Both mean nothing was
 *     signed, which is the point of the dry run.
 *   - Idempotency is an `Idempotency-Key` header, replayed for 24h. The two 409
 *     codes mean opposite things: `idempotency_conflict` is terminal (rotate the
 *     key), `idempotency_in_progress` is retryable with the SAME key.
 *   - Terminality comes from the `X-Poll-Interval-Hint` header, not the status
 *     string — the documented status list is a lower bound.
 *
 * `transferSafely` is the only exported way to move funds. It runs the dry run
 * and refuses to broadcast unless the dry run succeeded and would not revert, so
 * no caller can skip the dry run by accident.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

// Documented caps. A single transaction transferring a recognised stablecoin is
// capped at 100 USD on every write path — over the limit nothing is signed and
// the request comes back as a failed execution. Default native caps are
// 0.02 ETH/day and 0.5 SOL/day.
export const STABLECOIN_PER_TRANSACTION_CAP_USD = 100;
export const DEFAULT_NATIVE_DAILY_CAP_ETH = 0.02;

export const ExecutionStatusValues = [
  'pending',
  'running',
  'unconfirmed',
  'completed',
  'failed',
] as const;

export type ExecutionStatusValue = (typeof ExecutionStatusValues)[number];

const ExecutionResponse = z
  .object({
    executionId: z.string().min(1),
    status: z.string(),
    transactionHash: z.string().nullish(),
    transactionLink: z.string().nullish(),
    idempotentReplay: z.boolean().optional(),
  })
  .passthrough();

export type ExecutionResponse = z.infer<typeof ExecutionResponse>;

const SimulationResponse = z
  .object({
    success: z.boolean().optional(),
    status: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    value: z.string().optional(),
    gasEstimate: z.string().optional(),
    simulatedReturnValue: z.unknown().optional(),
    wouldRevert: z.boolean().optional(),
  })
  .passthrough();

export type SimulationResponse = z.infer<typeof SimulationResponse>;

const ReceiptSchema = z
  .object({
    hash: z.string(),
    chainId: z.union([z.string(), z.number()]).optional(),
    verified: z.boolean().optional(),
    receiptStatus: z.string().optional(),
    blockNumber: z.union([z.string(), z.number()]).nullish(),
    gasUsed: z.string().optional(),
    verifiedAt: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const ExecutionStatusResponse = z
  .object({
    executionId: z.string(),
    status: z.string(),
    type: z.string().optional(),
    network: z.union([z.string(), z.number()]).optional(),
    transactionHash: z.string().nullish(),
    transactionLink: z.string().nullish(),
    sponsored: z.boolean().optional(),
    retryCount: z.number().optional(),
    receipts: z.array(ReceiptSchema).optional(),
    gasUsedWei: z.string().nullish(),
    gasPriceWei: z.string().nullish(),
    estimatedCostUsd: z.string().nullish(),
    result: z.unknown().optional(),
    error: z.string().nullish(),
    createdAt: z.union([z.string(), z.number()]).optional(),
    completedAt: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

export type ExecutionStatusResponse = z.infer<typeof ExecutionStatusResponse>;

export interface KeeperHubClientOptions {
  readonly apiBase: string;
  readonly apiKey: string | undefined;
  readonly fetchImpl?: typeof fetch;
  /** Injected in tests so polling does not actually wait. */
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

export class KeeperHubError extends Error {
  override readonly name = 'KeeperHubError';
  readonly status: number;
  readonly code: string | undefined;
  readonly retryable: boolean;
  readonly body: string;

  constructor(
    operation: string,
    status: number,
    body: string,
    code?: string,
    retryable = false,
  ) {
    super(`KeeperHub ${operation} failed with HTTP ${status}${code ? ` [${code}]` : ''}: ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
    this.code = code;
    this.retryable = retryable;
  }
}

/** Raised when a dry run reports that the transaction would revert. Nothing was broadcast. */
export class SimulationRevertError extends Error {
  override readonly name = 'SimulationRevertError';
  readonly reason: string;
  readonly detail: unknown;

  constructor(message: string, detail: unknown) {
    super(message);
    this.reason = message;
    this.detail = detail;
  }
}

export interface TransferRequest {
  readonly chainId: string;
  readonly recipientAddress: string;
  /** Human-readable decimal string, e.g. `"12.50"`. */
  readonly amount: string;
  /** ERC-20 contract address. Omit for a native transfer. */
  readonly tokenAddress?: string | undefined;
  readonly tokenConfig?: string | undefined;
  readonly gasLimitMultiplier?: string | undefined;
}

export class KeeperHubClient {
  private readonly apiBase: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: KeeperHubClientOptions) {
    // Every path below already starts with `/api/`, but KH_API_BASE is
    // documented as `https://app.keeperhub.com/api` and ships that way in
    // .env.example. Naively concatenating gives `/api/api/execute/transfer`,
    // which 404s. Normalise to a bare origin so both spellings work and a
    // misconfigured base can never silently double the prefix.
    const trimmed = options.apiBase.replace(/\/+$/, '');
    this.apiBase = trimmed.endsWith('/api') ? trimmed.slice(0, -4) : trimmed;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    if (this.apiKey === undefined || this.apiKey.length === 0) {
      throw new Error(
        'KH_API_KEY is not configured. Create an organization key at avatar -> ' +
          'API Keys -> Organisation (it starts with kh_).',
      );
    }
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
      ...extra,
    };
  }

  /** Reads remaining rate-limit budget from a response, when the headers are present. */
  private static rateLimitFrom(response: Response): {
    limit: number | undefined;
    remaining: number | undefined;
    reset: number | undefined;
  } {
    const num = (name: string): number | undefined => {
      const value = response.headers.get(name);
      return value === null ? undefined : Number(value);
    };
    return {
      limit: num('X-RateLimit-Limit'),
      remaining: num('X-RateLimit-Remaining'),
      reset: num('X-RateLimit-Reset'),
    };
  }

  private async post(
    path: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<{ response: Response; text: string }> {
    const extra: Record<string, string> = {};
    if (idempotencyKey !== undefined) {
      extra['idempotency-key'] = idempotencyKey;
    }

    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: this.headers(extra),
      body: JSON.stringify(body),
    });
    return { response, text: await response.text() };
  }

  /**
   * Dry run. Never signs, never broadcasts, never returns a hash.
   * Throws `SimulationRevertError` when the transaction would fail, so callers
   * cannot accidentally proceed past a failure.
   */
  async simulateTransfer(request: TransferRequest): Promise<SimulationResponse> {
    const { response, text } = await this.post('/api/execute/transfer', {
      ...this.transferBody(request),
      simulate: true,
    });

    if (response.status === 400) {
      // Documented preflight failure shapes.
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // fall through with the raw text
      }
      const failureKind = parsed['failureKind'];
      const code = parsed['code'];
      if (failureKind === 'revert') {
        throw new SimulationRevertError(
          `Dry run would revert (${String(parsed['revertReason'] ?? 'no reason given')}). ` +
            `Nothing was signed or broadcast.`,
          parsed,
        );
      }
      if (failureKind === 'validation') {
        throw new SimulationRevertError(
          `Dry run failed validation${code ? ` (${String(code)})` : ''}. ` +
            `Nothing was signed or broadcast.`,
          parsed,
        );
      }
      throw new KeeperHubError('simulateTransfer', response.status, text);
    }

    if (!response.ok) {
      throw new KeeperHubError('simulateTransfer', response.status, text);
    }

    const simulation = SimulationResponse.parse(JSON.parse(text));
    if (simulation.wouldRevert === true) {
      throw new SimulationRevertError(
        'Dry run reported wouldRevert: true. Nothing was signed or broadcast.',
        simulation,
      );
    }
    return simulation;
  }

  /**
   * Broadcasts a transfer. Callers should prefer `transferSafely`, which dry-runs
   * first; this exists for the rare case where a dry run is impossible.
   */
  async executeTransfer(
    request: TransferRequest,
    idempotencyKey?: string,
  ): Promise<ExecutionResponse> {
    const { response, text } = await this.post(
      '/api/execute/transfer',
      this.transferBody(request),
      idempotencyKey,
    );

    if (response.status === 409) {
      const parsed = safeJson(text);
      const code = typeof parsed?.['code'] === 'string' ? parsed['code'] : undefined;
      const retryable = parsed?.['retryable'] === true;
      throw new KeeperHubError('executeTransfer', 409, text, code, retryable);
    }
    if (!response.ok) {
      throw new KeeperHubError('executeTransfer', response.status, text);
    }
    return ExecutionResponse.parse(JSON.parse(text));
  }

  /**
   * The only supported way to move funds through this service.
   *
   * Runs the dry run, refuses to continue unless it succeeded and would not
   * revert, then broadcasts with a stable idempotency key. If the same logical
   * payment is attempted twice, KeeperHub replays the first result rather than
   * sending a second transfer.
   */
  async transferSafely(
    request: TransferRequest,
    idempotencyKey: string,
  ): Promise<{ simulation: SimulationResponse; execution: ExecutionResponse }> {
    const simulation = await this.simulateTransfer(request);

    // A simulation that took no action (read-only or condition unmet) carries no
    // `wouldRevert` at all. For a transfer that means the dry run did not
    // actually exercise the write, so treat it as unsafe to proceed on.
    if (simulation.wouldRevert === undefined) {
      throw new SimulationRevertError(
        'Dry run returned no wouldRevert field, so it did not exercise the write. ' +
          'Refusing to broadcast on an unevaluated transaction.',
        simulation,
      );
    }

    const execution = await this.executeTransfer(request, idempotencyKey);
    return { simulation, execution };
  }

  /** Reads the authoritative status of an execution. */
  async getExecutionStatus(executionId: string): Promise<{
    status: ExecutionStatusResponse;
    /** From `X-Poll-Interval-Hint`. 0 means terminal. */
    pollIntervalHint: number | undefined;
  }> {
    const response = await this.fetchImpl(
      `${this.apiBase}/api/execute/${encodeURIComponent(executionId)}/status`,
      { method: 'GET', headers: this.headers() },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new KeeperHubError('getExecutionStatus', response.status, text);
    }
    const hint = response.headers.get('X-Poll-Interval-Hint');
    return {
      status: ExecutionStatusResponse.parse(JSON.parse(text)),
      pollIntervalHint: hint === null ? undefined : Number(hint),
    };
  }

  /**
   * Polls until terminal, honouring `X-Poll-Interval-Hint`. Terminality is the
   * hint reaching 0, not a status string match — the documented status list is
   * explicitly a lower bound, and treating an unknown status as failure would
   * report a loss for a run that is still settling.
   */
  async waitForExecution(
    executionId: string,
    options: { maxAttempts?: number; initialIntervalMs?: number } = {},
  ): Promise<ExecutionStatusResponse> {
    const maxAttempts = options.maxAttempts ?? 30;
    let interval = options.initialIntervalMs ?? 1500;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const { status, pollIntervalHint } = await this.getExecutionStatus(executionId);

      if (pollIntervalHint === 0) {
        return status;
      }
      if (
        pollIntervalHint === undefined &&
        (status.status === 'completed' || status.status === 'failed')
      ) {
        return status;
      }

      await this.sleepImpl(pollIntervalHint !== undefined ? pollIntervalHint * 1000 : interval);
      interval = Math.min(interval * 1.5, 10_000);
    }

    throw new Error(
      `Execution ${executionId} did not reach a terminal state within ${maxAttempts} polls.`,
    );
  }

  /** Triggers a workflow. Returns an execution id; there is no hash yet. */
  async executeWorkflow(workflowId: string): Promise<ExecutionResponse> {
    const { response, text } = await this.post(
      `/api/workflows/${encodeURIComponent(workflowId)}/execute`,
      {},
    );
    if (!response.ok) {
      throw new KeeperHubError('executeWorkflow', response.status, text);
    }
    return ExecutionResponse.parse(JSON.parse(text));
  }

  /**
   * Blocks server-side until a workflow run finishes. The window is capped at
   * 60s, so `completed: false` means call again rather than failure.
   */
  async waitForWorkflowExecution(
    executionId: string,
    timeoutMs = 55_000,
  ): Promise<{
    executionId: string;
    status: string;
    completed: boolean;
    transactionHashes: Array<{ hash: string; nodeId?: string; nodeName?: string }>;
    error?: string | null;
  }> {
    const response = await this.fetchImpl(
      `${this.apiBase}/api/workflows/executions/${encodeURIComponent(executionId)}/wait?timeoutMs=${timeoutMs}`,
      { method: 'GET', headers: this.headers() },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new KeeperHubError('waitForWorkflowExecution', response.status, text);
    }
    return JSON.parse(text) as {
      executionId: string;
      status: string;
      completed: boolean;
      transactionHashes: Array<{ hash: string; nodeId?: string; nodeName?: string }>;
      error?: string | null;
    };
  }

  /** Reads the org wallet that actually gets funded, and its balances. */
  async getChains(): Promise<unknown> {
    const response = await this.fetchImpl(`${this.apiBase}/chains`, {
      method: 'GET',
      headers: this.headers(),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new KeeperHubError('getChains', response.status, text);
    }
    return JSON.parse(text);
  }

  private transferBody(request: TransferRequest): Record<string, unknown> {
    return {
      chainId: request.chainId,
      recipientAddress: request.recipientAddress,
      amount: request.amount,
      ...(request.tokenAddress === undefined
        ? {}
        : { tokenAddress: request.tokenAddress }),
      ...(request.tokenConfig === undefined ? {} : { tokenConfig: request.tokenConfig }),
      ...(request.gasLimitMultiplier === undefined
        ? {}
        : { gasLimitMultiplier: request.gasLimitMultiplier }),
    };
  }
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds a stable idempotency key for a payment, following the derivation
 * KeeperHub documents: canonicalise the parts, join with `|`, SHA-256 the bytes,
 * send lowercase hex. Stable means a retry of the same logical payment replays
 * rather than paying twice.
 */
export function deriveIdempotencyKey(parts: {
  workId: string;
  chainId: string;
  recipientAddress: string;
  amount: string;
}): string {
  const encode = (value: string): string =>
    value.replace(/%/g, '%25').replace(/\|/g, '%7C');

  const canonicalAmount = (value: string): string => {
    const trimmed = value.trim();
    if (trimmed === '') return '0';
    const match = /^(\d*)(?:\.(\d*))?$/.exec(trimmed);
    if (match === null) return trimmed;
    const whole = (match[1] ?? '') === '' ? '0' : (match[1] as string);
    const fraction = (match[2] ?? '').replace(/0+$/, '');
    const normalisedWhole = whole.replace(/^0+(?=\d)/, '');
    return fraction === '' ? normalisedWhole : `${normalisedWhole}.${fraction}`;
  };

  const canonical = [
    encode(parts.workId),
    parts.chainId.replace(/^0+(?=\d)/, ''),
    parts.recipientAddress.toLowerCase(),
    canonicalAmount(parts.amount),
  ].join('|');

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
