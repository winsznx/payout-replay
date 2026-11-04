import { formatBaseUnits } from './amount.js';
import { serializeCsv } from './csv.js';
import type { ReconciliationResult } from './reconcile.js';
import type { FrozenManifest } from './types.js';

export const EXPORT_COLUMNS = [
  'line_id',
  'reference',
  'recipient_name',
  'destination',
  'asset_symbol',
  'amount',
  'run_id',
  'version',
  'manifest_digest',
  'environment',
  'payer_address',
  'asset_id',
  'amount_base_units',
  'obligation_id',
  'status',
  'tx_hash',
  'block_hash',
  'block_number',
  'extrinsic_index',
  'log_index',
  'finalized_at',
  'verification_at',
  'exception_reason',
  'correction_attempt_id',
] as const;

export const EXCEPTION_COLUMNS = [
  'run_id',
  'version',
  'line_id',
  'obligation_id',
  'severity',
  'type',
  'message',
  'attempt_id',
  'observed_from',
  'observed_to',
  'observed_asset_id',
  'observed_amount_base_units',
] as const;

export interface ExportContext {
  frozen: FrozenManifest;
  reconciliation: ReconciliationResult;
  verificationAt: string;
  /** Attempt IDs that were created as corrections (attempt number > 1 or from a recovery plan). */
  correctionAttemptIds?: ReadonlySet<string>;
  finalizedAt?: ReadonlyMap<string, string>;
}

/**
 * One row per original obligation, in manifest order, with base units kept as
 * strings so spreadsheets never round them. Incomplete runs export too; the
 * status column says exactly what is and isn't settled.
 */
export function exportReconciliationCsv(context: ExportContext): string {
  const { frozen, reconciliation } = context;
  const states = new Map(reconciliation.obligations.map((state) => [state.obligationId, state]));
  const rows = frozen.manifest.obligations.map((obligation) => {
    const state = states.get(obligation.obligationId);
    if (!state) throw new Error(`no reconciliation state for ${obligation.lineId}`);
    const evidence = state.settledBy?.evidence;
    const settledAttempt = state.settledBy?.attemptId;
    const correction =
      settledAttempt && context.correctionAttemptIds?.has(settledAttempt) ? settledAttempt : '';
    return [
      obligation.lineId,
      obligation.reference,
      obligation.recipientName ?? '',
      obligation.destination,
      obligation.symbol,
      formatBaseUnits(obligation.amountBaseUnits, obligation.decimals),
      frozen.manifest.runId,
      String(frozen.manifest.version),
      frozen.digest,
      obligation.environment,
      obligation.payer,
      obligation.assetId,
      obligation.amountBaseUnits,
      obligation.obligationId,
      state.status,
      evidence?.txHash ?? '',
      evidence?.blockHash ?? '',
      evidence?.blockNumber ?? '',
      evidence?.extrinsicIndex === undefined ? '' : String(evidence.extrinsicIndex),
      evidence?.logIndex === undefined ? '' : String(evidence.logIndex),
      (settledAttempt && context.finalizedAt?.get(settledAttempt)) ?? '',
      context.verificationAt,
      state.exceptions.map((exception) => `${exception.type}: ${exception.message}`).join(' | ') ||
        (state.status === 'paid_verified' ? '' : state.explanation),
      correction,
    ];
  });
  return serializeCsv(EXPORT_COLUMNS, rows);
}

export function exportExceptionsCsv(context: Pick<ExportContext, 'frozen' | 'reconciliation'>): string {
  const lineIds = new Map(context.frozen.manifest.obligations.map((obligation) => [obligation.obligationId, obligation.lineId]));
  const rows = context.reconciliation.exceptions.map((exception) => [
    context.frozen.manifest.runId,
    String(context.frozen.manifest.version),
    lineIds.get(exception.obligationId) ?? '',
    exception.obligationId,
    exception.severity,
    exception.type,
    exception.message,
    exception.attemptId ?? '',
    exception.transfer?.from ?? '',
    exception.transfer?.to ?? '',
    exception.transfer?.assetId ?? '',
    exception.transfer?.amountBaseUnits ?? '',
  ]);
  return serializeCsv(EXCEPTION_COLUMNS, rows);
}
