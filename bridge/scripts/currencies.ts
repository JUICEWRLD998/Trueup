/**
 * Looks up the exact currency identifiers Request Network expects for a given
 * network, so we do not guess at strings like `USDC-sepolia`.
 *
 * Run from bridge/:  pnpm exec tsx scripts/currencies.ts [network]
 */

import { loadConfig } from '../src/env.ts';

interface Currency {
  id?: string;
  symbol?: string;
  name?: string;
  network?: string;
  chainId?: number;
  decimals?: number;
  address?: string;
  type?: string;
}

async function tryFetch(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers });
  const text = await response.text();
  console.log(`\nGET ${url}`);
  console.log(`  auth: ${Object.keys(headers).join(', ') || '(none)'}`);
  console.log(`  HTTP ${response.status}`);
  return { status: response.status, text };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const networkFilter = process.argv[2] ?? 'sepolia';

  const authVariants: Array<{ label: string; headers: Record<string, string> }> = [
    { label: 'anonymous', headers: {} },
  ];
  if (config.rn.clientId !== undefined) {
    authVariants.push({
      label: 'x-client-id',
      headers: { 'x-client-id': config.rn.clientId },
    });
  }

  // Try the published token list first — it is a static JSON file and needs no auth.
  const listUrl = 'https://requestnetwork.github.io/request-token-list/latest.json';
  const listResult = (await tryFetch(listUrl, {})) as { status: number; text: string };
  if (listResult.status === 200) {
    try {
      const parsed = JSON.parse(listResult.text) as { tokens?: Currency[] } | Currency[];
      const tokens = Array.isArray(parsed) ? parsed : (parsed.tokens ?? []);
      console.log(`  total tokens in list: ${tokens.length}`);

      const matching = tokens.filter((token) =>
        `${token.network ?? ''} ${token.id ?? ''}`.toLowerCase().includes(networkFilter.toLowerCase()),
      );

      console.log(`\n--- tokens matching "${networkFilter}" (${matching.length}) ---`);
      for (const token of matching) {
        console.log(
          `  id=${String(token.id).padEnd(22)} symbol=${String(token.symbol).padEnd(6)} ` +
            `decimals=${token.decimals} chainId=${token.chainId} address=${token.address}`,
        );
      }
    } catch (error) {
      console.log(`  could not parse token list: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Then the live Currencies API, which is the runtime source of truth.
  for (const variant of authVariants) {
    const url = `${config.rn.apiBase}/v2/currencies?network=${encodeURIComponent(networkFilter)}`;
    const result = (await tryFetch(url, variant.headers)) as { status: number; text: string };
    if (result.status === 200) {
      try {
        const parsed = JSON.parse(result.text) as { currencies?: Currency[] } | Currency[];
        const currencies = Array.isArray(parsed) ? parsed : (parsed.currencies ?? []);
        console.log(`  currencies returned: ${currencies.length}`);
        for (const currency of currencies.slice(0, 40)) {
          console.log(
            `  id=${String(currency.id).padEnd(24)} symbol=${String(currency.symbol).padEnd(6)} chainId=${currency.chainId}`,
          );
        }
      } catch {
        console.log(`  raw: ${result.text.slice(0, 400)}`);
      }
    } else {
      console.log(`  body: ${result.text.slice(0, 300)}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error('currencies lookup failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
