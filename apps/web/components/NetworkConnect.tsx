'use client';
import { useState } from 'react';
import { prodLogin, getProdToken, setProdToken, PROD_BASE } from '../lib/api';
import { theme, input, button } from '../lib/ui';
import { useT } from '../lib/i18n';

/**
 * Desktop-only: sign in to the production network so the "network" lane (agent
 * compute / image gen) can reach the community node pool. Local features never
 * need this. Renders nothing useful in the online app (it already IS the network).
 */
export function NetworkConnect({ onChange }: { onChange?: () => void }) {
  const t = useT();
  const [connected, setConnected] = useState(!!getProdToken());
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function connect() {
    if (busy || !email.trim() || !pass) return;
    setBusy(true);
    setErr('');
    const ok = await prodLogin(email.trim(), pass);
    setBusy(false);
    if (ok) { setConnected(true); setPass(''); onChange?.(); }
    else setErr(t('network.connectFailed'));
  }
  function disconnect() {
    setProdToken(null);
    setConnected(false);
    onChange?.();
  }

  if (connected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: theme.muted }}>
        <span style={{ color: theme.accent }}>● {t('network.connected')}</span>
        <button onClick={disconnect} style={{ background: 'transparent', border: 'none', color: theme.muted, cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}>{t('network.disconnect')}</button>
      </div>
    );
  }

  return (
    <div style={{ border: `1px solid ${theme.border}`, borderRadius: 10, padding: 12, marginBottom: 12, maxWidth: 420 }}>
      <div style={{ fontSize: 12, color: theme.muted, marginBottom: 8 }}>{t('network.connectPrompt')} <span style={{ color: theme.text }}>{PROD_BASE.replace('https://', '')}</span></div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('network.email')} style={{ ...input, width: 160, padding: '6px 8px' }} />
        <input value={pass} onChange={(e) => setPass(e.target.value)} type="password" placeholder={t('network.password')} style={{ ...input, width: 130, padding: '6px 8px' }} onKeyDown={(e) => { if (e.key === 'Enter') void connect(); }} />
        <button onClick={() => void connect()} disabled={busy} style={{ ...button, padding: '6px 14px', opacity: busy ? 0.5 : 1 }}>{busy ? '…' : t('network.connect')}</button>
      </div>
      {err && <div style={{ color: '#e0533d', fontSize: 12, marginTop: 6 }}>⚠ {err}</div>}
    </div>
  );
}
