export type Environment = 'native' | 'evm';

export type ObligationStatus =
  | 'approved_unattempted'
  | 'awaiting_signature'
  | 'submitted'
  | 'confirming'
  | 'paid_verified'
  | 'failed_verified'
  | 'incorrect'
  | 'needs_review'
  | 'manually_resolved';

export interface Me {
  user: { id: string; displayName: string | null };
  session: { id: string; environment: Environment; address: string };
  identities: { id: string; environment: Environment; address: string; verifiedAt: string }[];
  organisations: { id: string; slug: string; name: string; role: Role }[];
}

export type Role = 'owner' | 'operator' | 'reviewer' | 'viewer';

export interface Run {
  id: string;
  orgId: string;
  name: string;
  status: string;
  currentVersion: number;
  lastReconciledAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  line: number | null;
  lineId?: string;
  field?: string;
}

export interface DraftLine {
  lineId: string;
  environment: Environment;
  assetId: string;
  destination: string;
  amount: string;
  amountBaseUnits: string;
  reference: string;
  recipientName?: string;
  sourceLine: number;
}

export interface AssetTotal {
  environment: Environment;
  assetId: string;
  symbol: string;
  decimals: number;
  count: number;
  amountBaseUnits: string;
}

export interface ValidationReport {
  ok: boolean;
  fileSha256: string;
  columns: { mapping: Record<string, string>; missingRequired: string[]; ignored: string[] };
  lines: DraftLine[];
  issues: ValidationIssue[];
  totals: AssetTotal[];
  duplicates: { key: string; lineIds: string[] }[];
  requiresAcknowledgement: boolean;
  signers: { environment: Environment; payer: string | null; lineCount: number }[];
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
}

export interface Partition {
  environment: Environment;
  assetId: string;
  symbol: string;
  decimals: number;
  total: string;
  verified: string;
  outstanding: string;
}

export interface RunSummary {
  runId: string;
  manifestVersion: number;
  manifestDigest: string;
  status: string;
  counts: Record<ObligationStatus | 'total', number>;
  partition: Partition[];
  exceptions: number;
  lastVerifiedAt: string | null;
}

export interface EligibleLine extends Obligation {
  priorStatus: 'approved_unattempted' | 'failed_verified';
  reason: string;
  lastAttemptId?: string;
}

export interface RecoveryPlan {
  runId: string;
  manifestVersion: number;
  manifestDigest: string;
  createdAt: string;
  expiresAt: string;
  eligible: EligibleLine[];
  blocked: { obligationId: string; lineId: string; status: ObligationStatus; reason: string }[];
  fingerprint: string;
}

export interface RunDetail {
  run: Run;
  role: Role | null;
  summary: RunSummary | null;
  latestVersion: {
    id: string;
    version: number;
    digest: string;
    status: string;
    frozenAt: string;
    approvedAt: string | null;
    manifest: { obligations: Obligation[]; totals: AssetTotal[]; network: Record<string, unknown>; payers: Record<string, string> } | null;
  } | null;
  latestImport: { id: string; fileName: string | null; fileSha256: string; createdAt: string; report: ValidationReport } | null;
  latestPlan: { id: string; kind: string; status: string; plan: RecoveryPlan } | null;
  versions: {
    id: string;
    version: number;
    digest: string;
    status: string;
    frozenBy: string;
    frozenAt: string;
    approvedAt: string | null;
    decisions: { reviewerId: string; decision: string; method: string; reason: string | null; at: string }[];
  }[];
}

export type AttemptOutcome =
  | { kind: 'not_broadcast' }
  | { kind: 'pending'; detail: string }
  | { kind: 'included'; evidence: Evidence }
  | { kind: 'finalized_success'; evidence: Evidence; transfers: unknown[] }
  | { kind: 'finalized_failure'; evidence?: Evidence; reason: string; detail: string }
  | { kind: 'unknown'; detail: string };

export interface Evidence {
  provider: string;
  txHash: string;
  blockHash?: string;
  blockNumber?: string;
  extrinsicIndex?: number;
  logIndex?: number;
  finalized: boolean;
  observedAt: string;
}

export interface AttemptView {
  id: string;
  attemptNumber: number;
  source: 'app' | 'imported' | 'chain_scan';
  phase: string;
  txHash: string | null;
  nonce: number | null;
  outcome: AttemptOutcome;
  explorerUrl: string | null;
  blockHash: string | null;
  blockNumber: string | null;
  extrinsicIndex: number | null;
  logIndex: number | null;
  finalized: boolean;
  provider: string | null;
  preparedAt: string;
  submittedAt: string | null;
  observedAt: string | null;
}

export interface LineView extends Obligation {
  amount: string;
  status: ObligationStatus;
  explanation: string;
  exceptions: { type: string; severity: string; message: string; attemptId?: string }[];
  settledBy: { attemptId: string; evidence: Evidence } | null;
  attempts: AttemptView[];
}

export interface EnvironmentHealth {
  environment: Environment;
  configured: boolean;
  capability: 'verified' | 'unverified' | 'unavailable';
  rpcAvailable: boolean;
  provider: string | null;
  identity: Record<string, unknown> | null;
  finalizedBlock: string | null;
  bestBlock: string | null;
  feeAsset: string | null;
  detail: string;
  checkedAt: string;
}

export interface ChainHealth {
  native: EnvironmentHealth;
  evm: EnvironmentHealth;
  assets: { environment: Environment; assetId: string; symbol: string; decimals: number; allowlisted: boolean; capability: string; label?: string }[];
}

export interface WalletView {
  id: string;
  environment: Environment;
  address: string;
  chainIdentity: string;
  chainMatches: boolean;
  verifiedAt: string;
  feeAsset: string | null;
  feeBalanceBaseUnits: string | null;
  feeBalanceDecimals: number | null;
  balanceError: string | null;
  rpcAvailable: boolean;
  capability: string;
}

export interface EvmTransferPayload {
  chainId: number;
  executor: string;
  token: string;
  amount: string;
  currentAllowance: string;
  approve: { to: `0x${string}`; data: `0x${string}` } | null;
  execute: { to: `0x${string}`; data: `0x${string}` };
}

export interface NativeTransferPayload {
  genesisHash: string;
  specVersion: number;
  pallet: 'balances';
  call: 'transferKeepAlive';
  dest: string;
  value: string;
  callHex: string;
  eraPeriod: number;
}

export interface UnsignedTransfer<T> {
  environment: Environment;
  obligationId: string;
  payer: string;
  method: string;
  payload: T;
  estimatedFee?: { amountBaseUnits: string; symbol: string; decimals: number };
  preflight: { code: string; message: string; blocking: boolean }[];
}
