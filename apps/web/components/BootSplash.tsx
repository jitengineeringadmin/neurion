'use client';
import { useEffect, useState } from 'react';
import { MatrixRain } from './MatrixRain';

const BOOT_LINES = [
  '> initializing neurion runtime…',
  '> connecting compute grid…',
  '> warming realtime pool…',
  '> verifying nodes [OK]',
  '> NRN ledger online [OK]',
  '> access granted.',
];

export function BootSplash() {
  const [phase, setPhase] = useState<'hidden' | 'show' | 'fade'>('hidden');
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    if (sessionStorage.getItem('neurion_booted')) return;
    setPhase('show');

    const timers: number[] = [];
    BOOT_LINES.forEach((l, i) => {
      timers.push(window.setTimeout(() => setLines((p) => [...p, l]), 350 + i * 320));
    });
    timers.push(window.setTimeout(() => setPhase('fade'), 2900));
    timers.push(
      window.setTimeout(() => {
        sessionStorage.setItem('neurion_booted', '1');
        setPhase('hidden');
      }, 3500),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);

  if (phase === 'hidden') return null;

  return (
    <div
      onClick={() => {
        sessionStorage.setItem('neurion_booted', '1');
        setPhase('hidden');
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'var(--bg-deep)',
        opacity: phase === 'fade' ? 0 : 1,
        transition: 'opacity 0.6s ease',
        cursor: 'pointer',
        overflow: 'hidden',
      }}
    >
      <MatrixRain opacity={0.55} />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 24,
        }}
      >
        <div
          className="display flicker neon"
          style={{ fontSize: 'clamp(40px, 9vw, 88px)', color: 'var(--accent)', letterSpacing: '0.18em' }}
        >
          NEURION
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)', fontSize: 13, minHeight: 130 }}>
          {lines.map((l, i) => (
            <div key={i} className="neon" style={{ opacity: 0.9 }}>
              {l}
            </div>
          ))}
          <span style={{ color: 'var(--accent)' }}>█</span>
        </div>
      </div>
    </div>
  );
}
