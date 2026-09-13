/**
 * Receipt bundle — the auditable record.
 *
 * This is the artifact the hackathon theme is actually about: "deterministically,
 * on demand, with full control and an auditable record". A settlement that we
 * acted on produces one of these; so does a settlement we deliberately refused to
 * act on, because a refusal is a decision and belongs in the record.
 *
 * Shape deliberately mirrors the design agreed in KeeperHub issue #2395 (a
 * read-only `POST /api/execute/receipts/export` taking `{ executionIds }` and
 * returning versioned JSON of allowlisted receipt fields):
 *
 *   - bounded — the caller passes a fixed set of execution ids, capped
 *   - versioned — `bundleVersion` is checked before the shape is trusted
 *   - allowlisted — every field is named explicitly, nothing is spread through
 *   - no raw payloads — the webhook body is fingerprinted, not embedded, and no
 *     credential, key or secret is ever written
 *   - ordered — receipts come back in the order requested, so two bundles for the
 *     same set of executions can be compared byte for byte
 *
 * Being column-explicit rather than spreading API responses is what keeps secrets
 * out: a client that spreads `...response` eventually leaks an auth header into
 * an export somebody emails.
 */

import { createHash } from 'node:crypto';
import type { ExecutionStatusResponse } from './keeperhub.ts';
import type { SettlementRecord } from './ledger.ts';

export const BUNDLE_VERSION = 1;

export interface BundleReceipt {
  /** KeeperHub run id — the primary key of the auditable record. */
  readonly executionId: string;
  readonly status: string;
  readonly chainId: string | undefined;
  readonly transactionHash: string | undefined;
  readonly transactionLink: string | undefined;
  readonly blockNumber: string | undefined;
  readonly gasUsed: string | undefined;
  /** Whether the chain receipt was independently verified by KeeperHub. */
  readonly verified: boolean | undefined;
  readonly receiptStatus: string | undefined;
  readonly retryCount: number | undefined;
}

export interface BundleDecision {
  readonly verdict: SettlementRecord['verdict'];
  readonly confidence: number;
  readonly invoiceId: string | undefined;
  /** The signals that produced the verdict, in the order they were scored. */
  readonly reasons: readonly string[];
}

export interface BundleInput {
  readonly source: 'request-network';
  /** Request Network's delivery id (ULID) — the idempotency key. */
  readonly deliveryId: string;
  readonly requestId: string;
  /** SHA-256 of the raw webhook body. The body itself is never embedded. */
  readonly webhookBodySha256: string;
  readonly receivedAt: string;
  readonly decision: BundleDecision;
  readonly executionIds: readonly string[];
  readonly receipts: readonly ExecutionStatusResponse[];
}

export interface ReceiptBundle {
  readonly bundleVersion: number;
  readonly generatedAt: string;
  readonly source: string;
  readonly deliveryId: string;
  readonly requestId: string;
  readonly webhookBodySha256: string;
  readonly receivedAt: string;
  readonly decision: BundleDecision;
  /** Number of executions cited. Bounded by MAX_RECEIPTS. */
  readonly executionCount: number;
  readonly receipts: readonly BundleReceipt[];
  /**
   * Fields we deliberately did not include, stated so a reader does not have to
   * guess whether the export is incomplete by accident or on purpose.
   */
  readonly excluded: readonly string[];
}

/** Hard cap, matching the bound agreed in issue #2395. */
export const MAX_RECEIPTS = 50;

/**
 * Field names that must never appear in an export.
 *
 * Both the key and these patterns are reduced to letters and digits before
 * comparison. Stripping only non-letters from the key while the list already
 * contained hyphens (`x-api-key`) meant those entries could never match — and a
 * check that silently never fires is worse than no check, because it reads like
 * protection without being any.
 *
 * Two lists, because one is not enough and the obvious fix is wrong:
 *
 *   EXACT  — matched against the whole normalised key.
 *   SUFFIX — matched against the end of the key, so compound names are caught:
 *            `webhookSecret` ends with `secret`, `accessToken` with `token`,
 *            `privateKey` with `privatekey`.
 *
 * A plain substring match would be the tempting shortcut and it is wrong: it
 * would flag `tokenAddress` and `tokenSymbol`, which are legitimate, public, and
 * exactly the kind of field an on-chain receipt should carry. Suffix matching
 * catches the credential-shaped compounds while leaving benign nouns alone —
 * `tokenAddress` ends in `address`, so it passes. There is a test for that too,
 * because a guard that rejects real output gets deleted by the next maintainer.
 */
const FORBIDDEN_EXACT = [
  'authorization',
  'auth',
  'apikey',
  'apikeys',
  'password',
  'passwd',
  'mnemonic',
  'seedphrase',
  'cookie',
  'credential',
  'credentials',
  'bearer',
  'hmac',
  'signature',
  'xapikey',
  'xclientid',
  'xkeeperhubkey',
  'authorizationheader',
] as const;

