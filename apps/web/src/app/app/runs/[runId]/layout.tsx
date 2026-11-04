'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { Notice, RunStatusPill, Skeleton, TopBar } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { RunProvider, useRun } from '@/lib/run-context';

const STEPS = [
  { slug: 'review', label: 'Review' },
  { slug: 'execute', label: 'Execute' },
  { slug: 'live', label: 'Settlement' },
  { slug: 'recover', label: 'Recover' },
  { slug: 'export', label: 'Export' },
] as const;

function available(slug: (typeof STEPS)[number]['slug'], status: string, frozen: boolean): boolean {
  if (slug === 'review') return frozen;
  return !['draft', 'validated', 'awaiting_approval'].includes(status);
}

function RunFrame({ children }: { children: ReactNode }) {
  const { runId, detail, error } = useRun();
  const pathname = usePathname();

  if (error) {
    return (
      <div className="page">
        <Notice tone="failed" title="This run could not be loaded">
          {errorMessage(error)}
        </Notice>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="page">
        <Skeleton rows={4} height={90} />
      </div>
    );
  }

  const { run } = detail;
  return (
    <>
      <TopBar
        crumbs={[{ label: 'Payout runs', href: '/app' }, { label: run.name }]}
        actions={
          <>
            <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>Checked {timeAgo(run.lastReconciledAt)}</span>
            <RunStatusPill status={run.status} />
          </>
        }
      />
      <div className="page" style={{ paddingBottom: 0 }}>
        <nav aria-label="Run steps" className="filter-pills">
          <Link href={`/app/runs/new?run=${runId}`}>
            <span className="step-num">01</span>Import
          </Link>
          {STEPS.map((step, index) => {
            const href = `/app/runs/${runId}/${step.slug}`;
            const number = String(index + 2).padStart(2, '0');
            return available(step.slug, run.status, Boolean(detail.latestVersion)) ? (
              <Link key={step.slug} href={href} aria-current={pathname === href ? 'step' : undefined}>
                <span className="step-num">{number}</span>
                {step.label}
              </Link>
            ) : (
              <span key={step.slug} aria-disabled="true">
                <span className="step-num">{number}</span>
                {step.label}
              </span>
            );
          })}
        </nav>
      </div>
      {children}
    </>
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
