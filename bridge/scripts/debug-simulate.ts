/**
 * Prints the raw dry-run response so a validation failure can be diagnosed
 * rather than guessed at. Read-only: it only ever sends simulate: true, which
 * never signs or broadcasts.
 *
 * Run from bridge/:  pnpm exec tsx scripts/debug-simulate.ts [recipient] [amount]
 */

import { loadConfig } from '../src/env.ts';

const SEPOLIA_FUSDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

async function main(): Promise<void> {
  const config = loadConfig();
  const key = config.kh.apiKey;
  if (key === undefined) {
    console.log('KH_API_KEY is not set.');
    return;
  }

  const recipient = process.argv[2] ?? '0xC0FFEE0000000000000000000000000000000001';
  const amount = process.argv[3] ?? '1.00';

  // KH_API_BASE ships as .../api and the client normalises it; mirror that here.
  const base = config.kh.apiBase.replace(/\/+$/, '').replace(/\/api$/, '');
  const url = `${base}/api/execute/transfer`;

  const bodies: Array<{ label: string; body: Record<string, unknown> }> = [
    {
      label: 'as-written, mixed case recipient, with tokenConfig',
      body: {
        chainId: config.kh.chainId,
        recipientAddress: recipient,
        amount,
        tokenAddress: SEPOLIA_FUSDC,
        tokenConfig: JSON.stringify({ decimals: 6, symbol: 'fUSDC' }),
        simulate: true,
      },
    },
    {
      label: 'lowercase recipient, no tokenConfig',
      body: {
        chainId: config.kh.chainId,
        recipientAddress: recipient.toLowerCase(),
        amount,
        tokenAddress: SEPOLIA_FUSDC,
        simulate: true,
      },
    },
  ];

  for (const candidate of bodies) {
    console.log(`\n=========== ${candidate.label} ===========`);
    console.log(`POST ${url}`);
    console.log(JSON.stringify(candidate.body, null, 2));
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(candidate.body),
    });
    const text = await response.text();
    console.log(`\nHTTP ${response.status}`);
    try {
      console.log(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      console.log(text.slice(0, 1500));
    }
  }
}

main().catch((error: unknown) => {
  console.error('debug failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
