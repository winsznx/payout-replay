'use client';

import { useState } from 'react';

import { apiPost, errorMessage } from '@/lib/api';
import { connectEvm, sendEvmCall, waitForEvmReceipt } from '@/lib/evm-wallet';
import { formatBaseUnits } from '@/lib/format';
import { sendNativeTransfer } from '@/lib/native-wallet';
import type { EligibleLine, Environment, EvmTransferPayload, NativeTransferPayload, ObligationStatus, UnsignedTransfer } from '@/lib/types';

import { IconChain, IconCheck, IconLayers } from './icons';
import { Button, IconTile, StatusPill } from './ui';

/** Signing stages, in order. `allowance` only applies to EVM token payments. */
export type Stage = 'recheck' | 'allowance' | 'sign' | 'recorded';

export type LineStep =
  | { kind: 'idle' }
  | { kind: 'working'; stage: Stage; message: string }
  | { kind: 'done'; message: string }
  | { kind: 'error'; stage: Stage; message: string };

async function revalidate<T>(planId: string, environment: Environment, obligationId: string): Promise<UnsignedTransfer<T>> {
  const result = await apiPost<{ transfers: UnsignedTransfer<T>[] }>(`/recovery-plans/${planId}/revalidate`, { environment, obligationIds: [obligationId] });
  const transfer = result.transfers[0];
  if (!transfer) throw new Error('The plan no longer contains this line.');
  return transfer;
}

function blocking(transfer: UnsignedTransfer<unknown>): string | null {
  return transfer.preflight.find((item) => item.blocking)?.message ?? null;
}

type Report = (stage: Stage, message: string) => void;

/**
 * One line, one signature. Order matters: recheck the chain, register the attempt (which
 * locks the line), then open the wallet. Whatever the wallet does is recorded.
 */
async function payEvmLine(runId: string, planId: string, line: EligibleLine, report: Report): Promise<string> {
  report('recheck', 'Rechecking chain state and executor records');
  const transfer = await revalidate<EvmTransferPayload>(planId, 'evm', line.obligationId);
  const problem = blocking(transfer);
  if (problem) throw new Error(problem);
  const account = await connectEvm();
  if (account.toLowerCase() !== line.payer.toLowerCase()) throw new Error(`Switch your wallet to the payout wallet ${line.payer}.`);

  if (transfer.payload.approve) {
    report('allowance', `Approve exactly ${formatBaseUnits(line.amountBaseUnits, line.decimals)} ${line.symbol} for the executor in your wallet`);
    const approval = await sendEvmCall(account, transfer.payload.approve);
    if (approval.kind === 'rejected') throw new Error('Allowance approval was rejected. Nothing was paid.');
    if (approval.kind === 'unknown') throw new Error(`Allowance approval result is unknown: ${approval.error}. Check the wallet, then try again.`);
    report('allowance', 'Waiting for the allowance to be included');
    if ((await waitForEvmReceipt(approval.txHash)) !== 'success') throw new Error('The allowance transaction reverted. Nothing was paid.');
  }

  const attempt = await apiPost<{ id: string }>(
    `/runs/${runId}/attempts`,
    { planId, obligationId: line.obligationId },
    { idempotencyKey: `attempt-${planId}-${line.obligationId}-${Date.now()}` },
  );
  report('sign', `Confirm ${transfer.method} in your wallet`);
  const sent = await sendEvmCall(account, transfer.payload.execute);
  if (sent.kind === 'rejected') {
    await apiPost(`/attempts/${attempt.id}/result`, { phase: 'signature_rejected' });
    return 'You rejected the signature. Nothing was broadcast, so this line can be prepared again.';
  }
  if (sent.kind === 'unknown') {
    await apiPost(`/attempts/${attempt.id}/result`, { phase: 'submission_unknown' });
    return 'The wallet didn’t confirm whether it broadcast. The line stays blocked until the chain shows what happened.';
  }
  await apiPost(`/attempts/${attempt.id}/result`, { phase: 'submitted', txHash: sent.txHash, ...(sent.nonce === undefined ? {} : { nonce: sent.nonce }) });
  return `Broadcast ${sent.txHash}. It counts as paid only after finality.`;
}

