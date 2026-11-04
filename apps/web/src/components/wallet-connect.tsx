'use client';

import { useState } from 'react';

import { errorMessage } from '@/lib/api';
import { type NativeAccount, connectNative } from '@/lib/native-wallet';
import { signInWithWallet } from '@/lib/session';
import type { Environment } from '@/lib/types';

import { IconChain, IconLayers, IconPlus } from './icons';
import { Button, Notice } from './ui';

/**
 * Wallet chooser in the "apps list" pattern: one row per wallet type with an icon tile and a
 * round action. Native lists the accounts the extension shares. No path asks for a key.
 */
export function WalletConnect({ onDone, link = false }: { onDone(): void; link?: boolean }) {
  const [busy, setBusy] = useState<Environment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nativeAccounts, setNativeAccounts] = useState<NativeAccount[] | null>(null);

  const sign = async (environment: Environment, address: string | null) => {
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

  const verb = link ? 'Link' : 'Sign in with';

  return (
    <div>
      <div className="app-list">
        <div className="app-row">
          <span className="icon-tile">
            <IconLayers />
          </span>
          <div className="app-row-body">
            <strong>EVM wallet</strong>
            <span>MetaMask or any injected wallet on Portaldot V3 EVM</span>
          </div>
          <Button variant="primary" size="sm" busy={busy === 'evm'} onClick={() => void sign('evm', null)}>
            {`${verb} EVM wallet`}
          </Button>
        </div>
        <div className="app-row">
          <span className="icon-tile">
            <IconChain />
          </span>
          <div className="app-row-body">
            <strong>Portaldot wallet</strong>
            <span>Polkadot.js, Talisman or SubWallet for native tPOT</span>
          </div>
          <Button variant="secondary" size="sm" busy={busy === 'native' && !nativeAccounts} onClick={() => void listNative()}>
            {`${verb} Portaldot wallet`}
          </Button>
        </div>
      </div>

      {nativeAccounts && (
        <div className="card-soft" style={{ padding: 10, marginBottom: 14 }}>
          {nativeAccounts.length === 0 && <p style={{ padding: 10, color: 'var(--ink-2)' }}>The extension shared no accounts with this site.</p>}
          {nativeAccounts.map((account) => (
            <div key={account.address} className="app-row" style={{ padding: '8px 10px' }}>
              <span className="rail-avatar" style={{ background: 'var(--accent)' }}>
                {(account.name ?? 'A').slice(0, 1).toUpperCase()}
              </span>
              <div className="app-row-body">
                <strong>{account.name ?? 'Unnamed account'}</strong>
                <span className="mono">{account.address}</span>
              </div>
              <button type="button" className="icon-btn" aria-label={`Sign with ${account.address}`} onClick={() => void sign('native', account.address)}>
                {busy === 'native' ? <span className="spinner" /> : <IconPlus size={18} />}
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <Notice tone="failed">{error}</Notice>}
      <p style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 10 }}>
        You sign a short message that names this site and network. It can’t move funds.
      </p>
    </div>
  );
}
