import Link from 'next/link';

const SHEET: { line: string; who: string; amount: string; state: 'paid' | 'failed' | 'unknown'; proof: string }[] = [
  { line: 'TASK-101', who: 'Contributor A', amount: '50 tPOT', state: 'paid', proof: 'Finalised extrinsic, Balances.Transfer at index 2' },
  { line: 'TASK-102', who: 'Contributor B', amount: '100 PRT', state: 'paid', proof: 'PaymentExecuted and ERC-20 Transfer in one receipt' },
  { line: 'TASK-103', who: 'Contributor C', amount: '40.5 PRT', state: 'failed', proof: 'Reverted on-chain. Safe to pay again' },
  { line: 'TASK-104', who: 'Contributor D', amount: '10 PRT', state: 'unknown', proof: 'Broadcast result lost. Blocked until proven' },
];

const MARK = {
  paid: { text: 'Paid, verified', className: 'text-settled bg-settled-wash', glyph: '✓' },
  failed: { text: 'Failed, verified', className: 'text-failed bg-failed-wash', glyph: '✕' },
  unknown: { text: 'Needs review', className: 'text-review bg-review-wash', glyph: '!' },
} as const;

export default function Landing() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-8">
      <header className="flex items-center justify-between">
        <span className="text-[16px] font-semibold tracking-[-0.01em]">Payout Replay</span>
        <Link href="/app" className="rounded-[5px] border border-accent bg-accent px-3 py-1.5 text-[14px] font-medium text-accent-ink">
          Open the app
        </Link>
      </header>

      <section className="mt-16 grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-start">
        <div>
          <h1 className="text-[40px] leading-[1.08] font-semibold tracking-[-0.02em] sm:text-[52px]">
            Know who actually got paid. Fix only what didn’t.
          </h1>
          <p className="mt-5 max-w-[52ch] text-[17px] text-ink-2">
            Import the payout sheet your team approved. Sign each transfer on Portaldot V3, native tPOT or EVM tokens. Payout Replay checks every line
            against finalised chain evidence, and when something fails it prepares a correction for that line and nothing else.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/app" className="rounded-[5px] border border-accent bg-accent px-4 py-2 text-[15px] font-medium text-accent-ink">
              Sign in with your wallet
            </Link>
            <Link href="/app/developers" className="rounded-[5px] border border-rule-strong bg-surface px-4 py-2 text-[15px] font-medium">
              API and SDK
            </Link>
          </div>
          <p className="mt-6 max-w-[56ch] text-[14px] text-ink-3">
            Non-custodial: every payment and correction is signed by your own wallet. Testnet only, with unaudited contracts. If the chain can’t prove what
            happened to a payment, Payout Replay says so and won’t offer to pay it again.
          </p>
        </div>

        <figure className="border border-rule bg-surface">
          <figcaption className="flex items-center justify-between border-b border-rule px-4 py-2 text-[13px] text-ink-3">
            <span>november-contributors.csv after reconciliation</span>
            <span className="rounded-[3px] bg-sunken px-1.5 py-0.5 text-[12px] text-ink-2">Illustration</span>
          </figcaption>
          <table className="w-full text-[14px]">
            <tbody>
              {SHEET.map((row) => (
                <tr key={row.line} className="border-b border-rule last:border-b-0">
                  <td className="px-4 py-3 align-top">
                    <span className="font-medium">{row.line}</span>
                    <span className="block text-[13px] text-ink-3">{row.who}</span>
                  </td>
                  <td className="num px-2 py-3 text-right align-top whitespace-nowrap">{row.amount}</td>
                  <td className="px-4 py-3 align-top">
                    <span className={`inline-flex items-center gap-1.5 rounded-[4px] px-1.5 py-0.5 text-[13px] font-medium ${MARK[row.state].className}`}>
                      <span aria-hidden>{MARK[row.state].glyph}</span>
                      {MARK[row.state].text}
                    </span>
                    <span className="mt-1 block text-[13px] text-ink-2">{row.proof}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-rule px-4 py-3 text-[14px] text-ink-2">
            Correction offered for TASK-103 only. TASK-104 stays blocked, because paying it again could pay twice.
          </p>
        </figure>
      </section>

      <section className="mt-20 grid gap-8 border-t border-rule pt-10 md:grid-cols-3">
        <div>
          <h2 className="text-[17px] font-semibold">Approved is not paid</h2>
          <p className="mt-2 text-[15px] text-ink-2">
            A line counts as paid only when a finalised transfer from your wallet matches its recipient, asset and exact amount.
          </p>
        </div>
        <div>
          <h2 className="text-[17px] font-semibold">A timeout is not a failure</h2>
          <p className="mt-2 text-[15px] text-ink-2">
            Lost RPC responses and unknown broadcasts stay in review until the chain settles them: a mortal era closes, a nonce is consumed, or a receipt appears.
          </p>
        </div>
        <div>
          <h2 className="text-[17px] font-semibold">One sheet in, the same sheet out</h2>
          <p className="mt-2 text-[15px] text-ink-2">
            Export your original rows with status, transaction, block and exception columns, ready for the accounting file.
          </p>
        </div>
      </section>
    </main>
  );
}
