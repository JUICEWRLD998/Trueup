/**
 * Dumps an existing workflow's full JSON so we can copy real node/edge shapes
 * rather than inventing them from the prose docs.
 *
 * The platform UI writes the canonical shape; reading one back is the most
 * reliable schema reference available, because `list_action_schemas` describes
 * config fields in prose ("string - Chain ID...") without JSON Schema types.
 *
 * Usage (from bridge/):
 *   pnpm exec tsx scripts/kh-inspect-workflow.ts            # id + name of every workflow
 *   pnpm exec tsx scripts/kh-inspect-workflow.ts <id>       # full definition of one
 */

import { loadConfig } from '../src/env.ts';

function normaliseBase(apiBase: string): string {
  const trimmed = apiBase.replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed.slice(0, -4) : trimmed;
}

interface WorkflowSummary {
  id: string;
  name: string;
  isEnabled?: boolean;
  enabled?: boolean;
  nodeCount?: number;
  updatedAt?: string;
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
  const headers = { authorization: `Bearer ${key}`, accept: 'application/json' };

  const requested = process.argv[2];
  if (requested !== undefined) {
    const response = await fetch(`${base}/api/workflows/${requested}`, { headers });
    const text = await response.text();
    console.log(`HTTP ${response.status}`);
    try {
      console.log(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      console.log(text);
    }
    return;
  }

  const response = await fetch(`${base}/api/workflows`, { headers });
  const workflows = (await response.json()) as WorkflowSummary[];
  console.log(`${workflows.length} workflow(s) in this org:\n`);
  for (const workflow of workflows) {
    console.log(`  ${workflow.id}  ${workflow.name}`);
  }
  console.log('\nPass an id to dump its full definition.');
}

main().catch((error: unknown) => {
  console.error('inspect failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
