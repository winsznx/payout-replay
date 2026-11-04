'use client';

import Link from 'next/link';
import { type ButtonHTMLAttributes, type ReactNode, useState } from 'react';

import type { AttemptView, LineView, ObligationStatus } from '@/lib/types';

type Tone = 'settled' | 'failed' | 'review' | 'waiting' | 'accent' | 'neutral';

const TONE_CLASS: Record<Tone, string> = {
  settled: 'text-settled bg-settled-wash',
  failed: 'text-failed bg-failed-wash',
  review: 'text-review bg-review-wash',
  waiting: 'text-waiting bg-waiting-wash',
  accent: 'text-accent bg-accent-wash',
  neutral: 'text-ink-2 bg-sunken',
};

/** Glyphs carry meaning on their own so status never depends on colour alone. */
function Glyph({ shape, className = '' }: { shape: 'check' | 'cross' | 'bang' | 'dot' | 'ring' | 'half' | 'dash'; className?: string }) {
  const common = { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': true, className } as const;
  switch (shape) {
    case 'check':
      return (
        <svg {...common}>
          <path d="M2.5 7.5 5.5 10.5 11.5 3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'cross':
      return (
        <svg {...common}>
          <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case 'bang':
      return (
        <svg {...common}>
          <path d="M7 2.5v5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="7" cy="11" r="1.2" fill="currentColor" />
        </svg>
      );
    case 'half':
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M7 2a5 5 0 0 1 0 10z" fill="currentColor" />
        </svg>
      );
    case 'ring':
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.4 2" />
        </svg>
      );
    case 'dash':
      return (
        <svg {...common}>
          <path d="M3 7h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="3" fill="currentColor" />
        </svg>
      );
  }
}

const STATUS: Record<ObligationStatus, { label: string; tone: Tone; glyph: Parameters<typeof Glyph>[0]['shape'] }> = {
  approved_unattempted: { label: 'Not attempted', tone: 'neutral', glyph: 'dash' },
  awaiting_signature: { label: 'Awaiting signature', tone: 'accent', glyph: 'ring' },
  submitted: { label: 'Submitted', tone: 'waiting', glyph: 'ring' },
  confirming: { label: 'Confirming', tone: 'waiting', glyph: 'half' },
  paid_verified: { label: 'Paid, verified', tone: 'settled', glyph: 'check' },
  failed_verified: { label: 'Failed, verified', tone: 'failed', glyph: 'cross' },
  incorrect: { label: 'Incorrect transfer', tone: 'failed', glyph: 'bang' },
  needs_review: { label: 'Needs review', tone: 'review', glyph: 'bang' },
  manually_resolved: { label: 'Resolved manually', tone: 'neutral', glyph: 'dot' },
};

export function StatusMark({ status }: { status: ObligationStatus }) {
  const meta = STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-[4px] px-1.5 py-0.5 text-[13px] font-medium whitespace-nowrap ${TONE_CLASS[meta.tone]}`}>
      <Glyph shape={meta.glyph} />
      {meta.label}
    </span>
  );
}

export function RunStatusMark({ status, label }: { status: string; label: string }) {
  const tone: Tone =
    status === 'complete' ? 'settled' : status === 'needs_review' ? 'review' : status === 'incomplete' ? 'failed' : ['executing', 'reconciling', 'recovering'].includes(status) ? 'waiting' : 'neutral';
  const glyph = tone === 'settled' ? 'check' : tone === 'review' ? 'bang' : tone === 'failed' ? 'cross' : tone === 'waiting' ? 'half' : 'dash';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-[4px] px-1.5 py-0.5 text-[13px] font-medium whitespace-nowrap ${TONE_CLASS[tone]}`}>
      <Glyph shape={glyph} />
      {label}
    </span>
  );
}

type TickState = 'done' | 'current' | 'failed' | 'unknown' | 'empty';

/**
 * The settlement trail: Approved → Submitted → Included → Finalised → Matched.
 * Each tick is filled only from stored evidence for the latest attempt.
 */
export function settlementTrail(line: LineView): { label: string; state: TickState; note?: string }[] {
  const latest: AttemptView | undefined = line.attempts.at(-1);
  const settled = line.status === 'paid_verified';
  const outcome = latest?.outcome;
  const submitted = latest && latest.phase !== 'prepared' && latest.phase !== 'signature_rejected';
  const included = settled || outcome?.kind === 'included' || outcome?.kind === 'finalized_success' || (outcome?.kind === 'finalized_failure' && Boolean(outcome.evidence));
  const finalized = settled || outcome?.kind === 'finalized_success' || outcome?.kind === 'finalized_failure';
  const failedFinal = outcome?.kind === 'finalized_failure';
  const unknown = outcome?.kind === 'unknown';
  return [
    { label: 'Approved', state: 'done' },
    {
      label: 'Submitted',
      state: settled || submitted ? 'done' : latest?.phase === 'prepared' ? 'current' : 'empty',
      ...(latest?.phase === 'signature_rejected' ? { note: 'signature rejected' } : {}),
    },
    {
      label: 'Included',
      state: included ? (failedFinal && outcome.reason === 'evm_reverted' ? 'failed' : 'done') : unknown ? 'unknown' : submitted ? 'current' : 'empty',
    },
    { label: 'Finalised', state: finalized ? (failedFinal ? 'failed' : 'done') : included ? 'current' : unknown ? 'unknown' : 'empty' },
    {
      label: 'Matched',
      state: settled ? 'done' : line.status === 'incorrect' || failedFinal ? 'failed' : unknown || line.status === 'needs_review' ? 'unknown' : 'empty',
    },
  ];
}

