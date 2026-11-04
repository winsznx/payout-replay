'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type FormEvent, type ReactNode, useState } from 'react';
import useSWR from 'swr';

import { apiPost, errorMessage, fetcher } from '@/lib/api';
import { shortHash } from '@/lib/format';
import { signOut, useSession } from '@/lib/session';
import type { Run } from '@/lib/types';

import { Mark, Wordmark } from './brand';
import { IconBook, IconCode, IconMenu, IconPlus, IconRuns, IconSignOut, IconUpload, IconWallet } from './icons';
import { Button, Notice, Skeleton } from './ui';
import { WalletConnect } from './wallet-connect';

const NAV = [
  { href: '/app', label: 'Payout runs', icon: IconRuns },
  { href: '/app/runs/new', label: 'Import a sheet', icon: IconUpload },
  { href: '/app/settings/wallets', label: 'Payout wallets', icon: IconWallet },
  { href: '/app/developers', label: 'API and SDK', icon: IconCode },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/app') return pathname === '/app' || /^\/app\/runs\/pr_/.test(pathname);
  return pathname.startsWith(href);
}

function CreateOrg({ onCreated }: { onCreated(orgId: string): void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const derivedSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const org = await apiPost<{ id: string }>('/orgs', { name, slug: derivedSlug });
      onCreated(org.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="stack" style={{ marginTop: 22 }}>
      <label className="field">
        <span>Organisation name</span>
        <input required minLength={2} value={name} onChange={(event) => setName(event.target.value)} className="input" placeholder="Northwind Contributors DAO" />
      </label>
      <label className="field">
        <span>Short name for links</span>
        <input value={derivedSlug} onChange={(event) => setSlug(event.target.value)} className="input mono" pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" />
      </label>
      {error && <Notice tone="failed">{error}</Notice>}
      <Button type="submit" variant="primary" busy={busy} block>
        Create organisation
      </Button>
    </form>
  );
}

function Gate({ children }: { children: ReactNode }) {
  return (
    <main className="gate">
      <div className="gate-card">
        <Wordmark />
        {children}
      </div>
    </main>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const { data: runs } = useSWR<Run[]>(session.orgId ? `/orgs/${session.orgId}/runs` : null, fetcher, { refreshInterval: 20_000 });
  const attention = runs?.filter((run) => ['needs_review', 'incomplete', 'awaiting_approval'].includes(run.status)).length ?? 0;

  if (session.loading) {
    return (
      <main className="gate">
        <div className="gate-card">
          <Skeleton rows={3} />
        </div>
      </main>
    );
  }

  if (!session.signedIn || !session.me) {
    return (
      <Gate>
        <h1>Sign in with the wallet you pay from</h1>
        <p>Your wallet is your identity. After signing in you can link a second wallet for the other environment.</p>
        <WalletConnect onDone={() => void session.refresh()} />
      </Gate>
    );
  }

  if (!session.org) {
    return (
      <Gate>
        <h1>Create the organisation that owns your payouts</h1>
        <p>You become its owner and can add operators and reviewers by wallet address later.</p>
        <CreateOrg
          onCreated={(orgId) => {
            session.selectOrg(orgId);
            void session.refresh();
          }}
        />
      </Gate>
    );
  }

  const me = session.me;
  const org = session.org;
  const doSignOut = () => void signOut().then(() => session.refresh());

  return (
    <div className="app-shell">
      <div className="mobile-bar">
        <Link href="/app" aria-label="Payout runs">
          <Mark size={30} />
        </Link>
        <button type="button" className="icon-btn" aria-label="Menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          <IconMenu size={18} />
        </button>
      </div>
      <nav className="mobile-menu" hidden={!menuOpen} aria-label="Mobile navigation">
        {NAV.map((item) => (
          <Link key={item.href} href={item.href} onClick={() => setMenuOpen(false)}>
            {item.label}
          </Link>
        ))}
        <button type="button" className="rail-signout" onClick={doSignOut}>
          Sign out
        </button>
      </nav>

      <aside className="rail">
        <div>
          <Wordmark href="/" />
          <label className="rail-org">
            <span className="rail-avatar" aria-hidden>
              {org.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="rail-org-meta">
              <select
                aria-label="Organisation"
                value={session.orgId ?? ''}
                onChange={(event) => {
                  session.selectOrg(event.target.value);
                  router.push('/app');
                }}
              >
                {me.organisations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <span>{org.role === 'owner' ? 'Owner' : org.role[0]!.toUpperCase() + org.role.slice(1)}</span>
            </span>
          </label>

          <nav className="rail-nav" aria-label="Main">
            {NAV.map((item) => {
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href} aria-current={isActive(pathname, item.href) ? 'page' : undefined}>
                  <Icon size={20} />
                  {item.label}
                  {item.href === '/app' && attention > 0 && <span className="rail-count">{attention}</span>}
                </Link>
              );
            })}
          </nav>

          <div className="rail-create">
            <Link href="/app/runs/new" className="btn btn-primary btn-block">
              <IconPlus size={16} />
              New payout run
            </Link>
          </div>
        </div>

        <div>
          <div className="rail-help">
            <span className="rail-help-icon">
              <IconBook size={18} />
            </span>
            <strong>Unknown is never failed.</strong>
            <p>A line counts as paid only when a finalised block proves it. Anything uncertain stays out of recovery.</p>
          </div>
          <div className="rail-identity">
            {me.identities.map((identity) => (
              <span key={identity.id}>
                <b>{identity.environment === 'evm' ? 'EVM' : 'Native'}</b> <span className="mono">{shortHash(identity.address, 8, 6)}</span>
              </span>
            ))}
            <button type="button" className="rail-signout" onClick={doSignOut}>
              <IconSignOut size={16} />
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <main className="workspace">{children}</main>
    </div>
  );
}
