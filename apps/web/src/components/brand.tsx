import Link from 'next/link';

/**
 * The Payout Replay mark: three ledger lines. Two end in a settled stop; the middle one
 * loops back into a replay ring, because only an unsettled line is ever paid again.
 */
export function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="#0D0E10" />
      <path d="M7.5 10h12" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <rect x="21.5" y="8" width="4" height="4" rx="1" fill="#fff" />
      <path d="M7.5 16h8.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M24.6 16a3.6 3.6 0 1 1-1.05-2.55" fill="none" stroke="#3B71F0" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M24.4 11.6v2.6h-2.6" fill="none" stroke="#3B71F0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.5 22h12" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <rect x="21.5" y="20" width="4" height="4" rx="1" fill="#fff" />
    </svg>
  );
}

export function Wordmark({ href = '/', size = 30 }: { href?: string; size?: number }) {
  return (
    <Link href={href} className="brand-lockup" aria-label="Payout Replay home">
      <Mark size={size} />
      <span>Payout Replay</span>
    </Link>
  );
}
