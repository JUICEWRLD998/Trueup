/**
 * Minimal MCP client for KeeperHub's Streamable-HTTP endpoint.
 *
 * Why hand-rolled instead of an SDK: the MCP server is the authoritative source
 * for the workflow JSON schema, and we need to see the raw envelopes (status
 * codes, session header, SSE vs JSON) when something goes wrong. An SDK that
 * hides the transport makes a schema-discovery failure indistinguishable from a
 * network failure.
 *
 * Transport notes, all observed against https://app.keeperhub.com/mcp:
 *   - Auth is the same `authorization: Bearer kh_...` header the REST API uses.
 *   - `initialize` returns 200 with `application/json` and an `mcp-session-id`
 *     response header. That id must be echoed on every later POST.
 *   - `notifications/initialized` (a notification, so no `id`) returns 202.
 *   - A response may come back as `text/event-stream`; the JSON-RPC envelope is
 *     then the last `data:` line.
 */

import { loadConfig } from '../src/env.ts';

export interface JsonRpcEnvelope {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export class McpClient {
  private sessionId: string | undefined;
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly apiKey: string,
  ) {}

  /** Builds a client from the project's normal config loading path. */
  static fromConfig(): McpClient {
    const config = loadConfig();
    const key = config.kh.apiKey;
    if (key === undefined) {
      throw new Error(
        'KH_API_KEY is not set. Add it to .env (see .env.example) before running this script.',
      );
    }
    return new McpClient(config.kh.mcpUrl, key);
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.sessionId === undefined ? {} : { 'mcp-session-id': this.sessionId }),
    };
  }

  private async post(body: unknown): Promise<{
    status: number;
    envelope: JsonRpcEnvelope | undefined;
    raw: string;
  }> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const assigned = response.headers.get('mcp-session-id');
    if (assigned !== null) this.sessionId = assigned;

    const raw = await response.text();
    if (!response.ok) return { status: response.status, envelope: undefined, raw };

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      const last = raw
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter((line) => line.length > 0)
        .at(-1);
      return {
        status: response.status,
        envelope: last === undefined ? undefined : (JSON.parse(last) as JsonRpcEnvelope),
        raw,
      };
    }
    return {
      status: response.status,
      envelope: raw.trim() === '' ? undefined : (JSON.parse(raw) as JsonRpcEnvelope),
      raw,
    };
  }

  /** Performs initialize + notifications/initialized. Safe to call once per run. */
  async connect(): Promise<{ serverName: string; serverVersion: string }> {
    const { envelope, raw } = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'trueup-bridge', version: '0.1.0' },
      },
    });
    if (envelope?.error !== undefined) {
      throw new Error(`initialize failed: ${JSON.stringify(envelope.error)}`);
    }
    const result = envelope?.result as
      | { serverInfo?: { name?: string; version?: string } }
      | undefined;
    if (result === undefined) throw new Error(`initialize returned no result: ${raw.slice(0, 300)}`);

    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return {
      serverName: result.serverInfo?.name ?? 'unknown',
      serverVersion: result.serverInfo?.version ?? 'unknown',
    };
  }

  /** Lists the tools the server exposes, so we never guess at a tool name. */
  async listTools(): Promise<ToolInfo[]> {
    const { envelope } = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/list',
      params: {},
    });
    const result = envelope?.result as { tools?: unknown } | undefined;
    const tools = result?.tools;
    if (!Array.isArray(tools)) return [];
    return tools.filter(
      (t): t is ToolInfo => typeof t === 'object' && t !== null && 'name' in t,
    );
  }

  /**
   * Calls a tool and returns its raw `result` plus the concatenated text content.
   * MCP tool failures arrive as `isError: true` with a text explanation rather
   * than a JSON-RPC error, so both are surfaced.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ result: unknown; text: string; isError: boolean; raw: string }> {
    const { envelope, raw, status } = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    if (envelope === undefined) {
      throw new Error(`tools/call ${name} failed: HTTP ${status} — ${raw.slice(0, 500)}`);
    }
    if (envelope.error !== undefined) {
      throw new Error(`tools/call ${name} error: ${JSON.stringify(envelope.error)}`);
    }
    const result = envelope.result as
      | { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
      | undefined;
    const text = (result?.content ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('\n');
    return { result, text, isError: result?.isError === true, raw };
  }

  /** Calls a tool whose text content is JSON and parses it. */
  async callToolJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { text, isError } = await this.callTool(name, args);
    if (isError) throw new Error(`tools/call ${name} reported an error: ${text.slice(0, 800)}`);
    return JSON.parse(text) as T;
  }
}

/** True when a tool result text looks like it failed rather than describing a schema. */
export function looksLikeToolError(text: string): boolean {
  return /^(Error|error:|\{"error")/.test(text.trim());
}
