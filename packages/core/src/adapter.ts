import type { AttemptOutcome, ObservedTransfer } from './reconcile.js';
import type { EligibleLine } from './recovery.js';
import type { AssetDescriptor, Environment, Obligation } from './types.js';

export interface FinalityCheckpoint {
  finalizedBlockNumber: string;
  finalizedBlockHash: string;
  bestBlockNumber: string;
}

/** Everything an adapter needs to find one attempt on-chain again. */
export interface AttemptLocator {
  environment: Environment;
  txHash: string;
  payer: string;
  obligationId: string;
  /** Account nonce the signed transaction used, when the wallet exposed it. */
  nonce?: number;
  /** Block the wallet reported inclusion in, if any. Not trusted without re-checking. */
  blockHash?: string;
  /** Native only: the mortal era the extrinsic was signed with. */
  mortality?: { birthBlock: number; period: number };
}

export interface PreflightIssue {
  code: string;
  message: string;
  blocking: boolean;
}

export interface UnsignedTransfer<TPayload> {
  environment: Environment;
  obligationId: string;
  payer: string;
  /** Human-readable description of the exact call the wallet will be asked to sign. */
  method: string;
  payload: TPayload;
  estimatedFee?: { amountBaseUnits: string; symbol: string; decimals: number };
  preflight: PreflightIssue[];
}

/**
 * A chain adapter turns chain state into evidence. It must never manufacture
 * success: when a chain-specific proof is missing it returns `unknown` or
 * `pending`, and core keeps the obligation blocked.
 */
export interface ChainAdapter<TIdentity, TPayload> {
  readonly environment: Environment;
  readonly provider: string;
  getNetworkIdentity(): Promise<TIdentity>;
  validateAsset(assetId: string): Promise<AssetDescriptor>;
  getFinality(): Promise<FinalityCheckpoint>;
  buildUnsignedTransfer(line: EligibleLine, context: { manifestDigest: string }): Promise<UnsignedTransfer<TPayload>>;
  observeAttempt(locator: AttemptLocator): Promise<AttemptOutcome>;
  /** Finalized settlements for an obligation found without a known attempt (EVM executor logs). */
  scanSettlements?(obligation: Obligation): Promise<AttemptOutcome[]>;
}

export type { ObservedTransfer };
