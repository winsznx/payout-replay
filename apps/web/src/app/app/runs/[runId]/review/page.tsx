'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { IconChain, IconCheck, IconFile, IconLayers, IconWallet, IconX } from '@/components/icons';
import { Button, CopyText, Empty, IconTile, KeyValue, Notice, PageHead } from '@/components/ui';
import { apiPost, errorMessage } from '@/lib/api';
import { dateTime, formatBaseUnits } from '@/lib/format';
import { useRun } from '@/lib/run-context';

export default function ReviewPage() {
  const { runId, detail, refresh } = useRun();
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!detail?.latestVersion?.manifest) {
    return (
      <div className="page">
        <Empty icon={<IconFile size={20} />} title="Nothing frozen yet">
          Import and freeze a sheet first.
        </Empty>
      </div>
    );
  }

  const version = detail.latestVersion;
  const manifest = version.manifest!;
  const canDecide = version.status === 'awaiting_approval' && (detail.role === 'owner' || detail.role === 'reviewer');
  const headline =
    version.status === 'approved'
      ? `Version ${version.version} is approved`
      : version.status === 'awaiting_approval'
        ? `Version ${version.version} is waiting for approval`
        : `Version ${version.version} is ${version.status}`;

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(decision);
    setError(null);
    try {
      await apiPost(`/runs/${runId}/approvals`, { version: version.version, digest: version.digest, decision, ...(decision === 'reject' ? { reason } : {}) });
      await refresh();
      if (decision === 'approve') router.push(`/app/runs/${runId}/execute`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <PageHead
        title={headline}
        description="Approval is recorded in this app against the exact fingerprint below. It doesn’t move money. Every payment still needs the payout wallet’s own signature."
      />
      <div className="split">
        <div className="stack">
          <div className="table-card">
            <div className="table-scroll">
              <table className="table" aria-label="Frozen obligations">
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>Destination</th>
                    <th className="right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {manifest.obligations.map((obligation) => (
                    <tr key={obligation.obligationId}>
                      <td>
                        <strong style={{ fontWeight: 600 }}>{obligation.lineId}</strong>
                        <span style={{ display: 'block', fontSize: 12.5, color: 'var(--ink-3)' }}>
                          {obligation.recipientName ?? obligation.reference} · {obligation.environment === 'evm' ? 'EVM' : 'Native'}
                        </span>
                      </td>
                      <td style={{ maxWidth: 380 }}>
                        <span className="mono">{obligation.destination}</span>
                      </td>
                      <td className="right num" style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                        {formatBaseUnits(obligation.amountBaseUnits, obligation.decimals)} {obligation.symbol}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  {manifest.totals.map((total) => (
                    <tr key={total.assetId}>
                      <td colSpan={2}>
                        Total {total.symbol} ({total.count} line{total.count === 1 ? '' : 's'})
                      </td>
                      <td className="right num" style={{ whiteSpace: 'nowrap' }}>
                        {formatBaseUnits(total.amountBaseUnits, total.decimals)} {total.symbol}
                      </td>
                    </tr>
                  ))}
                </tfoot>
              </table>
            </div>
          </div>

          <div className="card">
            <h2 className="card-title">Version history</h2>
            <div className="queue" style={{ marginTop: 12 }}>
              {detail.versions.map((item) => (
                <div className="queue-row" key={item.id}>
                  <IconTile tone={item.status === 'approved' ? 'settled' : item.status === 'rejected' ? 'failed' : item.status === 'awaiting_approval' ? 'review' : undefined}>
                    <IconFile size={18} />
                  </IconTile>
                  <div className="queue-main">
                    <small>Frozen {dateTime(item.frozenAt)}</small>
                    <h3>
                      Version {item.version}, {item.status.replace('_', ' ')}
                    </h3>
                    <p className="mono">{item.digest}</p>
                    {item.decisions.map((decision) => (
                      <p key={decision.at}>
                        {decision.decision === 'approve' ? 'Approved' : 'Sent back'} in the app on {dateTime(decision.at)}
                        {decision.reason ? `: ${decision.reason}` : ''}
                      </p>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <aside className="stack">
          <div className="card">
            <h2 className="card-title">Fingerprint</h2>
            <p className="card-desc">SHA-256 of the canonical manifest. Change any line and this changes.</p>
            <div style={{ marginTop: 12, padding: 12, borderRadius: 12, background: 'var(--panel)' }}>
              <CopyText value={version.digest} />
            </div>
            <div style={{ marginTop: 14 }}>
              <KeyValue
                items={[
                  { label: 'Frozen', value: dateTime(version.frozenAt) },
                  ...(version.approvedAt ? [{ label: 'Approved', value: dateTime(version.approvedAt) }] : []),
                  ...(manifest.network.evm ? [{ label: 'EVM chain', value: <span className="num">{String((manifest.network.evm as { chainId: number }).chainId)}</span> }] : []),
                ]}
              />
            </div>
          </div>

          <div className="inset-list">
            {Object.entries(manifest.payers).map(([environment, payer]) => (
              <div className="inset" key={environment}>
                <IconTile>{environment === 'evm' ? <IconLayers size={18} /> : <IconChain size={18} />}</IconTile>
                <div className="inset-body">
                  <span>{environment === 'evm' ? 'EVM payout wallet' : 'Native payout wallet'}</span>
                  <p className="mono">{payer}</p>
                </div>
                <IconWallet size={18} />
              </div>
            ))}
          </div>

          {canDecide && (
            <div className="card-dark">
              <p style={{ color: '#fff', fontSize: 17, fontWeight: 600 }}>Your decision</p>
              <p style={{ marginTop: 6 }}>Approving lets operators prepare payments for this version. Nothing is sent until each wallet signs.</p>
              <Button variant="white" block busy={busy === 'approve'} onClick={() => void decide('approve')} style={{ marginTop: 16 }}>
                <IconCheck size={16} />
                Approve version {version.version}
              </Button>
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why it needs changes"
                aria-label="Rejection reason"
                className="input"
                style={{ marginTop: 12, background: 'rgba(255,255,255,.08)', borderColor: 'rgba(255,255,255,.14)', color: '#fff' }}
              />
              <Button variant="ghost" block busy={busy === 'reject'} disabled={!reason.trim()} onClick={() => void decide('reject')} style={{ marginTop: 8, color: '#fff' }}>
                <IconX size={16} />
                Send back to draft
              </Button>
            </div>
          )}
          {version.status === 'awaiting_approval' && !canDecide && <Notice tone="review">An owner or reviewer has to approve this version.</Notice>}
          {error && <Notice tone="failed">{error}</Notice>}
        </aside>
      </div>
    </div>
  );
}
