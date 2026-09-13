/**
 * Lists the chains this organization can execute on, and confirms the configured
 * demo chain is among them.
 *
 * Run from bridge/:  pnpm exec tsx scripts/chains.ts
 */

import { loadConfig } from '../src/env.ts';

interface Chain {
  chainId: number;
  name: string;
  symbol: string;
  isTestnet: boolean;
  explorerUrl?: string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const key = config.kh.apiKey;
  if (key === undefined) {
    console.log('KH_API_KEY is not set.');
    return;
  }

  const response = await fetch(`${config.kh.apiBase}/chains`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    console.log(`chains request failed: HTTP ${response.status}`);
    return;
  }

  const chains = (await response.json()) as Chain[];
  console.log(`total chains: ${chains.length}\n`);

  console.log('--- testnets ---');
  for (const chain of chains.filter((c) => c.isTestnet)) {
    console.log(
      `  ${String(chain.chainId).padEnd(10)} ${chain.name.padEnd(22)} ${chain.symbol.padEnd(8)} ${chain.explorerUrl ?? ''}`,
    );
  }

  console.log('\n--- mainnets ---');
  for (const chain of chains.filter((c) => !c.isTestnet)) {
    console.log(`  ${String(chain.chainId).padEnd(10)} ${chain.name.padEnd(22)} ${chain.symbol}`);
  }

  const configured = chains.find((c) => String(c.chainId) === config.kh.chainId);
  console.log(`\nconfigured KH_CHAIN_ID=${config.kh.chainId} -> ${configured ? `FOUND (${configured.name})` : 'NOT FOUND'}`);
}

main().catch((error: unknown) => {
  console.error('chains failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
