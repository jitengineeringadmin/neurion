'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';
import { theme, card, button } from '../../lib/ui';
import { MatrixRain } from '../../components/MatrixRain';
import { useT } from '../../lib/i18n';

export default function VerifyPage() {
  const t = useT();
  const [state, setState] = useState<'checking' | 'ok' | 'fail'>('checking');

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    if (!token) { setState('fail'); return; }
    api('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) })
      .then(() => setState('ok'))
      .catch(() => setState('fail'));
  }, []);

  return (
    <main style={{ position: 'relative', minHeight: '100vh', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, opacity: 0.16 }}><MatrixRain /></div>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 380, margin: '0 auto', padding: '120px 24px' }}>
        <h1 className="display neon" style={{ fontSize: 30, letterSpacing: '0.12em', color: 'var(--accent)' }}>NEURION</h1>
        <div style={{ ...card, marginTop: 24, textAlign: 'center' }}>
          {state === 'checking' && <p style={{ color: theme.muted }}>{t('auth.verifyChecking')}</p>}
          {state === 'ok' && (
            <>
              <div style={{ fontSize: 32, color: theme.accent }}>✓</div>
              <h2 style={{ margin: '8px 0', fontSize: 18 }}>{t('auth.verifyOk')}</h2>
              <Link href="/app/chat" style={{ ...button, display: 'inline-block', marginTop: 8, textDecoration: 'none' }}>{t('auth.openApp')}</Link>
            </>
          )}
          {state === 'fail' && (
            <>
              <div style={{ fontSize: 32, color: theme.red }}>✕</div>
              <h2 style={{ margin: '8px 0', fontSize: 18 }}>{t('auth.verifyFail')}</h2>
              <Link href="/login" style={{ color: theme.accent, fontSize: 13, textDecoration: 'none' }}>{t('auth.backToLogin')}</Link>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
