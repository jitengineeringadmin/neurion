'use client';
import { ReactNode, Suspense, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '../../lib/auth';
import { theme } from '../../lib/ui';
import { ThemeToggle } from '../../components/ThemeToggle';
import { SessionsSidebar } from '../../components/SessionsSidebar';

const TABS: [string, string][] = [
  ['/app/chat', 'Chat'],
  ['/app/agent', 'Agent'],
  ['/app/dashboard', 'Network'],
];
const NETWORK: [string, string][] = [
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

  if (loading || !user) return <div style={{ padding: 40, color: theme.muted }}>Loading…</div>;

  const isNetwork = ['/app/dashboard', '/app/jobs', '/app/nodes', '/app/wallet', '/app/admin'].some((p) => pathname.startsWith(p));
  const activeTab = pathname.startsWith('/app/agent') ? '/app/agent' : isNetwork ? '/app/dashboard' : '/app/chat';

  const tab = (href: string, label: string) => {
    const active = href === activeTab;
    return (
      <Link
        key={href}
        href={href}
        style={{
          padding: '6px 16px',
          borderRadius: 8,
          fontSize: 13,
          textDecoration: 'none',
          color: active ? 'var(--bg)' : theme.muted,
          background: active ? theme.accent : 'transparent',
          fontWeight: active ? 500 : 400,
        }}
      >
        {label}
      </Link>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* top bar: logo + segmented tabs */}
      <header style={{ display: 'flex', alignItems: 'center', gap: 24, padding: '10px 16px', borderBottom: `1px solid ${theme.border}` }}>
        <div className="display neon" style={{ fontSize: 18, letterSpacing: '0.1em', color: theme.accent }}>NEURION</div>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', borderRadius: 10, padding: 3 }}>
          {TABS.map(([h, l]) => tab(h, l))}
        </div>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* single left sidebar: sessions tree + user */}
        <aside style={{ width: 250, flexShrink: 0, borderRight: `1px solid ${theme.border}`, padding: 12, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Suspense fallback={<div style={{ color: theme.muted, fontSize: 12 }}>…</div>}>
            <SessionsSidebar />
          </Suspense>
          <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 10, marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ fontSize: 11, color: theme.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <ThemeToggle />
              <button
                onClick={() => void logout().then(() => router.replace('/login'))}
                style={{ background: 'transparent', border: `1px solid ${theme.border}`, borderRadius: 8, color: theme.text, padding: '6px 8px', cursor: 'pointer', fontSize: 11 }}
              >
                Logout
              </button>
            </div>
          </div>
        </aside>

        {/* main */}
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {isNetwork && (
            <div style={{ display: 'flex', gap: 6, padding: '8px 20px', borderBottom: `1px solid ${theme.border}` }}>
              {NETWORK.map(([h, l]) => (
                <Link key={h} href={h} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, textDecoration: 'none', color: pathname.startsWith(h) ? theme.text : theme.muted, background: pathname.startsWith(h) ? theme.surface : 'transparent' }}>{l}</Link>
              ))}
              {(user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') && (
                <Link href="/app/admin" style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, textDecoration: 'none', color: pathname.startsWith('/app/admin') ? theme.text : theme.muted }}>Admin</Link>
              )}
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0, padding: 20, overflowY: 'auto' }}>{children}</div>
        </main>
      </div>
    </div>
  );
}
