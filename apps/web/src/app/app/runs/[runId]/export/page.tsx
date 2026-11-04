'use client';

import { CopyText, KeyValue, Notice, PageHeader, Section, StatusMark } from '@/components/ui';
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
  if (!summary) return <Notice>Approve a version before exporting.</Notice>;
  const complete = detail.run.status === 'complete';
  const unsettled = summary.counts.total - summary.counts.paid_verified;

  return (
    <div className="max-w-5xl">
      <PageHeader
        title={complete ? 'Every line is verified on-chain' : `${unsettled} of ${summary.counts.total} lines are not verified paid`}
        description="The export is your original sheet, one row per approved line, with the status and the proof the chain gave for it."
      />
      {!complete && (
        <div className="mt-6">
          <Notice tone="review" title="This run is not complete">
            You can still export. Unsettled lines keep their real status and reason, and they are never shown as paid.
          </Notice>
        </div>
      )}

      <Section title="Counts by status">
        <ul className="grid gap-2 sm:grid-cols-2">
          {ORDER.filter((status) => summary.counts[status] > 0).map((status) => (
            <li key={status} className="flex items-center justify-between border-b border-rule py-1.5">
              <StatusMark status={status} />
              <span className="num text-[15px]">{summary.counts[status]}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Totals by asset" description="Assets are never added together; each has its own decimals.">
        <table className="w-full max-w-2xl text-[14px]">
          <thead>
            <tr className="text-left text-ink-3">
              <th className="py-1 font-normal">Asset</th>
              <th className="py-1 text-right font-normal">Approved</th>
              <th className="py-1 text-right font-normal">Verified paid</th>
              <th className="py-1 text-right font-normal">Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {summary.partition.map((part) => (
              <tr key={part.assetId} className="border-t border-rule">
                <td className="py-1.5">{part.symbol}</td>
                <td className="num py-1.5 text-right">{groupDecimal(part.total)}</td>
                <td className="num py-1.5 text-right text-settled">{groupDecimal(part.verified)}</td>
                <td className="num py-1.5 text-right font-semibold">{groupDecimal(part.outstanding)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Downloads">
        <ul className="space-y-3 text-[15px]">
          <li>
            <a className="font-medium text-accent underline" href={`/api/v1/runs/${runId}/export.csv`}>
              Reconciled payout sheet (CSV)
            </a>
            <span className="block text-[13px] text-ink-3">Opens in Excel and Google Sheets. Base-unit amounts are text, so nothing is rounded.</span>
          </li>
          <li>
            <a className="font-medium text-accent underline" href={`/api/v1/runs/${runId}/exceptions.csv`}>
              Exceptions (CSV)
            </a>
            <span className="block text-[13px] text-ink-3">{summary.exceptions} recorded discrepancies, including wrong amounts, unknown outcomes and duplicates.</span>
          </li>
          <li>
            <a className="font-medium text-accent underline" href={`/api/v1/runs/${runId}/evidence.json`}>
              Evidence package (JSON)
            </a>
            <span className="block text-[13px] text-ink-3">Manifest, approvals, attempts, RPC observations and known limitations, for independent re-verification.</span>
          </li>
        </ul>
      </Section>

      <Section title="Provenance">
        <KeyValue
          items={[
            { label: 'Manifest version', value: <span className="num">{summary.manifestVersion}</span> },
            { label: 'Manifest digest', value: <CopyText value={summary.manifestDigest} /> },
            { label: 'Last verified', value: timeAgo(summary.lastVerifiedAt) },
          ]}
        />
      </Section>
    </div>
  );
}
