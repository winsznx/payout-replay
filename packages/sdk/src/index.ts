import type { AttemptRecord, ImportContext, ManualResolution, ReconciliationResult, ValidationReport } from '@payout-replay/core';
import { reconcileRun as reconcile, validateManifestCsv } from '@payout-replay/core';

export * from '@payout-replay/core';
export { EvmAdapter, erc20Abi, payoutExecutorAbi } from '@payout-replay/adapters-evm';
export type { EvmAdapterConfig, EvmTransferPayload } from '@payout-replay/adapters-evm';
export { DEFAULT_ERA_PERIOD, NativeAdapter } from '@payout-replay/adapters-native';
export type { NativeAdapterConfig, NativeTransferPayload } from '@payout-replay/adapters-native';
export * from './client.js';

/** Parses a payout CSV into validated draft lines. Alias of `validateManifestCsv`, named as in the spec. */
export function parseManifest(csv: string, context: ImportContext): ValidationReport {
  return validateManifestCsv(csv, context);
}

/** Validates a CSV and returns only the blocking problems; empty means it can be frozen. */
export function validateManifest(csv: string, context: ImportContext): ValidationReport['issues'] {
  return validateManifestCsv(csv, context).issues.filter((issue) => issue.severity === 'error');
}

/** Convenience wrapper for `reconcileRun` that takes a frozen manifest directly. */
export function reconcileFrozen(
  frozen: { digest: string; manifest: { obligations: Parameters<typeof reconcile>[0]['obligations']; totals: Parameters<typeof reconcile>[0]['totals'] } },
  attempts: readonly AttemptRecord[],
  manualResolutions: readonly ManualResolution[] = [],
): ReconciliationResult {
  return reconcile({
    manifestDigest: frozen.digest,
    obligations: frozen.manifest.obligations,
    totals: frozen.manifest.totals,
    attempts,
    manualResolutions,
  });
}
