'use client';

import { useState } from 'react';

import { apiPost, errorMessage } from '@/lib/api';
import { formatBaseUnits, timeAgo } from '@/lib/format';
import { useRun } from '@/lib/run-context';
import type { RecoveryPlan } from '@/lib/types';

import { IconAlert, IconRefresh } from './icons';
import { PaymentCards, SigningStepper, usePaymentQueue } from './payment-queue';
import { Button, Empty, IconTile, Notice, STATUS } from './ui';

/**
 * Shared by Execute and Recover: build a plan from fresh chain state, show exactly what is
 * safe and what is blocked, and sign the safe lines one at a time.
 */
export function PlanPanel({ kind }: { kind: 'execution' | 'recovery' }) {
  const { runId, detail, lines, refresh } = useRun();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = detail?.latestPlan;
  const current =
    latest && latest.kind === kind && ['open', 'revalidated'].includes(latest.status) && Date.parse(latest.plan.expiresAt) > Date.now() ? latest : null;
  const queue = usePaymentQueue(runId, current?.id ?? '', () => void refresh());

  const statusById = new Map((lines ?? []).map((line) => [line.obligationId, line.status]));
  const stillSafe =
    current?.plan.eligible.filter((line) => {
      const status = statusById.get(line.obligationId);
      return status === undefined || status === 'approved_unattempted' || status === 'failed_verified';
    }) ?? [];

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

  const buildLabel = current ? 'Rebuild plan from the chain' : kind === 'execution' ? 'Build payment plan' : 'Build recovery plan';

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="inset" style={{ flexWrap: 'wrap' }}>
        <IconTile>
          <IconRefresh size={18} />
        </IconTile>
        <div className="inset-body">
          <span>{kind === 'execution' ? 'Payment plan' : 'Recovery plan'}</span>
          <strong style={{ fontSize: 16 }}>
            {current ? `Built ${timeAgo(current.plan.createdAt)}, expires ${timeAgo(current.plan.expiresAt)}` : latest && latest.kind === kind ? 'The last plan expired' : 'No plan yet'}
          </strong>
          <p>
            {kind === 'execution'
              ? 'The plan re-reads the chain first, so anything already attempted is held back.'
              : 'Only lines with no attempt, or where every attempt failed conclusively on-chain, can be paid again.'}
          </p>
        </div>
        <Button variant={current ? 'secondary' : 'primary'} busy={busy} onClick={() => void build()}>
          {buildLabel}
        </Button>
      </div>

      {error && <Notice tone="failed">{error}</Notice>}

      {current && (
        <div className="split">
          <div>
            <h2 className="section-title" style={{ marginTop: 0 }}>
              Safe to pay ({stillSafe.length}) <span className="mono">{current.plan.fingerprint.slice(0, 19)}…</span>
            </h2>
            {current.plan.eligible.length === 0 ? (
              <Empty title="Nothing is safe to pay right now">Every line is either paid, in flight, or waiting for a human decision.</Empty>
            ) : (
              <PaymentCards lines={current.plan.eligible} statusById={statusById} steps={queue.steps} busy={queue.busy} onPay={(line) => void queue.pay(line)} />
            )}
          </div>
          <aside className="stack">
            <SigningStepper line={queue.activeLine} step={queue.activeLine ? queue.steps[queue.activeLine.obligationId] : undefined} />
            <div className="card">
              <h2 className="card-title">Blocked ({current.plan.blocked.length})</h2>
              <p className="card-desc">Never offered for payment, each with the reason.</p>
              <div className="queue" style={{ marginTop: 12 }}>
                {current.plan.blocked.length === 0 && <p style={{ fontSize: 13.5, color: 'var(--ink-3)' }}>Nothing is blocked.</p>}
                {current.plan.blocked.map((line) => {
                  const obligation = detail?.latestVersion?.manifest?.obligations.find((item) => item.obligationId === line.obligationId);
                  const meta = STATUS[line.status];
                  return (
                    <div className="queue-row" key={line.obligationId} style={{ alignItems: 'flex-start' }}>
                      <IconTile tone={meta.tone}>
                        <IconAlert size={16} />
                      </IconTile>
                      <div className="queue-main">
                        <small>{meta.label}</small>
                        <h3>
                          {line.lineId}
                          {obligation && (
                            <span className="num" style={{ fontWeight: 500, color: 'var(--ink-2)', marginLeft: 8, fontSize: 14 }}>
                              {formatBaseUnits(obligation.amountBaseUnits, obligation.decimals)} {obligation.symbol}
                            </span>
                          )}
                        </h3>
                        <p>{line.reason}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
