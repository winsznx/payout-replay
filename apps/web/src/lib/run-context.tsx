'use client';

import { type ReactNode, createContext, useContext } from 'react';
import useSWR, { type KeyedMutator } from 'swr';

import { fetcher } from './api';
import type { LineView, RunDetail } from './types';

interface RunValue {
  runId: string;
  detail: RunDetail | undefined;
  lines: LineView[] | undefined;
  error: unknown;
  refresh(): Promise<void>;
  mutateLines: KeyedMutator<{ items: LineView[]; total: number }>;
}

const RunContext = createContext<RunValue | null>(null);

/** Polls while anything is in flight so status changes appear without a reload; polling is the fallback transport. */
export function RunProvider({ runId, children }: { runId: string; children: ReactNode }) {
  const detail = useSWR<RunDetail>(`/runs/${runId}`, fetcher, {
    refreshInterval: (data) => (data && ['executing', 'reconciling', 'recovering', 'needs_review'].includes(data.run.status) ? 5_000 : 0),
  });
  const approved = Boolean(detail.data?.summary);
  const lines = useSWR<{ items: LineView[]; total: number }>(approved ? `/runs/${runId}/lines?limit=500` : null, fetcher, {
    refreshInterval: (data) =>
      data?.items.some((line) => ['awaiting_signature', 'submitted', 'confirming'].includes(line.status)) ? 5_000 : 0,
  });
  const value: RunValue = {
    runId,
    detail: detail.data,
    lines: lines.data?.items,
    error: detail.error,
    refresh: async () => {
      await Promise.all([detail.mutate(), lines.mutate()]);
    },
    mutateLines: lines.mutate,
  };
  return <RunContext.Provider value={value}>{children}</RunContext.Provider>;
}

export function useRun(): RunValue {
  const value = useContext(RunContext);
  if (!value) throw new Error('useRun must be used inside RunProvider');
  return value;
}
