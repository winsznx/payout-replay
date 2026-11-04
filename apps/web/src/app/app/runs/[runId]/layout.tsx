'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { Notice, RunStatusMark, Skeleton } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { RUN_STATUS_LABEL, timeAgo } from '@/lib/format';
import { RunProvider, useRun } from '@/lib/run-context';

const STEPS = [
  { slug: 'review', label: 'Review and approve' },
  { slug: 'execute', label: 'Execute' },
  { slug: 'live', label: 'Settlement' },
  { slug: 'recover', label: 'Recover' },
  { slug: 'export', label: 'Export' },
] as const;

function stepAvailable(slug: (typeof STEPS)[number]['slug'], status: string, hasVersion: boolean): boolean {
  if (slug === 'review') return hasVersion;
  return !['draft', 'validated', 'awaiting_approval'].includes(status);
}

function RunFrame({ children }: { children: ReactNode }) {
  const { runId, detail, error } = useRun();
  const pathname = usePathname();
  if (error) return <Notice tone="failed" title="This run could not be loaded">{errorMessage(error)}</Notice>;
  if (!detail) return <Skeleton rows={6} />;
  const { run } = detail;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-3">
        <Link href="/app" className="hover:text-ink">
          Payout runs
        </Link>
        <span aria-hidden>/</span>
        <span className="text-ink-2">{run.name}</span>
        <RunStatusMark status={run.status} label={RUN_STATUS_LABEL[run.status] ?? run.status} />
        {run.currentVersion > 0 && <span>Version {run.currentVersion}</span>}
        <span>Last verified {timeAgo(run.lastReconciledAt)}</span>
      </div>
      <nav aria-label="Run steps" className="mt-4 mb-6 overflow-x-auto">
        <ol className="flex min-w-max border-b border-rule">
          <li>
            <Link
              href={`/app/runs/new?run=${runId}`}
              className="block border-b-2 border-transparent px-3 py-2 text-[14px] text-ink-2 hover:text-ink"
            >
              <span className="num mr-1.5 text-ink-3">1</span>Import
            </Link>
          </li>
          {STEPS.map((step, index) => {
            const href = `/app/runs/${runId}/${step.slug}`;
            const active = pathname === href;
            const available = stepAvailable(step.slug, run.status, Boolean(detail.latestVersion));
            return (
              <li key={step.slug}>
                {available ? (
                  <Link
                    href={href}
                    aria-current={active ? 'step' : undefined}
                    className={`block border-b-2 px-3 py-2 text-[14px] ${active ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}
                  >
                    <span className="num mr-1.5 text-ink-3">{index + 2}</span>
                    {step.label}
                  </Link>
                ) : (
                  <span className="block border-b-2 border-transparent px-3 py-2 text-[14px] text-ink-3" aria-disabled="true">
                    <span className="num mr-1.5">{index + 2}</span>
                    {step.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      {children}
    </div>
  );
}

export default function RunLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ runId: string }>();
  return (
    <RunProvider runId={params.runId}>
      <RunFrame>{children}</RunFrame>
    </RunProvider>
  );
}
