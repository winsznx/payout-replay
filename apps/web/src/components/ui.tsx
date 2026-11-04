'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ButtonHTMLAttributes, type ReactNode, useState } from 'react';

import type { AttemptView, LineView, ObligationStatus } from '@/lib/types';

import { IconAlert, IconArrowRight, IconCheck, IconChevronLeft, IconChevronRight, IconClock, IconX } from './icons';

export type Tone = 'settled' | 'failed' | 'review' | 'waiting' | 'neutral';

type ButtonVariant = 'primary' | 'secondary' | 'soft' | 'white' | 'danger' | 'ghost';

export function Button({
  variant = 'secondary',
  size,
  busy = false,
  block = false,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm'; busy?: boolean; block?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
      className={`btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''} ${block ? 'btn-block' : ''} ${className}`}
    >
      {busy && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  variant = 'secondary',
  size,
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  size?: 'sm';
  children: ReactNode;
}) {
  return (
    <Link href={href} className={`btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''}`}>
      {children}
    </Link>
  );
}

export const STATUS: Record<ObligationStatus, { label: string; tone: Tone }> = {
  approved_unattempted: { label: 'Not attempted', tone: 'neutral' },
  awaiting_signature: { label: 'Awaiting signature', tone: 'waiting' },
  submitted: { label: 'Submitted', tone: 'waiting' },
  confirming: { label: 'Confirming', tone: 'waiting' },
  paid_verified: { label: 'Paid, verified', tone: 'settled' },
  failed_verified: { label: 'Failed, verified', tone: 'failed' },
  incorrect: { label: 'Incorrect transfer', tone: 'failed' },
  needs_review: { label: 'Needs review', tone: 'review' },
  manually_resolved: { label: 'Resolved manually', tone: 'neutral' },
};

export function ToneIcon({ tone, size = 14 }: { tone: Tone; size?: number }) {
  if (tone === 'settled') return <IconCheck size={size} strokeWidth={2.2} />;
  if (tone === 'failed') return <IconX size={size} strokeWidth={2.2} />;
  if (tone === 'review') return <IconAlert size={size} strokeWidth={2} />;
  if (tone === 'waiting') return <IconClock size={size} strokeWidth={2} />;
  return <span className="dot dot-neutral" aria-hidden />;
}

export function StatusPill({ status }: { status: ObligationStatus }) {
  const meta = STATUS[status];
  return (
    <span className={`pill tone-${meta.tone}`}>
      <ToneIcon tone={meta.tone} />
      {meta.label}
    </span>
  );
}

export const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  validated: { label: 'Validated', tone: 'neutral' },
  awaiting_approval: { label: 'Awaiting approval', tone: 'review' },
  approved: { label: 'Approved', tone: 'waiting' },
  executing: { label: 'Executing', tone: 'waiting' },
  reconciling: { label: 'Waiting for finality', tone: 'waiting' },
  recovering: { label: 'Recovering', tone: 'waiting' },
  complete: { label: 'Complete', tone: 'settled' },
  incomplete: { label: 'Incomplete', tone: 'failed' },
  needs_review: { label: 'Needs review', tone: 'review' },
};

export function RunStatusPill({ status }: { status: string }) {
  const meta = RUN_STATUS[status] ?? { label: status, tone: 'neutral' as const };
  return (
    <span className={`pill tone-${meta.tone}`}>
      <ToneIcon tone={meta.tone} />
      {meta.label}
    </span>
  );
}

export function IconTile({ tone, children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`icon-tile ${tone && tone !== 'neutral' ? `tone-${tone}` : ''}`}>{children}</span>;
}

type TrailState = 'done' | 'current' | 'failed' | 'unknown' | 'empty';

