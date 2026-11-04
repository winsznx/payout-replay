// Pulls every finished or partially finished payout run into a local folder an
// accounting tool can watch: the reconciled sheet, the exceptions register and
// the evidence package. Runs with unresolved lines are exported too, under
// their real status, and listed so someone follows up.
//
//   PAYOUT_REPLAY_URL=https://api.example.com PAYOUT_REPLAY_KEY=prk_... \
//   PAYOUT_REPLAY_ORG=org_... OUT_DIR=./ledger pnpm sync
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PayoutReplayApiError, PayoutReplayClient } from '@payout-replay/sdk';

const baseUrl = process.env.PAYOUT_REPLAY_URL;
const apiKey = process.env.PAYOUT_REPLAY_KEY;
const orgId = process.env.PAYOUT_REPLAY_ORG;
const outDir = process.env.OUT_DIR ?? './ledger';
if (!baseUrl || !apiKey || !orgId) {
  throw new Error('set PAYOUT_REPLAY_URL, PAYOUT_REPLAY_KEY and PAYOUT_REPLAY_ORG');
}

const client = new PayoutReplayClient({ baseUrl, apiKey });
const EXPORTABLE = new Set(['complete', 'incomplete', 'needs_review', 'reconciling', 'recovering', 'executing']);

await mkdir(outDir, { recursive: true });
const runs = await client.listRuns(orgId);
const followUp: string[] = [];

for (const run of runs.filter((item) => EXPORTABLE.has(item.status))) {
  try {
    const summary = await client.reconcile(run.id);
    const folder = join(outDir, `${run.id}-v${summary.manifestVersion}`);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'reconciliation.csv'), await client.exportCsv(run.id));
    await writeFile(join(folder, 'exceptions.csv'), await client.exceptionsCsv(run.id));
    await writeFile(join(folder, 'evidence.json'), JSON.stringify(await client.evidence(run.id), null, 2));
    const unsettled = (summary.counts.total ?? 0) - (summary.counts.paid_verified ?? 0);
    console.log(`${run.name}: ${summary.counts.paid_verified}/${summary.counts.total} verified, written to ${folder}`);
    if (unsettled > 0 || summary.exceptions > 0) {
      followUp.push(`${run.name} (${run.id}): ${unsettled} unsettled line(s), ${summary.exceptions} exception(s)`);
    }
  } catch (error) {
    if (error instanceof PayoutReplayApiError && error.retryable) {
      followUp.push(`${run.name} (${run.id}): chain verification unavailable, retry later [${error.traceId}]`);
      continue;
    }
    throw error;
  }
}

if (followUp.length > 0) {
  console.log('\nNeeds follow-up:');
  for (const line of followUp) console.log(`  ${line}`);
  process.exitCode = 2;
}
