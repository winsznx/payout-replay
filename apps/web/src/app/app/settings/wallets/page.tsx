'use client';

import { useState } from 'react';
import useSWR from 'swr';

import { IconChain, IconLayers, IconPlus, IconWallet } from '@/components/icons';
import { Button, CopyText, IconTile, Module, Notice, PageHead, Skeleton, TopBar } from '@/components/ui';
import { WalletConnect } from '@/components/wallet-connect';
import { apiPost, errorMessage, fetcher } from '@/lib/api';
import { connectEvm, signEvmMessage } from '@/lib/evm-wallet';
import { formatBaseUnits, timeAgo } from '@/lib/format';
import { type NativeAccount, connectNative, signNativeMessage } from '@/lib/native-wallet';
import { useSession } from '@/lib/session';
import type { ChainHealth, Environment, WalletView } from '@/lib/types';

function RegisterWallet({ environment, orgId, onDone }: { environment: Environment; orgId: string; onDone(): void }) {
  const [accounts, setAccounts] = useState<NativeAccount[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const register = async (address: string) => {
    setBusy(true);
    setError(null);
    try {
      const challenge = await apiPost<{ challengeId: string; message: string }>(`/orgs/${orgId}/wallet-challenges`, { environment, address });
      const signature = environment === 'evm' ? await signEvmMessage(address as `0x${string}`, challenge.message) : await signNativeMessage(address, challenge.message);
      await apiPost(`/orgs/${orgId}/wallets`, { challengeId: challenge.challengeId, signature });
      setAccounts(null);
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 10 }}>
      {environment === 'evm' ? (
        <Button variant="primary" busy={busy} onClick={() => void connectEvm().then(register, (caught: unknown) => setError(errorMessage(caught)))}>
          Register the connected EVM wallet
        </Button>
      ) : (
        <Button variant="primary" busy={busy && !accounts} onClick={() => void connectNative().then(setAccounts, (caught: unknown) => setError(errorMessage(caught)))}>
          Choose a native account to register
        </Button>
      )}
      {accounts && (
        <div className="card-soft" style={{ padding: 8 }}>
          {accounts.map((account) => (
            <div key={account.address} className="app-row" style={{ padding: '8px 10px' }}>
              <span className="rail-avatar" style={{ background: 'var(--accent)' }}>
                {(account.name ?? 'A').slice(0, 1).toUpperCase()}
              </span>
              <div className="app-row-body">
                <strong>{account.name ?? 'Unnamed'}</strong>
                <span className="mono">{account.address}</span>
              </div>
              <button type="button" className="icon-btn" aria-label={`Register ${account.address}`} onClick={() => void register(account.address)}>
                <IconPlus size={18} />
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <Notice tone="failed">{error}</Notice>}
    </div>
  );
}

export default function WalletsPage() {
  const { orgId, org, me, refresh } = useSession();
  const health = useSWR<ChainHealth>('/health/chain', (path: string) => fetch(path).then((response) => response.json() as Promise<ChainHealth>), {
    refreshInterval: 30_000,
  });
  const wallets = useSWR<WalletView[]>(orgId ? `/orgs/${orgId}/wallets` : null, fetcher);
  const isOwner = org?.role === 'owner';

  return (
    <>
      <TopBar crumbs={[{ label: 'Payout wallets' }]} />
      <div className="page">
        <PageHead
          title="Payout wallets"
          description="Native and EVM payouts come from separate wallets. Each one is registered from its own signature, and neither address is ever derived from the other."
        />

        <div className="modules">
          {(['native', 'evm'] as const).map((environment) => {
            const wallet = wallets.data?.find((item) => item.environment === environment);
            return (
              <Module key={environment} title={environment === 'evm' ? 'EVM payout wallet' : 'Native payout wallet'} aside={<span>{environment === 'evm' ? 'Token payments' : 'tPOT payments'}</span>}>
                {!wallets.data ? (
                  <Skeleton rows={1} height={110} />
                ) : wallet ? (
                  <div className="stack" style={{ gap: 12 }}>
                    <div className="inset">
                      <IconTile tone={wallet.chainMatches ? 'settled' : 'failed'}>
                        <IconWallet size={18} />
                      </IconTile>
                      <div className="inset-body">
                        <span>Fee balance</span>
                        <strong className="num">
                          {wallet.feeBalanceBaseUnits !== null && wallet.feeBalanceDecimals !== null
                            ? `${formatBaseUnits(wallet.feeBalanceBaseUnits, wallet.feeBalanceDecimals)} tPOT`
                            : 'Unavailable'}
                        </strong>
                        <p>{wallet.balanceError ?? (wallet.chainMatches ? `Bound to ${wallet.chainIdentity}` : `Registered on ${wallet.chainIdentity}, not the configured network`)}</p>
                      </div>
                    </div>
                    <CopyText value={wallet.address} />
                    <p style={{ fontSize: 13, color: 'var(--ink-3)' }}>Signature verified {timeAgo(wallet.verifiedAt)}</p>
                  </div>
                ) : (
                  <p style={{ fontSize: 13.5, color: 'var(--ink-2)', marginBottom: 12 }}>Not registered. Lines for this environment can’t be imported yet.</p>
                )}
                {isOwner && orgId && (
                  <div style={{ marginTop: 14 }}>
                    <RegisterWallet environment={environment} orgId={orgId} onDone={() => void Promise.all([wallets.mutate(), refresh()])} />
                  </div>
                )}
              </Module>
            );
          })}
        </div>
        {!isOwner && <Notice>Only an owner can change payout wallets.</Notice>}

        <h2 className="section-title">Portaldot V3 networks</h2>
        {!health.data ? (
          <Skeleton rows={2} height={80} />
        ) : (
          <div className="modules">
            {[health.data.native, health.data.evm].map((env) => (
              <div className="inset" key={env.environment} style={{ alignItems: 'flex-start' }}>
                <IconTile tone={env.capability === 'verified' ? 'settled' : env.capability === 'unavailable' ? 'failed' : 'review'}>
                  {env.environment === 'evm' ? <IconLayers size={18} /> : <IconChain size={18} />}
                </IconTile>
                <div className="inset-body">
                  <span>{env.environment === 'evm' ? 'EVM (pallet-revive)' : 'Native runtime'}</span>
                  <strong>{env.capability === 'verified' ? 'Verified' : env.capability === 'unavailable' ? 'Unavailable' : 'Not verified'}</strong>
                  <p>{env.detail}</p>
                  {env.finalizedBlock && (
                    <p className="num">
                      Finalised #{env.finalizedBlock}, best #{env.bestBlock} · {env.provider}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {health.data && health.data.assets.length > 0 && (
          <div className="filter-pills" style={{ marginTop: 4 }}>
            {health.data.assets.map((asset) => (
              <span key={asset.assetId} title={asset.label}>
                <span className={`dot dot-${asset.capability === 'verified' ? 'settled' : 'review'}`} aria-hidden />
                {asset.symbol}, {asset.decimals} decimals, {asset.capability}
              </span>
            ))}
          </div>
        )}

        <h2 className="section-title">Wallets you can sign with</h2>
        <div className="split">
          <div className="card">
            <p className="card-desc" style={{ marginTop: 0 }}>
              To sign a payment you must be signed in with, or have linked, that environment’s payout wallet.
            </p>
            <div className="queue" style={{ marginTop: 12 }}>
              {me?.identities.map((identity) => (
                <div className="queue-row" key={identity.id}>
                  <IconTile>{identity.environment === 'evm' ? <IconLayers size={18} /> : <IconChain size={18} />}</IconTile>
                  <div className="queue-main">
                    <small>{identity.environment === 'evm' ? 'EVM' : 'Native'}</small>
                    <p className="mono" style={{ color: 'var(--ink)' }}>
                      {identity.address}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <h2 className="card-title">Link another wallet</h2>
            <WalletConnect link onDone={() => void refresh()} />
          </div>
        </div>
      </div>
    </>
  );
}
