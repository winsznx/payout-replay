'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type FormEvent, type ReactNode, useState, useSyncExternalStore } from 'react';

import { apiPost, errorMessage } from '@/lib/api';
import { shortHash } from '@/lib/format';
import { signOut, useSession } from '@/lib/session';

import { Button, Notice, Skeleton } from './ui';
import { WalletConnect } from './wallet-connect';

const NAV = [
  { href: '/app', label: 'Payout runs' },
  { href: '/app/runs/new', label: 'Import a payout sheet' },
  { href: '/app/settings/wallets', label: 'Payout wallets' },
  { href: '/app/developers', label: 'API and SDK' },
];

type Theme = 'light' | 'dark' | 'system';
const themeListeners = new Set<() => void>();

function readTheme(): Theme {
  try {
    return (window.localStorage.getItem('payout-replay:theme') as Theme | null) ?? 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    window.localStorage.setItem('payout-replay:theme', theme);
  } catch {
    // Theme then lasts for this page only.
  }
  for (const listener of themeListeners) listener();
}

function ThemeSwitch() {
  const theme = useSyncExternalStore(
    (listener) => {
      themeListeners.add(listener);
      return () => themeListeners.delete(listener);
    },
    readTheme,
    () => 'system' as Theme,
  );
  return (
    <label className="flex items-center gap-2 text-[13px] text-ink-3">
      Theme
      <select
        className="rounded border border-rule bg-surface px-1.5 py-0.5 text-ink"
        value={theme}
        onChange={(event) => applyTheme(event.target.value as Theme)}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
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
    <form onSubmit={(event) => void submit(event)} className="max-w-md space-y-3">
      <label className="block">
        <span className="text-[14px] text-ink-2">Organisation name</span>
        <input
          required
          minLength={2}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="mt-1 w-full rounded-[5px] border border-rule-strong bg-surface px-3 py-2"
          placeholder="Northwind Contributors DAO"
        />
      </label>
      <label className="block">
        <span className="text-[14px] text-ink-2">Short name for links</span>
        <input
          value={derivedSlug}
          onChange={(event) => setSlug(event.target.value)}
          className="mt-1 w-full rounded-[5px] border border-rule-strong bg-surface px-3 py-2 font-mono text-[14px]"
          pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]"
        />
      </label>
      {error && <Notice tone="failed">{error}</Notice>}
      <Button type="submit" variant="primary" busy={busy}>
        Create organisation
      </Button>
    </form>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const router = useRouter();

  if (session.loading) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <Skeleton rows={4} />
      </div>
    );
  }

  if (!session.signedIn || !session.me) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16">
        <Link href="/" className="text-[15px] font-semibold text-ink">
          Payout Replay
        </Link>
        <h1 className="mt-8 text-[28px] leading-tight font-semibold">Sign in with the wallet you operate payouts from</h1>
        <p className="mt-2 mb-6 text-ink-2">Your wallet is your identity here. You can link a second wallet for the other environment after signing in.</p>
        <WalletConnect onDone={() => void session.refresh()} />
      </main>
    );
  }

  if (!session.org) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16">
        <h1 className="text-[28px] leading-tight font-semibold">Create the organisation that owns your payouts</h1>
        <p className="mt-2 mb-6 text-ink-2">You become its owner. You can invite operators and reviewers by wallet address later.</p>
        <CreateOrg
          onCreated={(orgId) => {
            session.selectOrg(orgId);
            void session.refresh();
          }}
        />
      </main>
    );
  }

  const me = session.me;
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="border-b border-rule bg-surface lg:sticky lg:top-0 lg:h-screen lg:border-r lg:border-b-0">
        <div className="flex h-full flex-col gap-6 p-4">
          <Link href="/app" className="text-[16px] font-semibold tracking-[-0.01em] text-ink">
            Payout Replay
          </Link>
          <label className="block">
            <span className="text-[13px] text-ink-3">Organisation</span>
            <select
              className="mt-1 w-full rounded-[5px] border border-rule bg-paper px-2 py-1.5 text-[14px]"
              value={session.orgId ?? ''}
              onChange={(event) => {
                session.selectOrg(event.target.value);
                router.push('/app');
              }}
            >
              {me.organisations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name} ({org.role})
                </option>
              ))}
            </select>
          </label>
          <nav aria-label="Main">
            <ul className="flex flex-wrap gap-1 lg:flex-col">
              {NAV.map((item) => {
                const active = item.href === '/app' ? pathname === '/app' || pathname.startsWith('/app/runs/pr_') : pathname.startsWith(item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={`block rounded-[5px] px-2.5 py-1.5 text-[14px] ${active ? 'bg-accent-wash font-medium text-accent' : 'text-ink-2 hover:bg-sunken hover:text-ink'}`}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="mt-auto space-y-3 border-t border-rule pt-4 text-[13px]">
            <div>
              <p className="text-ink-3">Signed in as</p>
              {me.identities.map((identity) => (
                <p key={identity.id} className="text-ink-2">
                  {identity.environment === 'evm' ? 'EVM' : 'Native'} <span className="hash">{shortHash(identity.address, 8, 6)}</span>
                </p>
              ))}
            </div>
            <ThemeSwitch />
            <Button
              variant="ghost"
              className="px-0"
              onClick={() =>
                void signOut().then(() => {
                  void session.refresh();
                })
              }
            >
              Sign out
            </Button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 px-4 py-6 sm:px-8 lg:py-8">{children}</main>
    </div>
  );
}
