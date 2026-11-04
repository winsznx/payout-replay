import Link from 'next/link';

import { Wordmark } from '@/components/brand';
import {
  IconAlert,
  IconArrowRight,
  IconChain,
  IconCheck,
  IconCode,
  IconDownload,
  IconFile,
  IconLayers,
  IconRefresh,
  IconSpark,
  IconUpload,
  IconWallet,
  IconX,
} from '@/components/icons';

import './app/app.css';
import './marketing.css';

const SEQUENCE = [
  { title: 'Import the approved sheet', body: 'Every address, asset and decimal is checked line by line.' },
  { title: 'Freeze and approve', body: 'A reviewer approves one exact SHA-256 fingerprint.' },
  { title: 'Sign from your own wallet', body: 'Native tPOT and EVM tokens, one line at a time.' },
  { title: 'Verify against finality', body: 'Paid only when a finalised block proves the exact transfer.' },
  { title: 'Recover only what failed', body: 'Uncertain lines stay blocked, so nobody is paid twice.' },
];

function Pill({ tone, children }: { tone: 'settled' | 'failed' | 'review'; children: string }) {
  return (
    <span className={`pill tone-${tone}`}>
      {tone === 'settled' ? <IconCheck size={13} strokeWidth={2.2} /> : tone === 'failed' ? <IconX size={13} strokeWidth={2.2} /> : <IconAlert size={13} />}
      {children}
    </span>
  );
}

function RunMock() {
  return (
    <div className="app-mock">
      <div className="app-mock-head">
        <span className="avatar">N</span>
        <div>
          <strong>November contributors</strong>
          <small>Version 1 · 4 lines · 2 environments</small>
        </div>
        <span className="mock-chip">Approved</span>
      </div>
      <div className="mock-panel">
        <div className="mock-panel-top">
          <span>Verified paid</span>
          <span>Finalised #320488</span>
        </div>
        <div className="mock-readout">
          <strong className="num">2 of 4</strong>
          <span>lines settled on-chain</span>
        </div>
        <div className="mock-actions">
          <div>
            <span>
              <IconUpload size={18} />
            </span>
            Import
          </div>
          <div>
            <span>
              <IconCheck size={18} />
            </span>
            Approve
          </div>
          <div className="on">
            <span>
              <IconWallet size={18} />
            </span>
            Sign
          </div>
          <div>
            <span>
              <IconRefresh size={18} />
            </span>
            Recover
          </div>
        </div>
      </div>
      <div className="mock-lines">
        <div className="mock-line">
          <span className="icon-tile tone-settled" style={{ width: 38, height: 38 }}>
            <IconChain size={16} />
          </span>
          <div className="grow">
            <strong>TASK-101</strong>
            <small>transfer_keep_alive, extrinsic 2</small>
          </div>
          <span className="amt num">50 tPOT</span>
        </div>
        <div className="mock-line">
          <span className="icon-tile tone-failed" style={{ width: 38, height: 38 }}>
            <IconLayers size={16} />
          </span>
          <div className="grow">
            <strong>TASK-103</strong>
            <small>Reverted on-chain, safe to pay again</small>
          </div>
          <span className="amt num">40.5 PRT</span>
        </div>
        <div className="mock-line">
          <span className="icon-tile tone-review" style={{ width: 38, height: 38 }}>
            <IconLayers size={16} />
          </span>
          <div className="grow">
            <strong>TASK-104</strong>
            <small>Broadcast result lost, blocked</small>
          </div>
          <span className="amt num">10 PRT</span>
        </div>
      </div>
    </div>
  );
}

