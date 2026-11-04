'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { Skeleton } from '@/components/ui';
import { useRun } from '@/lib/run-context';

function stepFor(status: string): string {
  if (status === 'draft' || status === 'validated') return 'import';
  if (status === 'awaiting_approval') return 'review';
  if (status === 'approved') return 'execute';
  if (status === 'incomplete' || status === 'recovering') return 'recover';
  if (status === 'complete') return 'export';
  return 'live';
}

/** Sends the operator to the step that holds the next safe action for this run. */
export default function RunIndex() {
  const { detail } = useRun();
  const router = useRouter();
  const { runId } = useParams<{ runId: string }>();
  const status = detail?.run.status;
  useEffect(() => {
    if (!status) return;
    const step = stepFor(status);
    router.replace(step === 'import' ? `/app/runs/new?run=${runId}` : `/app/runs/${runId}/${step}`);
  }, [status, runId, router]);
  return <Skeleton rows={4} />;
}
