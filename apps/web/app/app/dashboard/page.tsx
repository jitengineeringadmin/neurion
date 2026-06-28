'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { theme, card } from '../../../lib/ui';
import { useT } from '../../../lib/i18n';

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ ...card, minWidth: 130 }}>
      <div style={{ fontSize: 12, color: theme.muted }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 500, marginTop: 4 }}>{value}</div>
    </div>
  );
}

export default function DashboardPage() {
  const t = useT();
  const [balance, setBalance] = useState<number | null>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [nodes, setNodes] = useState<any[]>([]);

  useEffect(() => {
    void api<{ balance: number }>('/credits/balance').then((b) => setBalance(b.balance)).catch(() => undefined);
    void api<any[]>('/jobs').then(setJobs).catch(() => undefined);
    void api<any[]>('/nodes').then(setNodes).catch(() => undefined);
  }, []);

  const online = nodes.filter((n) => n.status === 'ONLINE').length;
  const rewarded = jobs.filter((j) => j.status === 'REWARDED').length;

  return (
    <div>
      <h2 style={{ fontSize: 20, marginTop: 0 }}>{t('dashboard.heading')}</h2>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Metric label={t('dashboard.metricCredits')} value={balance ?? '…'} />
        <Metric label={t('dashboard.metricJobs')} value={jobs.length} />
        <Metric label={t('dashboard.metricJobsRewarded')} value={rewarded} />
        <Metric label={t('dashboard.metricNodes')} value={nodes.length} />
        <Metric label={t('dashboard.metricNodesOnline')} value={online} />
      </div>
    </div>
  );
}
