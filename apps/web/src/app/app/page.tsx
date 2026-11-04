'use client';

import Link from 'next/link';
import useSWR from 'swr';

import { ButtonLink, Notice, PageHeader, RunStatusMark, Section, Skeleton, Table, td, th } from '@/components/ui';
import { errorMessage, fetcher } from '@/lib/api';
import { RUN_STATUS_LABEL, groupDecimal, timeAgo } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { Run, RunDetail } from '@/lib/types';

const NEXT_ACTION: Record<string, string> = {
  draft: 'Fix the sheet and validate it',
  validated: 'Freeze a version for review',
  awaiting_approval: 'Review and approve',
  approved: 'Sign the payments',
  executing: 'Finish signing and watch settlement',
  reconciling: 'Wait for finality',
  recovering: 'Sign the corrections',
  incomplete: 'Recover the failed lines',
  needs_review: 'Review the uncertain lines',
  complete: 'Export the reconciled sheet',
};

function RunRow({ run }: { run: Run }) {
  const { data } = useSWR<RunDetail>(`/runs/${run.id}`, fetcher);
  const summary = data?.summary;
  return (
    <tr>
      <td className={td}>
        <Link href={`/app/runs/${run.id}`} className="font-medium text-ink underline-offset-2 hover:underline">
          {run.name}
        </Link>
        <span className="block text-[13px] text-ink-3">{NEXT_ACTION[run.status] ?? ''}</span>
      </td>
      <td className={td}>
        <RunStatusMark status={run.status} label={RUN_STATUS_LABEL[run.status] ?? run.status} />
      </td>
      <td className={`${td} num`}>{summary ? `${summary.counts.paid_verified} / ${summary.counts.total}` : '—'}</td>
      <td className={`${td} num`}>{summary ? summary.counts.needs_review + summary.counts.incorrect : '—'}</td>
      <td className={`${td} num whitespace-nowrap`}>
        {summary
          ? summary.partition
              .filter((part) => part.outstanding !== '0')
              .map((part) => (
                <span key={part.assetId} className="block">
                  {groupDecimal(part.outstanding)} {part.symbol}
                </span>
              ))
          : '—'}
        {summary && summary.partition.every((part) => part.outstanding === '0') && <span className="text-ink-3">none</span>}
      </td>
      <td className={`${td} text-[13px] text-ink-3`}>{timeAgo(run.lastReconciledAt)}</td>
    </tr>
  );
}

export default function RunsOverview() {
  const { orgId, org } = useSession();
  const { data: runs, error } = useSWR<Run[]>(orgId ? `/orgs/${orgId}/runs` : null, fetcher, { refreshInterval: 15_000 });
  const attention = runs?.filter((run) => ['needs_review', 'incomplete', 'awaiting_approval'].includes(run.status)) ?? [];

  return (
    <div className="max-w-7xl">
      <PageHeader
        title={org?.name ?? 'Payout runs'}
        description="Each run is one approved payout sheet, followed from approval to verified settlement."
        actions={
          <ButtonLink href="/app/runs/new" variant="primary">
            Import a payout sheet
          </ButtonLink>
        }
      />
      {error && (
        <div className="mt-6">
          <Notice tone="failed">{errorMessage(error)}</Notice>
        </div>
      )}
      {attention.length > 0 && (
        <div className="mt-6">
          <Notice tone="review" title={`${attention.length} run${attention.length === 1 ? '' : 's'} need${attention.length === 1 ? 's' : ''} you`}>
            {attention.map((run) => (
              <Link key={run.id} href={`/app/runs/${run.id}`} className="mr-3 underline">
                {run.name}: {NEXT_ACTION[run.status]}
              </Link>
            ))}
          </Notice>
        </div>
      )}
      <Section title="Runs">
        {!runs && !error && <Skeleton rows={3} />}
        {runs && runs.length === 0 && (
          <div className="border border-dashed border-rule-strong bg-surface px-6 py-10">
            <p className="text-[17px] font-medium">No payout runs yet</p>
            <p className="mt-1 max-w-[60ch] text-ink-2">
              Register your payout wallets, then import the sheet your team already approved. Payout Replay freezes it, helps you sign each transfer,
              and tells you which lines the chain actually settled.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <ButtonLink href="/app/settings/wallets">Register payout wallets</ButtonLink>
              <ButtonLink href="/app/runs/new" variant="primary">
                Import a payout sheet
              </ButtonLink>
            </div>
          </div>
        )}
        {runs && runs.length > 0 && (
          <Table label="Payout runs">
            <thead>
              <tr>
                <th className={th}>Run</th>
                <th className={th}>Status</th>
                <th className={th}>Verified paid</th>
                <th className={th}>Need review</th>
                <th className={th}>Outstanding</th>
                <th className={th}>Last verified</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </tbody>
          </Table>
        )}
      </Section>
    </div>
  );
}
