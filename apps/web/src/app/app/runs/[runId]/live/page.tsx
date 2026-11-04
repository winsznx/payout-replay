'use client';

import { type FormEvent, useState } from 'react';

import { IconChain, IconExternal, IconLayers, IconRefresh } from '@/components/icons';
import { Button, CopyText, IconTile, KeyValue, Notice, PageHead, STATUS, Skeleton, StatTile, StatusPill, Trail } from '@/components/ui';
import { apiPost, errorMessage } from '@/lib/api';
import { dateTime, groupDecimal, timeAgo } from '@/lib/format';
import { useRun } from '@/lib/run-context';
import type { AttemptView, LineView } from '@/lib/types';

const OUTCOME: Record<string, string> = {
  not_broadcast: 'Not broadcast',
  pending: 'Waiting for inclusion',
  included: 'In a block, not final yet',
  finalized_success: 'Final, succeeded',
  finalized_failure: 'Final, failed',
  unknown: 'Outcome unknown',
};

const SOURCE: Record<AttemptView['source'], string> = {
  app: 'Signed in Payout Replay',
  imported: 'Attached transaction',
  chain_scan: 'Found on-chain by obligation ID',
};

function AttemptEvidence({ attempt }: { attempt: AttemptView }) {
  const outcome = attempt.outcome;
  const detail = 'detail' in outcome ? outcome.detail : null;
  const tone = outcome.kind === 'finalized_success' ? 'settled' : outcome.kind === 'finalized_failure' ? 'failed' : outcome.kind === 'unknown' ? 'review' : 'waiting';
  return (
    <div className="inset" style={{ alignItems: 'flex-start', background: '#fff' }}>
      <span className={`pill tone-${tone}`} style={{ flexShrink: 0 }}>
        #{attempt.attemptNumber}
      </span>
      <div className="inset-body">
        <span>{SOURCE[attempt.source]}</span>
        <strong style={{ fontSize: 15 }}>{OUTCOME[outcome.kind] ?? outcome.kind}</strong>
        {detail && <p>{detail}</p>}
        <div style={{ marginTop: 10 }}>
          <KeyValue
            items={[
              ...(attempt.txHash
                ? [
                    {
                      label: 'Transaction',
                      value: (
                        <>
                          <CopyText value={attempt.txHash} />
                          {attempt.explorerUrl && (
                            <a href={attempt.explorerUrl} target="_blank" rel="noreferrer" style={{ marginLeft: 8, color: 'var(--accent)' }}>
                              Explorer <IconExternal size={13} style={{ verticalAlign: '-2px' }} />
                            </a>
                          )}
                        </>
                      ),
                    },
                  ]
                : []),
              ...(attempt.blockNumber
                ? [{ label: 'Block', value: <span><span className="num">#{attempt.blockNumber}</span> <span className="mono">{attempt.blockHash}</span></span> }]
                : []),
              ...(attempt.extrinsicIndex !== null ? [{ label: 'Extrinsic index', value: <span className="num">{attempt.extrinsicIndex}</span> }] : []),
              ...(attempt.logIndex !== null ? [{ label: 'Log index', value: <span className="num">{attempt.logIndex}</span> }] : []),
              ...(attempt.nonce !== null ? [{ label: 'Nonce', value: <span className="num">{attempt.nonce}</span> }] : []),
              {
                label: 'Observed',
                value: attempt.observedAt ? `${dateTime(attempt.observedAt)} via ${attempt.provider ?? 'RPC'}${attempt.finalized ? ', finalised' : ''}` : 'Not yet',
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

function AttachTransaction({ runId, line, onDone }: { runId: string; line: LineView; onDone(): void }) {
  const [txHash, setTxHash] = useState('');
  const [blockHash, setBlockHash] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/runs/${runId}/external-transactions`, { obligationId: line.obligationId, txHash, ...(blockHash ? { blockHash } : {}) });
      setTxHash('');
      setBlockHash('');
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="card" style={{ padding: 16 }}>
      <p className="card-title" style={{ fontSize: 14 }}>Paid outside Payout Replay?</p>
      <p className="card-desc">Attach the transaction. It counts only after the chain confirms payer, recipient, asset and exact amount.</p>
      <div className="stack" style={{ gap: 8, marginTop: 10 }}>
        <input required pattern="0x[0-9a-fA-F]{64}" value={txHash} onChange={(event) => setTxHash(event.target.value.trim())} placeholder="Transaction hash" aria-label="Transaction hash" className="input mono" />
        {line.environment === 'native' && (
          <input required pattern="0x[0-9a-fA-F]{64}" value={blockHash} onChange={(event) => setBlockHash(event.target.value.trim())} placeholder="Block hash it was included in" aria-label="Block hash" className="input mono" />
        )}
        <Button type="submit" variant="secondary" busy={busy}>
          Attach transaction
        </Button>
        {error && <Notice tone="failed">{error}</Notice>}
      </div>
    </form>
  );
}

function ResolveManually({ runId, line, onDone }: { runId: string; line: LineView; onDone(): void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/runs/${runId}/resolutions`, { obligationId: line.obligationId, reason });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="card" style={{ padding: 16 }}>
      <p className="card-title" style={{ fontSize: 14 }}>Close this line by hand</p>
      <p className="card-desc">Recorded as resolved manually, never as paid, and never used to approve a payment.</p>
      <div className="stack" style={{ gap: 8, marginTop: 10 }}>
        <input required minLength={10} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="What happened and where the proof is" aria-label="Resolution reason" className="input" />
        <Button type="submit" variant="danger" busy={busy}>
          Resolve manually
        </Button>
        {error && <Notice tone="failed">{error}</Notice>}
      </div>
    </form>
  );
}

function LineCard({ line, runId, canImport, canResolve, onChange }: { line: LineView; runId: string; canImport: boolean; canResolve: boolean; onChange(): void }) {
  const [open, setOpen] = useState(false);
  const tone = STATUS[line.status].tone;
  const unresolved = !['paid_verified', 'manually_resolved'].includes(line.status);
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', background: open ? 'var(--panel)' : '#fff' }}>
      <div className="queue-row" style={{ border: 0, borderRadius: 0, background: 'transparent' }}>
        <IconTile tone={tone}>{line.environment === 'evm' ? <IconLayers size={18} /> : <IconChain size={18} />}</IconTile>
        <div className="queue-main">
          <small>{line.recipientName ?? line.reference}</small>
          <h3>{line.lineId}</h3>
          <p style={{ overflowWrap: 'anywhere' }}>{line.explanation}</p>
          {line.exceptions.map((exception, index) => (
            <p key={`${exception.type}-${index}`} style={{ color: exception.severity === 'critical' ? 'var(--failed)' : 'var(--review)' }}>
              {exception.message}
            </p>
          ))}
        </div>
        <div className="queue-side">
          <span className="amount num">
            {groupDecimal(line.amount)}
            <small>{line.symbol}</small>
          </span>
          <Trail line={line} />
          <StatusPill status={line.status} />
          <Button variant="soft" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide proof' : 'Show proof'}
          </Button>
        </div>
      </div>
      {open && (
        <div style={{ padding: '4px 16px 18px', display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
          <div className="stack" style={{ gap: 12 }}>
            <div className="card" style={{ padding: 16 }}>
              <Trail line={line} labels />
              <div style={{ marginTop: 14 }}>
                <KeyValue
                  items={[
                    { label: 'Obligation ID', value: <CopyText value={line.obligationId} /> },
                    { label: 'Destination', value: <CopyText value={line.destination} /> },
                    { label: 'Payer', value: <CopyText value={line.payer} /> },
                    { label: 'Base units', value: <span className="num">{line.amountBaseUnits}</span> },
                  ]}
                />
              </div>
            </div>
            {unresolved && canImport && <AttachTransaction runId={runId} line={line} onDone={onChange} />}
            {unresolved && canResolve && line.status !== 'approved_unattempted' && <ResolveManually runId={runId} line={line} onDone={onChange} />}
          </div>
          <div className="stack" style={{ gap: 10 }}>
            {line.attempts.length === 0 ? (
              <p style={{ color: 'var(--ink-3)', fontSize: 13.5 }}>No attempts yet.</p>
            ) : (
              line.attempts.map((attempt) => <AttemptEvidence key={attempt.id} attempt={attempt} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SettlementPage() {
  const { runId, detail, lines, refresh } = useRun();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const summary = detail?.summary;

  const checkNow = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      await apiPost(`/runs/${runId}/reconcile`, {});
      await refresh();
    } catch (caught) {
      setCheckError(errorMessage(caught));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="page">
      <PageHead
        title="Settlement"
        description={`What the chain says about every approved line. Last checked ${timeAgo(detail?.run.lastReconciledAt)}.`}
        actions={
          <Button variant="primary" onClick={() => void checkNow()} busy={checking}>
            <IconRefresh size={16} />
            Check the chain now
          </Button>
        }
      />
      {checkError && (
        <div style={{ marginBottom: 16 }}>
          <Notice tone="failed" title="Verification unavailable">
            {checkError}. Lines keep their last known state; nothing is assumed paid or failed.
          </Notice>
        </div>
      )}

      {summary && (
        <>
          <h2 className="section-title" style={{ marginTop: 0 }}>
            Where the money stands <span>Each asset on its own</span>
          </h2>
          <div className="tiles">
            {summary.partition.map((part) => (
              <StatTile
                key={part.assetId}
                icon={part.environment === 'evm' ? <IconLayers size={20} /> : <IconChain size={20} />}
                tone={part.outstanding === '0' ? 'settled' : undefined}
                label={`${part.symbol} outstanding`}
                value={groupDecimal(part.outstanding)}
                sub={{ tone: 'settled', label: `Verified paid of ${groupDecimal(part.total)}`, value: groupDecimal(part.verified) }}
              />
            ))}
            <StatTile
              icon={<IconRefresh size={20} />}
              tone={summary.counts.needs_review > 0 ? 'review' : undefined}
              label="Lines verified"
              value={`${summary.counts.paid_verified} / ${summary.counts.total}`}
              sub={{ tone: 'review', label: 'Needs review', value: summary.counts.needs_review + summary.counts.incorrect }}
            />
          </div>
        </>
      )}

      <h2 className="section-title">Lines</h2>
      {!lines ? (
        <Skeleton rows={3} height={84} />
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {lines.map((line) => (
            <LineCard
              key={line.obligationId}
              line={line}
              runId={runId}
              canImport={detail?.role === 'owner' || detail?.role === 'operator'}
              canResolve={detail?.role === 'owner'}
              onChange={() => void refresh()}
            />
          ))}
        </div>
      )}
    </div>
  );
}
