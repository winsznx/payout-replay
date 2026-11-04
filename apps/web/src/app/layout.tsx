import type { Metadata } from 'next';
import { IBM_Plex_Mono, Instrument_Sans } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';

const instrument = Instrument_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-instrument', display: 'swap' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-mono', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Payout Replay', template: '%s | Payout Replay' },
  description: 'Know who actually got paid. Fix only what didn’t. Payout reconciliation and safe recovery on Portaldot V3.',
  icons: { icon: '/icon.svg' },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${instrument.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
