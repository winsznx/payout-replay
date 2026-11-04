import { checkAddress, sameAddress } from './address.js';
import { UINT128_MAX, UINT256_MAX, parseDecimalAmount } from './amount.js';
import { canonicalJson, sha256Digest, sha256Hex } from './canonical.js';
import { CsvSyntaxError, parseCsv } from './csv.js';
import { deriveObligationId } from './obligation-id.js';
import type {
  AssetDescriptor,
  AssetTotal,
  DraftLine,
  Environment,
  FrozenManifest,
  NetworkIdentity,
  Obligation,
  PayerWallets,
  PayoutManifest,
} from './types.js';

export const REQUIRED_FIELDS = ['line_id', 'environment', 'asset_id', 'destination', 'amount', 'reference'] as const;
export const OPTIONAL_FIELDS = ['recipient_name', 'recipient_id', 'invoice_id', 'note', 'source_wallet'] as const;

export type ManifestField = (typeof REQUIRED_FIELDS)[number] | (typeof OPTIONAL_FIELDS)[number];

export interface ImportLimits {
  maxBytes: number;
  maxLines: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = { maxBytes: 5 * 1024 * 1024, maxLines: 500 };

export interface ImportContext {
  assets: readonly AssetDescriptor[];
  payers: PayerWallets;
  ss58Prefix: number;
  limits?: ImportLimits;
  /** Maps a canonical field to the header used in the uploaded file. Defaults to identity. */
  columnMapping?: Partial<Record<ManifestField, string>>;
}

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  /** Physical CSV line, or null for file-level issues. */
  line: number | null;
  lineId?: string;
  field?: ManifestField;
}

export interface DuplicateGroup {
  key: string;
  lineIds: string[];
}

export interface ValidationReport {
  ok: boolean;
  fileSha256: string;
  columns: {
    mapping: Partial<Record<ManifestField, string>>;
    missingRequired: ManifestField[];
    ignored: string[];
  };
  lines: DraftLine[];
  issues: ValidationIssue[];
  totals: AssetTotal[];
  duplicates: DuplicateGroup[];
  /** Duplicate-looking rows are kept but must be explicitly acknowledged before freezing. */
  requiresAcknowledgement: boolean;
  signers: { environment: Environment; payer: string | null; lineCount: number }[];
}

const LINE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\-/#]{0,127}$/;
const MAX_REFERENCE_LENGTH = 256;
const MAX_TEXT_LENGTH = 512;

export function findAsset(
  assets: readonly AssetDescriptor[],
  environment: Environment,
  assetId: string,
): AssetDescriptor | undefined {
  const needle = assetId.trim().toLowerCase();
  return assets.find((asset) => asset.environment === environment && asset.assetId.toLowerCase() === needle);
}

