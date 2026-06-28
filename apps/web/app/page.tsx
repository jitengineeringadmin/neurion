'use client';
import Link from 'next/link';
import { MatrixRain } from '../components/MatrixRain';
import { ThemeToggle } from '../components/ThemeToggle';
import { LangToggle } from '../components/LangToggle';
import { button } from '../lib/ui';
import { useT } from '../lib/i18n';

export default function Home() {
  const t = useT();
  return (
    <main style={{ position: 'relative', minHeight: '100vh', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, opacity: 0.18 }}>
        <MatrixRain />
      </div>
      <div style={{ position: 'absolute', top: 20, right: 20, zIndex: 2 }}>
        <ThemeToggle />
        <LangToggle />
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
          {t('home.brandName')}
        </h1>
        <p style={{ fontSize: 18, color: 'var(--text)', marginTop: 8 }}>
          {t('home.tagline')}
        </p>
        <p style={{ color: 'var(--muted)', lineHeight: 1.8, maxWidth: 560 }}>
          {t('home.description')}
        </p>
        <Link href="/login" style={{ ...button, display: 'inline-block', marginTop: 24, textDecoration: 'none' }}>
          {t('home.enterCta')} ▸
        </Link>
      </div>
    </main>
  );
}