async function payNativeLine(runId: string, planId: string, line: EligibleLine, report: Report): Promise<string> {
  report('recheck', 'Rechecking chain state and balances');
  const transfer = await revalidate<NativeTransferPayload>(planId, 'native', line.obligationId);
  const problem = blocking(transfer);
  if (problem) throw new Error(problem);
  const attempt = await apiPost<{ id: string }>(
    `/runs/${runId}/attempts`,
    { planId, obligationId: line.obligationId },
    { idempotencyKey: `attempt-${planId}-${line.obligationId}-${Date.now()}` },
  );
  const fee = transfer.estimatedFee
    ? ` Estimated fee ${formatBaseUnits(transfer.estimatedFee.amountBaseUnits, transfer.estimatedFee.decimals)} ${transfer.estimatedFee.symbol}.`
    : '';
  report('sign', `Confirm ${transfer.method} in your extension.${fee}`);
  let sent;
  try {
    sent = await sendNativeTransfer(line.payer, transfer.payload);
  } catch (error) {
    await apiPost(`/attempts/${attempt.id}/result`, { phase: 'signature_rejected' });
    throw error;
  }
  if (sent.kind === 'rejected') {
    await apiPost(`/attempts/${attempt.id}/result`, { phase: 'signature_rejected' });
    return 'You rejected the signature. Nothing was broadcast, so this line can be prepared again.';
  }
  await apiPost(`/attempts/${attempt.id}/result`, {
    phase: sent.kind === 'sent' ? 'submitted' : 'submission_unknown',
    txHash: sent.txHash,
    nonce: sent.nonce,
    mortality: sent.mortality,
  });
  return sent.kind === 'sent'
    ? `Broadcast ${sent.txHash}. Valid until block ${sent.mortality.birthBlock + sent.mortality.period}. It counts as paid only after finality.`
    : `Signed ${sent.txHash}, but the broadcast result is unknown (${sent.error ?? 'no detail'}). The line stays blocked until its era closes or it appears on-chain.`;
}

export function usePaymentQueue(runId: string, planId: string, onChange: () => void) {
  const [steps, setSteps] = useState<Record<string, LineStep>>({});
  const [activeLine, setActiveLine] = useState<EligibleLine | null>(null);
  const set = (id: string, step: LineStep) => setSteps((current) => ({ ...current, [id]: step }));

  const pay = async (line: EligibleLine) => {
    setActiveLine(line);
    let stage: Stage = 'recheck';
    const report: Report = (next, message) => {
      stage = next;
      set(line.obligationId, { kind: 'working', stage: next, message });
    };
    try {
      const message = line.environment === 'evm' ? await payEvmLine(runId, planId, line, report) : await payNativeLine(runId, planId, line, report);
      set(line.obligationId, { kind: 'done', message });
    } catch (error) {
      set(line.obligationId, { kind: 'error', stage, message: errorMessage(error) });
    } finally {
      onChange();
    }
  };

  return { steps, activeLine, pay, busy: Object.values(steps).some((step) => step.kind === 'working') };
}

