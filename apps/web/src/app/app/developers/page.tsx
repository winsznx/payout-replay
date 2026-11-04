'use client';

import { type FormEvent, useState } from 'react';
import useSWR from 'swr';

import { IconKey } from '@/components/icons';
import { Button, CopyText, IconTile, Notice, PageHead, TopBar } from '@/components/ui';
import { apiPost, errorMessage, fetcher } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useSession } from '@/lib/session';

const ENDPOINTS: [string, string, string][] = [
  ['GET', '/api/v1/orgs/:orgId/runs', 'List payout runs'],
  ['POST', '/api/v1/orgs/:orgId/runs', 'Create a draft run'],
  ['POST', '/api/v1/runs/:runId/import', 'Upload CSV text, get a line-level report'],
  ['POST', '/api/v1/runs/:runId/freeze', 'Freeze the latest valid import'],
  ['GET', '/api/v1/runs/:runId/lines', 'Lines with attempts and proof'],
  ['POST', '/api/v1/runs/:runId/reconcile', 'Re-read the chain now'],
  ['POST', '/api/v1/runs/:runId/external-transactions', 'Attach an out-of-band transaction'],
  ['GET', '/api/v1/runs/:runId/export.csv', 'Reconciled sheet'],
  ['GET', '/api/v1/runs/:runId/exceptions.csv', 'Exceptions register'],
  ['GET', '/api/v1/runs/:runId/evidence.json', 'Machine-readable evidence'],
  ['GET', '/health/chain', 'Public network capability'],
];

const SDK = `import { PayoutReplayClient, NativeAdapter } from '@payout-replay/sdk';

const client = new PayoutReplayClient({ baseUrl, apiKey: process.env.PAYOUT_REPLAY_KEY });
const lines = await client.listLines('pr_…');
const csv = await client.exportCsv('pr_…');

// Or verify an extrinsic yourself, no hosted API involved
const native = new NativeAdapter({ wsUrl: 'wss://test-node-v3.portaldot.dev' });
const outcome = await native.observeAttempt({ environment: 'native', txHash, payer, obligationId, blockHash });
// 'finalized_success' | 'finalized_failure' | 'included' | 'pending' | 'unknown'`;

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
  const [busy, setBusy] = useState(false);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await apiPost<{ secret: string }>(`/orgs/${orgId}/api-keys`, { name, scopes: write ? ['runs:read', 'runs:write'] : ['runs:read'] });
      setSecret(created.secret);
      setName('');
      await keys.mutate();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2 className="card-title">API keys</h2>
      <p className="card-desc">Keys read runs and can attach transactions. They can never approve, sign or register wallets.</p>
      <form onSubmit={(event) => void create(event)} className="stack" style={{ gap: 10, marginTop: 14 }}>
        <input required minLength={2} value={name} onChange={(event) => setName(event.target.value)} placeholder="Key name, e.g. accounting sync" aria-label="Key name" className="input" />
        <label style={{ display: 'flex', gap: 8, fontSize: 13.5, color: 'var(--ink-2)' }}>
          <input type="checkbox" checked={write} onChange={(event) => setWrite(event.target.checked)} />
          Can create runs, import CSVs and trigger checks
        </label>
        <Button type="submit" variant="primary" busy={busy}>
          Create key
        </Button>
      </form>
      {secret && (
        <div style={{ marginTop: 12 }}>
          <Notice tone="info" title="Copy this key now. It isn’t shown again.">
            <CopyText value={secret} />
          </Notice>
        </div>
      )}
      {error && (
        <div style={{ marginTop: 12 }}>
          <Notice tone="failed">{error}</Notice>
        </div>
      )}
      {keys.data && keys.data.length > 0 && (
        <div className="queue" style={{ marginTop: 14 }}>
          {keys.data.map((key) => (
            <div className="queue-row" key={key.id}>
              <IconTile tone={key.revokedAt ? undefined : 'settled'}>
                <IconKey size={18} />
              </IconTile>
              <div className="queue-main">
                <small className="mono">{key.prefix}…</small>
                <h3>{key.name}</h3>
                <p>
                  {key.scopes.join(', ')} · used {timeAgo(key.lastUsedAt)}
                </p>
              </div>
              {key.revokedAt ? (
                <span className="pill tone-neutral">Revoked</span>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => void apiPost(`/orgs/${orgId}/api-keys/${key.id}/revoke`, {}).then(() => keys.mutate())}>
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DevelopersPage() {
  const { orgId, org } = useSession();
  return (
    <>
      <TopBar crumbs={[{ label: 'API and SDK' }]} />
      <div className="page">
        <PageHead
          title="API and SDK"
          description="The same reconciliation engine the app runs on, as an open-source TypeScript SDK and a REST API."
        />
        <div className="split">
          <div className="stack">
            <div className="code">{SDK}</div>
            <div className="table-card">
              <div className="table-scroll">
                <table className="table" aria-label="REST endpoints">
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th>Path</th>
                      <th>What it does</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ENDPOINTS.map(([method, path, description]) => (
                      <tr key={`${method} ${path}`}>
                        <td>
                          <span className={`pill ${method === 'GET' ? 'tone-waiting' : 'tone-neutral'}`}>{method}</span>
                        </td>
                        <td className="mono">{path}</td>
                        <td style={{ color: 'var(--ink-2)' }}>{description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <aside className="stack">
            <div className="card-dark">
              <p style={{ color: '#fff', fontSize: 17, fontWeight: 600 }}>Writes are idempotent</p>
              <p style={{ marginTop: 6 }}>
                Every POST carries an Idempotency-Key. A retried request replays the first response, so a lost network reply never creates a second attempt.
              </p>
            </div>
            {orgId && org?.role === 'owner' && <ApiKeys orgId={orgId} />}
            <div className="card">
              <h2 className="card-title">Webhooks</h2>
              <p className="card-desc">
                payout_run.updated, obligation.paid_verified, obligation.needs_review and recovery_plan.ready. Each delivery is signed as{' '}
                <span className="mono">t=…,v1=hmac</span> over the timestamp and body. Reject stale timestamps and repeated event IDs.
              </p>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