const TICK_STYLE: Record<TickState, string> = {
  done: 'bg-settled text-paper border-settled',
  current: 'bg-transparent text-waiting border-waiting',
  failed: 'bg-failed text-paper border-failed',
  unknown: 'bg-review-wash text-review border-review',
  empty: 'bg-transparent text-transparent border-rule-strong',
};

export function TickTrail({ line, compact = false }: { line: LineView; compact?: boolean }) {
  const steps = settlementTrail(line);
  return (
    <ol className="flex items-center gap-0" aria-label="Settlement trail">
      {steps.map((step, index) => (
        <li key={step.label} className="flex items-center">
          {index > 0 && <span className={`h-px w-3 ${step.state === 'empty' ? 'bg-rule' : 'bg-rule-strong'}`} aria-hidden />}
          <span className="group relative flex items-center gap-1" title={`${step.label}: ${step.state}${step.note ? ` (${step.note})` : ''}`}>
            <span className={`flex h-[18px] w-[18px] items-center justify-center rounded-full border ${TICK_STYLE[step.state]}`}>
              <Glyph
                shape={step.state === 'done' ? 'check' : step.state === 'failed' ? 'cross' : step.state === 'unknown' ? 'bang' : step.state === 'current' ? 'ring' : 'dot'}
                className="h-[11px] w-[11px]"
              />
            </span>
            {!compact && <span className={`text-[12px] ${step.state === 'empty' ? 'text-ink-3' : 'text-ink-2'}`}>{step.label}</span>}
            <span className="sr-only">{`${step.label}: ${step.state}`}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function Button({
  variant = 'secondary',
  busy = false,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; busy?: boolean }) {
  const styles = {
    primary: 'bg-accent text-accent-ink border-accent hover:brightness-110',
    secondary: 'bg-surface text-ink border-rule-strong hover:bg-sunken',
    danger: 'bg-surface text-failed border-failed hover:bg-failed-wash',
    ghost: 'bg-transparent text-ink-2 border-transparent hover:bg-sunken',
  }[variant];
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-[5px] border px-3 py-1.5 text-[14px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    >
      {busy && <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}

export function ButtonLink({ href, children, variant = 'secondary' }: { href: string; children: ReactNode; variant?: 'primary' | 'secondary' }) {
  const styles = variant === 'primary' ? 'bg-accent text-accent-ink border-accent hover:brightness-110' : 'bg-surface text-ink border-rule-strong hover:bg-sunken';
  return (
    <Link href={href} className={`inline-flex items-center justify-center gap-2 rounded-[5px] border px-3 py-1.5 text-[14px] font-medium ${styles}`}>
      {children}
    </Link>
  );
}

export function CopyText({ value, display, className = '' }: { value: string; display?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={`inline-flex items-baseline gap-1.5 ${className}`}>
      <span className="hash">{display ?? value}</span>
      <button
        type="button"
        className="shrink-0 rounded px-1 text-[12px] text-ink-3 hover:bg-sunken hover:text-ink"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
        aria-label={`Copy ${value}`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

export function Notice({ tone = 'neutral', title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  const border = {
    settled: 'border-settled',
    failed: 'border-failed',
    review: 'border-review',
    waiting: 'border-waiting',
    accent: 'border-accent',
    neutral: 'border-rule-strong',
  }[tone];
  return (
    <div role={tone === 'failed' ? 'alert' : 'status'} className={`border-l-[3px] bg-surface px-4 py-3 text-[14px] ${border}`}>
      {title && <p className="font-semibold text-ink">{title}</p>}
      <div className="text-ink-2">{children}</div>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-4">
      <div className="max-w-[70ch]">
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        {description && <div className="mt-1 text-[15px] text-ink-2">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Section({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold text-ink">{title}</h2>
          {description && <p className="text-[14px] text-ink-3">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Table({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="overflow-x-auto border border-rule bg-surface">
      <table className="w-full border-collapse text-left text-[14px]" aria-label={label}>
        {children}
      </table>
    </div>
  );
}

export const th = 'border-b border-rule bg-sunken px-3 py-2 text-[13px] font-medium text-ink-2 whitespace-nowrap';
export const td = 'border-b border-rule px-3 py-2.5 align-top';

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="h-9 animate-pulse rounded bg-sunken" />
      ))}
    </div>
  );
}

export function KeyValue({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-[max-content_1fr]">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-[13px] text-ink-3">{item.label}</dt>
          <dd className="min-w-0 text-[14px] text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
