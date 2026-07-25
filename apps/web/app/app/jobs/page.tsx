'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { theme, card, input, button } from '../../../lib/ui';
import { useT } from '../../../lib/i18n';

const statusColor: Record<string, string> = {
  REWARDED: theme.green,
  VERIFIED: theme.green,
  FAILED: theme.red,
  PENDING: theme.amber,
  RUNNING: theme.accent,
};

const statusKey: Record<string, string> = {
  REWARDED: 'jobs.statusRewarded',
  VERIFIED: 'jobs.statusVerified',
  FAILED: 'jobs.statusFailed',
  PENDING: 'jobs.statusPending',
  RUNNING: 'jobs.statusRunning',
};

export default function JobsPage() {
  const t = useT();
  const [jobs, setJobs] = useState<any[]>([]);
  const [text, setText] = useState('hello neurion');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api<any[]>('/jobs').then(setJobs).catch(() => undefined);
  useEffect(() => {
    void load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);

  async function createJob() {
    setBusy(true);
    setError('');
    try {
      await api('/jobs', { method: 'POST', body: JSON.stringify({ type: 'echo.v1', inputJson: { text } }) });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 style={{ fontSize: 20, marginTop: 0 }}>{t('jobs.heading')}</h2>
      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: theme.muted, marginBottom: 8 }}>{t('jobs.createJobLabel')}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={input} value={text} onChange={(e) => setText(e.target.value)} />
          <button style={{ ...button, opacity: busy ? 0.6 : 1 }} onClick={() => void createJob()} disabled={busy}>
            {t('jobs.createButton')}
          </button>
        </div>
        {error && <div style={{ color: theme.red, fontSize: 13, marginTop: 8 }}>{error}</div>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {jobs.map((j) => (
          <div key={j.id} style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 14 }}>{j.type}</div>
              <div style={{ fontSize: 12, color: theme.muted }}>{j.id.slice(0, 12)}… · {t('jobs.costLabel')} {j.costCredits} · {t('jobs.rewardLabel')} {j.rewardCredits}</div>
            </div>
            <div style={{ fontSize: 13, fontWeight: 500, color: statusColor[j.status] ?? theme.muted }}>{statusKey[j.status] ? t(statusKey[j.status]) : j.status}</div>
          </div>
        ))}
        {jobs.length === 0 && <div style={{ color: theme.muted, fontSize: 14 }}>{t('jobs.emptyState')}</div>}
      </div>
    </div>
  );
}
