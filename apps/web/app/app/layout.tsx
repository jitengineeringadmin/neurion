'use client';
import { ReactNode, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '../../lib/auth';
import { theme } from '../../lib/ui';

const NAV = [
  ['/app/chat', 'Chat'],
  ['/app/dashboard', 'Dashboard'],
  ['/app/jobs', 'Jobs'],
  ['/app/nodes', 'Nodes'],
  ['/app/wallet', 'Wallet'],
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  if (loading || !user) {
    return <div style={{ padding: 40, color: theme.muted }}>Loading…</div>;
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside
        style={{
          width: 200,
          borderRight: `1px solid ${theme.border}`,
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 500, marginBottom: 20 }}>
          Neurion <span style={{ color: theme.accent }}>AI</span>
        </div>
        {NAV.map(([href, label]) => (
          <Link
            key={href}
            href={href}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              color: pathname === href ? theme.text : theme.muted,
              background: pathname === href ? theme.surface : 'transparent',
              textDecoration: 'none',
              fontSize: 14,
            }}
          >
            {label}
          </Link>
        ))}
        {(user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') && (
          <Link
            href="/app/admin"
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              color: pathname === '/app/admin' ? theme.text : theme.muted,
              textDecoration: 'none',
              fontSize: 14,
            }}
          >
            Admin
          </Link>
        )}
        <div style={{ marginTop: 'auto', fontSize: 12, color: theme.muted }}>
          <div style={{ marginBottom: 8 }}>{user.email}</div>
          <button
            onClick={() => {
              void logout().then(() => router.replace('/login'));
            }}
            style={{
              background: 'transparent',
              border: `1px solid ${theme.border}`,
              borderRadius: 8,
              color: theme.text,
              padding: '6px 10px',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            Logout
          </button>
        </div>
      </aside>
      <main style={{ flex: 1, padding: 28, maxWidth: 900 }}>{children}</main>
    </div>
  );
}
