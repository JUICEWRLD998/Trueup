/**
 * Verifies the configured credentials actually work, and reports what is still
 * missing — without ever printing a secret value.
 *
 * Run from bridge/:  pnpm exec tsx scripts/check-setup.ts
 *
 * Anything that looks like a credential is redacted before printing. Wallet
 * addresses are shown, because they are public and you need them to fund the
 * account.
 */

import { loadConfig, describeReadiness } from '../src/env.ts';

const SECRETISH = /(key|secret|token|password|hmac|signature|authorization)/i;

/** Replaces credential-looking values with a length-preserving marker. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '<deep>';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SECRETISH.test(key) && typeof inner === 'string' && inner.length > 0) {
        out[key] = `<redacted ${inner.length} chars>`;
      } else {
        out[key] = redact(inner, depth + 1);
      }
    }
    return out;
  }
  return value;
}

async function probe(
  label: string,
  url: string,
  apiKey: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 800);
  }
  console.log(`\n--- ${label} ---`);
  console.log(`GET ${url}`);
  console.log(`HTTP ${response.status}`);
  console.log(JSON.stringify(redact(body), null, 2));
  return { status: response.status, body };
}

async function main(): Promise<void> {
  const config = loadConfig();

  console.log('=== configuration ===');
  for (const line of describeReadiness(config)) {
    console.log(`  ${line}`);
  }
  console.log(`  chain id: ${config.kh.chainId}`);

  const apiKey = config.kh.apiKey;
  if (apiKey === undefined) {
    console.log('\nKH_API_KEY is not set, so there is nothing to verify yet.');
    console.log('Create an organization key: avatar -> API Keys -> Organisation (prefix kh_).');
    return;
  }

  // 1. Does the key authenticate? 200 = valid and org-scoped, 401 = not.
  const keys = await probe('validate credential', `${config.kh.apiBase}/keys`, apiKey);

  if (keys.status === 401) {
    console.log('\nThe key was rejected. Check it starts with kh_ and belongs to an organization.');
    return;
  }

  // 2. The organization wallet. This is the address that must be funded — NOT the
  //    address the account signed in with.
  await probe('organization wallet (FUND THIS ADDRESS)', `${config.kh.apiBase}/user`, apiKey);

  // 3. Supported chains, so we can confirm the demo chain is available.
  const chains = await probe('supported chains', `${config.kh.apiBase}/chains`, apiKey);

  const desired = config.kh.chainId;
  const raw = JSON.stringify(chains.body);
  if (raw.includes(desired)) {
    console.log(`\nchain ${desired} appears in the supported list — good.`);
  } else {
    console.log(
      `\nWARNING: chain ${desired} does not appear in the chains response. ` +
        `Check the actual chain id before funding.`,
    );
  }

  console.log('\n=== next ===');
  console.log('1. Put the organization wallet address above into KH_ORG_WALLET in .env');
  console.log('2. Fund it: Sepolia ETH first (gas), then Sepolia USDC.');
  console.log('   ETH  faucet: https://cloud.google.com/application/web3/faucet/ethereum/sepolia');
  console.log('   USDC faucet: https://faucet.circle.com');
}

main().catch((error: unknown) => {
  console.error('\ncheck-setup failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
