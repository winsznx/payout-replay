'use client';

import { useState } from 'react';

import { apiPost, errorMessage } from '@/lib/api';
import { connectEvm, sendEvmCall, waitForEvmReceipt } from '@/lib/evm-wallet';
import { formatBaseUnits } from '@/lib/format';
import { sendNativeTransfer } from '@/lib/native-wallet';
import type { EligibleLine, Environment, EvmTransferPayload, NativeTransferPayload, UnsignedTransfer } from '@/lib/types';

import { Button, Notice } from './ui';

type Step = { kind: 'idle' } | { kind: 'working'; message: string } | { kind: 'done'; message: string } | { kind: 'error'; message: string };

async function revalidate<T>(planId: string, environment: Environment, obligationId: string): Promise<UnsignedTransfer<T>> {
  const result = await apiPost<{ transfers: UnsignedTransfer<T>[] }>(`/recovery-plans/${planId}/revalidate`, { environment, obligationIds: [obligationId] });
  const transfer = result.transfers[0];
  if (!transfer) throw new Error('The plan no longer contains this line.');
  return transfer;
}

function blocking(transfer: UnsignedTransfer<unknown>): string | null {
  const issue = transfer.preflight.find((item) => item.blocking);
  return issue ? issue.message : null;
}

/**
 * One line, one signature. Order matters: revalidate against the chain,
 * register the attempt (which locks the line), then open the wallet. The
 * attempt's outcome is recorded whatever the wallet does.
 */
async function payEvmLine(runId: string, planId: string, line: EligibleLine, report: (message: string) => void): Promise<string> {
  report('Checking chain state and executor records');
  const transfer = await revalidate<EvmTransferPayload>(planId, 'evm', line.obligationId);
  const problem = blocking(transfer);
  if (problem) throw new Error(problem);
  const account = await connectEvm();
  if (account.toLowerCase() !== line.payer.toLowerCase()) throw new Error(`Switch your wallet to the payout wallet ${line.payer}.`);

  if (transfer.payload.approve) {
    report(`Approve exactly ${formatBaseUnits(line.amountBaseUnits, line.decimals)} ${line.symbol} for the executor in your wallet`);
    const approval = await sendEvmCall(account, transfer.payload.approve);
    if (approval.kind === 'rejected') throw new Error('Allowance approval was rejected. Nothing was paid.');
    if (approval.kind === 'unknown') throw new Error(`Allowance approval result is unknown: ${approval.error}. Check the wallet, then try again.`);
    report('Waiting for the allowance to be included');
    if ((await waitForEvmReceipt(approval.txHash)) !== 'success') throw new Error('The allowance transaction reverted. Nothing was paid.');
  }

  const attemptKey = `attempt-${planId}-${line.obligationId}-${Date.now()}`;
  const attempt = await apiPost<{ id: string }>(`/runs/${runId}/attempts`, { planId, obligationId: line.obligationId }, { idempotencyKey: attemptKey });
  report('Confirm the payment in your wallet');
  const sent = await sendEvmCall(account, transfer.payload.execute);
  if (sent.kind === 'rejected') {
    await apiPost(`/attempts/${attempt.id}/result`, { phase: 'signature_rejected' });
    return 'You rejected the signature. Nothing was broadcast, so this line can be prepared again.';
  }
  if (sent.kind === 'unknown') {
    await apiPost(`/attempts/${attempt.id}/result`, { phase: 'submission_unknown' });
    return 'The wallet did not confirm whether it broadcast. The line is blocked until the chain shows what happened.';
  }
  await apiPost(`/attempts/${attempt.id}/result`, { phase: 'submitted', txHash: sent.txHash, ...(sent.nonce === undefined ? {} : { nonce: sent.nonce }) });
  return `Broadcast ${sent.txHash}. It counts as paid only after finality.`;
}

