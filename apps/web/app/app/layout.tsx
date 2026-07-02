'use client';
import { ReactNode, Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '../../lib/auth';
import { publicApi } from '../../lib/api';
import { theme } from '../../lib/ui';
import { ThemeToggle } from '../../components/ThemeToggle';
import { LangToggle } from '../../components/LangToggle';
import { SessionsSidebar } from '../../components/SessionsSidebar';
import { AgentSidebar } from '../../components/AgentSidebar';
import { GallerySidebar } from '../../components/GallerySidebar';
import { Onboarding } from '../../components/Onboarding';
import { useT } from '../../lib/i18n';

// [href, i18n key] — label resolved via t() in render (hooks can't run at module scope)
const TABS: [string, string][] = [
  ['/app/chat', 'nav.tabChat'],
  ['/app/agent', 'nav.tabAgent'],
  ['/app/image', 'nav.tabImage'],
  ['/app/models', 'nav.tabModels'],
  ['/app/forum', 'nav.tabForum'],
  ['/app/dashboard', 'nav.tabNetwork'],
];
const NETWORK: [string, string][] = [
  ['/app/dashboard', 'nav.subnavDashboard'],
  ['/app/jobs', 'nav.subnavJobs'],
  ['/app/nodes', 'nav.subnavNodes'],
  ['/app/wallet', 'nav.subnavWallet'],
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const t = useT();
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [restricted, setRestricted] = useState(false);

  useEffect(() => {
    publicApi<{ restricted: boolean }>('/config')
      .then((c) => setRestricted(!!c.restricted))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  // Online build (no local AI engine): only account + forum are usable; send
  // chat/agent/compute routes back to the account page.
  useEffect(() => {
    if (loading || !user || !restricted) return;
    const ok = pathname.startsWith('/app/account') || pathname.startsWith('/app/forum');
    if (!ok) router.replace('/app/account');
  }, [loading, user, restricted, pathname, router]);

  if (loading || !user) return <div style={{ padding: 40, color: theme.muted }}>{t('nav.loading')}</div>;

  const isNetwork = ['/app/dashboard', '/app/jobs', '/app/nodes', '/app/wallet', '/app/admin'].some((p) => pathname.startsWith(p));
  const activeTab = pathname.startsWith('/app/agent')
    ? '/app/agent'
    : pathname.startsWith('/app/image')
    ? '/app/image'
    : pathname.startsWith('/app/models')
    ? '/app/models'
    : pathname.startsWith('/app/forum')
    ? '/app/forum'
    : isNetwork
    ? '/app/dashboard'
    : '/app/chat';

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
      {/* first-run wizard: guides a new user to a working model (skips itself otherwise) */}
      {!restricted && <Onboarding />}
      {/* top bar: logo + segmented tabs + account (account lives here so tabs without
          a sidebar keep theme/lang/logout) */}
      <header style={{ display: 'flex', alignItems: 'center', gap: 24, padding: '10px 16px', borderBottom: `1px solid ${theme.border}` }}>
        <div className="display neon" style={{ fontSize: 18, letterSpacing: '0.1em', color: theme.accent }}>NEURION</div>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', borderRadius: 10, padding: 3 }}>
          {(restricted ? TABS.filter(([h]) => h === '/app/forum') : TABS).map(([h, l]) => tab(h, t(l)))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Link href="/app/account" title="Account" style={{ fontSize: 11, color: theme.muted, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'none' }}>{user.email}</Link>
          <ThemeToggle />
          <LangToggle />
          <button
            onClick={() => void logout().then(() => router.replace('/login'))}
            style={{ background: 'transparent', border: `1px solid ${theme.border}`, borderRadius: 8, color: theme.text, padding: '6px 8px', cursor: 'pointer', fontSize: 11 }}
          >
            {t('nav.logout')}
          </button>
        </div>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* contextual left sidebar: chat → sessions, agent → project folders,
            image → generation history; other tabs get the full width */}
        {(activeTab === '/app/chat' || activeTab === '/app/agent' || activeTab === '/app/image') && !restricted && (
          <aside style={{ width: 250, flexShrink: 0, borderRight: `1px solid ${theme.border}`, padding: 12, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Suspense fallback={<div style={{ color: theme.muted, fontSize: 12 }}>…</div>}>
              {activeTab === '/app/chat' ? <SessionsSidebar /> : activeTab === '/app/agent' ? <AgentSidebar /> : <GallerySidebar />}
            </Suspense>
          </aside>
        )}

        {/* main */}
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {isNetwork && (
            <div style={{ display: 'flex', gap: 6, padding: '8px 20px', borderBottom: `1px solid ${theme.border}` }}>
              {NETWORK.map(([h, l]) => (
                <Link key={h} href={h} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, textDecoration: 'none', color: pathname.startsWith(h) ? theme.text : theme.muted, background: pathname.startsWith(h) ? theme.surface : 'transparent' }}>{t(l)}</Link>
              ))}
              {(user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') && (
                <Link href="/app/admin" style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, textDecoration: 'none', color: pathname.startsWith('/app/admin') ? theme.text : theme.muted }}>{t('nav.adminLink')}</Link>
              )}
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0, padding: 20, overflowY: 'auto' }}>{children}</div>
        </main>
      </div>
    </div>
  );
}
