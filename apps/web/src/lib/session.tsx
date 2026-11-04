'use client';

import { type ReactNode, createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import useSWR from 'swr';

import { ApiRequestError, apiPost, fetcher } from './api';
import { connectEvm, signEvmMessage } from './evm-wallet';
import { signNativeMessage } from './native-wallet';
import type { Environment, Me } from './types';

const ORG_KEY = 'payout-replay:org';
const listeners = new Set<() => void>();

function readOrg(): string | null {
  try {
    return window.localStorage.getItem(ORG_KEY);
  } catch {
    return null;
  }
}

function writeOrg(orgId: string): void {
  try {
    window.localStorage.setItem(ORG_KEY, orgId);
  } catch {
    // Storage can be unavailable in private windows; the selection then lasts for this page only.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

interface SessionValue {
  me: Me | undefined;
  loading: boolean;
  signedIn: boolean;
  orgId: string | null;
  org: Me['organisations'][number] | null;
  selectOrg(orgId: string): void;
  refresh(): Promise<unknown>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const { data, error, isLoading, mutate } = useSWR<Me>('/me', fetcher, { shouldRetryOnError: false, revalidateOnFocus: false });
  const storedOrg = useSyncExternalStore(subscribe, readOrg, () => null);
  const signedIn = Boolean(data) && !(error instanceof ApiRequestError && error.status === 401);
  const org = data?.organisations.find((item) => item.id === storedOrg) ?? data?.organisations[0] ?? null;

  const selectOrg = useCallback((orgId: string) => writeOrg(orgId), []);
  const value = useMemo<SessionValue>(
    () => ({ me: data, loading: isLoading, signedIn, orgId: org?.id ?? null, org, selectOrg, refresh: () => mutate() }),
    [data, isLoading, signedIn, org, selectOrg, mutate],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

/** Signs a server challenge with the chosen wallet; `link` attaches it to the signed-in user. */
export async function signInWithWallet(environment: Environment, address: string | null, options: { link?: boolean } = {}): Promise<void> {
  const resolved = environment === 'evm' ? (address ?? (await connectEvm())) : address;
  if (!resolved) throw new Error('Choose an account first.');
  const challenge = await apiPost<{ challengeId: string; message: string }>('/auth/challenge', { environment, address: resolved });
  const signature =
    environment === 'evm'
      ? await signEvmMessage(resolved as `0x${string}`, challenge.message)
      : await signNativeMessage(resolved, challenge.message);
  await apiPost('/auth/verify', { challengeId: challenge.challengeId, signature, ...(options.link ? { link: true } : {}) });
}

export async function signOut(): Promise<void> {
  await apiPost('/auth/logout', {});
}
