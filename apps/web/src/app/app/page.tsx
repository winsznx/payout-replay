'use client';

import Link from 'next/link';
import useSWR from 'swr';

import { IconAlert, IconArrowRight, IconChain, IconCheck, IconLayers, IconPlus, IconRuns, IconUpload, IconWallet } from '@/components/icons';
import { ButtonLink, Empty, IconTile, Module, Notice, PageHead, RUN_STATUS, RunStatusPill, Skeleton, StatTile, TopBar } from '@/components/ui';
import { apiGet, errorMessage, fetcher } from '@/lib/api';
import { formatBaseUnits, timeAgo } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { ChainHealth, Run, RunDetail } from '@/lib/types';

const NEXT_ACTION: Record<string, string> = {
  draft: 'Fix the sheet and validate it',
  validated: 'Freeze a version for review',
  awaiting_approval: 'Review and approve the frozen version',
  approved: 'Sign the approved payments',
  executing: 'Finish signing and watch settlement',
  reconciling: 'Waiting for finality on submitted lines',
  recovering: 'Sign the safe corrections',
  incomplete: 'Recover the lines that failed on-chain',
  needs_review: 'Some lines have an outcome nobody can prove yet',
  complete: 'Every line verified. Export the sheet',
};

function useRunDetails(runs: Run[] | undefined) {
  const key = runs && runs.length > 0 ? ['run-details', ...runs.map((run) => run.id)] : null;
  return useSWR(key, async () => Promise.all(runs!.map((run) => apiGet<RunDetail>(`/runs/${run.id}`))), { refreshInterval: 20_000 });
}

