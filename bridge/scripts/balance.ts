/**
 * Reads the organization wallet's native and USDC balances directly from public
 * RPC endpoints, so an operator can see what still needs funding without trusting
 * a dashboard.
 *
 * Run from bridge/:  pnpm exec tsx scripts/balance.ts
 */

import { loadConfig } from '../src/env.ts';

const ORG_WALLET_FALLBACK = '0x495b365a62908ea47bcfda84d84f38f1c370e816';

interface ChainProbe {
  chainId: string;
  name: string;
  rpc: string;
  usdc?: { address: string; symbol: string; decimals: number };
}

const PROBES: ChainProbe[] = [
  {
    chainId: '11155111',
    name: 'Ethereum Sepolia',
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    usdc: {
      address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      symbol: 'USDC',
      decimals: 6,
    },
  },
  {
    chainId: '84532',
    name: 'Base Sepolia',
    rpc: 'https://sepolia.base.org',
    usdc: {
      address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      symbol: 'USDC',
      decimals: 6,
    },
  },
];

async function rpc(url: string, method: string, params: unknown[]): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: string; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  if (body.result === undefined) throw new Error('empty result');
  return body.result;
}

function formatUnits(hex: string, decimals: number): string {
  const value = BigInt(hex);
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const wallet = config.kh.orgWallet ?? ORG_WALLET_FALLBACK;
  console.log(`organization wallet: ${wallet}`);
  console.log(`(funded address — this is NOT the address the account signs in with)\n`);

  for (const probe of PROBES) {
    console.log(`--- ${probe.name} (chain ${probe.chainId}) ---`);
    try {
      const native = await rpc(probe.rpc, 'eth_getBalance', [wallet, 'latest']);
      const nativeFormatted = formatUnits(native, 18);
      const funded = BigInt(native) > 0n;
      console.log(`  native: ${nativeFormatted} ETH ${funded ? '' : '  <-- NOT FUNDED'}`);

      if (probe.usdc !== undefined) {
        // balanceOf(address) selector 0x70a08231
        const data = `0x70a08231000000000000000000000000${wallet.replace(/^0x/, '').toLowerCase()}`;
        const tokenBalance = await rpc(probe.rpc, 'eth_call', [
          { to: probe.usdc.address, data },
          'latest',
        ]);
        const tokenFormatted = formatUnits(tokenBalance, probe.usdc.decimals);
        const tokenFunded = BigInt(tokenBalance) > 0n;
        console.log(
          `  ${probe.usdc.symbol}: ${tokenFormatted} ${tokenFunded ? '' : '  <-- NOT FUNDED'}`,
        );
      }
    } catch (error) {
      console.log(`  probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log('');
  }

  console.log('=== funding order ===');
  console.log('1. Gas first  — Sepolia ETH');
  console.log('   https://cloud.google.com/application/web3/faucet/ethereum/sepolia');
  console.log('2. Then token — Sepolia USDC');
  console.log('   https://faucet.circle.com');
}

main().catch((error: unknown) => {
  console.error('balance check failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