export default function Landing() {
  return (
    <div className="site">
      <header className="site-header">
        <div className="container site-header-inner">
          <Wordmark />
          <nav className="site-nav" aria-label="Sections">
            <a href="#how">How it works</a>
            <a href="#safety">Why it’s safe</a>
            <a href="#recovery">Recovery</a>
            <a href="#developers">Developers</a>
          </nav>
          <div className="site-actions">
            <Link href="/app" className="login">
              Sign in
            </Link>
            <Link href="/app" className="pill-btn pill-btn-black">
              Open the app
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="container">
            <span className="eyebrow">
              <IconSpark size={15} />
              Portaldot V3 <i>·</i> native tPOT <i>·</i> EVM tokens
            </span>
            <h1>Know who actually got paid. Fix only what didn’t.</h1>
            <p className="hero-sub">
              Import the payout sheet your team already approved. Sign each line from your own wallet, verify it against finalised chain evidence, and when something
              fails, pay that line again and nothing else.
            </p>
            <div className="hero-actions">
              <Link href="/app" className="pill-btn pill-btn-black pill-btn-lg">
                Start a payout run
              </Link>
              <a href="#how" className="pill-btn pill-btn-outline pill-btn-lg">
                See how it works
              </a>
            </div>

            <div className="hero-panels">
              <div className="sky sky-left">
                <div className="sky-copy">
                  <strong>An approved line is not a payment.</strong>
                  <span>Each row stays open until a finalised block shows the exact transfer from your payout wallet.</span>
                </div>
                <div className="float-card">
                  <span className="icon-chip tone-settled">
                    <IconCheck size={18} />
                  </span>
                  <div className="grow">
                    <strong>Contributor A</strong>
                    <small>Paid, verified at finality</small>
                  </div>
                  <span className="value num">+50 tPOT</span>
                </div>
                <div className="float-card">
                  <span className="icon-chip tone-review">
                    <IconAlert size={18} />
                  </span>
                  <div className="grow">
                    <strong>Contributor D</strong>
                    <small>Outcome unknown, never retried</small>
                  </div>
                  <span className="value num">10 PRT</span>
                </div>
              </div>

              <div className="sky sky-right">
                <span className="illustration-tag">Illustration</span>
                <div className="stat-float">
                  <strong>Outstanding PRT</strong>
                  <div className="meter">
                    <span style={{ width: '68%' }} />
                  </div>
                  <p>
                    <span className="num">
                      <b style={{ color: 'var(--ink)', fontWeight: 600 }}>50.5</b> still owed
                    </span>
                    <span className="num">of 150.5</span>
                  </p>
                </div>
                <RunMock />
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="how">
          <div className="container">
            <div className="section-split">
              <div>
                <span className="eyebrow">
                  <IconSpark size={15} />
                  How it works
                </span>
                <h2>From approved sheet to proven settlement</h2>
              </div>
              <p className="section-lead">
                Treasury teams already keep the spreadsheet. Payout Replay keeps every row tied to its approval, its signature and the block that settled it, so the
                answer to “did they get paid?” is evidence, not memory.
              </p>
            </div>
            <div className="solutions">
              <div className="seq">
                {SEQUENCE.map((item, index) => (
                  <div key={item.title} className={`seq-item ${index === 2 ? 'active' : ''}`}>
                    <b>{String(index + 1).padStart(2, '0')}</b>
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.body}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="sky solutions-art">
                <div className="glass">
                  <strong>64</strong>
                  <span>blocks. Every native payment is signed with a mortal era, so “never landed” becomes provable instead of a guess.</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="safety">
          <div className="container">
            <div className="centered">
              <span className="eyebrow">
                <IconSpark size={15} />
                Why it’s safe
              </span>
              <h2>Built so nobody gets paid twice</h2>
              <p className="section-lead">A timeout isn’t a failure, and a missing record isn’t proof of non-payment.</p>
            </div>
            <div className="three">
              <div className="feature">
                <span className="feature-icon">
                  <IconAlert size={30} />
                </span>
                <h3>Unknown stays unknown</h3>
                <p>Lost wallet responses and RPC timeouts are held for review until the chain settles them.</p>
                <div className="feature-inner">
                  <p style={{ fontWeight: 600 }}>Line status</p>
                  <div className="mini-field">
                    <small>Attempt 1</small>
                    <div>
                      <span>Broadcast result lost</span>
                      <Pill tone="review">Needs review</Pill>
                    </div>
                  </div>
                  <div className="mini-field">
                    <small>Recovery</small>
                    <div>
                      <span>Not offered</span>
                      <IconX size={16} />
                    </div>
                  </div>
                  <div className="mini-row" style={{ marginTop: 8 }}>
                    <span>Released when</span>
                    <span>era closes or nonce is used</span>
                  </div>
                </div>
              </div>

              <div className="feature sky">
                <span className="feature-icon">
                  <IconLayers size={30} />
                </span>
                <h3 style={{ position: 'relative', zIndex: 1 }}>Native and EVM in one sheet</h3>
                <p style={{ position: 'relative', zIndex: 1 }}>
                  One run pays tPOT through the runtime and tokens through the PayoutExecutor contract. Each side is verified on its own.
                </p>
                <div className="feature-inner">
                  <div className="mini-row">
                    <span>Native</span>
                    <b>Balances.transfer_keep_alive</b>
                  </div>
                  <div className="mini-row">
                    <span>EVM</span>
                    <b>PaymentExecuted + Transfer</b>
                  </div>
                  <div className="mini-row">
                    <span>Finality</span>
                    <b>GRANDPA / finalized tag</b>
                  </div>
                  <div className="mini-row">
                    <span>Duplicate ID</span>
                    <b>reverts on-chain</b>
                  </div>
                </div>
              </div>

              <div className="feature">
                <span className="feature-icon">
                  <IconFile size={30} />
                </span>
                <h3>Proof on every row</h3>
                <p>Every paid line carries the transaction, block and event index that proved it.</p>
                <div className="feature-inner" style={{ textAlign: 'center' }}>
                  <span className="ok-badge">
                    <IconCheck size={24} strokeWidth={2.4} />
                  </span>
                  <p style={{ fontWeight: 600 }}>Paid, verified</p>
                  <p style={{ fontSize: 13, color: 'var(--ink-3)' }}>TASK-102 · 100 PRT</p>
                  <div style={{ borderTop: '1px solid var(--border)', marginTop: 14, paddingTop: 8, textAlign: 'left' }}>
                    <div className="mini-row">
                      <span>Block</span>
                      <b>#320412</b>
                    </div>
                    <div className="mini-row">
                      <span>Log index</span>
                      <b>1</b>
                    </div>
                  </div>
                  <div className="mini-btn">
                    <IconDownload size={16} />
                    Download reconciled CSV
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="recovery">
          <div className="container">
            <div className="section-split">
              <div>
                <span className="eyebrow">
                  <IconSpark size={15} />
                  Recovery and records
                </span>
                <h2>Fix the gap, keep the record</h2>
              </div>
              <p className="section-lead">
                After an interruption you see exactly what is safe to pay again and why everything else is held. When you’re done, you get your own sheet back.
              </p>
            </div>
            <div className="grid-two">
              <div className="big-feature">
                <span className="circle-icon">
                  <IconRefresh size={26} />
                </span>
                <h3>Recovery offers only what failed</h3>
                <p>A correction reuses the original obligation ID, so the executor refuses to pay the same line twice even if someone tries.</p>
                <div className="device">
                  <p className="device-title">Recovery plan</p>
                  <div className="mock-line">
                    <span className="icon-tile tone-failed" style={{ width: 38, height: 38 }}>
                      <IconLayers size={16} />
                    </span>
                    <div className="grow">
                      <strong>TASK-103</strong>
                      <small>Every attempt reverted</small>
                    </div>
                    <Pill tone="settled">Safe to pay</Pill>
                  </div>
                  <div className="mock-line">
                    <span className="icon-tile tone-settled" style={{ width: 38, height: 38 }}>
                      <IconChain size={16} />
                    </span>
                    <div className="grow">
                      <strong>TASK-101</strong>
                      <small>Already verified</small>
                    </div>
                    <Pill tone="review">Blocked</Pill>
                  </div>
                  <div className="mock-line">
                    <span className="icon-tile tone-review" style={{ width: 38, height: 38 }}>
                      <IconLayers size={16} />
                    </span>
                    <div className="grow">
                      <strong>TASK-104</strong>
                      <small>Outcome unknown</small>
                    </div>
                    <Pill tone="review">Blocked</Pill>
                  </div>
                </div>
              </div>
              <div className="big-feature">
                <span className="circle-icon">
                  <IconFile size={26} />
                </span>
                <h3>The same sheet, with proof</h3>
                <p>Export one row per approved line with status, transaction, block and exception columns. Base units stay exact, and incomplete runs say so.</p>
                <div className="device">
                  <p className="device-title">november-contributors.csv</p>
                  {[
                    ['TASK-101', 'paid_verified', '0x8f13…bb07'],
                    ['TASK-102', 'paid_verified', '0x4bae…5439'],
                    ['TASK-103', 'paid_verified', '0x3ed0…f435'],
                    ['TASK-104', 'needs_review', ''],
                  ].map(([line, status, tx]) => (
                    <div className="mock-line" key={line}>
                      <div className="grow">
                        <strong>{line}</strong>
                        <small className="mono">{tx || 'no settlement proven'}</small>
                      </div>
                      <Pill tone={status === 'paid_verified' ? 'settled' : 'review'}>{status === 'paid_verified' ? 'paid_verified' : 'needs_review'}</Pill>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="developers">
          <div className="container">
            <div className="dev">
              <div>
                <span className="eyebrow">
                  <IconCode size={15} />
                  For developers
                </span>
                <h2>The engine is open source</h2>
                <p>
                  Use the TypeScript SDK to validate sheets, reconcile attempts and check extrinsics yourself, or call the REST API with an organisation key. Keys can
                  read and attach evidence. They can never sign.
                </p>
                <div className="dev-list">
                  <span>PayoutExecutor.sol</span>
                  <span>Native adapter</span>
                  <span>EVM adapter</span>
                  <span>REST API</span>
                  <span>Signed webhooks</span>
                </div>
              </div>
              <pre>{`import { reconcileRun, createRecoveryPlan } from '@payout-replay/sdk';

const result = reconcileRun({ manifestDigest, obligations, totals, attempts });
// paid_verified only from finalised, attributed proof

const plan = createRecoveryPlan({ frozen, reconciliation: result, chainSnapshot });
plan.eligible; // never attempted, or failed on-chain
plan.blocked;  // paid, in flight, or unknown, each with a reason`}</pre>
            </div>
          </div>
        </section>

        <div className="container">
          <section className="cta sky">
            <h2>Close the payout run with evidence</h2>
            <p>Testnet only, with unaudited contracts. Every payment is signed by your wallet, and the app never holds keys.</p>
            <div className="hero-actions">
              <Link href="/app" className="pill-btn pill-btn-black pill-btn-lg">
                Start a payout run
                <IconArrowRight size={18} />
              </Link>
              <Link href="/app/developers" className="pill-btn pill-btn-outline pill-btn-lg">
                API and SDK
              </Link>
            </div>
          </section>

          <footer className="site-footer">
            <Wordmark />
            <nav aria-label="Footer">
              <a href="#how">How it works</a>
              <a href="#recovery">Recovery</a>
              <Link href="/app">Open the app</Link>
              <Link href="/app/developers">Developers</Link>
            </nav>
            <span>Built for the Portaldot Hacker House 2026. Testnet only.</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
