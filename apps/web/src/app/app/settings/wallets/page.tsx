'use client';

import { useState } from 'react';
import useSWR from 'swr';

import { Button, CopyText, Notice, PageHeader, Section, Skeleton } from '@/components/ui';
import { WalletConnect } from '@/components/wallet-connect';
import { apiPost, errorMessage, fetcher } from '@/lib/api';
import { connectEvm, signEvmMessage } from '@/lib/evm-wallet';
import { formatBaseUnits, timeAgo } from '@/lib/format';
import { type NativeAccount, connectNative, signNativeMessage } from '@/lib/native-wallet';
import { useSession } from '@/lib/session';
import type { ChainHealth, Environment, EnvironmentHealth, WalletView } from '@/lib/types';

function NetworkCard({ health }: { health: EnvironmentHealth }) {
  const tone = health.capability === 'verified' ? 'text-settled' : health.capability === 'unavailable' ? 'text-failed' : 'text-review';
  return (
    <div className="border border-rule bg-surface px-4 py-3 text-[14px]">
      <p className="font-medium">{health.environment === 'evm' ? 'Portaldot V3 EVM' : 'Portaldot V3 native runtime'}</p>
      <p className={`${tone} font-medium`}>
        {health.capability === 'verified' ? 'Verified' : health.capability === 'unavailable' ? 'Unavailable' : 'Not verified'}
        {health.rpcAvailable ? '' : ', RPC unreachable'}
      </p>
      <p className="mt-1 text-ink-2">{health.detail}</p>
      {health.finalizedBlock && (
        <p className="num mt-1 text-ink-3">
          Finalized #{health.finalizedBlock}, best #{health.bestBlock}
        </p>
      )}
      <p className="mt-1 text-[12px] text-ink-3">
        {health.provider ?? 'no provider'}, checked {timeAgo(health.checkedAt)}
      </p>
    </div>
  );
}

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
    <div className="space-y-2">
      {environment === 'evm' ? (
        <Button busy={busy} onClick={() => void connectEvm().then(register, (caught: unknown) => setError(errorMessage(caught)))}>
          Register the connected EVM wallet
        </Button>
      ) : (
        <Button busy={busy && !accounts} onClick={() => void connectNative().then(setAccounts, (caught: unknown) => setError(errorMessage(caught)))}>
          Choose a native account to register
        </Button>
      )}
      {accounts && (
        <ul className="divide-y divide-rule border border-rule bg-surface">
          {accounts.map((account) => (
            <li key={account.address} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>
                <span className="block text-[14px]">{account.name ?? 'Unnamed'}</span>
                <span className="hash text-ink-2">{account.address}</span>
              </span>
              <Button busy={busy} onClick={() => void register(account.address)}>
                Register this account
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <Notice tone="failed">{error}</Notice>}
    </div>
  );
}

export default function WalletsPage() {
  const { orgId, org, me, refresh } = useSession();
  const health = useSWR<ChainHealth>('/health/chain', (path: string) => fetch(path).then((response) => response.json() as Promise<ChainHealth>), { refreshInterval: 30_000 });
  const wallets = useSWR<WalletView[]>(orgId ? `/orgs/${orgId}/wallets` : null, fetcher);
  const isOwner = org?.role === 'owner';

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Payout wallets"
        description="Native and EVM payouts come from separate wallets. Each is registered from its own signature; one address is never inferred from the other."
      />

      <Section title="Networks">
        {!health.data ? (
          <Skeleton rows={2} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <NetworkCard health={health.data.native} />
            <NetworkCard health={health.data.evm} />
          </div>
        )}
        {health.data && health.data.assets.length > 0 && (
          <ul className="mt-3 space-y-1 text-[14px]">
            {health.data.assets.map((asset) => (
              <li key={asset.assetId} className="text-ink-2">
                <span className="font-medium text-ink">{asset.symbol}</span> ({asset.environment}, {asset.decimals} decimals): {asset.capability}
                {asset.label ? `. ${asset.label}` : ''}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Registered payout sources">
        {!wallets.data ? (
          <Skeleton rows={2} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {(['native', 'evm'] as const).map((environment) => {
              const wallet = wallets.data?.find((item) => item.environment === environment);
              return (
                <div key={environment} className="border border-rule bg-surface px-4 py-3">
                  <p className="font-medium">{environment === 'evm' ? 'EVM payout wallet' : 'Native payout wallet'}</p>
                  {wallet ? (
                    <div className="mt-2 space-y-1 text-[14px]">
                      <CopyText value={wallet.address} />
                      <p className="text-ink-2">
                        Fee balance:{' '}
                        {wallet.feeBalanceBaseUnits !== null && wallet.feeBalanceDecimals !== null ? (
                          <span className="num">
                            {formatBaseUnits(wallet.feeBalanceBaseUnits, wallet.feeBalanceDecimals)} {wallet.feeAsset}
                          </span>
                        ) : (
                          <span className="text-review">unavailable ({wallet.balanceError})</span>
                        )}
                      </p>
                      <p className={wallet.chainMatches ? 'text-ink-3' : 'text-failed'}>
                        {wallet.chainMatches ? `Bound to ${wallet.chainIdentity}` : `Registered on ${wallet.chainIdentity}, which is not the configured network`}
                      </p>
                      <p className="text-ink-3">Signature verified {timeAgo(wallet.verifiedAt)}</p>
                    </div>
                  ) : (
                    <p className="mt-2 text-[14px] text-ink-2">Not registered. Lines for this environment cannot be imported yet.</p>
                  )}
                  {isOwner && orgId && (
                    <div className="mt-3">
                      <RegisterWallet environment={environment} orgId={orgId} onDone={() => void Promise.all([wallets.mutate(), refresh()])} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {!isOwner && <p className="mt-3 text-[14px] text-ink-3">Only an owner can change payout wallets.</p>}
      </Section>

      <Section title="Wallets you can sign with" description="To sign payments you must be signed in with, or have linked, the payout wallet for that environment.">
        <ul className="mb-4 space-y-1 text-[14px]">
          {me?.identities.map((identity) => (
            <li key={identity.id}>
              {identity.environment === 'evm' ? 'EVM' : 'Native'} <span className="hash">{identity.address}</span>
            </li>
          ))}
        </ul>
        <WalletConnect link label="Link" onDone={() => void refresh()} />
      </Section>
    </div>
  );
}