function resolveMapping(
  headers: readonly string[],
  overrides: ImportContext['columnMapping'],
): ValidationReport['columns'] {
  const mapping: Partial<Record<ManifestField, string>> = {};
  const used = new Set<string>();
  for (const field of [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]) {
    const header = (overrides?.[field] ?? field).trim().toLowerCase();
    if (headers.includes(header)) {
      mapping[field] = header;
      used.add(header);
    }
  }
  return {
    mapping,
    missingRequired: REQUIRED_FIELDS.filter((field) => mapping[field] === undefined),
    ignored: headers.filter((header) => !used.has(header)),
  };
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Parses and validates a payout CSV. Never throws for user input problems;
 * every problem becomes a line-level or file-level issue in the report so the
 * operator can fix the sheet before anything is persisted.
 */
export function validateManifestCsv(csvText: string, context: ImportContext): ValidationReport {
  const limits = context.limits ?? DEFAULT_IMPORT_LIMITS;
  const issues: ValidationIssue[] = [];
  const report = (partial: Partial<ValidationReport>): ValidationReport => {
    const hasErrors = issues.some((issue) => issue.severity === 'error');
    return {
      ok: !hasErrors,
      fileSha256: sha256Hex(csvText),
      columns: { mapping: {}, missingRequired: [], ignored: [] },
      lines: [],
      totals: [],
      duplicates: [],
      requiresAcknowledgement: false,
      signers: [],
      ...partial,
      issues,
    };
  };

  if (utf8ByteLength(csvText) > limits.maxBytes) {
    issues.push({
      severity: 'error',
      code: 'FILE_TOO_LARGE',
      message: `file exceeds ${limits.maxBytes} bytes`,
      line: null,
    });
    return report({});
  }

  let table;
  try {
    table = parseCsv(csvText);
  } catch (error) {
    if (!(error instanceof CsvSyntaxError)) throw error;
    issues.push({ severity: 'error', code: 'CSV_SYNTAX', message: error.message, line: error.line });
    return report({});
  }

  const columns = resolveMapping(table.headers, context.columnMapping);
  for (const field of columns.missingRequired) {
    issues.push({
      severity: 'error',
      code: 'MISSING_COLUMN',
      message: `required column "${field}" is missing`,
      line: 1,
      field,
    });
  }
  if (columns.missingRequired.length > 0) return report({ columns });

  if (table.records.length === 0) {
    issues.push({ severity: 'error', code: 'NO_ROWS', message: 'file has a header but no payout rows', line: null });
    return report({ columns });
  }
  if (table.records.length > limits.maxLines) {
    issues.push({
      severity: 'error',
      code: 'TOO_MANY_ROWS',
      message: `file has ${table.records.length} rows, the limit is ${limits.maxLines}`,
      line: null,
    });
    return report({ columns });
  }

  const columnIndex = new Map(table.headers.map((header, index) => [header, index]));
  const read = (values: string[], field: ManifestField): string | undefined => {
    const header = columns.mapping[field];
    if (header === undefined) return undefined;
    const value = values[columnIndex.get(header)!]?.trim();
    return value === '' ? undefined : value;
  };

  const lines: DraftLine[] = [];
  const seenLineIds = new Map<string, number>();

  for (const record of table.records) {
    const line = record.line;
    const rowIssues: ValidationIssue[] = [];
    const fail = (field: ManifestField, code: string, message: string, lineId?: string) =>
      rowIssues.push({ severity: 'error', code, message, line, field, ...(lineId ? { lineId } : {}) });

    const lineId = read(record.values, 'line_id');
    if (!lineId) fail('line_id', 'LINE_ID_REQUIRED', 'line_id is required');
    else if (!LINE_ID_PATTERN.test(lineId)) {
      fail('line_id', 'LINE_ID_INVALID', `line_id "${lineId}" must be 1-128 characters of letters, digits and ._:-/#`, lineId);
    } else {
      const key = lineId.toLowerCase();
      const firstLine = seenLineIds.get(key);
      if (firstLine !== undefined) {
        fail('line_id', 'LINE_ID_DUPLICATE', `line_id "${lineId}" already used on line ${firstLine}`, lineId);
      } else {
        seenLineIds.set(key, line);
      }
    }

    const environmentRaw = read(record.values, 'environment')?.toLowerCase();
    const environment: Environment | undefined =
      environmentRaw === 'native' || environmentRaw === 'evm' ? environmentRaw : undefined;
    if (!environment) {
      fail('environment', 'ENVIRONMENT_INVALID', `environment must be "native" or "evm", got "${environmentRaw ?? ''}"`, lineId);
    }

    const assetIdRaw = read(record.values, 'asset_id');
    const asset = environment && assetIdRaw ? findAsset(context.assets, environment, assetIdRaw) : undefined;
    if (!assetIdRaw) fail('asset_id', 'ASSET_REQUIRED', 'asset_id is required', lineId);
    else if (environment && !asset) {
      fail('asset_id', 'ASSET_UNKNOWN', `asset "${assetIdRaw}" is not configured for the ${environment} environment`, lineId);
    } else if (asset && !asset.allowlisted) {
      fail('asset_id', 'ASSET_NOT_ALLOWLISTED', `asset ${asset.symbol} is not on the payout allowlist`, lineId);
    } else if (asset && asset.capability !== 'verified') {
      fail('asset_id', 'ASSET_CAPABILITY', `payments in ${asset.symbol} are ${asset.capability} on this network`, lineId);
    }

    const destinationRaw = read(record.values, 'destination');
    let destination: string | undefined;
    if (!destinationRaw) fail('destination', 'DESTINATION_REQUIRED', 'destination is required', lineId);
    else if (environment) {
      const check = checkAddress(environment, destinationRaw, context.ss58Prefix);
      if (!check.ok) fail('destination', 'DESTINATION_INVALID', check.message, lineId);
      else {
        destination = check.canonical;
        if (check.warning) {
          rowIssues.push({ severity: 'warning', code: 'DESTINATION_REENCODED', message: check.warning, line, field: 'destination', ...(lineId ? { lineId } : {}) });
        }
      }
    }

    const amount = read(record.values, 'amount');
    let amountBaseUnits: bigint | undefined;
    if (!amount) fail('amount', 'AMOUNT_REQUIRED', 'amount is required', lineId);
    else if (asset) {
      const parsed = parseDecimalAmount(amount, asset.decimals, environment === 'native' ? UINT128_MAX : UINT256_MAX);
      if (parsed.ok) amountBaseUnits = parsed.baseUnits;
      else fail('amount', parsed.error.code, parsed.error.message, lineId);
    }

    const reference = read(record.values, 'reference');
    if (!reference) fail('reference', 'REFERENCE_REQUIRED', 'reference is required', lineId);
    else if (reference.length > MAX_REFERENCE_LENGTH) {
      fail('reference', 'REFERENCE_TOO_LONG', `reference exceeds ${MAX_REFERENCE_LENGTH} characters`, lineId);
    }

    const optional: Partial<Pick<DraftLine, 'recipientName' | 'recipientId' | 'invoiceId' | 'note' | 'sourceWallet'>> = {};
    for (const [field, key] of [
      ['recipient_name', 'recipientName'],
      ['recipient_id', 'recipientId'],
      ['invoice_id', 'invoiceId'],
      ['note', 'note'],
      ['source_wallet', 'sourceWallet'],
    ] as const) {
      const value = read(record.values, field);
      if (value === undefined) continue;
      if (value.length > MAX_TEXT_LENGTH) fail(field, 'TEXT_TOO_LONG', `${field} exceeds ${MAX_TEXT_LENGTH} characters`, lineId);
      else optional[key] = value;
    }

    if (environment) {
      const payer = context.payers[environment];
      if (!payer) {
        fail('environment', 'PAYER_MISSING', `no verified ${environment} payout wallet is configured`, lineId);
      } else if (optional.sourceWallet && !sameAddress(environment, optional.sourceWallet, payer)) {
        fail('source_wallet', 'SOURCE_WALLET_MISMATCH', `source_wallet ${optional.sourceWallet} is not the configured ${environment} payout wallet ${payer}`, lineId);
      } else if (destination && sameAddress(environment, destination, payer)) {
        fail('destination', 'DESTINATION_IS_PAYER', 'destination is the paying wallet itself', lineId);
      }
    }

    issues.push(...rowIssues);
    if (rowIssues.some((issue) => issue.severity === 'error')) continue;
    lines.push({
      lineId: lineId!,
      environment: environment!,
      assetId: asset!.assetId,
      destination: destination!,
      amount: amount!,
      amountBaseUnits: amountBaseUnits!.toString(),
      reference: reference!,
      ...optional,
      sourceLine: line,
    });
  }

  const duplicates = findDuplicateGroups(lines);
  for (const group of duplicates) {
    issues.push({
      severity: 'warning',
      code: 'DUPLICATE_LOOKING',
      message: `lines ${group.lineIds.join(', ')} pay the same amount of the same asset to the same destination; they stay separate obligations`,
      line: null,
    });
  }

  const signers = (['native', 'evm'] as const)
    .map((environment) => ({
      environment,
      payer: context.payers[environment] ?? null,
      lineCount: lines.filter((line) => line.environment === environment).length,
    }))
    .filter((signer) => signer.lineCount > 0);

  return report({
    columns,
    lines,
    totals: computeTotals(lines, context.assets),
    duplicates,
    requiresAcknowledgement: duplicates.length > 0,
    signers,
  });
}

function findDuplicateGroups(lines: readonly DraftLine[]): DuplicateGroup[] {
  const groups = new Map<string, string[]>();
  for (const line of lines) {
    const key = `${line.environment}|${line.assetId.toLowerCase()}|${line.destination}|${line.amountBaseUnits}`;
    groups.set(key, [...(groups.get(key) ?? []), line.lineId]);
  }
  return [...groups.entries()]
    .filter(([, lineIds]) => lineIds.length > 1)
    .map(([key, lineIds]) => ({ key, lineIds }));
}

export function computeTotals(
  lines: readonly Pick<DraftLine, 'environment' | 'assetId' | 'amountBaseUnits'>[],
  assets: readonly AssetDescriptor[],
): AssetTotal[] {
  const totals = new Map<string, AssetTotal>();
  for (const line of lines) {
    const asset = findAsset(assets, line.environment, line.assetId);
    if (!asset) throw new Error(`asset ${line.assetId} missing from registry`);
    const key = `${line.environment}|${asset.assetId}`;
    const current = totals.get(key) ?? {
      environment: line.environment,
      assetId: asset.assetId,
      symbol: asset.symbol,
      decimals: asset.decimals,
      count: 0,
      amountBaseUnits: '0',
    };
    current.count += 1;
    current.amountBaseUnits = (BigInt(current.amountBaseUnits) + BigInt(line.amountBaseUnits)).toString();
    totals.set(key, current);
  }
  return [...totals.values()].sort(compareAssetKey);
}

function compareAssetKey(a: { environment: string; assetId: string }, b: { environment: string; assetId: string }): number {
  return compareStrings(a.environment, b.environment) || compareStrings(a.assetId, b.assetId);
}

/** Code-unit ordering, independent of locale, so every runtime sorts identically. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface FreezeInput {
  runId: string;
  version: number;
  network: NetworkIdentity;
  payers: PayerWallets;
  assets: readonly AssetDescriptor[];
  lines: readonly DraftLine[];
}

/**
 * Builds the canonical manifest and its SHA-256 digest. Obligations are sorted
 * by line_id and every value that could vary by formatting (addresses,
 * amounts) is already canonical, so the same approved sheet always produces
 * the same digest.
 */
export function freezeManifest(input: FreezeInput): FrozenManifest {
  const obligations: Obligation[] = input.lines
    .map((line) => {
      const asset = findAsset(input.assets, line.environment, line.assetId);
      const payer = input.payers[line.environment];
      if (!asset) throw new Error(`asset ${line.assetId} missing from registry`);
      if (!payer) throw new Error(`no ${line.environment} payer configured`);
      const obligation: Obligation = {
        obligationId: deriveObligationId({
          environment: line.environment,
          network: input.network,
          payer,
          runId: input.runId,
          version: input.version,
          lineId: line.lineId,
        }),
        lineId: line.lineId,
        environment: line.environment,
        assetId: asset.assetId,
        symbol: asset.symbol,
        decimals: asset.decimals,
        payer,
        destination: line.destination,
        amountBaseUnits: line.amountBaseUnits,
        reference: line.reference,
      };
      if (line.recipientName) obligation.recipientName = line.recipientName;
      if (line.recipientId) obligation.recipientId = line.recipientId;
      if (line.invoiceId) obligation.invoiceId = line.invoiceId;
      if (line.note) obligation.note = line.note;
      return obligation;
    })
    .sort((a, b) => compareStrings(a.lineId, b.lineId));

  const usedEnvironments = new Set(obligations.map((obligation) => obligation.environment));
  const network: NetworkIdentity = {};
  if (usedEnvironments.has('native')) network.native = input.network.native;
  if (usedEnvironments.has('evm')) network.evm = input.network.evm;
  const payers: PayerWallets = {};
  if (usedEnvironments.has('native')) payers.native = input.payers.native;
  if (usedEnvironments.has('evm')) payers.evm = input.payers.evm;

  const manifest: PayoutManifest = {
    schema: 'payout-replay/manifest@1',
    runId: input.runId,
    version: input.version,
    network,
    payers,
    obligations,
    totals: computeTotals(obligations, input.assets),
  };
  const json = canonicalJson(manifest);
  return { manifest, canonicalJson: json, digest: sha256Digest(json) };
}

/** Recomputes the digest of a stored manifest; used to detect tampering of persisted versions. */
export function verifyManifestDigest(frozen: Pick<FrozenManifest, 'manifest' | 'digest'>): boolean {
  return sha256Digest(canonicalJson(frozen.manifest)) === frozen.digest;
}
