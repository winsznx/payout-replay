'use client';

import { type FormEvent, useState } from 'react';

import { Button, CopyText, Notice, PageHeader, Section, StatusMark, Table, TickTrail, td, th } from '@/components/ui';
import { apiPost, errorMessage } from '@/lib/api';
import { dateTime, groupDecimal, timeAgo } from '@/lib/format';
import { useRun } from '@/lib/run-context';
import type { AttemptView, LineView } from '@/lib/types';

const OUTCOME_LABEL: Record<string, string> = {
  not_broadcast: 'Not broadcast',
  pending: 'Waiting for inclusion',
  included: 'In a block, not final',
  finalized_success: 'Final, succeeded',
  finalized_failure: 'Final, failed',
  unknown: 'Outcome unknown',
};

function AttemptEvidence({ attempt }: { attempt: AttemptView }) {
  const outcome = attempt.outcome;
  const detail = 'detail' in outcome ? outcome.detail : null;
  return (
    <div className="border-l-2 border-rule-strong py-1 pl-3 text-[13px]">
      <p className="text-ink">
        Attempt {attempt.attemptNumber}
        {attempt.source === 'imported' ? ' (imported reference)' : attempt.source === 'chain_scan' ? ' (found on-chain by obligation ID)' : ''}:{' '}
        <span className="font-medium">{OUTCOME_LABEL[outcome.kind] ?? outcome.kind}</span>
        {detail ? <span className="text-ink-2">. {detail}</span> : null}
      </p>
      <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-ink-2">
        {attempt.txHash && (
          <>
            <dt className="text-ink-3">Transaction</dt>
            <dd className="min-w-0">
              <CopyText value={attempt.txHash} />
              {attempt.explorerUrl && (
                <a href={attempt.explorerUrl} target="_blank" rel="noreferrer" className="ml-2 text-accent underline">
                  Explorer
                </a>
              )}
            </dd>
          </>
        )}
        {attempt.blockNumber && (
          <>
            <dt className="text-ink-3">Block</dt>
            <dd className="min-w-0">
              <span className="num">#{attempt.blockNumber}</span> <span className="hash">{attempt.blockHash}</span>
            </dd>
          </>
        )}
        {attempt.extrinsicIndex !== null && (
          <>
            <dt className="text-ink-3">Extrinsic index</dt>
            <dd className="num">{attempt.extrinsicIndex}</dd>
          </>
        )}
        {attempt.logIndex !== null && (
          <>
            <dt className="text-ink-3">Log index</dt>
            <dd className="num">{attempt.logIndex}</dd>
          </>
        )}
        {attempt.nonce !== null && (
          <>
            <dt className="text-ink-3">Nonce</dt>
            <dd className="num">{attempt.nonce}</dd>
          </>
        )}
        <dt className="text-ink-3">Observed</dt>
        <dd>
          {attempt.observedAt ? `${dateTime(attempt.observedAt)} via ${attempt.provider ?? 'RPC'}` : 'not yet'}
          {attempt.finalized ? ', finalized' : ''}
        </dd>
      </dl>
    </div>
  );
}

function ImportTransaction({ runId, line, onDone }: { runId: string; line: LineView; onDone(): void }) {
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
    <form onSubmit={(event) => void submit(event)} className="mt-3 space-y-2">
      <p className="text-[13px] text-ink-3">Paid outside this app? Attach the transaction. It counts only after the chain verifies payer, recipient, asset and amount.</p>
      <div className="flex flex-wrap gap-2">
        <input
          required
          pattern="0x[0-9a-fA-F]{64}"
          value={txHash}
          onChange={(event) => setTxHash(event.target.value.trim())}
          placeholder="Transaction hash"
          className="w-[34ch] rounded border border-rule-strong bg-surface px-2 py-1 font-mono text-[13px]"
          aria-label="Transaction hash"
        />
        {line.environment === 'native' && (
          <input
            required
            pattern="0x[0-9a-fA-F]{64}"
            value={blockHash}
            onChange={(event) => setBlockHash(event.target.value.trim())}
            placeholder="Block hash it was included in"
            className="w-[34ch] rounded border border-rule-strong bg-surface px-2 py-1 font-mono text-[13px]"
            aria-label="Block hash"
          />
        )}
        <Button type="submit" busy={busy}>
          Attach transaction
        </Button>
      </div>
      {error && <p className="text-[13px] text-failed">{error}</p>}
    </form>
  );
}

function ManualResolve({ runId, line, onDone }: { runId: string; line: LineView; onDone(): void }) {
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
    <form onSubmit={(event) => void submit(event)} className="mt-3 space-y-2">
      <p className="text-[13px] text-ink-3">Owners can close a line by hand. It is recorded as resolved manually, never as paid, and never authorises a payment.</p>
      <div className="flex flex-wrap gap-2">
        <input
          required
          minLength={10}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="What happened and where the proof is"
          className="w-[46ch] rounded border border-rule-strong bg-surface px-2 py-1 text-[13px]"
          aria-label="Resolution reason"
        />
        <Button type="submit" variant="danger" busy={busy}>
          Resolve manually
        </Button>
      </div>
      {error && <p className="text-[13px] text-failed">{error}</p>}
    </form>
  );
}

