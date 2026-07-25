'use client';
import Link from 'next/link';
import { ForumBoard } from '../../components/forum/ForumBoard';
import { theme, button } from '../../lib/ui';
import { ThemeToggle } from '../../components/ThemeToggle';
import { LangToggle } from '../../components/LangToggle';
import { useT } from '../../lib/i18n';

export default function PublicForumPage() {
  const t = useT();
  return (
    <main style={{ minHeight: '100vh' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 20px', borderBottom: `1px solid ${theme.border}` }}>
        <Link href="/" className="display neon" style={{ fontSize: 20, letterSpacing: '0.1em', color: theme.accent, textDecoration: 'none' }}>NEURION</Link>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <ThemeToggle /><LangToggle />
          <Link href="/app/forum" style={{ ...button, padding: '6px 14px', textDecoration: 'none' }}>{t('forum.participate')}</Link>
        </div>
      </header>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px' }}>
        <ForumBoard canPost={false} threadHref={(id) => `/forum/${id}`} loginHref="/app/forum" />
      </div>
    </main>
  );
}
