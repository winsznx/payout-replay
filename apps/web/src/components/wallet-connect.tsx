'use client';

import { useState } from 'react';

import { errorMessage } from '@/lib/api';
import { type NativeAccount, connectNative } from '@/lib/native-wallet';
import { signInWithWallet } from '@/lib/session';
import type { Environment } from '@/lib/types';

import { Button, Notice } from './ui';

/**
 * Wallet sign-in. EVM uses the injected provider; native lists accounts from
 * a Polkadot-compatible extension. Neither path ever asks for a key.
 */
export function WalletConnect({ onDone, link = false, label }: { onDone(): void; link?: boolean; label?: string }) {
  const [busy, setBusy] = useState<Environment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nativeAccounts, setNativeAccounts] = useState<NativeAccount[] | null>(null);

  const run = async (environment: Environment, address: string | null) => {
    setBusy(environment);
    setError(null);
    try {
      await signInWithWallet(environment, address, { link });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const listNative = async () => {
    setBusy('native');
    setError(null);
    try {
      setNativeAccounts(await connectNative());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" busy={busy === 'evm'} onClick={() => void run('evm', null)}>
          {label ? `${label} with EVM wallet` : 'Sign in with EVM wallet'}
        </Button>
        <Button busy={busy === 'native' && !nativeAccounts} onClick={() => void listNative()}>
          {label ? `${label} with Portaldot wallet` : 'Sign in with Portaldot wallet'}
        </Button>
      </div>
      {nativeAccounts && (
        <fieldset className="border border-rule bg-surface p-3">
          <legend className="px-1 text-[13px] text-ink-3">Choose the native account to sign with</legend>
          {nativeAccounts.length === 0 && <p className="text-[14px] text-ink-2">The extension shared no accounts with this site.</p>}
          <ul className="divide-y divide-rule">
            {nativeAccounts.map((account) => (
              <li key={account.address} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block text-[14px] text-ink">{account.name ?? 'Unnamed account'}</span>
                  <span className="hash text-ink-2">{account.address}</span>
                </span>
                <Button busy={busy === 'native'} onClick={() => void run('native', account.address)}>
                  Sign with this account
                </Button>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      {error && <Notice tone="failed">{error}</Notice>}
      <p className="text-[13px] text-ink-3">You sign a text message that names this site and network. It cannot move funds.</p>
    </div>
  );
}