export default function Dashboard() {
  const { orgId, org } = useSession();
  const { data: runs, error } = useSWR<Run[]>(orgId ? `/orgs/${orgId}/runs` : null, fetcher, { refreshInterval: 15_000 });
  const { data: details } = useRunDetails(runs);
  const { data: health } = useSWR<ChainHealth>('/health/chain', (path: string) => fetch(path).then((response) => response.json() as Promise<ChainHealth>), {
    refreshInterval: 30_000,
  });

  const summaries = (details ?? []).flatMap((detail) => (detail.summary ? [detail.summary] : []));
  const totalLines = summaries.reduce((sum, summary) => sum + summary.counts.total, 0);
  const paidLines = summaries.reduce((sum, summary) => sum + summary.counts.paid_verified, 0);
  const reviewLines = summaries.reduce((sum, summary) => sum + summary.counts.needs_review + summary.counts.incorrect, 0);
  const failedLines = summaries.reduce((sum, summary) => sum + summary.counts.failed_verified, 0);
  const attention = runs?.filter((run) => ['needs_review', 'incomplete', 'awaiting_approval'].includes(run.status)) ?? [];
  const awaitingApproval = runs?.filter((run) => run.status === 'awaiting_approval').length ?? 0;

  const outstanding = new Map<string, { symbol: string; environment: string; decimals: number; outstanding: bigint; total: bigint; runs: number }>();
  for (const summary of summaries) {
    for (const part of summary.partition) {
      const current = outstanding.get(part.assetId) ?? { symbol: part.symbol, environment: part.environment, decimals: part.decimals, outstanding: 0n, total: 0n, runs: 0 };
      current.outstanding += BigInt(part.outstandingBaseUnits);
      current.total += BigInt(part.totalBaseUnits);
      current.runs += 1;
      outstanding.set(part.assetId, current);
    }
  }
  const verifiedNetworks = health ? [health.native, health.evm].filter((item) => item.capability === 'verified').length : null;

  return (
    <>
      <TopBar crumbs={[{ label: 'Payout runs' }]} actions={<ButtonLink href="/app/runs/new" variant="primary" size="sm"><IconPlus size={15} />New payout run</ButtonLink>} />
      <div className="page">
        <PageHead
          title={org?.name ?? 'Payout runs'}
          description="Every approved payout sheet, followed from approval to a settlement the chain can prove."
        />

        {error && <Notice tone="failed" title="Runs could not be loaded">{errorMessage(error)}</Notice>}

        <div className="tiles">
          <StatTile
            icon={<IconAlert size={20} />}
            tone={attention.length > 0 ? 'review' : undefined}
            label="Runs needing you"
            value={runs ? attention.length : '—'}
            sub={{ tone: 'review', label: 'Awaiting approval', value: awaitingApproval }}
            link={{ href: '#runs', label: 'See in details' }}
          />
          <StatTile
            icon={<IconCheck size={20} />}
            tone={paidLines > 0 ? 'settled' : undefined}
            label="Lines verified paid"
            value={details ? `${paidLines} / ${totalLines}` : '—'}
            sub={{ tone: 'settled', label: 'Approved runs', value: summaries.length }}
            link={{ href: '#runs', label: 'See in details' }}
          />
          <StatTile
            icon={<IconRuns size={20} />}
            label="Lines to resolve"
            value={details ? reviewLines + failedLines : '—'}
            sub={{ tone: 'failed', label: 'Failed on-chain, recoverable', value: failedLines }}
            link={{ href: '#runs', label: 'See in details' }}
          />
          <StatTile
            icon={<IconChain size={20} />}
            tone={verifiedNetworks === 2 ? 'settled' : verifiedNetworks === null ? undefined : 'review'}
            label="Portaldot V3 networks"
            value={verifiedNetworks === null ? '—' : `${verifiedNetworks} of 2 verified`}
            sub={{ tone: 'waiting', label: 'Native finalised', value: health?.native.finalizedBlock ? `#${health.native.finalizedBlock}` : '—' }}
            link={{ href: '/app/settings/wallets', label: 'See in details' }}
          />
        </div>

        <div className="modules">
          <Module title="Outstanding by asset" aside={<span>Never added across assets</span>}>
            {outstanding.size === 0 ? (
              <p style={{ color: 'var(--ink-3)', fontSize: 13.5 }}>Nothing approved yet. Totals appear once a version is approved.</p>
            ) : (
              <div className="inset-list">
                {[...outstanding.entries()].map(([assetId, item]) => (
                  <div className="inset" key={assetId}>
                    <IconTile tone={item.outstanding === 0n ? 'settled' : undefined}>{item.environment === 'evm' ? <IconLayers size={18} /> : <IconChain size={18} />}</IconTile>
                    <div className="inset-body">
                      <span>{item.symbol} {item.environment === 'evm' ? 'on EVM' : 'native'}</span>
                      <strong className="num">{formatBaseUnits(item.outstanding.toString(), item.decimals)}</strong>
                    </div>
                    <div className="inset-aside num">
                      of {formatBaseUnits(item.total.toString(), item.decimals)}
                      <br />
                      {item.runs} run{item.runs === 1 ? '' : 's'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Module>
          <Module title="Network evidence" aside={<Link href="/app/settings/wallets">Wallets and networks</Link>}>
            {!health ? (
              <Skeleton rows={2} height={70} />
            ) : (
              <div className="inset-list">
                {[health.native, health.evm].map((env) => (
                  <div className="inset" key={env.environment}>
                    <IconTile tone={env.capability === 'verified' ? 'settled' : env.capability === 'unavailable' ? 'failed' : 'review'}>
                      {env.environment === 'evm' ? <IconLayers size={18} /> : <IconChain size={18} />}
                    </IconTile>
                    <div className="inset-body">
                      <span>{env.environment === 'evm' ? 'EVM (pallet-revive)' : 'Native runtime'}</span>
                      <strong>{env.capability === 'verified' ? 'Verified' : env.capability === 'unavailable' ? 'Unavailable' : 'Not verified'}</strong>
                      <p>{env.detail}</p>
                    </div>
                    <div className="inset-aside num">
                      {env.finalizedBlock ? `#${env.finalizedBlock}` : ''}
                      <br />
                      {env.finalizedBlock ? 'finalised' : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Module>
        </div>

        <h2 className="section-title" id="runs">
          Runs <span>{runs ? `${runs.length} total` : ''}</span>
        </h2>
        {!runs && !error && <Skeleton rows={3} height={78} />}
        {runs && runs.length === 0 && (
          <Empty
            icon={<IconUpload size={20} />}
            title="No payout runs yet"
            actions={
              <>
                <ButtonLink href="/app/settings/wallets"><IconWallet size={16} />Register payout wallets</ButtonLink>
                <ButtonLink href="/app/runs/new" variant="primary"><IconUpload size={16} />Import a payout sheet</ButtonLink>
              </>
            }
          >
            Register the wallets you pay from, then import the sheet your team already approved. Payout Replay freezes it, helps you sign each line and tells you
            what the chain actually settled.
          </Empty>
        )}
        {runs && runs.length > 0 && (
          <div className="queue">
            {runs.map((run) => {
              const detail = details?.find((item) => item.run.id === run.id);
              const summary = detail?.summary;
              const tone = RUN_STATUS[run.status]?.tone ?? 'neutral';
              return (
                <Link key={run.id} href={`/app/runs/${run.id}`} className="queue-row">
                  <IconTile tone={tone}>
                    <IconRuns size={18} />
                  </IconTile>
                  <div className="queue-main">
                    <small>{run.currentVersion > 0 ? `Version ${run.currentVersion}` : 'Not frozen'}</small>
                    <h3>{run.name}</h3>
                    <p>{NEXT_ACTION[run.status] ?? ''}</p>
                  </div>
                  <div className="queue-side">
                    <span className="meta num">
                      {summary ? `${summary.counts.paid_verified} of ${summary.counts.total} verified` : ''}
                      <br />
                      {`Checked ${timeAgo(run.lastReconciledAt)}`}
                    </span>
                    <RunStatusPill status={run.status} />
                    <span className="icon-btn" aria-hidden>
                      <IconArrowRight size={16} />
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
