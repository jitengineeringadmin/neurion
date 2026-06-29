'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';
import { theme, card, input, button } from '../../lib/ui';
import { MatrixRain } from '../../components/MatrixRain';
import { ThemeToggle } from '../../components/ThemeToggle';
import { LangToggle } from '../../components/LangToggle';
import { useT } from '../../lib/i18n';

export default function ForgotPage() {
  const t = useT();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
      setSent(true);
    } catch {
      setSent(true); // never reveal whether the email exists
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
          <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>{t('auth.forgotTitle')}</h2>
          {sent ? (
            <p style={{ color: theme.muted, fontSize: 14, lineHeight: 1.6 }}>{t('auth.forgotSent')}</p>
          ) : (
            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ color: theme.muted, fontSize: 13, margin: 0 }}>{t('auth.forgotIntro')}</p>
              <input style={input} type="email" placeholder={t('login.emailPlaceholder')} value={email} onChange={(e) => setEmail(e.target.value)} required />
              <button type="submit" style={{ ...button, opacity: busy ? 0.6 : 1 }} disabled={busy}>
                {busy ? t('login.submitBusy') : t('auth.forgotSubmit')}
              </button>
            </form>
          )}
          <div style={{ marginTop: 14 }}>
            <Link href="/login" style={{ color: theme.accent, fontSize: 13, textDecoration: 'none' }}>← {t('auth.backToLogin')}</Link>
          </div>
        </div>
      </div>
    </main>
  );
}
