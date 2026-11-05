'use client';

import { useState } from 'react';

interface Step {
  title: string;
  body: string;
  figure: string;
  detail: string;
}

const STEPS: Step[] = [
  {
    title: 'Import the approved sheet',
    body: 'Every address, asset and decimal is checked line by line.',
    figure: '1 bad row',
    detail: 'blocks the freeze. Addresses, assets and decimals are checked on every line before anything can be approved or signed.',
  },
  {
    title: 'Freeze and approve',
    body: 'A reviewer approves one exact SHA-256 fingerprint.',
    figure: 'SHA-256',
    detail: 'of the canonical manifest is what gets approved. Change one amount and it is a different run that needs a new approval.',
  },
  {
    title: 'Sign from your own wallet',
    body: 'Native tPOT and EVM tokens, one line at a time.',
    figure: '0 keys',
    detail: 'held by Payout Replay. Native transfers and EVM executor calls are signed by the payout wallet itself.',
  },
  {
    title: 'Verify against finality',
    body: 'Paid only when a finalised block proves the exact transfer.',
    figure: 'GRANDPA',
    detail: 'finality for native tPOT and the finalized tag on the EVM. A line is paid only when that block shows the exact payer, recipient and amount.',
  },
  {
    title: 'Recover only what failed',
    body: 'Uncertain lines stay blocked, so nobody is paid twice.',
    figure: '64',
    detail: 'blocks. Every native payment is signed with a mortal era, so “never landed” becomes provable instead of a guess.',
  },
];

export function HowItWorks() {
  const [active, setActive] = useState(0);
  const step = STEPS[active]!;
  return (
    <div className="solutions">
      <div className="seq" role="tablist" aria-label="How it works" aria-orientation="vertical">
        {STEPS.map((item, index) => (
          <button
            key={item.title}
            type="button"
            role="tab"
            id={`how-tab-${index}`}
            aria-selected={index === active}
            aria-controls="how-panel"
            className={`seq-item ${index === active ? 'active' : ''}`}
            onClick={() => setActive(index)}
          >
            <b>{String(index + 1).padStart(2, '0')}</b>
            <div>
              <strong>{item.title}</strong>
              <p>{item.body}</p>
            </div>
          </button>
        ))}
      </div>
      <div className="sky solutions-art" id="how-panel" role="tabpanel" aria-labelledby={`how-tab-${active}`}>
        <div className="glass" key={active}>
          <strong>{step.figure}</strong>
          <span>{step.detail}</span>
        </div>
      </div>
    </div>
  );
}
