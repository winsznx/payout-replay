'use client';

import { IconAlert, IconCheck, IconDownload, IconFile, IconLayers } from '@/components/icons';
import { CopyText, Empty, IconTile, KeyValue, PageHead, StatusPill } from '@/components/ui';
import { groupDecimal, timeAgo } from '@/lib/format';
import { useRun } from '@/lib/run-context';
import type { ObligationStatus } from '@/lib/types';

const ORDER: ObligationStatus[] = [
  'paid_verified',
  'failed_verified',
  'incorrect',
  'needs_review',
  'confirming',
  'submitted',
  'awaiting_signature',
  'approved_unattempted',
  'manually_resolved',
];

export default function ExportPage() {
  const { runId, detail } = useRun();
  const summary = detail?.summary;
  if (!summary) {
    return (
      <div className="page">
        <Empty icon={<IconFile size={20} />} title="Nothing to export yet">
          Approve a version first. The export follows the approved sheet line by line.
        </Empty>
      </div>
    );
  }
  const complete = detail.run.status === 'complete';
  const unsettled = summary.counts.total - summary.counts.paid_verified;
  const downloads = [
    {
      href: `/api/v1/runs/${runId}/export.csv`,
      icon: <IconFile size={20} />,
      title: 'Reconciled payout sheet',
      body: 'Your original rows with status, transaction, block and exception columns. Base units stay as text, so nothing is rounded.',
    },
    {
      href: `/api/v1/runs/${runId}/exceptions.csv`,
      icon: <IconAlert size={20} />,
      title: 'Exceptions register',
      body: `${summary.exceptions} recorded discrepancies, including wrong amounts, unknown outcomes and duplicates.`,
    },
    {
      href: `/api/v1/runs/${runId}/evidence.json`,
      icon: <IconLayers size={20} />,
      title: 'Evidence package',
      body: 'Manifest, approvals, attempts, RPC observations and known limitations, for independent re-verification.',
    },
  ];

  return (
    <div className="page">
      <PageHead
        title={complete ? 'Every line is verified on-chain' : `${unsettled} of ${summary.counts.total} lines are not verified paid`}
        description="The export is your approved sheet, one row per line, with the status and the proof the chain gave for it."
      />
      <div className="split">
        <div className="stack">
          <div className={complete ? 'notice notice-settled' : 'notice notice-review'} style={{ padding: 20 }}>
            <IconTile tone={complete ? 'settled' : 'review'}>{complete ? <IconCheck size={20} /> : <IconAlert size={20} />}</IconTile>
            <div>
              <strong style={{ fontSize: 16 }}>{complete ? 'Complete' : 'Incomplete run'}</strong>
              <p>
                {complete
                  ? 'Each line matched a finalised transfer from your payout wallet with the exact recipient, asset and amount.'
                  : 'You can still export. Unsettled lines keep their real status and reason, and are never shown as paid.'}
              </p>
            </div>
          </div>

          <div className="card">
            <h2 className="card-title">Downloads</h2>
            <div className="app-list" style={{ margin: '8px 0 0' }}>
              {downloads.map((item) => (
                <div className="app-row" key={item.href}>
                  <span className="icon-tile">{item.icon}</span>
                  <div className="app-row-body">
                    <strong>{item.title}</strong>
                    <span style={{ whiteSpace: 'normal' }}>{item.body}</span>
                  </div>
                  <a className="icon-btn" href={item.href} aria-label={`Download ${item.title}`}>
                    <IconDownload size={18} />
                  </a>
                </div>
              ))}
            </div>
          </div>

          <div className="table-card">
            <table className="table" aria-label="Totals by asset">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th className="right">Approved</th>
                  <th className="right">Verified paid</th>
                  <th className="right">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {summary.partition.map((part) => (
                  <tr key={part.assetId}>
                    <td>
                      <strong style={{ fontWeight: 600 }}>{part.symbol}</strong>
                      <span style={{ display: 'block', fontSize: 12.5, color: 'var(--ink-3)' }}>{part.environment === 'evm' ? 'EVM token' : 'Native'}</span>
                    </td>
                    <td className="right num">{groupDecimal(part.total)}</td>
                    <td className="right num" style={{ color: 'var(--settled)' }}>
                      {groupDecimal(part.verified)}
                    </td>
                    <td className="right num" style={{ fontWeight: 600 }}>
                      {groupDecimal(part.outstanding)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="stack">
          <div className="card">
            <h2 className="card-title">Lines by status</h2>
            <div className="stack" style={{ gap: 8, marginTop: 12 }}>
              {ORDER.filter((status) => summary.counts[status] > 0).map((status) => (
                <div key={status} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <StatusPill status={status} />
                  <span className="num" style={{ fontWeight: 600 }}>
                    {summary.counts[status]}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <h2 className="card-title">Provenance</h2>
            <div style={{ marginTop: 12 }}>
              <KeyValue
                items={[
                  { label: 'Version', value: <span className="num">{summary.manifestVersion}</span> },
                  { label: 'Digest', value: <CopyText value={summary.manifestDigest} /> },
                  { label: 'Last checked', value: timeAgo(summary.lastVerifiedAt) },
                ]}
              />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
