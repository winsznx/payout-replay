'use client';

import { useState } from 'react';

import { apiPost, errorMessage } from '@/lib/api';
import { formatBaseUnits, timeAgo } from '@/lib/format';
import { useRun } from '@/lib/run-context';
import type { RecoveryPlan } from '@/lib/types';

import { PaymentQueue } from './payment-queue';
import { Button, Notice, Section, StatusMark } from './ui';

/**
 * Shared by Execute and Recover: build a plan from fresh chain state, show
 * exactly what is safe and what is blocked, then hand the safe lines to the
 * signing queue. The plan expires; signing revalidates it line by line.
 */
export function PlanPanel({ kind }: { kind: 'execution' | 'recovery' }) {
  const { runId, detail, refresh } = useRun();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = detail?.latestPlan;
  const current = latest && ['open', 'revalidated'].includes(latest.status) && Date.parse(latest.plan.expiresAt) > Date.now() ? latest : null;

  const build = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost<{ planId: string; plan: RecoveryPlan }>(`/runs/${runId}/${kind === 'execution' ? 'execute/plan' : 'recovery-plans'}`, {});
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section
        title={kind === 'execution' ? 'Plan the payments' : 'Work out what is safe to pay again'}
        description={
          kind === 'execution'
            ? 'The plan re-reads the chain first, so anything already attempted is held back.'
            : 'Only lines with no attempt, or where every attempt failed conclusively on-chain, can be paid again. Anything uncertain stays blocked.'
        }
        actions={
          <Button variant={current ? 'secondary' : 'primary'} busy={busy} onClick={() => void build()}>
            {current ? 'Rebuild plan from the chain' : kind === 'execution' ? 'Build payment plan' : 'Build recovery plan'}
          </Button>
        }
      >
        {error && <Notice tone="failed">{error}</Notice>}
        {!current && !error && (
          <Notice>{latest ? `The last plan is ${latest.status === 'open' || latest.status === 'revalidated' ? 'expired' : latest.status}. Build a fresh one.` : 'No plan yet.'}</Notice>
        )}
        {current && (
          <p className="text-[13px] text-ink-3">
            Plan built {timeAgo(current.plan.createdAt)}, expires {timeAgo(current.plan.expiresAt)}. Fingerprint <span className="hash">{current.plan.fingerprint.slice(0, 23)}…</span>
          </p>
        )}
      </Section>

      {current && (
        <div className="mt-6 grid gap-8 xl:grid-cols-[3fr_2fr]">
          <div>
            <h2 className="mb-3 text-[17px] font-semibold">Safe to pay ({current.plan.eligible.length})</h2>
            <PaymentQueue runId={runId} planId={current.id} lines={current.plan.eligible} onChange={() => void refresh()} />
          </div>
          <div>
            <h2 className="mb-3 text-[17px] font-semibold">Blocked ({current.plan.blocked.length})</h2>
            {current.plan.blocked.length === 0 ? (
              <p className="text-[14px] text-ink-3">Nothing is blocked.</p>
            ) : (
              <ul className="divide-y divide-rule border border-rule bg-surface">
                {current.plan.blocked.map((line) => {
                  const obligation = detail?.latestVersion?.manifest?.obligations.find((item) => item.obligationId === line.obligationId);
                  return (
                    <li key={line.obligationId} className="space-y-1 px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{line.lineId}</span>
                        <StatusMark status={line.status} />
                      </div>
                      {obligation && (
                        <p className="num text-[14px] text-ink-2">
                          {formatBaseUnits(obligation.amountBaseUnits, obligation.decimals)} {obligation.symbol}
                        </p>
                      )}
                      <p className="text-[14px] text-ink-2">{line.reason}</p>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
}
