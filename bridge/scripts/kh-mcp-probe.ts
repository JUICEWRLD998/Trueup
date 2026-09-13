/**
 * Probes the KeeperHub MCP server over its HTTP transport.
 *
 * The transport is Streamable HTTP: a POST of a JSON-RPC 2.0 envelope that comes
 * back either as `application/json` or as an SSE stream (`text/event-stream`),
 * plus an optional `mcp-session-id` response header that must be echoed back on
 * subsequent calls. This script does the handshake by hand so we can see the
 * exact shapes rather than trusting an SDK to hide them.
 *
 * Usage (from bridge/):
 *   pnpm exec tsx scripts/kh-mcp-probe.ts                # tools/list + short list
 *   pnpm exec tsx scripts/kh-mcp-probe.ts tools_documentation
 *   pnpm exec tsx scripts/kh-mcp-probe.ts list_action_schemas '{"limit":5}'
 */

import { loadConfig } from '../src/env.ts';

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

let sessionId: string | undefined;

/** MCP responses may be plain JSON or an SSE stream; both carry one JSON envelope. */
async function readEnvelope(response: Response): Promise<JsonRpcResponse | undefined> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();

  if (contentType.includes('text/event-stream')) {
    // Take the last `data:` line — a stream may carry notifications before the reply.
    const payloads = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line.length > 0);
    const last = payloads.at(-1);
    if (last === undefined) return undefined;
    return JSON.parse(last) as JsonRpcResponse;
  }

  if (text.trim() === '') return undefined;
  return JSON.parse(text) as JsonRpcResponse;
}

async function rpc(
  base: string,
  key: string,
  method: string,
  params: unknown,
  id: number,
): Promise<JsonRpcResponse | undefined> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;

  const response = await fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });

  const assigned = response.headers.get('mcp-session-id');
  if (assigned !== null) sessionId = assigned;

  console.log(`  <- HTTP ${response.status} ${contentTypeOf(response)}${assigned ? ' (session established)' : ''}`);
  if (!response.ok) {
    console.log(`     body: ${(await response.text()).slice(0, 500)}`);
    return undefined;
  }
  return readEnvelope(response);
}

function contentTypeOf(response: Response): string {
  return response.headers.get('content-type') ?? 'no content-type';
}

async function main(): Promise<void> {
  const config = loadConfig();
  const key = config.kh.apiKey;
  if (key === undefined) {
    console.log('KH_API_KEY is not set.');
    process.exitCode = 1;
    return;
  }
  const base = config.kh.mcpUrl;
  console.log(`MCP endpoint: ${base}\n`);

  console.log('[1] initialize');
  const init = await rpc(base, key, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'trueup-bridge-probe', version: '0.1.0' },
  }, 1);
  console.log(JSON.stringify(init, null, 2).slice(0, 2000));

  console.log('\n[2] notifications/initialized');
  await fetch(base, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }).then((r) => console.log(`  <- HTTP ${r.status}`));

  const toolName = process.argv[2];
  const rawArgs = process.argv[3];

  console.log('\n[3] tools/list');
  const listing = await rpc(base, key, 'tools/list', {}, 2);
  const tools = extractTools(listing);
  if (tools.length > 0) {
    console.log(`  ${tools.length} tools:`);
    for (const tool of tools) {
      console.log(`    - ${tool.name}`);
    }
  } else {
    console.log(JSON.stringify(listing, null, 2).slice(0, 1500));
  }

  if (toolName !== undefined) {
    const args = rawArgs === undefined ? {} : (JSON.parse(rawArgs) as unknown);
    console.log(`\n[4] tools/call ${toolName} ${JSON.stringify(args)}`);
    const called = await rpc(base, key, 'tools/call', { name: toolName, arguments: args }, 3);
    console.log(JSON.stringify(called, null, 2));
  }
}

interface ToolSummary {
  name: string;
  description?: string;
}

function extractTools(listing: JsonRpcResponse | undefined): ToolSummary[] {
  const result = listing?.result;
  if (typeof result !== 'object' || result === null) return [];
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t): t is ToolSummary => typeof t === 'object' && t !== null && 'name' in t)
    .map((t) => ({ name: t.name, description: t.description }));
}

main().catch((error: unknown) => {
  console.error('probe failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
