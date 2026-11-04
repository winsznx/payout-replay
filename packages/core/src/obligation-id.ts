import { encodeAbiParameters, keccak256 } from 'viem';

import { nativePublicKeyHex } from './address.js';
import type { Environment, NetworkIdentity } from './types.js';

export const OBLIGATION_ID_DOMAIN = 'payout-replay/obligation@1';

export interface ObligationIdInput {
  environment: Environment;
  network: NetworkIdentity;
  payer: string;
  runId: string;
  version: number;
  lineId: string;
}

export function chainIdentity(environment: Environment, network: NetworkIdentity): string {
  if (environment === 'evm') {
    if (!network.evm) throw new Error('EVM network identity is required for EVM obligations');
    return `eip155:${network.evm.chainId}`;
  }
  if (!network.native) throw new Error('native network identity is required for native obligations');
  return `substrate:${network.native.genesisHash.toLowerCase()}`;
}

function payerKey(environment: Environment, payer: string): string {
  return environment === 'evm' ? payer.toLowerCase() : nativePublicKeyHex(payer);
}

/**
 * keccak256(abi.encode(string domain, string chainIdentity, string payerKey,
 * string runId, uint32 version, string lineId)). Native payers are keyed by
 * their 32-byte public key so that SS58 prefix choice cannot change the ID.
 */
export function deriveObligationId(input: ObligationIdInput): `0x${string}` {
  if (!Number.isInteger(input.version) || input.version < 1 || input.version > 0xffffffff) {
    throw new RangeError(`manifest version out of range: ${input.version}`);
  }
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'string' },
        { type: 'string' },
        { type: 'string' },
        { type: 'uint32' },
        { type: 'string' },
      ],
      [
        OBLIGATION_ID_DOMAIN,
        chainIdentity(input.environment, input.network),
        payerKey(input.environment, input.payer),
        input.runId,
        input.version,
        input.lineId,
      ],
    ),
  );
}
