'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { theme, card, input, button } from '../../../lib/ui';
import { useT } from '../../../lib/i18n';

interface Me { email: string; emailVerified: boolean }

export default function AccountPage() {
  const t = useT();
  const [me, setMe] = useState<Me | null>(null);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [resent, setResent] = useState(false);

  useEffect(() => { void api<Me>('/auth/me').then(setMe).catch(() => undefined); }, []);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setErr(''); setMsg('');
    if (newPw.length < 10) { setErr(t('auth.pwTooShort')); return; }
    if (newPw !== newPw2) { setErr(t('auth.pwMismatch')); return; }
    setBusy(true);
    try {
      await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }) });
      setMsg(t('auth.pwChanged'));
      setOldPw(''); setNewPw(''); setNewPw2('');
    } catch (e2) {
      setErr((e2 as Error).message || t('auth.pwChangeFail'));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    try { await api('/auth/resend-verification', { method: 'POST' }); setResent(true); } catch { /* ignore */ }
  }

  return (
    <div style={{ maxWidth: 460 }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 20 }}>{t('auth.accountTitle')}</h2>
      {me && (
        <p style={{ color: theme.muted, fontSize: 13, marginTop: 0 }}>
          {me.email} ·{' '}
          {me.emailVerified
            ? <span style={{ color: theme.accent }}>✓ {t('auth.emailVerified')}</span>
            : <span style={{ color: theme.amber ?? '#e0a33d' }}>● {t('auth.emailUnverified')}</span>}
        </p>
      )}

      {me && !me.emailVerified && (
        <div style={{ ...card, marginBottom: 16 }}>
          <p style={{ margin: '0 0 10px', fontSize: 13, color: theme.muted }}>{t('auth.verifyPrompt')}</p>
          {resent
            ? <span style={{ color: theme.accent, fontSize: 13 }}>{t('auth.verifyResent')}</span>
            : <button onClick={() => void resend()} style={{ ...button, padding: '6px 14px' }}>{t('auth.resendVerification')}</button>}
        </div>
      )}

      <div style={card}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>{t('auth.changePasswordTitle')}</h3>
        <form onSubmit={changePassword} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input style={input} type="password" placeholder={t('auth.currentPassword')} value={oldPw} onChange={(e) => setOldPw(e.target.value)} required />
          <input style={input} type="password" placeholder={t('auth.newPassword')} value={newPw} onChange={(e) => setNewPw(e.target.value)} required />
          <input style={input} type="password" placeholder={t('auth.confirmPassword')} value={newPw2} onChange={(e) => setNewPw2(e.target.value)} required />
          {err && <div style={{ color: theme.red, fontSize: 13 }}>{err}</div>}
          {msg && <div style={{ color: theme.accent, fontSize: 13 }}>{msg}</div>}
          <button type="submit" style={{ ...button, opacity: busy ? 0.6 : 1 }} disabled={busy}>
            {busy ? t('login.submitBusy') : t('auth.changePasswordSubmit')}
          </button>
        </form>
      </div>
    </div>
  );
}
