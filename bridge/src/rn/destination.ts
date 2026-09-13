/**
 * ERC-7828 composite payment destination parsing.
 *
 * Request Network's `destinationId` is a composite: the payee destination's
 * human-readable interop address (itself an ERC-7828 string) joined to the
 * token's contract address with a colon.
 *
 *   <interopAddress>:<tokenAddress>
 *   0x6923...C7D7@eip155:1#1f969856:0x036CbD...
 *
 * The interop address contains a colon of its own (`eip155:1`), so the split
 * must happen on the LAST colon, not the first. Doing it naively silently
 * produces a wrong token address, which is the kind of bug that shows up as a
 * payment that never reconciles.
 */

export interface InteropAddress {
  /** The 0x-prefixed account address, exactly as supplied. */
  readonly address: string;
  /** CAIP-2 namespace, e.g. `eip155` or `solana`. */
  readonly namespace: string;
  /** CAIP-2 reference — the chain id, e.g. `1`. */
  readonly chainId: string;
  /** Optional ERC-7828 checksum suffix. */
  readonly checksum: string | undefined;
}

export interface ParsedDestination {
  readonly interopAddress: InteropAddress;
  /** ERC-20 contract address of the settlement token. */
  readonly tokenAddress: string;
  /** The original string, unchanged — kept for auditability. */
  readonly raw: string;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export class DestinationParseError extends Error {
  override readonly name = 'DestinationParseError';
}

/**
 * Splits an interop address into its parts.
 * Shape: `address@namespace:chainId` with an optional `#checksum`.
 */
export function parseInteropAddress(value: string): InteropAddress {
  const hashIndex = value.indexOf('#');
  const withoutChecksum = hashIndex === -1 ? value : value.slice(0, hashIndex);
  const checksum = hashIndex === -1 ? undefined : value.slice(hashIndex + 1);

  const atIndex = withoutChecksum.indexOf('@');
  if (atIndex === -1) {
    throw new DestinationParseError(
      `Interop address is missing the '@' separator: ${JSON.stringify(value)}`,
    );
  }

  const address = withoutChecksum.slice(0, atIndex);
  const caip2 = withoutChecksum.slice(atIndex + 1);

  const colonIndex = caip2.indexOf(':');
  if (colonIndex === -1) {
    throw new DestinationParseError(
      `Interop address is missing the CAIP-2 chain reference: ${JSON.stringify(value)}`,
    );
  }

  return {
    address,
    namespace: caip2.slice(0, colonIndex),
    chainId: caip2.slice(colonIndex + 1),
    checksum: checksum === '' ? undefined : checksum,
  };
}

/**
 * Parses a full `destinationId`. Splits on the last colon so that the colons
 * inside the CAIP-2 chain reference are preserved.
 */
export function parseDestinationId(value: string): ParsedDestination {
  const lastColon = value.lastIndexOf(':');
  if (lastColon === -1) {
    throw new DestinationParseError(
      `destinationId has no token address (expected '<interopAddress>:<tokenAddress>'): ${JSON.stringify(value)}`,
    );
  }

  const interopRaw = value.slice(0, lastColon);
  const tokenAddress = value.slice(lastColon + 1);

  if (!EVM_ADDRESS.test(tokenAddress)) {
    throw new DestinationParseError(
      `destinationId token address is not a valid EVM address: ${JSON.stringify(tokenAddress)}`,
    );
  }

  return {
    interopAddress: parseInteropAddress(interopRaw),
    tokenAddress,
    raw: value,
  };
}

/** Composes a `destinationId` from its parts. Used to build fixtures and tests. */
export function composeDestinationId(
  interopAddress: string,
  tokenAddress: string,
): string {
  return `${interopAddress}:${tokenAddress}`;
}

/** CAIP-2 chain identifier for an interop address, e.g. `eip155:1`. */
export function caip2Of(interopAddress: InteropAddress): string {
  return `${interopAddress.namespace}:${interopAddress.chainId}`;
}
