/**
 * ERC-7828 composite destination parsing.
 *
 * The case that earns this file: the interop address contains a colon of its own
 * (`eip155:8453`), so splitting the composite on the FIRST colon silently returns
 * a token address of `8453` and an interop address missing its chain. That bug
 * does not throw — it produces a wrong address, which surfaces much later as a
 * payment that never reconciles.
 */

import { describe, expect, it } from 'vitest';
import {
  caip2Of,
  composeDestinationId,
  DestinationParseError,
  parseDestinationId,
  parseInteropAddress,
} from '../src/rn/destination.ts';

const SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const INTEROP = '0x6923C7D7a1b4E5f8C2d9A0b3E6f1C4d7a8b9C7D7@eip155:11155111#1f969856';

describe('parseInteropAddress', () => {
  it('splits address, CAIP-2 chain and checksum', () => {
    const parsed = parseInteropAddress(INTEROP);
    expect(parsed.address).toBe('0x6923C7D7a1b4E5f8C2d9A0b3E6f1C4d7a8b9C7D7');
    expect(parsed.namespace).toBe('eip155');
    expect(parsed.chainId).toBe('11155111');
    expect(parsed.checksum).toBe('1f969856');
  });

  it('tolerates a missing checksum', () => {
    const parsed = parseInteropAddress('0xabc@eip155:8453');
    expect(parsed.checksum).toBeUndefined();
    expect(parsed.chainId).toBe('8453');
  });

  it('rejects a value with no @ separator', () => {
    expect(() => parseInteropAddress('0xabc')).toThrow(DestinationParseError);
  });

  it('rejects a value with no CAIP-2 reference', () => {
    expect(() => parseInteropAddress('0xabc@eip155')).toThrow(DestinationParseError);
  });

  it('builds the CAIP-2 identifier', () => {
    expect(caip2Of(parseInteropAddress(INTEROP))).toBe('eip155:11155111');
  });
});

describe('parseDestinationId', () => {
  it('splits on the LAST colon so the CAIP-2 colon survives', () => {
    const parsed = parseDestinationId(`${INTEROP}:${SEPOLIA_USDC}`);

    // The naive first-colon split would yield tokenAddress "11155111".
    expect(parsed.tokenAddress).toBe(SEPOLIA_USDC);
    expect(parsed.interopAddress.chainId).toBe('11155111');
    expect(parsed.interopAddress.namespace).toBe('eip155');
  });

  it('preserves the original string for the audit trail', () => {
    const raw = `${INTEROP}:${SEPOLIA_USDC}`;
    expect(parseDestinationId(raw).raw).toBe(raw);
  });

  it('rejects a composite with no token address', () => {
    expect(() => parseDestinationId(INTEROP)).toThrow(DestinationParseError);
  });

  it('rejects a non-EVM token address', () => {
    expect(() => parseDestinationId(`${INTEROP}:notanaddress`)).toThrow(
      DestinationParseError,
    );
  });

  it('rejects a token address that is too short', () => {
    expect(() => parseDestinationId(`${INTEROP}:0x1234`)).toThrow(DestinationParseError);
  });

  it('round-trips with composeDestinationId', () => {
    const composed = composeDestinationId(INTEROP, SEPOLIA_USDC);
    const parsed = parseDestinationId(composed);
    expect(parsed.interopAddress.address).toBe(
      '0x6923C7D7a1b4E5f8C2d9A0b3E6f1C4d7a8b9C7D7',
    );
    expect(parsed.tokenAddress).toBe(SEPOLIA_USDC);
  });

  it('handles a Base destination', () => {
    const base = '0x6923C7D7a1b4E5f8C2d9A0b3E6f1C4d7a8b9C7D7@eip155:8453#1f969856';
    const parsed = parseDestinationId(`${base}:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`);
    expect(parsed.interopAddress.chainId).toBe('8453');
    expect(parsed.tokenAddress).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  });
});