export default function LivePage() {
  const { runId, detail, lines, refresh } = useRun();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
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
    <div className="max-w-7xl">
      <PageHeader
        title="Settlement"
        description={`What the chain says about every approved line. Last verified ${timeAgo(detail?.run.lastReconciledAt)}.`}
        actions={
          <Button onClick={() => void checkNow()} busy={checking}>
            Check the chain now
          </Button>
        }
      />
      {checkError && (
        <div className="mt-4">
          <Notice tone="failed" title="Verification unavailable">
            {checkError}. Pending lines keep their last known state; nothing is assumed paid or failed.
          </Notice>
        </div>
      )}

      {summary && (
        <Section title="Where the money stands">
          <div className="grid gap-4 md:grid-cols-2">
            {summary.partition.map((part) => (
              <div key={part.assetId} className="border border-rule bg-surface px-4 py-3">
                <p className="text-[14px] text-ink-2">
                  {part.symbol} <span className="text-ink-3">({part.environment === 'evm' ? 'EVM' : 'native'})</span>
                </p>
                <dl className="mt-2 grid grid-cols-[1fr_auto] gap-y-1 text-[15px]">
                  <dt className="text-ink-2">Approved</dt>
                  <dd className="num text-right">{groupDecimal(part.total)}</dd>
                  <dt className="text-settled">Verified paid</dt>
                  <dd className="num text-right text-settled">{groupDecimal(part.verified)}</dd>
                  <dt className="font-medium">Outstanding</dt>
                  <dd className="num text-right font-semibold">{groupDecimal(part.outstanding)}</dd>
                </dl>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Lines">
        <Table label="Settlement status by line">
          <thead>
            <tr>
              <th className={th}>Line</th>
              <th className={`${th} text-right`}>Amount</th>
              <th className={th}>Status</th>
              <th className={th}>Trail</th>
              <th className={th}>Why</th>
              <th className={th}>
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(lines ?? []).map((line) => (
              <LineRow
                key={line.obligationId}
                line={line}
                runId={runId}
                open={open === line.obligationId}
                onToggle={() => setOpen(open === line.obligationId ? null : line.obligationId)}
                canResolve={detail?.role === 'owner'}
                canImport={detail?.role === 'owner' || detail?.role === 'operator'}
                onChange={() => void refresh()}
              />
            ))}
          </tbody>
        </Table>
      </Section>
    </div>
  );
}

function LineRow({
  line,
  runId,
  open,
  onToggle,
  canResolve,
  canImport,
  onChange,
}: {
  line: LineView;
  runId: string;
  open: boolean;
  onToggle(): void;
  canResolve: boolean;
  canImport: boolean;
  onChange(): void;
}) {
  const unresolved = !['paid_verified', 'manually_resolved'].includes(line.status);
  return (
    <>
      <tr className={open ? 'bg-sunken' : undefined}>
        <td className={td}>
          <span className="font-medium">{line.lineId}</span>
          <span className="block text-[13px] text-ink-3">{line.recipientName ?? line.reference}</span>
        </td>
        <td className={`${td} num text-right whitespace-nowrap`}>
          {groupDecimal(line.amount)} {line.symbol}
        </td>
        <td className={td}>
          <StatusMark status={line.status} />
        </td>
        <td className={td}>
          <TickTrail line={line} compact />
        </td>
        <td className={`${td} max-w-[44ch] text-[13px] text-ink-2 [overflow-wrap:anywhere]`}>
          {line.explanation}
          {line.exceptions.map((exception, index) => (
            <span key={`${exception.type}-${index}`} className={`block ${exception.severity === 'critical' ? 'text-failed' : 'text-review'}`}>
              {exception.message}
            </span>
          ))}
        </td>
        <td className={td}>
          <Button variant="ghost" onClick={onToggle} aria-expanded={open}>
            {open ? 'Hide proof' : 'Show proof'}
          </Button>
        </td>
      </tr>
      {open && (
        <tr className="bg-sunken">
          <td colSpan={6} className="border-b border-rule px-4 py-4">
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="space-y-2 text-[13px]">
                <TickTrail line={line} />
                <p className="text-ink-3">Obligation ID</p>
                <CopyText value={line.obligationId} />
                <p className="text-ink-3">Destination</p>
                <CopyText value={line.destination} />
                <p className="text-ink-3">Payer</p>
                <CopyText value={line.payer} />
              </div>
              <div className="space-y-3">
                {line.attempts.length === 0 ? <p className="text-[13px] text-ink-3">No attempts yet.</p> : line.attempts.map((attempt) => <AttemptEvidence key={attempt.id} attempt={attempt} />)}
                {unresolved && canImport && <ImportTransaction runId={runId} line={line} onDone={onChange} />}
                {unresolved && canResolve && line.status !== 'approved_unattempted' && <ManualResolve runId={runId} line={line} onDone={onChange} />}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
