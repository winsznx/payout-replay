'use client';

import { PlanPanel } from '@/components/plan-panel';
import { PageHead } from '@/components/ui';

export default function ExecutePage() {
  return (
    <div className="page">
      <PageHead
        title="Execute approved payments"
        description="Every payment is signed by the payout wallet itself. Payout Replay prepares and records; it never holds keys or sends on its own."
      />
      <PlanPanel kind="execution" />
    </div>
  );
}
