/**
 * Probes the KeeperHub REST surface for endpoints the workflow-builder needs.
 *
 * Purpose: the docs name `POST /api/workflows/create` and `GET /api/mcp/schemas`
 * but do not say which read endpoints exist, nor what plan the organization is
 * on. `HTTP Request` and `webhook/send-webhook` are gated behind `requiredPlan:
 * "pro"`, so knowing the plan before authoring avoids guessing at a validation
 * failure. Each probe prints only HTTP status and a truncated body — the key is
 * never printed.
 *
 * Usage (from bridge/):  pnpm exec tsx scripts/kh-rest-probe.ts
 */

import { loadConfig } from '../src/env.ts';

/** KH_API_BASE ships as `https://app.keeperhub.com/api`, so strip a trailing `/api`. */
function normaliseBase(apiBase: string): string {
  const trimmed = apiBase.replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed.slice(0, -4) : trimmed;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const key = config.kh.apiKey;
  if (key === undefined) {
    console.log('KH_API_KEY is not set.');
    process.exitCode = 1;
    return;
  }
  const base = normaliseBase(config.kh.apiBase);
  console.log(`REST base: ${base}`);
  console.log(`configured chain: ${config.kh.chainId}`);
  console.log(`org wallet set: ${config.kh.orgWallet === undefined ? 'no' : 'yes'}`);
  console.log(`org wallet: ${config.kh.orgWallet ?? '(unset)'}\n`);

  const paths = [
    '/api/chains',
    '/api/integrations',
    '/api/workflows',
    '/api/projects',
    '/api/tags',
    '/api/mcp/schemas',
    '/api/organizations',
    '/api/organization',
    '/api/billing',
    '/api/subscription',
    '/api/plan',
    '/api/spending-limits',
    '/api/workflows/validate',
  ];

  for (const path of paths) {
    try {
      const response = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      });
      const text = await response.text();
      const summary = text.replace(/\s+/g, ' ').slice(0, 320);
      console.log(`${String(response.status).padEnd(4)} ${path}`);
      console.log(`     ${summary}`);
    } catch (error) {
      console.log(`ERR  ${path} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error('probe failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
