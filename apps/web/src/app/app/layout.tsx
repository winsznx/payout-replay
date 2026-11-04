'use client';

import type { ReactNode } from 'react';

import { AppShell } from '@/components/shell';
import { SessionProvider } from '@/lib/session';

import './app.css';

export default function OperatorLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
