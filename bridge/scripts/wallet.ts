/**
 * Reports the organization wallet and its balances on the configured chain, so
 * an operator knows exactly what still needs funding.
 *
 * Run from bridge/:  pnpm exec tsx scripts/wallet.ts
 */

import { loadConfig } from '../src/env.ts';

const CANDIDATE_PATHS = [
  '/wallet',
  '/wallets',
  '/wallet/balance',
  '/analytics/spend-cap',
] as const;

async function main(): Promise<void> {
  const config = loadConfig();
  const key = config.kh.apiKey;
  if (key === undefined) {
    console.log('KH_API_KEY is not set.');
    return;
  }
  const headers = { authorization: `Bearer ${key}` };

  for (const path of CANDIDATE_PATHS) {
    const url = `${config.kh.apiBase}${path}`;
    try {
      const response = await fetch(url, { headers });
      const text = await response.text();
      console.log(`\n--- GET ${path} --- HTTP ${response.status}`);
      console.log(text.slice(0, 1200));
    } catch (error) {
      console.log(`\n--- GET ${path} --- ERROR ${String(error).slice(0, 160)}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error('wallet probe failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
