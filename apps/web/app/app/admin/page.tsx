'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { theme, card } from '../../../lib/ui';
import { useT } from '../../../lib/i18n';

export default function AdminPage() {
  const t = useT();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api('/admin/dashboard').then(setData).catch((e) => setError((e as Error).message));
  }, []);

  if (error) return <div style={{ color: theme.red }}>{error}</div>;
  if (!data) return <div style={{ color: theme.muted }}>{t('admin.loading')}</div>;

  return (
    <div>
      <h2 style={{ fontSize: 20, marginTop: 0 }}>{t('admin.dashboardHeading')}</h2>
      <pre style={{ ...card, fontSize: 13, overflowX: 'auto' }}>{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}
