/**
 * Configuration loading and validation.
 *
 * Secrets are optional at load time so the service can boot and tell you which
 * keys are missing, rather than dying at import. Accessors that genuinely need
 * a secret call `requireSecret`, which fails with the exact variable name.
 */

import { z } from 'zod';

export interface Config {
  readonly rn: {
    clientId: string | undefined;
    webhookSecret: string | undefined;
    destinationId: string | undefined;
    apiBase: string;
    authBase: string;
  };
  readonly kh: {
    apiKey: string | undefined;
    apiBase: string;
    mcpUrl: string;
    orgWallet: string | undefined;
    chainId: string;
  };
  readonly bridge: {
    port: number;
    publicUrl: string | undefined;
    matchAutoApproveThreshold: number;
  };
}

/**
 * An empty value in a .env template means "not set", not "invalid".
 *
 * `.env.example` ships every key with an empty value so the operator can see
 * what exists. Without this, copying the template produces a wall of validation
 * errors for keys the operator has simply not filled in yet.
 *
 * The placement of `.optional()` is load-bearing. `blankAsUnset` turns `''` into
 * `undefined`, so the inner schema is what must accept undefined:
 *
 *   optional(schema)       -> z.preprocess(blankAsUnset, schema.optional())
 *   withDefault(schema)    -> z.preprocess(blankAsUnset, schema)   // inner .default() applies
 *
 * Putting `.optional()` on the outside instead would (a) fail every blank key with
 * "Required", because ZodOptional sees `''` as defined and forwards it to a
 * preprocess that then yields undefined, and (b) discard an inner `.default()`.
 * Both mistakes are covered by tests/env.test.ts.
 */
const blankAsUnset = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(blankAsUnset, schema.optional());

const withDefault = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(blankAsUnset, schema) as unknown as z.ZodType<z.output<T>>;

/** Exported so tests can exercise the blank-value handling without touching process.env. */
export const EnvSchema = z.object({
  RN_CLIENT_ID: optional(z.string().min(1)),
  RN_WEBHOOK_SECRET: optional(z.string().min(1)),
  RN_DESTINATION_ID: optional(z.string().min(1)),
  RN_API_BASE: withDefault(z.string().url().default('https://api.request.network')),
  RN_AUTH_BASE: withDefault(z.string().url().default('https://auth.request.network')),

  KH_API_KEY: optional(z.string().min(1)),
  KH_API_BASE: withDefault(z.string().url().default('https://app.keeperhub.com/api')),
  KH_MCP_URL: withDefault(z.string().url().default('https://app.keeperhub.com/mcp')),
  KH_ORG_WALLET: optional(z.string().min(1)),
  KH_CHAIN_ID: withDefault(
    z
      .string()
      .regex(/^\d+$/, 'KH_CHAIN_ID must be a numeric chain id as a string')
      .default('11155111'),
  ),

  BRIDGE_PORT: withDefault(z.coerce.number().int().positive().max(65535).default(8787)),
  BRIDGE_PUBLIC_URL: optional(z.string().url()),
  MATCH_AUTO_APPROVE_THRESHOLD: withDefault(
    z.coerce.number().min(0).max(1).default(0.85),
  ),
});

/**
 * Reads .env into process.env. Node 24 ships this; no dotenv needed.
 *
 * The search order matters. The template lives at the repository root, so an
 * operator who copies it once should not have to duplicate it per package. We
 * look in the working directory first, then one level up, so the bridge works
 * whether it is started from `bridge/` or from the repository root.
 *
 * Override with TRUEUP_ENV=/path/to/file when neither fits.
 */
function loadDotEnv(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      process.loadEnvFile(candidate);
      return candidate;
    } catch {
      // Try the next candidate. A missing file is normal — vars may be exported.
    }
  }
  return undefined;
}

/** The .env candidates, in priority order. */
export function envCandidates(): string[] {
  const explicit = process.env['TRUEUP_ENV'];
  return [...(explicit === undefined || explicit === '' ? [] : [explicit]), '.env', '../.env'];
}

export function loadConfig(envPath?: string): Config {
  const loaded = loadDotEnv(envPath === undefined ? envCandidates() : [envPath]);
  if (loaded !== undefined) {
    // Recorded so the readiness output can name the file it actually used —
    // reading a different .env than the operator edited is a confusing failure.
    process.env['TRUEUP_ENV_LOADED'] = loaded;
  }

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  const env = parsed.data;

  return {
    rn: {
      clientId: env.RN_CLIENT_ID,
      webhookSecret: env.RN_WEBHOOK_SECRET,
      destinationId: env.RN_DESTINATION_ID,
      apiBase: env.RN_API_BASE,
      authBase: env.RN_AUTH_BASE,
    },
    kh: {
      apiKey: env.KH_API_KEY,
      apiBase: env.KH_API_BASE,
      mcpUrl: env.KH_MCP_URL,
      orgWallet: env.KH_ORG_WALLET,
      chainId: env.KH_CHAIN_ID,
    },
    bridge: {
      port: env.BRIDGE_PORT,
      publicUrl: env.BRIDGE_PUBLIC_URL,
      matchAutoApproveThreshold: env.MATCH_AUTO_APPROVE_THRESHOLD,
    },
  };
}

/** Names the missing variable so the operator can fix it without reading code. */
export function requireSecret(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(
      `Missing required configuration: ${name}. Set it in .env (see .env.example).`,
    );
  }
  return value;
}

/** Reports which pieces of Phase 1 setup are complete. Used by the startup banner. */
export function describeReadiness(config: Config): string[] {
  const lines: string[] = [];
  const loaded = process.env['TRUEUP_ENV_LOADED'];
  lines.push(
    loaded === undefined
      ? 'warn no .env file found (looked for .env, then ../.env)'
      : `ok   .env loaded from ${loaded}`,
  );
  lines.push(config.rn.clientId ? 'ok   RN_CLIENT_ID' : 'MISS RN_CLIENT_ID');
  lines.push(config.rn.webhookSecret ? 'ok   RN_WEBHOOK_SECRET' : 'MISS RN_WEBHOOK_SECRET');
  lines.push(config.rn.destinationId ? 'ok   RN_DESTINATION_ID' : 'MISS RN_DESTINATION_ID');
  lines.push(config.kh.apiKey ? 'ok   KH_API_KEY' : 'MISS KH_API_KEY');
  lines.push(config.kh.orgWallet ? 'ok   KH_ORG_WALLET' : 'MISS KH_ORG_WALLET');
  return lines;
}
