'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { type DragEvent, Suspense, useState } from 'react';
import useSWR, { mutate } from 'swr';

import { Button, CopyText, Notice, PageHeader, Section, Table, td, th } from '@/components/ui';
import { apiPost, errorMessage, fetcher } from '@/lib/api';
import { formatBaseUnits, groupDecimal } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { RunDetail, ValidationReport } from '@/lib/types';

const REQUIRED = ['line_id', 'environment', 'asset_id', 'destination', 'amount', 'reference'] as const;
const OPTIONAL = ['recipient_name', 'recipient_id', 'invoice_id', 'note', 'source_wallet'] as const;
const MAX_BYTES = 5 * 1024 * 1024;

const SAMPLE = `line_id,environment,asset_id,destination,amount,reference,recipient_name
TASK-101,native,tPOT,5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty,1.5,TASK-101,Contributor A
TASK-102,evm,0xYourTestTokenAddress,0x90F79bf6EB2c4f870365E785982E1f101E93b906,100,TASK-102,Contributor B`;

function headerRow(csv: string): string[] {
  const first = csv.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  return first.split(',').map((cell) => cell.trim().replace(/^"|"$/g, '').toLowerCase()).filter(Boolean);
}

function ImportScreen() {
  const router = useRouter();
  const search = useSearchParams();
  const { orgId } = useSession();
  const existingRunId = search.get('run');
  const { data: existing } = useSWR<RunDetail>(existingRunId ? `/runs/${existingRunId}` : null, fetcher);

  const [name, setName] = useState('');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [runId, setRunId] = useState<string | null>(existingRunId);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<'validate' | 'freeze' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const shownReport = report ?? existing?.latestImport?.report ?? null;
  const headers = headerRow(csv);
  const unmatched = csv ? REQUIRED.filter((field) => !headers.includes(mapping[field] ?? field)) : [];
  const locked = existing && !['draft', 'validated', 'awaiting_approval', 'approved'].includes(existing.run.status);

  const loadFile = async (file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) {
      setError('The file is larger than 5 MB. Split it into smaller runs.');
      return;
    }
    setCsv(await file.text());
    setFileName(file.name);
    setReport(null);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void loadFile(file);
  };

  const validate = async () => {
    if (!orgId) return;
    setBusy('validate');
    setError(null);
    try {
      let id = runId;
      if (!id) {
        const run = await apiPost<{ id: string }>(`/orgs/${orgId}/runs`, { name: name.trim() || fileName || 'Payout run' });
        id = run.id;
        setRunId(id);
        router.replace(`/app/runs/new?run=${id}`);
      }
      const columnMapping = Object.fromEntries(Object.entries(mapping).filter(([field, header]) => header && header !== field));
      const result = await apiPost<{ report: ValidationReport }>(`/runs/${id}/import`, {
        csv,
        ...(fileName ? { fileName } : {}),
        ...(Object.keys(columnMapping).length ? { columnMapping } : {}),
      });
      setReport(result.report);
      setAcknowledged(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const freeze = async () => {
    if (!runId) return;
    setBusy('freeze');
    setError(null);
    try {
      await apiPost(`/runs/${runId}/freeze`, { acknowledgeDuplicates: acknowledged });
      await mutate(`/runs/${runId}`);
      router.push(`/app/runs/${runId}/review`);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(null);
    }
  };

  const errors = shownReport?.issues.filter((issue) => issue.severity === 'error') ?? [];
  const warnings = shownReport?.issues.filter((issue) => issue.severity === 'warning') ?? [];

  return (
    <div className="max-w-6xl">
      <PageHeader
        title={existing ? `Import for ${existing.run.name}` : 'Import a payout sheet'}
        description="Upload the approved spreadsheet as CSV. Nothing is frozen or paid until you review and approve it."
      />

      {locked && (
        <div className="mt-6">
          <Notice tone="review" title="Payments have started for this run">
            Its manifest is frozen and can no longer change. Start a new run for different lines.
          </Notice>
        </div>
      )}

      {!locked && (
        <Section title="Upload" description="Required columns: line_id, environment, asset_id, destination, amount, reference.">
          {!existing && (
            <label className="mb-4 block max-w-md">
              <span className="text-[14px] text-ink-2">Run name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="November contributor payouts"
                className="mt-1 w-full rounded-[5px] border border-rule-strong bg-surface px-3 py-2"
              />
            </label>
          )}
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex flex-col items-start gap-3 border border-dashed px-5 py-6 ${dragging ? 'border-accent bg-accent-wash' : 'border-rule-strong bg-surface'}`}
          >
            <p className="text-[15px] text-ink">{fileName ? `Loaded ${fileName}` : 'Drop a CSV file here, or choose one.'}</p>
            <div className="flex flex-wrap gap-2">
              <label className="inline-flex cursor-pointer items-center rounded-[5px] border border-rule-strong bg-surface px-3 py-1.5 text-[14px] font-medium hover:bg-sunken">
                Choose file
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void loadFile(file);
                  }}
                />
              </label>
              <Button variant="ghost" onClick={() => { setCsv(SAMPLE); setFileName('sample.csv'); }}>
                Load the column template
              </Button>
            </div>
          </div>

          {csv && (
            <details className="mt-3" open={unmatched.length > 0}>
              <summary className="cursor-pointer text-[14px] text-ink-2">Column mapping {unmatched.length > 0 ? `(${unmatched.length} required column${unmatched.length > 1 ? 's' : ''} not found)` : '(all required columns found)'}</summary>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {[...REQUIRED, ...OPTIONAL].map((field) => (
                  <label key={field} className="flex items-center justify-between gap-2 text-[14px]">
                    <span className={REQUIRED.includes(field as (typeof REQUIRED)[number]) ? 'text-ink' : 'text-ink-3'}>{field}</span>
                    <select
                      value={mapping[field] ?? (headers.includes(field) ? field : '')}
                      onChange={(event) => setMapping({ ...mapping, [field]: event.target.value })}
                      className="w-44 rounded border border-rule bg-surface px-2 py-1"
                    >
                      <option value="">Not in file</option>
                      {headers.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </details>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => void validate()} busy={busy === 'validate'} disabled={!csv || unmatched.length > 0}>
              Validate sheet
            </Button>
          </div>
        </Section>
      )}

      {error && (
        <div className="mt-4">
          <Notice tone="failed">{error}</Notice>
        </div>
      )}

      {shownReport && (
        <>
          <Section
            title={shownReport.ok ? `${shownReport.lines.length} lines ready to freeze` : `${errors.length} problem${errors.length === 1 ? '' : 's'} to fix before freezing`}
            description={
              <>
                File checksum <CopyText value={`sha256:${shownReport.fileSha256}`} display={`sha256:${shownReport.fileSha256.slice(0, 16)}…`} />
              </>
            }
          >
            {errors.length > 0 && (
              <Table label="Validation errors">
                <thead>
                  <tr>
                    <th className={th}>CSV line</th>
                    <th className={th}>Line ID</th>
                    <th className={th}>Column</th>
                    <th className={th}>Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.map((issue, index) => (
                    <tr key={`${issue.code}-${index}`}>
                      <td className={`${td} num`}>{issue.line ?? 'file'}</td>
                      <td className={td}>{issue.lineId ?? ''}</td>
                      <td className={td}>{issue.field ?? ''}</td>
                      <td className={`${td} text-failed`}>{issue.message}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {warnings.length > 0 && (
              <ul className="mt-3 space-y-1 text-[14px] text-review">
                {warnings.map((issue, index) => (
                  <li key={`${issue.code}-${index}`}>
                    {issue.line ? `Line ${issue.line}: ` : ''}
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {shownReport.lines.length > 0 && (
            <Section title="Lines as they will be frozen" description="Full destination addresses, exactly as they will be paid.">
              <Table label="Validated lines">
                <thead>
                  <tr>
                    <th className={th}>Line ID</th>
                    <th className={th}>Recipient</th>
                    <th className={th}>Environment</th>
                    <th className={th}>Destination</th>
                    <th className={`${th} text-right`}>Amount</th>
                    <th className={th}>Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {shownReport.lines.map((line) => {
                    const total = shownReport.totals.find((item) => item.environment === line.environment && item.assetId === line.assetId);
                    return (
                      <tr key={line.lineId}>
                        <td className={`${td} font-medium`}>{line.lineId}</td>
                        <td className={td}>{line.recipientName ?? ''}</td>
                        <td className={td}>{line.environment === 'evm' ? 'EVM' : 'Native'}</td>
                        <td className={`${td} max-w-[28ch]`}>
                          <span className="hash">{line.destination}</span>
                        </td>
                        <td className={`${td} num text-right whitespace-nowrap`}>
                          {groupDecimal(line.amount)} {total?.symbol}
                        </td>
                        <td className={td}>{line.reference}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              <div className="mt-4 grid gap-6 sm:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-[14px] font-medium text-ink-2">Totals by asset</h3>
                  <ul className="space-y-1 text-[14px]">
                    {shownReport.totals.map((total) => (
                      <li key={total.assetId} className="flex justify-between gap-4 border-b border-rule py-1">
                        <span>
                          {total.symbol} <span className="text-ink-3">({total.count} lines)</span>
                        </span>
                        <span className="num">{formatBaseUnits(total.amountBaseUnits, total.decimals)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="mb-2 text-[14px] font-medium text-ink-2">Who has to sign</h3>
                  <ul className="space-y-1 text-[14px]">
                    {shownReport.signers.map((signer) => (
                      <li key={signer.environment} className="border-b border-rule py-1">
                        {signer.environment === 'evm' ? 'EVM payout wallet' : 'Native payout wallet'} for {signer.lineCount} line{signer.lineCount === 1 ? '' : 's'}
                        <span className="hash block text-ink-2">{signer.payer}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[13px] text-ink-3">Network fees are estimated per transfer on the execution screen, from live chain data.</p>
                </div>
              </div>
            </Section>
          )}

          {shownReport.ok && runId && !locked && (
            <Section title="Freeze for approval" description="Freezing creates an immutable version with a SHA-256 fingerprint. Any later change makes a new version that needs approval again.">
              {shownReport.requiresAcknowledgement && (
                <label className="mb-3 flex items-start gap-2 text-[14px]">
                  <input type="checkbox" className="mt-1" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                  <span>
                    I checked the lines that pay the same amount to the same address ({shownReport.duplicates.map((group) => group.lineIds.join(' and ')).join('; ')}). They are separate obligations and each will be paid.
                  </span>
                </label>
              )}
              <Button variant="primary" onClick={() => void freeze()} busy={busy === 'freeze'} disabled={shownReport.requiresAcknowledgement && !acknowledged}>
                Freeze version for review
              </Button>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

export default function NewRunPage() {
  return (
    <Suspense>
      <ImportScreen />
    </Suspense>
  );
}
