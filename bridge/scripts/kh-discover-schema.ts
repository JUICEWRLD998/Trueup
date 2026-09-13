/**
 * Enumerates KeeperHub's action and trigger types through the MCP server.
 *
 * `list_action_schemas` is the authoritative registry: it returns every trigger
 * type and every action type along with the config fields each one accepts. The
 * public docs describe the workflow envelope but not this registry, so this is
 * the only reliable way to author a workflow without guessing field names.
 *
 * Usage (from bridge/):
 *   pnpm exec tsx scripts/kh-discover-schema.ts                 # summary of everything
 *   pnpm exec tsx scripts/kh-discover-schema.ts --tool <name>   # one action's raw schema
 *   pnpm exec tsx scripts/kh-discover-schema.ts --json          # full raw registry dump
 */

import { McpClient } from './kh-mcp-client.ts';

/** Shape is inferred from the live payload; everything is optional so a shape drift cannot crash. */
interface RawAction {
  actionType?: string;
  type?: string;
  name?: string;
  label?: string;
  description?: string;
  category?: string;
  kind?: string;
  isTrigger?: boolean;
  requiresCredentials?: boolean;
  requiredCredentialTypes?: string[];
  configSchema?: { properties?: Record<string, unknown>; required?: string[] };
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
  config?: { properties?: Record<string, unknown>; required?: string[] };
}

interface ActionRegistry {
  version?: string;
  generatedAt?: string;
  // `actions` and `triggers` arrive as objects keyed by action name, not arrays.
  actions?: RawAction[] | Record<string, RawAction>;
  triggers?: RawAction[] | Record<string, RawAction>;
  categories?: unknown[];
  [key: string]: unknown;
}

/**
 * The registry serves both sections as objects keyed by action type. Accept an
 * array too so a server-side shape change degrades to "still lists things"
 * rather than "crashes on .length".
 */
function asList(section: RawAction[] | Record<string, RawAction> | undefined): RawAction[] {
  if (section === undefined) return [];
  if (Array.isArray(section)) return section;
  return Object.entries(section).map(([key, value]) => ({
    actionType: value.actionType ?? key,
    ...value,
  }));
}

/** The registry names the discriminator differently across sections; normalise it. */
function actionName(entry: RawAction): string {
  return entry.actionType ?? entry.type ?? entry.name ?? entry.label ?? '(unnamed)';
}

function configFields(entry: RawAction): { properties: Record<string, unknown>; required: string[] } {
  const schema = entry.configSchema ?? entry.inputSchema ?? entry.config;
  return { properties: schema?.properties ?? {}, required: schema?.required ?? [] };
}

function summarise(entry: RawAction): string {
  const { properties, required } = configFields(entry);
  const fields = Object.keys(properties);
  const requiredSet = new Set(required);
  const rendered = fields
    .map((field) => (requiredSet.has(field) ? `${field}*` : field))
    .join(', ');
  const flags = [
    entry.requiresCredentials === true ? 'needs-credentials' : '',
    required.length > 0 ? `required: ${required.join(',')}` : '',
  ]
    .filter((f) => f !== '')
    .join(' | ');
  return `  ${actionName(entry).padEnd(28)} ${flags}\n      fields: ${rendered.slice(0, 400)}`;
}

async function main(): Promise<void> {
  const client = McpClient.fromConfig();
  const info = await client.connect();
  console.log(`connected to MCP server ${info.serverName} v${info.serverVersion}\n`);

  const tools = await client.listTools();
  console.log(`tools exposed: ${tools.length}`);
  for (const tool of tools) {
    if (!['list_action_schemas', 'validate_workflow', 'create_workflow', 'update_workflow', 'get_workflow'].includes(tool.name)) {
      continue;
    }
    console.log(`\n--- ${tool.name} ---`);
    console.log(`  ${tool.description ?? '(no description)'}`);
    console.log(`  inputSchema: ${JSON.stringify(tool.inputSchema)}`);
  }

  const registry = await client.callToolJson<ActionRegistry>('list_action_schemas', {});

  if (process.argv.includes('--json')) {
    console.log('\n=== RAW REGISTRY ===');
    console.log(JSON.stringify(registry, null, 2));
    return;
  }

  const explicitTool = (() => {
    const index = process.argv.indexOf('--tool');
    return index === -1 ? undefined : process.argv[index + 1];
  })();

  if (explicitTool !== undefined) {
    const all = [...asList(registry.triggers), ...asList(registry.actions)];
    const matches = all.filter((entry) => actionName(entry) === explicitTool);
    if (matches.length === 0) {
      console.log(`\nno action named ${explicitTool} in the registry`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n=== ${explicitTool} ===`);
    console.log(JSON.stringify(matches, null, 2));
    return;
  }

  const triggers = asList(registry.triggers);
  const actions = asList(registry.actions);
  console.log(`\nregistry top-level keys: ${Object.keys(registry).join(', ')}`);
  console.log(`\n=== TRIGGERS (${triggers.length}) ===`);
  for (const trigger of triggers) console.log(summarise(trigger));
  console.log(`\n=== ACTIONS (${actions.length}) ===`);
  for (const action of actions) console.log(summarise(action));
}

main().catch((error: unknown) => {
  console.error('\ndiscovery failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
