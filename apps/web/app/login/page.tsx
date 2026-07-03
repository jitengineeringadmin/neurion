'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../lib/auth';
import { API_BASE } from '../../lib/api';
import { theme, card, input, button } from '../../lib/ui';
import { MatrixRain } from '../../components/MatrixRain';
import { ThemeToggle } from '../../components/ThemeToggle';
import { LangToggle } from '../../components/LangToggle';
import { useT } from '../../lib/i18n';

export default function LoginPage() {
  const t = useT();
  const { login, register } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  // Demo credentials are only prefilled when explicitly enabled (never in a
  // production/public deploy). Desktop users stay logged in via the refresh cookie.
  const demo = process.env.NEXT_PUBLIC_DEMO_LOGIN === 'true';
  const [email, setEmail] = useState(demo ? 'user@neurion.local' : '');
  const [password, setPassword] = useState(demo ? 'ChangeMe!User2026' : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The desktop API takes ~30-60s to boot (embedded Postgres init + migrations) on the
  // very first launch. Poll /health so the form shows "starting up…" instead of letting the
  // user submit early and hit a raw "Failed to fetch".
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let tries = 0;
    const ping = async () => {
      tries += 1;
      if (tries > 10 && alive) setSlow(true); // ~15s in
      try {
        const res = await fetch(`${API_BASE}/api/health`, { cache: 'no-store' });
        if (res.ok) {
          if (alive) setReady(true);
          return;
        }
      } catch {
        /* API not up yet */
      }
      if (alive) timer = setTimeout(ping, 1500);
    };
    void ping();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password);
      router.push('/app/chat');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ position: 'relative', minHeight: '100vh', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, opacity: 0.16 }}>
        <MatrixRain />
      </div>
      <div style={{ position: 'absolute', top: 20, right: 20, zIndex: 2, display: 'flex', gap: 8 }}>
        <ThemeToggle />
        <LangToggle />
      </div>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 380, margin: '0 auto', padding: '110px 24px' }}>
      <h1 className="display neon" style={{ fontSize: 34, letterSpacing: '0.12em', color: 'var(--accent)' }}>
        NEURION <span style={{ color: theme.text }}>{t('login.brandSuffix')}</span>
      </h1>
      <div style={{ ...card, marginTop: 24 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {(['login', 'register'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                flex: 1,
                background: mode === m ? theme.surface2 : 'transparent',
                border: `1px solid ${theme.border}`,
                borderRadius: 8,
                color: theme.text,
                padding: 8,
                cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >
              {m === 'login' ? t('login.tabLogin') : t('login.tabRegister')}
            </button>
          ))}
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input style={input} placeholder={t('login.emailPlaceholder')} value={email} onChange={(e) => setEmail(e.target.value)} />
          <input
            style={input}
            type="password"
            placeholder={t('login.passwordPlaceholder')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <div style={{ color: theme.red, fontSize: 13 }}>{error}</div>}
          <button type="submit" style={{ ...button, opacity: busy || !ready ? 0.6 : 1, cursor: ready ? 'pointer' : 'wait' }} disabled={busy || !ready}>
            {!ready ? t('login.startingUp') : busy ? t('login.submitBusy') : mode === 'login' ? t('login.submitLogin') : t('login.submitRegister')}
          </button>
          {!ready && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: theme.amber, fontSize: 12, lineHeight: 1.5 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: theme.amber, animation: 'pulse 1.2s ease-in-out infinite', flexShrink: 0 }} />
              <span>{slow ? t('login.startingUpSlow') : t('login.startingUpHint')}</span>
            </div>
          )}
        </form>
        {mode === 'login' && (
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <Link href="/forgot" style={{ color: theme.muted, fontSize: 12, textDecoration: 'none' }}>{t('auth.forgotLink')}</Link>
          </div>
        )}
      </div>
      </div>
    </main>
  );
}
