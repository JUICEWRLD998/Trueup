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

const EnvSchema = z.object({
  RN_CLIENT_ID: z.string().min(1).optional(),
  RN_WEBHOOK_SECRET: z.string().min(1).optional(),
  RN_DESTINATION_ID: z.string().min(1).optional(),
  RN_API_BASE: z.string().url().default('https://api.request.network'),
  RN_AUTH_BASE: z.string().url().default('https://auth.request.network'),

  KH_API_KEY: z.string().min(1).optional(),
  KH_API_BASE: z.string().url().default('https://app.keeperhub.com/api'),
  KH_MCP_URL: z.string().url().default('https://app.keeperhub.com/mcp'),
  KH_ORG_WALLET: z.string().min(1).optional(),
  KH_CHAIN_ID: z.string().regex(/^\d+$/, 'KH_CHAIN_ID must be a numeric chain id as a string').default('11155111'),

  BRIDGE_PORT: z.coerce.number().int().positive().max(65535).default(8787),
  BRIDGE_PUBLIC_URL: z.string().url().optional(),
  MATCH_AUTO_APPROVE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
});

/** Reads .env into process.env if present. Node 24 ships this; no dotenv needed. */
function loadDotEnv(path: string): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // No .env file is a normal state — the operator may export vars instead.
  }
}

export function loadConfig(envPath = '.env'): Config {
  loadDotEnv(envPath);

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
  lines.push(config.rn.clientId ? 'ok   RN_CLIENT_ID' : 'MISS RN_CLIENT_ID');
  lines.push(config.rn.webhookSecret ? 'ok   RN_WEBHOOK_SECRET' : 'MISS RN_WEBHOOK_SECRET');
  lines.push(config.rn.destinationId ? 'ok   RN_DESTINATION_ID' : 'MISS RN_DESTINATION_ID');
  lines.push(config.kh.apiKey ? 'ok   KH_API_KEY' : 'MISS KH_API_KEY');
  lines.push(config.kh.orgWallet ? 'ok   KH_ORG_WALLET' : 'MISS KH_ORG_WALLET');
  return lines;
}