async function payNativeLine(runId: string, planId: string, line: EligibleLine, report: (message: string) => void): Promise<string> {
  report('Checking chain state and balances');
  const transfer = await revalidate<NativeTransferPayload>(planId, 'native', line.obligationId);
  const problem = blocking(transfer);
  if (problem) throw new Error(problem);
  const attemptKey = `attempt-${planId}-${line.obligationId}-${Date.now()}`;
  const attempt = await apiPost<{ id: string }>(`/runs/${runId}/attempts`, { planId, obligationId: line.obligationId }, { idempotencyKey: attemptKey });
  report('Confirm Balances.transfer_keep_alive in your extension');
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
    ? `Broadcast ${sent.txHash}. Valid until block ${sent.mortality.birthBlock + sent.mortality.period}; it counts as paid only after GRANDPA finality.`
    : `Signed ${sent.txHash} but the broadcast result is unknown (${sent.error ?? 'no detail'}). The line stays blocked until its era closes or it appears on-chain.`;
}

export function PaymentQueue({ runId, planId, lines, onChange }: { runId: string; planId: string; lines: EligibleLine[]; onChange(): void }) {
  const [steps, setSteps] = useState<Record<string, Step>>({});
  const set = (id: string, step: Step) => setSteps((current) => ({ ...current, [id]: step }));
  const groups = (['native', 'evm'] as const).map((environment) => ({ environment, lines: lines.filter((line) => line.environment === environment) })).filter((group) => group.lines.length > 0);

  const pay = async (line: EligibleLine) => {
    const report = (message: string) => set(line.obligationId, { kind: 'working', message });
    try {
      const message = line.environment === 'evm' ? await payEvmLine(runId, planId, line, report) : await payNativeLine(runId, planId, line, report);
      set(line.obligationId, { kind: 'done', message });
    } catch (error) {
      set(line.obligationId, { kind: 'error', message: errorMessage(error) });
    } finally {
      onChange();
    }
  };

  const anyWorking = Object.values(steps).some((step) => step.kind === 'working');

  return (
    <div className="space-y-8">
      {groups.map((group) => (
        <div key={group.environment}>
          <h3 className="mb-1 text-[15px] font-semibold">{group.environment === 'evm' ? 'EVM token payments' : 'Native tPOT payments'}</h3>
          <p className="mb-3 text-[13px] text-ink-3">
            {group.environment === 'evm'
              ? 'Each line is a PayoutExecutor.executePayment call from the payout wallet. If the allowance is short, your wallet first asks to approve that exact amount.'
              : 'Each line is one Balances.transfer_keep_alive extrinsic, signed with a 64-block mortal era.'}{' '}
            Lines settle independently. There is no all-or-nothing batch.
          </p>
          <ul className="divide-y divide-rule border border-rule bg-surface">
            {group.lines.map((line) => {
              const step = steps[line.obligationId] ?? { kind: 'idle' };
              return (
                <li key={line.obligationId} className="grid gap-3 px-4 py-3 md:grid-cols-[1fr_auto]">
                  <div className="min-w-0">
                    <p className="text-[15px]">
                      <span className="font-medium">{line.lineId}</span>{' '}
                      <span className="num">
                        pays {formatBaseUnits(line.amountBaseUnits, line.decimals)} {line.symbol}
                      </span>{' '}
                      to
                    </p>
                    <p className="hash text-ink-2">{line.destination}</p>
                    <p className="mt-1 text-[13px] text-ink-3">
                      Signed by <span className="hash">{line.payer}</span>. {line.reason}
                    </p>
                    {step.kind !== 'idle' && (
                      <p
                        role="status"
                        className={`mt-2 text-[14px] ${step.kind === 'error' ? 'text-failed' : step.kind === 'done' ? 'text-settled' : 'text-ink-2'}`}
                      >
                        {step.message}
                      </p>
                    )}
                  </div>
                  <div className="flex items-start">
                    <Button
                      variant="primary"
                      busy={step.kind === 'working'}
                      disabled={anyWorking || step.kind === 'done'}
                      onClick={() => void pay(line)}
                    >
                      {step.kind === 'done' ? 'Sent' : `Sign payment for ${line.lineId}`}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {groups.length === 0 && <Notice>No lines are safe to pay right now.</Notice>}
    </div>
  );
}