/** Approved, Submitted, Included, Finalised, Matched: each step is filled only from stored evidence. */
export function trailFor(line: LineView): { label: string; state: TrailState }[] {
  const latest: AttemptView | undefined = line.attempts.at(-1);
  const settled = line.status === 'paid_verified';
  const outcome = latest?.outcome;
  const submitted = Boolean(latest && latest.phase !== 'prepared' && latest.phase !== 'signature_rejected');
  const failedFinal = outcome?.kind === 'finalized_failure';
  const unknown = outcome?.kind === 'unknown';
  const included =
    settled || outcome?.kind === 'included' || outcome?.kind === 'finalized_success' || (failedFinal && Boolean(outcome.evidence));
  const finalized = settled || outcome?.kind === 'finalized_success' || failedFinal;
  return [
    { label: 'Approved', state: 'done' },
    { label: 'Submitted', state: settled || submitted ? 'done' : latest?.phase === 'prepared' ? 'current' : 'empty' },
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

export function Trail({ line, labels = false }: { line: LineView; labels?: boolean }) {
  const steps = trailFor(line);
  return (
    <div>
      <ol className="trail" aria-label="Settlement trail">
        {steps.map((step, index) => (
          <li key={step.label} title={`${step.label}: ${step.state}`}>
            {index > 0 && <span className={`trail-link ${step.state === 'done' ? 'done' : ''}`} aria-hidden />}
            <span className={`trail-node ${step.state}`}>
              {step.state === 'done' && <IconCheck size={12} strokeWidth={2.6} />}
              {step.state === 'failed' && <IconX size={12} strokeWidth={2.6} />}
              {step.state === 'unknown' && <IconAlert size={11} strokeWidth={2.4} />}
            </span>
            <span className="sr-only">{`${step.label}: ${step.state}`}</span>
          </li>
        ))}
      </ol>
      {labels && (
        <div className="trail-labels" aria-hidden>
          {steps.map((step) => (
            <span key={step.label}>{step.label}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export function CopyText({ value, display }: { value: string; display?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copy">
      <span className="mono">{display ?? value}</span>
      <button
        type="button"
        aria-label={`Copy ${value}`}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

export function Notice({ tone = 'info', title, children }: { tone?: 'failed' | 'review' | 'info' | 'settled'; title?: string; children?: ReactNode }) {
  const iconTone: Tone = tone === 'info' ? 'waiting' : tone;
  return (
    <div className={`notice notice-${tone}`} role={tone === 'failed' ? 'alert' : 'status'}>
      <span className="icon-tile" style={{ background: '#fff' }}>
        <ToneIcon tone={iconTone} size={16} />
      </span>
      <div>
        {title && <strong>{title}</strong>}
        {children && <p>{children}</p>}
      </div>
    </div>
  );
}

export function TopBar({ crumbs, actions }: { crumbs: { label: string; href?: string }[]; actions?: ReactNode }) {
  const router = useRouter();
  return (
    <header className="topbar">
      <nav className="crumbs" aria-label="Breadcrumb">
        <span className="crumb-nav">
          <button type="button" aria-label="Back" onClick={() => router.back()}>
            <IconChevronLeft size={16} />
          </button>
          <button type="button" aria-label="Forward" onClick={() => router.forward()}>
            <IconChevronRight size={16} />
          </button>
        </span>
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <span key={`${crumb.label}-${index}`} style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
              {index > 0 && (
                <span className="crumb-sep" aria-hidden>
                  /
                </span>
              )}
              {crumb.href && !last ? (
                <Link href={crumb.href}>{crumb.label}</Link>
              ) : (
                <span aria-current={last ? 'page' : undefined}>{crumb.label}</span>
              )}
            </span>
          );
        })}
      </nav>
      {actions && <div className="topbar-actions">{actions}</div>}
    </header>
  );
}

export function PageHead({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </div>
  );
}

export function StatTile({
  icon,
  tone,
  label,
  value,
  sub,
  link,
}: {
  icon: ReactNode;
  tone?: Tone;
  label: string;
  value: ReactNode;
  sub?: { tone: Tone; label: string; value: ReactNode };
  link?: { href: string; label: string };
}) {
  return (
    <div className="tile">
      <div className="tile-top">
        <IconTile tone={tone}>{icon}</IconTile>
        <div>
          <span>{label}</span>
          <strong className="num">{value}</strong>
        </div>
      </div>
      {sub && (
        <div className="tile-sub">
          <span className={`dot dot-${sub.tone}`} aria-hidden />
          {sub.label}
          <b className="num">{sub.value}</b>
        </div>
      )}
      {link && (
        <Link href={link.href} className="tile-link">
          {link.label}
          <IconArrowRight size={16} />
        </Link>
      )}
    </div>
  );
}

export function Module({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="module">
      <div className="module-head">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Skeleton({ rows = 3, height = 64 }: { rows?: number; height?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}

export function Empty({ icon, title, children, actions }: { icon?: ReactNode; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <span className="icon-tile">{icon}</span>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {actions && <div className="page-head-actions" style={{ marginTop: 8 }}>{actions}</div>}
    </div>
  );
}

export function KeyValue({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="kv">
      {items.map((item) => (
        <div key={item.label} style={{ display: 'contents' }}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
