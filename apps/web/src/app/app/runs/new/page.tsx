'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { type DragEvent, Suspense, useState } from 'react';
import useSWR, { mutate } from 'swr';

import { IconAlert, IconChain, IconCheck, IconFile, IconLayers, IconUpload, IconWallet } from '@/components/icons';
import { Button, CopyText, IconTile, Notice, PageHead, TopBar } from '@/components/ui';
import { apiPost, errorMessage, fetcher } from '@/lib/api';
import { formatBaseUnits, groupDecimal } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { RunDetail, ValidationReport } from '@/lib/types';

const REQUIRED = ['line_id', 'environment', 'asset_id', 'destination', 'amount', 'reference'] as const;
const OPTIONAL = ['recipient_name', 'recipient_id', 'invoice_id', 'note', 'source_wallet'] as const;
const MAX_BYTES = 5 * 1024 * 1024;

const COLUMN_HELP: Record<(typeof REQUIRED)[number], string> = {
  line_id: 'Unique per sheet, e.g. TASK-101',
  environment: 'native or evm',
  asset_id: 'tPOT, or the token contract address',
  destination: 'SS58 for native, 0x address for EVM',
  amount: 'Plain decimal, never rounded',
  reference: 'Invoice, task or grant reference',
};

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

  const shown = report ?? existing?.latestImport?.report ?? null;
  const headers = headerRow(csv);
  const unmatched = csv ? REQUIRED.filter((field) => !headers.includes(mapping[field] ?? field)) : [];
  const locked = Boolean(existing && !['draft', 'validated', 'awaiting_approval', 'approved'].includes(existing.run.status));
  const errors = shown?.issues.filter((issue) => issue.severity === 'error') ?? [];
  const warnings = shown?.issues.filter((issue) => issue.severity === 'warning') ?? [];
  const currentStep = !runId && !csv ? 0 : !csv && !shown ? 1 : !shown || !shown.ok ? 2 : 3;

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

  const steps = [
    { title: 'Name the run', body: 'One run is one approved sheet.' },
    { title: 'Add the CSV', body: 'Drop the file your team signed off.' },
    { title: 'Validate every line', body: 'Addresses, decimals and payout wallets.' },
    { title: 'Freeze for review', body: 'An immutable version with a fingerprint.' },
  ];

  return (
    <>
      <TopBar crumbs={[{ label: 'Payout runs', href: '/app' }, ...(existing ? [{ label: existing.run.name, href: `/app/runs/${existing.run.id}` }] : []), { label: 'Import' }]} />
      <div className="page">
        <PageHead
          title={existing ? `Import for ${existing.run.name}` : 'Import a payout sheet'}
          description="Upload the spreadsheet your team already approved. Nothing is frozen or paid until a reviewer approves the exact version."
        />

        <div className="split">
          <div className="stack">
            {locked && (
              <Notice tone="review" title="Payments have started for this run">
                Its manifest is frozen and can’t change. Start a new run for different lines.
              </Notice>
            )}

            {!locked && (
              <>
                {!existing && (
                  <label className="field">
                    <span>Run name</span>
                    <input value={name} onChange={(event) => setName(event.target.value)} placeholder="November contributor payouts" className="input" />
                  </label>
                )}

                <div
                  className={`dropzone ${dragging ? 'dragging' : ''}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                >
                  <span className="icon-tile">{fileName ? <IconFile size={20} /> : <IconUpload size={20} />}</span>
                  <h3>{fileName ? `Loaded ${fileName}` : 'Drop your payout CSV here'}</h3>
                  <p>{fileName ? `${headers.length} columns found. Validate it to check every line.` : 'UTF-8 CSV with a header row, up to 500 lines and 5 MB.'}</p>
                  <label className="btn btn-secondary" style={{ cursor: 'pointer' }}>
                    {fileName ? 'Choose another file' : 'Choose file'}
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
                </div>

                {csv && (
                  <div className="card">
                    <div className="module-head" style={{ marginBottom: 10 }}>
                      <h2 className="card-title">Column mapping</h2>
                      <span style={{ fontSize: 13, color: unmatched.length ? 'var(--failed)' : 'var(--settled)' }}>
                        {unmatched.length ? `${unmatched.length} required column${unmatched.length > 1 ? 's' : ''} not found` : 'All required columns found'}
                      </span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                      {[...REQUIRED, ...OPTIONAL].map((field) => (
                        <label key={field} className="field">
                          <span>
                            {field}
                            {REQUIRED.includes(field as (typeof REQUIRED)[number]) ? '' : ' (optional)'}
                          </span>
                          <select className="select" value={mapping[field] ?? (headers.includes(field) ? field : '')} onChange={(event) => setMapping({ ...mapping, [field]: event.target.value })}>
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
                  </div>
                )}

                <div>
                  <Button variant="primary" onClick={() => void validate()} busy={busy === 'validate'} disabled={!csv || unmatched.length > 0}>
                    <IconCheck size={16} />
                    Validate sheet
                  </Button>
                </div>
              </>
            )}

            {error && <Notice tone="failed">{error}</Notice>}

            {shown && (
              <>
                <div className="tiles" style={{ marginBottom: 0 }}>
                  <div className="inset">
                    <IconTile tone={shown.ok ? 'settled' : undefined}>
                      <IconCheck size={18} />
                    </IconTile>
                    <div className="inset-body">
                      <span>{shown.ok ? 'Validation passed' : 'Valid lines'}</span>
                      <strong className="num" style={shown.ok ? { fontSize: 16 } : undefined}>
                        {shown.ok ? `${shown.lines.length} lines ready to freeze` : shown.lines.length}
                      </strong>
                    </div>
                  </div>
                  <div className="inset">
                    <IconTile tone={errors.length ? 'failed' : undefined}>
                      <IconAlert size={18} />
                    </IconTile>
                    <div className="inset-body">
                      <span>Problems to fix</span>
                      <strong className="num">{errors.length}</strong>
                    </div>
                  </div>
                  <div className="inset">
                    <IconTile>
                      <IconFile size={18} />
                    </IconTile>
                    <div className="inset-body">
                      <span>File checksum</span>
                      <CopyText value={`sha256:${shown.fileSha256}`} display={`${shown.fileSha256.slice(0, 12)}…`} />
                    </div>
                  </div>
                </div>

                {errors.length > 0 && (
                  <div className="queue">
                    {errors.map((issue, index) => (
                      <div className="queue-row" key={`${issue.code}-${index}`}>
                        <IconTile tone="failed">
                          <IconAlert size={18} />
                        </IconTile>
                        <div className="queue-main">
                          <small>
                            {issue.line ? `CSV line ${issue.line}` : 'Whole file'}
                            {issue.field ? ` · ${issue.field}` : ''}
                          </small>
                          <h3 style={{ whiteSpace: 'normal' }}>{issue.lineId ?? issue.code.toLowerCase().replace(/_/g, ' ')}</h3>
                          <p>{issue.message}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {warnings.length > 0 && (
                  <Notice tone="review" title={`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`}>
                    {warnings.map((issue) => issue.message).join(' ')}
                  </Notice>
                )}

                {shown.lines.length > 0 && (
                  <div className="table-card">
                    <div className="table-scroll">
                      <table className="table" aria-label="Lines as they will be frozen">
                        <thead>
                          <tr>
                            <th>Line</th>
                            <th>Destination, exactly as it will be paid</th>
                            <th className="right">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {shown.lines.map((line) => {
                            const total = shown.totals.find((item) => item.environment === line.environment && item.assetId === line.assetId);
                            return (
                              <tr key={line.lineId}>
                                <td>
                                  <strong style={{ fontWeight: 600 }}>{line.lineId}</strong>
                                  <span style={{ display: 'block', fontSize: 12.5, color: 'var(--ink-3)' }}>
                                    {line.recipientName ?? line.reference} · {line.environment === 'evm' ? 'EVM' : 'Native'}
                                  </span>
                                </td>
                                <td style={{ maxWidth: 360 }}>
                                  <span className="mono">{line.destination}</span>
                                </td>
                                <td className="right num" style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                                  {groupDecimal(line.amount)} {total?.symbol}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {shown.lines.length > 0 && (
                  <div className="modules" style={{ marginBottom: 0 }}>
                    <div className="inset-list">
                      {shown.totals.map((total) => (
                        <div className="inset" key={total.assetId}>
                          <IconTile>{total.environment === 'evm' ? <IconLayers size={18} /> : <IconChain size={18} />}</IconTile>
                          <div className="inset-body">
                            <span>
                              Total {total.symbol}, {total.count} line{total.count === 1 ? '' : 's'}
                            </span>
                            <strong className="num">{formatBaseUnits(total.amountBaseUnits, total.decimals)}</strong>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="inset-list">
                      {shown.signers.map((signer) => (
                        <div className="inset" key={signer.environment}>
                          <IconTile>
                            <IconWallet size={18} />
                          </IconTile>
                          <div className="inset-body">
                            <span>
                              Signs {signer.lineCount} {signer.environment === 'evm' ? 'EVM' : 'native'} line{signer.lineCount === 1 ? '' : 's'}
                            </span>
                            <p className="mono">{signer.payer}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {shown.ok && runId && !locked && (
                  <div className="card-dark">
                    <p style={{ color: '#fff', fontSize: 17, fontWeight: 600 }}>Freeze version for review</p>
                    <p style={{ marginTop: 6 }}>
                      Freezing creates an immutable version with a SHA-256 fingerprint. Any later change creates a new version that needs approval again.
                    </p>
                    {shown.requiresAcknowledgement && (
                      <label style={{ display: 'flex', gap: 10, marginTop: 14, fontSize: 13.5, color: 'rgba(255,255,255,.85)' }}>
                        <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                        <span>
                          I checked {shown.duplicates.map((group) => group.lineIds.join(' and ')).join('; ')}. They pay the same amount to the same address and each will be
                          paid.
                        </span>
                      </label>
                    )}
                    <Button
                      variant="white"
                      block
                      className="mt-4"
                      busy={busy === 'freeze'}
                      disabled={shown.requiresAcknowledgement && !acknowledged}
                      onClick={() => void freeze()}
                      style={{ marginTop: 16 }}
                    >
                      Freeze version for review
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>

          <aside className="stack">
            <div className="stepper" aria-label="Import steps">
              {steps.map((step, index) => (
                <div key={step.title} className={`step ${index === currentStep ? 'active' : index < currentStep ? 'done' : ''}`}>
                  <span className="step-index">{index < currentStep ? <IconCheck size={16} strokeWidth={2.2} /> : String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <strong>{step.title}</strong>
                    <p>{step.body}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="card">
              <h2 className="card-title">Required columns</h2>
              <dl className="kv" style={{ marginTop: 12 }}>
                {REQUIRED.map((field) => (
                  <div key={field} style={{ display: 'contents' }}>
                    <dt className="mono" style={{ color: 'var(--ink)' }}>
                      {field}
                    </dt>
                    <dd style={{ color: 'var(--ink-2)' }}>{COLUMN_HELP[field]}</dd>
                  </div>
                ))}
              </dl>
              <p className="card-desc" style={{ marginTop: 12 }}>
                Optional: recipient_name, recipient_id, invoice_id, note, source_wallet. Other columns are ignored and listed.
              </p>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}

export default function NewRunPage() {
  return (
    <Suspense>
      <ImportScreen />
    </Suspense>
  );
}
