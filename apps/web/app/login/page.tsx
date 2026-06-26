'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../lib/auth';
import { theme, card, input, button } from '../../lib/ui';
import { MatrixRain } from '../../components/MatrixRain';
import { ThemeToggle } from '../../components/ThemeToggle';

export default function LoginPage() {
  const { login, register } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('user@neurion.local');
  const [password, setPassword] = useState('ChangeMe!User2026');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
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
      <div style={{ position: 'absolute', top: 20, right: 20, zIndex: 2 }}>
        <ThemeToggle />
      </div>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 380, margin: '0 auto', padding: '110px 24px' }}>
      <h1 className="display neon" style={{ fontSize: 34, letterSpacing: '0.12em', color: 'var(--accent)' }}>
        NEURION <span style={{ color: theme.text }}>AI</span>
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
              {m}
            </button>
          ))}
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input style={input} placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input
            style={input}
            type="password"
            placeholder="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <div style={{ color: theme.red, fontSize: 13 }}>{error}</div>}
          <button type="submit" style={{ ...button, opacity: busy ? 0.6 : 1 }} disabled={busy}>
            {busy ? '...' : mode === 'login' ? 'Login' : 'Register'}
          </button>
        </form>
      </div>
      </div>
    </main>
  );
}
