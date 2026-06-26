'use client';
import Link from 'next/link';
import { MatrixRain } from '../components/MatrixRain';
import { ThemeToggle } from '../components/ThemeToggle';
import { button } from '../lib/ui';

export default function Home() {
  return (
    <main style={{ position: 'relative', minHeight: '100vh', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, opacity: 0.18 }}>
        <MatrixRain />
      </div>
      <div style={{ position: 'absolute', top: 20, right: 20, zIndex: 2 }}>
        <ThemeToggle />
      </div>
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          maxWidth: 760,
          margin: '0 auto',
          padding: '120px 24px',
        }}
      >
        <h1 className="neon" style={{ fontSize: 'clamp(44px, 9vw, 84px)', margin: 0, letterSpacing: '0.12em', color: 'var(--accent)' }}>
          NEURION
        </h1>
        <p style={{ fontSize: 18, color: 'var(--text)', marginTop: 8 }}>
          Share idle power. Access AI. Earn credits and the NRN token.
        </p>
        <p style={{ color: 'var(--muted)', lineHeight: 1.8, maxWidth: 560 }}>
          A distributed AI compute network: fast chat over a community grid, with a Fast / Grid / Fallback
          router, internal credits and an on-chain NRN utility token.
        </p>
        <Link href="/login" style={{ ...button, display: 'inline-block', marginTop: 24, textDecoration: 'none' }}>
          ENTER ▸
        </Link>
      </div>
    </main>
  );
}