/** Sensitive nouns: a key ending in one of these is treated as a credential. */
const FORBIDDEN_SUFFIX = [
  'secret',
  'token',
  'apikey',
  'privatekey',
  'password',
  'passwd',
  'mnemonic',
  'seedphrase',
  'credential',
  'hmac',
] as const;

const normaliseKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

const EXACT_SET: ReadonlySet<string> = new Set(FORBIDDEN_EXACT.map(normaliseKey));
const SUFFIX_LIST: readonly string[] = FORBIDDEN_SUFFIX.map(normaliseKey);

/** True when a key name looks like it carries a credential. */
export function looksLikeCredentialKey(key: string): boolean {
  const normalised = normaliseKey(key);
  if (normalised === '') {
    return false;
  }
  if (EXACT_SET.has(normalised)) {
    return true;
  }
  return SUFFIX_LIST.some((suffix) => normalised.endsWith(suffix));
}

export class ReceiptBundleError extends Error {
  override readonly name = 'ReceiptBundleError';
}

/** Fingerprints a raw body without retaining it. */
export function fingerprint(rawBody: Buffer | string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/**
 * Projects a KeeperHub status response down to allowlisted fields.
 *
 * Note what is dropped: `result` (which can carry arbitrary plugin output and, for
 * some actions, echoed request data) and `error` (which can quote internals).
 */
export function toReceipt(status: ExecutionStatusResponse): BundleReceipt {
  const firstReceipt = status.receipts?.[0];
  return {
    executionId: status.executionId,
    status: status.status,
    chainId: status.network === undefined ? undefined : String(status.network),
    transactionHash: status.transactionHash ?? undefined,
    transactionLink: status.transactionLink ?? undefined,
    blockNumber:
      firstReceipt?.blockNumber === undefined || firstReceipt.blockNumber === null
        ? undefined
        : String(firstReceipt.blockNumber),
    gasUsed: firstReceipt?.gasUsed ?? status.gasUsedWei ?? undefined,
    verified: firstReceipt?.verified,
    receiptStatus: firstReceipt?.receiptStatus,
    retryCount: status.retryCount,
  };
}

/**
 * Builds a bundle.
 *
 * Receipts are reordered to match `executionIds`, and any requested execution
 * missing from `receipts` is reported as an error rather than silently omitted —
 * a bundle that quietly cites fewer executions than it claims is worse than one
 * that fails loudly.
 */
export function buildReceiptBundle(input: BundleInput): ReceiptBundle {
  if (input.executionIds.length > MAX_RECEIPTS) {
    throw new ReceiptBundleError(
      `Cannot cite ${input.executionIds.length} executions; the bound is ${MAX_RECEIPTS}.`,
    );
  }

  const byId = new Map(input.receipts.map((receipt) => [receipt.executionId, receipt]));

  const missing = input.executionIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new ReceiptBundleError(
      `No status was supplied for execution(s): ${missing.join(', ')}. ` +
        `Fetch every execution before building a bundle rather than exporting a partial record.`,
    );
  }

  const receipts = input.executionIds.map((id) => toReceipt(byId.get(id) as ExecutionStatusResponse));

  const bundle: ReceiptBundle = {
    bundleVersion: BUNDLE_VERSION,
    generatedAt: new Date().toISOString(),
    source: input.source,
    deliveryId: input.deliveryId,
    requestId: input.requestId,
    webhookBodySha256: input.webhookBodySha256,
    receivedAt: input.receivedAt,
    decision: {
      verdict: input.decision.verdict,
      confidence: input.decision.confidence,
      invoiceId: input.decision.invoiceId,
      reasons: [...input.decision.reasons],
    },
    executionCount: receipts.length,
    receipts,
    excluded: [
      'the raw webhook body (fingerprint only, see webhookBodySha256)',
      'KeeperHub execution result payloads',
      'credentials, API keys and webhook signing secrets',
    ],
  };

  assertNoSecrets(bundle);
  return bundle;
}

/**
 * Rejects a bundle that contains a field name which looks like a credential.
 *
 * Belt and braces: the projection above is already allowlisted, so this can only
 * fire if someone later adds a field carelessly. That is exactly the change worth
 * failing a build over.
 */
export function assertNoSecrets(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (looksLikeCredentialKey(key)) {
      throw new ReceiptBundleError(
        `Refusing to emit a receipt bundle containing a credential-shaped field ` +
          `'${key}' at ${path}. Use an allowlist rather than spreading a response.`,
      );
    }
    assertNoSecrets(inner, `${path}.${key}`);
  }
}

/** Serialises a bundle for writing to disk or posting to a judge. */
export function serialiseBundle(bundle: ReceiptBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/**
 * Checks a bundle's version before its shape is trusted.
 *
 * A reader should never have to guess whether a field is missing because the
 * export is old or because the data was absent.
 */
export function assertSupportedVersion(bundle: { bundleVersion?: unknown }): void {
  if (bundle.bundleVersion !== BUNDLE_VERSION) {
    throw new ReceiptBundleError(
      `Unsupported receipt bundle version ${String(bundle.bundleVersion)}; ` +
        `this build understands version ${BUNDLE_VERSION}.`,
    );
  }
}
