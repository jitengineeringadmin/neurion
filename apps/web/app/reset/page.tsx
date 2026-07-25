'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';
import { theme, card, input, button } from '../../lib/ui';
import { MatrixRain } from '../../components/MatrixRain';
import { ThemeToggle } from '../../components/ThemeToggle';
import { LangToggle } from '../../components/LangToggle';
import { useT } from '../../lib/i18n';

export default function ResetPage() {
  const t = useT();
  const [token, setToken] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setToken(q.get('token') ?? '');
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (pw.length < 10) { setError(t('auth.pwTooShort')); return; }
    if (pw !== pw2) { setError(t('auth.pwMismatch')); return; }
    setBusy(true);
    try {
      await api('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password: pw }) });
      setDone(true);
    } catch (err) {
      setError((err as Error).message || t('auth.resetInvalid'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ position: 'relative', minHeight: '100vh', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, opacity: 0.16 }}><MatrixRain /></div>
      <div style={{ position: 'absolute', top: 20, right: 20, zIndex: 2, display: 'flex', gap: 8 }}>
        <ThemeToggle /><LangToggle />
      </div>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 380, margin: '0 auto', padding: '110px 24px' }}>
        <h1 className="display neon" style={{ fontSize: 30, letterSpacing: '0.12em', color: 'var(--accent)' }}>NEURION</h1>
        <div style={{ ...card, marginTop: 24 }}>
          <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>{t('auth.resetTitle')}</h2>
          {done ? (
            <>
              <p style={{ color: theme.muted, fontSize: 14, lineHeight: 1.6 }}>{t('auth.resetDone')}</p>
              <Link href="/login" style={{ ...button, display: 'inline-block', marginTop: 8, textDecoration: 'none' }}>{t('auth.goToLogin')}</Link>
            </>
          ) : !token ? (
            <p style={{ color: theme.red, fontSize: 14 }}>{t('auth.resetNoToken')}</p>
          ) : (
            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <input style={input} type="password" placeholder={t('auth.newPassword')} value={pw} onChange={(e) => setPw(e.target.value)} required />
              <input style={input} type="password" placeholder={t('auth.confirmPassword')} value={pw2} onChange={(e) => setPw2(e.target.value)} required />
              {error && <div style={{ color: theme.red, fontSize: 13 }}>{error}</div>}
              <button type="submit" style={{ ...button, opacity: busy ? 0.6 : 1 }} disabled={busy}>
                {busy ? t('login.submitBusy') : t('auth.resetSubmit')}
              </button>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
