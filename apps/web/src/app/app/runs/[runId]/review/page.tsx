'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button, CopyText, KeyValue, Notice, PageHeader, Section, Table, td, th } from '@/components/ui';
import { apiPost, errorMessage } from '@/lib/api';
import { dateTime, formatBaseUnits } from '@/lib/format';
import { useRun } from '@/lib/run-context';

export default function ReviewPage() {
  const { runId, detail, refresh } = useRun();
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!detail?.latestVersion?.manifest) return <Notice title="Nothing frozen yet">Import and freeze a sheet first.</Notice>;

  const version = detail.latestVersion;
  const manifest = version.manifest!;
  const canDecide = version.status === 'awaiting_approval' && (detail.role === 'owner' || detail.role === 'reviewer');

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
    <div className="max-w-6xl">
      <PageHeader
        title={`Version ${version.version} ${version.status === 'approved' ? 'is approved' : version.status === 'awaiting_approval' ? 'is waiting for approval' : `is ${version.status}`}`}
        description="Approval is recorded in this app, against this exact fingerprint. It does not send funds; every payment still needs the payout wallet's own signature."
      />

      <Section title="Fingerprint">
        <KeyValue
          items={[
            { label: 'Manifest digest', value: <CopyText value={version.digest} /> },
            { label: 'Frozen', value: dateTime(version.frozenAt) },
            ...(version.approvedAt ? [{ label: 'Approved', value: dateTime(version.approvedAt) }] : []),
            ...Object.entries(manifest.payers).map(([environment, payer]) => ({
              label: environment === 'evm' ? 'EVM payout wallet' : 'Native payout wallet',
              value: <CopyText value={payer} />,
            })),
            ...(manifest.network.evm ? [{ label: 'EVM chain', value: <span className="num">{String((manifest.network.evm as { chainId: number }).chainId)}</span> }] : []),
            ...(manifest.network.native
              ? [{ label: 'Native genesis', value: <CopyText value={String((manifest.network.native as { genesisHash: string }).genesisHash)} /> }]
              : []),
          ]}
        />
      </Section>

      <Section title={`${manifest.obligations.length} obligations`}>
        <Table label="Frozen obligations">
          <thead>
            <tr>
              <th className={th}>Line ID</th>
              <th className={th}>Recipient</th>
              <th className={th}>Destination</th>
              <th className={`${th} text-right`}>Amount</th>
              <th className={th}>Reference</th>
            </tr>
          </thead>
          <tbody>
            {manifest.obligations.map((obligation) => (
              <tr key={obligation.obligationId}>
                <td className={`${td} font-medium`}>{obligation.lineId}</td>
                <td className={td}>{obligation.recipientName ?? ''}</td>
                <td className={`${td} max-w-[30ch]`}>
                  <span className="text-[12px] text-ink-3">{obligation.environment === 'evm' ? 'EVM' : 'Native'}</span>
                  <span className="hash block">{obligation.destination}</span>
                </td>
                <td className={`${td} num text-right whitespace-nowrap`}>
                  {formatBaseUnits(obligation.amountBaseUnits, obligation.decimals)} {obligation.symbol}
                </td>
                <td className={td}>{obligation.reference}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {manifest.totals.map((total) => (
              <tr key={total.assetId}>
                <td className="px-3 py-2 text-ink-2" colSpan={3}>
                  Total {total.symbol} ({total.count} lines)
                </td>
                <td className="num px-3 py-2 text-right font-semibold whitespace-nowrap">
                  {formatBaseUnits(total.amountBaseUnits, total.decimals)} {total.symbol}
                </td>
                <td />
              </tr>
            ))}
          </tfoot>
        </Table>
      </Section>

      {canDecide && (
        <Section title="Decision">
          <div className="flex flex-wrap items-start gap-3">
            <Button variant="primary" busy={busy === 'approve'} onClick={() => void decide('approve')}>
              Approve version {version.version}
            </Button>
            <div className="flex flex-wrap items-start gap-2">
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why it needs changes"
                className="w-72 rounded-[5px] border border-rule-strong bg-surface px-3 py-1.5 text-[14px]"
                aria-label="Rejection reason"
              />
              <Button variant="danger" busy={busy === 'reject'} disabled={!reason.trim()} onClick={() => void decide('reject')}>
                Send back to draft
              </Button>
            </div>
          </div>
        </Section>
      )}
      {version.status === 'awaiting_approval' && !canDecide && (
        <div className="mt-6">
          <Notice>An owner or reviewer must approve this version.</Notice>
        </div>
      )}
      {error && (
        <div className="mt-4">
          <Notice tone="failed">{error}</Notice>
        </div>
      )}

      <Section title="Version history">
        <ul className="space-y-2 text-[14px]">
          {detail.versions.map((item) => (
            <li key={item.id} className="border-b border-rule pb-2">
              <span className="font-medium">Version {item.version}</span> <span className="text-ink-3">{item.status}</span>
              <span className="hash block text-ink-2">{item.digest}</span>
              {item.decisions.map((decision) => (
                <span key={decision.at} className="block text-ink-3">
                  {decision.decision === 'approve' ? 'Approved' : 'Rejected'} off-chain by {decision.reviewerId} on {dateTime(decision.at)}
                  {decision.reason ? `: ${decision.reason}` : ''}
                </span>
              ))}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
