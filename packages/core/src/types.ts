export type Environment = 'native' | 'evm';

export type CapabilityStatus = 'verified' | 'unverified' | 'unavailable';

export interface AssetDescriptor {
  environment: Environment;
  /** `POT` style symbol for native assets, checksummed contract address for ERC-20. */
  assetId: string;
  symbol: string;
  decimals: number;
  allowlisted: boolean;
  capability: CapabilityStatus;
  label?: string;
}

export interface NativeNetworkIdentity {
  genesisHash: string;
  specName: string;
  specVersion: number;
  ss58Prefix: number;
  tokenSymbol: string;
  tokenDecimals: number;
}

export interface EvmNetworkIdentity {
  chainId: number;
  executorAddress: string;
}

export interface NetworkIdentity {
  native?: NativeNetworkIdentity;
  evm?: EvmNetworkIdentity;
}

export interface PayerWallets {
  native?: string;
  evm?: string;
}

/** A validated CSV row before it is frozen into a manifest. */
export interface DraftLine {
  lineId: string;
  environment: Environment;
  assetId: string;
  destination: string;
  amount: string;
  amountBaseUnits: string;
  reference: string;
  recipientName?: string;
  recipientId?: string;
  invoiceId?: string;
  note?: string;
  sourceWallet?: string;
  /** 1-based physical CSV line the row came from. */
  sourceLine: number;
}

export interface Obligation {
  obligationId: string;
  lineId: string;
  environment: Environment;
  assetId: string;
  symbol: string;
  decimals: number;
  payer: string;
  destination: string;
  amountBaseUnits: string;
  reference: string;
  recipientName?: string;
  recipientId?: string;
  invoiceId?: string;
  note?: string;
}

export interface AssetTotal {
  environment: Environment;
  assetId: string;
  symbol: string;
  decimals: number;
  count: number;
  amountBaseUnits: string;
}

export interface PayoutManifest {
  schema: 'payout-replay/manifest@1';
  runId: string;
  version: number;
  network: NetworkIdentity;
  payers: PayerWallets;
  obligations: Obligation[];
  totals: AssetTotal[];
}

export interface FrozenManifest {
  manifest: PayoutManifest;
  canonicalJson: string;
  /** `sha256:` prefixed lowercase hex digest of `canonicalJson`. */
  digest: string;
}
