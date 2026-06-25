'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../lib/auth';
import { theme, card, input, button } from '../../lib/ui';

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
    <main style={{ maxWidth: 380, margin: '0 auto', padding: '80px 24px' }}>
      <h1 style={{ fontSize: 30, letterSpacing: -1 }}>
        Neurion <span style={{ color: theme.accent }}>AI</span>
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
    </main>
  );
}
