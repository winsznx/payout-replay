'use client';

import { PlanPanel } from '@/components/plan-panel';
import { PageHeader } from '@/components/ui';

export default function ExecutePage() {
  return (
    <div className="max-w-7xl">
      <PageHeader
        title="Execute approved payments"
        description="Every payment is signed by the payout wallet itself. This app prepares and records; it never holds keys or sends on its own."
      />
      <PlanPanel kind="execution" />
    </div>
  );
}
