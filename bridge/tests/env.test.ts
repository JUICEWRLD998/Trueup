/**
 * Environment parsing.
 *
 * The case this file exists for: `.env.example` ships every key with an empty
 * value so the operator can see what exists, and copying it must not produce a
 * wall of "Required" errors for keys that simply have not been filled in yet.
 *
 * Getting the Zod composition wrong here has two distinct failure modes, and
 * both are asserted below: blank values reported as Required, and defaults being
 * silently discarded. I got this wrong twice while building it, so it is pinned.
 */

import { describe, expect, it } from 'vitest';
import { EnvSchema } from '../src/env.ts';

describe('EnvSchema blank-value handling', () => {
  it('treats an empty template value as unset, not invalid', () => {
    const result = EnvSchema.safeParse({
      RN_CLIENT_ID: '',
      RN_WEBHOOK_SECRET: '',
      RN_DESTINATION_ID: '',
      KH_API_KEY: '',
      KH_ORG_WALLET: '',
      BRIDGE_PUBLIC_URL: '',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.RN_CLIENT_ID).toBeUndefined();
      expect(result.data.KH_API_KEY).toBeUndefined();
      expect(result.data.BRIDGE_PUBLIC_URL).toBeUndefined();
    }
  });

  it('treats a whitespace-only value as unset', () => {
    const result = EnvSchema.safeParse({ RN_CLIENT_ID: '   ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.RN_CLIENT_ID).toBeUndefined();
    }
  });

  it('keeps defaults when the key is absent entirely', () => {
    const result = EnvSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      // The regression this guards: wrapping a defaulted schema in .optional()
      // discards the default and leaves undefined.
      expect(result.data.RN_API_BASE).toBe('https://api.request.network');
      expect(result.data.RN_AUTH_BASE).toBe('https://auth.request.network');
      expect(result.data.KH_API_BASE).toBe('https://app.keeperhub.com/api');
      expect(result.data.KH_MCP_URL).toBe('https://app.keeperhub.com/mcp');
      expect(result.data.KH_CHAIN_ID).toBe('11155111');
      expect(result.data.BRIDGE_PORT).toBe(8787);
      expect(result.data.MATCH_AUTO_APPROVE_THRESHOLD).toBe(0.85);
    }
  });

  it('keeps defaults when the template ships the key empty', () => {
    // This is the real-world case: the operator copied .env.example verbatim.
    const result = EnvSchema.safeParse({
      RN_API_BASE: '',
      KH_CHAIN_ID: '',
      BRIDGE_PORT: '',
      MATCH_AUTO_APPROVE_THRESHOLD: '',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.RN_API_BASE).toBe('https://api.request.network');
      expect(result.data.KH_CHAIN_ID).toBe('11155111');
      expect(result.data.BRIDGE_PORT).toBe(8787);
      expect(result.data.MATCH_AUTO_APPROVE_THRESHOLD).toBe(0.85);
    }
  });

  it('coerces numeric strings', () => {
    const result = EnvSchema.safeParse({ BRIDGE_PORT: '9000', MATCH_AUTO_APPROVE_THRESHOLD: '0.9' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.BRIDGE_PORT).toBe(9000);
      expect(result.data.MATCH_AUTO_APPROVE_THRESHOLD).toBe(0.9);
    }
  });

  it('rejects a value that is present but malformed', () => {
    // A non-empty value must still fail loudly: silently ignoring a typo in a
    // base URL would surface much later as an unexplained network error.
    const result = EnvSchema.safeParse({ RN_API_BASE: 'not-a-url' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-numeric chain id', () => {
    const result = EnvSchema.safeParse({ KH_CHAIN_ID: 'sepolia' });
    expect(result.success).toBe(false);
  });

  it('rejects an out-of-range auto-approve threshold', () => {
    expect(EnvSchema.safeParse({ MATCH_AUTO_APPROVE_THRESHOLD: '1.5' }).success).toBe(false);
    expect(EnvSchema.safeParse({ MATCH_AUTO_APPROVE_THRESHOLD: '-0.1' }).success).toBe(false);
  });

  it('accepts a fully populated environment', () => {
    const result = EnvSchema.safeParse({
      RN_CLIENT_ID: 'client_abc',
      RN_WEBHOOK_SECRET: 'whsec_abc',
      RN_DESTINATION_ID: '0xabc@eip155:11155111#deadbeef:0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      KH_API_KEY: 'kh_abc',
      KH_ORG_WALLET: '0x0000000000000000000000000000000000000001',
      KH_CHAIN_ID: '11155111',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.RN_CLIENT_ID).toBe('client_abc');
      expect(result.data.KH_ORG_WALLET).toBe('0x0000000000000000000000000000000000000001');
    }
  });
});