export function PaymentCards({
  lines,
  statusById,
  steps,
  busy,
  onPay,
}: {
  lines: EligibleLine[];
  statusById: ReadonlyMap<string, ObligationStatus>;
  steps: Record<string, LineStep>;
  busy: boolean;
  onPay(line: EligibleLine): void;
}) {
  const groups = (['native', 'evm'] as const)
    .map((environment) => ({ environment, lines: lines.filter((line) => line.environment === environment) }))
    .filter((group) => group.lines.length > 0);

  return (
    <div className="stack">
      {groups.map((group) => (
        <div key={group.environment} className="stack" style={{ gap: 10 }}>
          <p style={{ fontSize: 13, color: 'var(--ink-3)' }}>
            {group.environment === 'evm'
              ? 'EVM token payments through PayoutExecutor. If the allowance is short, your wallet first approves that exact amount.'
              : 'Native tPOT payments as Balances.transfer_keep_alive, signed with a 64-block mortal era.'}{' '}
            Each line settles on its own.
          </p>
          {group.lines.map((line) => {
            const step = steps[line.obligationId] ?? { kind: 'idle' };
            const status = statusById.get(line.obligationId);
            const safe = status === undefined || status === 'approved_unattempted' || status === 'failed_verified';
            return (
              <div key={line.obligationId} className="card" style={{ padding: 18 }}>
                <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <IconTile tone={step.kind === 'done' ? 'settled' : step.kind === 'error' ? 'failed' : undefined}>
                    {line.environment === 'evm' ? <IconLayers size={18} /> : <IconChain size={18} />}
                  </IconTile>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <p style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{line.reference}</p>
                    <p style={{ fontSize: 16, fontWeight: 600 }}>
                      {line.lineId} pays <span className="num">{formatBaseUnits(line.amountBaseUnits, line.decimals)} {line.symbol}</span>
                    </p>
                    <p className="mono" style={{ color: 'var(--ink-2)', marginTop: 4 }}>
                      {line.destination}
                    </p>
                  </div>
                  <div>
                    {safe || step.kind === 'working' ? (
                      <Button variant="primary" busy={step.kind === 'working'} disabled={busy} onClick={() => onPay(line)}>
                        {`Sign payment for ${line.lineId}`}
                      </Button>
                    ) : (
                      status && <StatusPill status={status} />
                    )}
                  </div>
                </div>
                <p style={{ fontSize: 13, color: 'var(--ink-2)', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                  Signed by <span className="mono">{line.payer}</span>. {line.reason}
                </p>
                {step.kind !== 'idle' && (
                  <p
                    role="status"
                    style={{
                      marginTop: 10,
                      fontSize: 13.5,
                      padding: '10px 12px',
                      borderRadius: 12,
                      overflowWrap: 'anywhere',
                      background: step.kind === 'error' ? 'var(--failed-soft)' : step.kind === 'done' ? 'var(--settled-soft)' : 'var(--panel)',
                      color: step.kind === 'error' ? 'var(--failed)' : step.kind === 'done' ? 'var(--settled)' : 'var(--ink-2)',
                    }}
                  >
                    {step.kind === 'done' && <IconCheck size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />}
                    {step.message}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

const STAGES: { stage: Stage; title: string; body: string; evmOnly?: boolean }[] = [
  { stage: 'recheck', title: 'Recheck the chain', body: 'Fresh finality, balances and executor records for this line.' },
  { stage: 'allowance', title: 'Approve the exact amount', body: 'Only when the executor’s allowance is short.', evmOnly: true },
  { stage: 'sign', title: 'Sign in your wallet', body: 'The attempt is recorded before the prompt opens.' },
  { stage: 'recorded', title: 'Recorded, waiting for finality', body: 'Paid only once a finalised block proves it.' },
];

export function SigningStepper({ line, step }: { line: EligibleLine | null; step: LineStep | undefined }) {
  const stages = STAGES.filter((item) => !item.evmOnly || line?.environment !== 'native');
  const index = !step || step.kind === 'idle' ? -1 : step.kind === 'done' ? stages.length - 1 : stages.findIndex((item) => item.stage === step.stage);
  return (
    <div className="stepper" aria-label="Signing steps">
      {stages.map((item, position) => {
        const state =
          step?.kind === 'error' && position === index ? 'failed' : step?.kind === 'done' ? 'done' : position < index ? 'done' : position === index ? 'active' : '';
        return (
          <div key={item.stage} className={`step ${state}`}>
            <span className="step-index">{state === 'done' ? <IconCheck size={16} strokeWidth={2.2} /> : String(position + 1).padStart(2, '0')}</span>
            <div>
              <strong>{item.title}</strong>
              <p>{item.body}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
