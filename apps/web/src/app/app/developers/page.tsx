'use client';

import { type FormEvent, useState } from 'react';
import useSWR from 'swr';

import { Button, CopyText, Notice, PageHeader, Section, Table, td, th } from '@/components/ui';
import { apiPost, errorMessage, fetcher } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useSession } from '@/lib/session';

const ENDPOINTS: [string, string, string][] = [
  ['GET', '/api/v1/orgs/:orgId/runs', 'List payout runs'],
  ['POST', '/api/v1/orgs/:orgId/runs', 'Create a draft run'],
  ['POST', '/api/v1/runs/:runId/import', 'Upload CSV text and get a validation report'],
  ['POST', '/api/v1/runs/:runId/freeze', 'Freeze the latest valid import into a new version'],
  ['POST', '/api/v1/runs/:runId/approvals', 'Approve or reject an exact version and digest (signed-in reviewer)'],
  ['GET', '/api/v1/runs/:runId', 'Manifest, status summary and latest plan'],
  ['GET', '/api/v1/runs/:runId/lines', 'Obligations with attempts and proof'],
  ['POST', '/api/v1/runs/:runId/reconcile', 'Refresh chain evidence now'],
  ['POST', '/api/v1/runs/:runId/recovery-plans', 'Recompute what is safe to pay (signed-in operator)'],
  ['POST', '/api/v1/recovery-plans/:planId/revalidate', 'Recheck immediately before signing and get unsigned calls'],
  ['POST', '/api/v1/runs/:runId/external-transactions', 'Attach an out-of-band tx reference for verification'],
  ['GET', '/api/v1/runs/:runId/export.csv', 'Reconciled sheet'],
  ['GET', '/api/v1/runs/:runId/exceptions.csv', 'Exceptions register'],
  ['GET', '/api/v1/runs/:runId/evidence.json', 'Machine-readable evidence package'],
  ['GET', '/health/chain', 'Public network capability summary'],
];

const SDK_SNIPPET = `import { validateManifestCsv, freezeManifest, reconcileRun, createRecoveryPlan } from '@payout-replay/core';
import { EvmAdapter } from '@payout-replay/adapters-evm';

const report = validateManifestCsv(csvText, { assets, payers, ss58Prefix: 42 });
if (!report.ok) throw new Error(report.issues.map((issue) => issue.message).join('\\n'));

const frozen = freezeManifest({ runId, version: 1, network, payers, assets, lines: report.lines });
const evm = new EvmAdapter({ rpcUrl, chainId: 420420777, executorAddress });
const outcome = await evm.observeAttempt({ environment: 'evm', txHash, payer, obligationId });
// outcome.kind is 'finalized_success' | 'finalized_failure' | 'included' | 'pending' | 'unknown'`;

const CURL_SNIPPET = `curl -H "Authorization: Bearer $PAYOUT_REPLAY_KEY" \\
  https://<your-host>/api/v1/runs/<runId>/lines

curl -X POST -H "Authorization: Bearer $PAYOUT_REPLAY_KEY" \\
  -H "Idempotency-Key: $(uuidgen)" -H "content-type: application/json" \\
  -d '{}' https://<your-host>/api/v1/runs/<runId>/reconcile`;

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function ApiKeys({ orgId }: { orgId: string }) {
  const keys = useSWR<KeyRow[]>(`/orgs/${orgId}/api-keys`, fetcher);
  const [name, setName] = useState('');
  const [write, setWrite] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const created = await apiPost<{ secret: string }>(`/orgs/${orgId}/api-keys`, { name, scopes: write ? ['runs:read', 'runs:write'] : ['runs:read'] });
      setSecret(created.secret);
      setName('');
      await keys.mutate();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <div className="space-y-4">
      <form onSubmit={(event) => void create(event)} className="flex flex-wrap items-center gap-3">
        <input
          required
          minLength={2}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Key name, e.g. accounting sync"
          className="w-72 rounded-[5px] border border-rule-strong bg-surface px-3 py-1.5 text-[14px]"
          aria-label="Key name"
        />
        <label className="flex items-center gap-2 text-[14px]">
          <input type="checkbox" checked={write} onChange={(event) => setWrite(event.target.checked)} />
          Can create runs, import CSVs and trigger checks
        </label>
        <Button type="submit">Create key</Button>
      </form>
      {secret && (
        <Notice tone="accent" title="Copy this key now. It is not shown again.">
          <CopyText value={secret} />
        </Notice>
      )}
      {error && <Notice tone="failed">{error}</Notice>}
      {keys.data && keys.data.length > 0 && (
        <Table label="API keys">
          <thead>
            <tr>
              <th className={th}>Name</th>
              <th className={th}>Key starts with</th>
              <th className={th}>Permissions</th>
              <th className={th}>Last used</th>
              <th className={th}>State</th>
            </tr>
          </thead>
          <tbody>
            {keys.data.map((key) => (
              <tr key={key.id}>
                <td className={td}>{key.name}</td>
                <td className={`${td} hash`}>{key.prefix}</td>
                <td className={td}>{key.scopes.join(', ')}</td>
                <td className={td}>{timeAgo(key.lastUsedAt)}</td>
                <td className={td}>
                  {key.revokedAt ? (
                    'Revoked'
                  ) : (
                    <Button variant="ghost" onClick={() => void apiPost(`/orgs/${orgId}/api-keys/${key.id}/revoke`, {}).then(() => keys.mutate())}>
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

export default function DevelopersPage() {
  const { orgId, org } = useSession();
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="API and SDK"
        description="The same reconciliation engine the app uses, as an open-source TypeScript package and a REST API. API keys can read and register data; they can never sign or move funds."
      />
      <Section title="TypeScript SDK" description="packages/core, packages/adapters-evm and packages/adapters-native in the repository.">
        <pre className="overflow-x-auto border border-rule bg-sunken p-4 text-[13px] leading-relaxed">
          <code className="font-mono">{SDK_SNIPPET}</code>
        </pre>
      </Section>
      <Section title="REST endpoints" description="Writes need an Idempotency-Key header. Errors look like { error: { code, message, retryable, traceId } }.">
        <Table label="REST endpoints">
          <thead>
            <tr>
              <th className={th}>Method</th>
              <th className={th}>Path</th>
              <th className={th}>What it does</th>
            </tr>
          </thead>
          <tbody>
            {ENDPOINTS.map(([method, path, description]) => (
              <tr key={`${method} ${path}`}>
                <td className={`${td} font-mono text-[13px]`}>{method}</td>
                <td className={`${td} font-mono text-[13px]`}>{path}</td>
                <td className={td}>{description}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <pre className="mt-4 overflow-x-auto border border-rule bg-sunken p-4 text-[13px] leading-relaxed">
          <code className="font-mono">{CURL_SNIPPET}</code>
        </pre>
      </Section>
      <Section title="Webhooks" description="payout_run.updated, obligation.paid_verified, obligation.needs_review and recovery_plan.ready.">
        <p className="max-w-[72ch] text-[14px] text-ink-2">
          Each delivery carries <code className="font-mono text-[13px]">x-payout-replay-signature: t=…,v1=…</code>, an HMAC-SHA256 of
          <code className="font-mono text-[13px]"> {'"<t>.<body>"'}</code> with your endpoint secret, plus a stable event ID. Reject stale timestamps and
          event IDs you have already processed. Failed deliveries retry with exponential backoff, up to eight times.
        </p>
      </Section>
      {orgId && org?.role === 'owner' && (
        <Section title="API keys">
          <ApiKeys orgId={orgId} />
        </Section>
      )}
    </div>
  );
}
