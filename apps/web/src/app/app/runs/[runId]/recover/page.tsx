'use client';

import { PlanPanel } from '@/components/plan-panel';
import { Notice, PageHeader } from '@/components/ui';
import { useRun } from '@/lib/run-context';

export default function RecoverPage() {
  const { detail } = useRun();
  const counts = detail?.summary?.counts;
  return (
    <div className="max-w-7xl">
      <PageHeader
        title="Recover only what didn't settle"
        description="A correction reuses the original obligation, so the executor still refuses to pay any line twice."
      />
      {counts && counts.needs_review > 0 && (
        <div className="mt-6">
          <Notice tone="review" title={`${counts.needs_review} line${counts.needs_review === 1 ? '' : 's'} need review`}>
            Their outcome can't be proven yet, so they are never offered here. Check the settlement screen for evidence, import the
            transaction if it was paid elsewhere, or wait for the chain to settle the question.
          </Notice>
        </div>
      )}
      <PlanPanel kind="recovery" />
    </div>
  );
}
