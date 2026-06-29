'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';
import { theme, button } from '../../lib/ui';
import { ThemeToggle } from '../../components/ThemeToggle';
import { LangToggle } from '../../components/LangToggle';
import { useT } from '../../lib/i18n';

const CATS = ['GENERAL', 'NODES', 'SUPPORT', 'IDEAS', 'ANNOUNCEMENTS'] as const;
type Cat = (typeof CATS)[number];
interface Thread {
  id: string; category: Cat; title: string; pinned: boolean; locked: boolean;
  lastActivityAt: string; author: { id: string; name: string }; replies: number;
}
const catKey: Record<Cat, string> = {
  GENERAL: 'forum.catGeneral', NODES: 'forum.catNodes', SUPPORT: 'forum.catSupport',
  IDEAS: 'forum.catIdeas', ANNOUNCEMENTS: 'forum.catAnnouncements',
};

export default function PublicForum() {
  const t = useT();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [filter, setFilter] = useState<Cat | 'ALL'>('ALL');
  useEffect(() => {
    api<Thread[]>(`/forum/threads${filter !== 'ALL' ? `?category=${filter}` : ''}`).then(setThreads).catch(() => setThreads([]));
  }, [filter]);

  const chip = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
    border: `1px solid ${active ? theme.accent : theme.border}`,
    background: active ? theme.accent : 'transparent', color: active ? 'var(--bg)' : theme.muted,
  });

  return (
    <main style={{ minHeight: '100vh' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 20px', borderBottom: `1px solid ${theme.border}` }}>
        <Link href="/" className="display neon" style={{ fontSize: 20, letterSpacing: '0.1em', color: theme.accent, textDecoration: 'none' }}>NEURION</Link>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <ThemeToggle /><LangToggle />
          <Link href="/app/forum" style={{ ...button, padding: '6px 14px', textDecoration: 'none' }}>{t('forum.participate')}</Link>
        </div>
      </header>

      <div style={{ maxWidth: 820, margin: '0 auto', padding: '28px 20px' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 26 }}>{t('forum.title')}</h1>
        <p style={{ color: theme.muted, fontSize: 14, marginTop: 0 }}>{t('forum.publicSubtitle')}</p>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '16px 0' }}>
          <span onClick={() => setFilter('ALL')} style={chip(filter === 'ALL')}>{t('forum.all')}</span>
          {CATS.map((c) => <span key={c} onClick={() => setFilter(c)} style={chip(filter === c)}>{t(catKey[c])}</span>)}
        </div>

        {threads.length === 0 && <div style={{ color: theme.muted, fontSize: 13 }}>{t('forum.empty')}</div>}
        {threads.map((th) => (
          <Link key={th.id} href={`/forum/${th.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderBottom: `1px solid ${theme.border}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, color: theme.text }}>
                  {th.pinned && <span style={{ color: theme.accent }}>📌 </span>}{th.locked && '🔒 '}{th.title}
                </div>
                <div style={{ fontSize: 12, color: theme.muted, marginTop: 3 }}>
                  {t(catKey[th.category])} · {th.author.name} · {new Date(th.lastActivityAt).toLocaleDateString()}
                </div>
              </div>
              <div style={{ fontSize: 13, color: theme.muted, textAlign: 'center', minWidth: 54 }}>
                <div style={{ color: theme.accent, fontWeight: 600 }}>{th.replies}</div>
                <div style={{ fontSize: 11 }}>{t('forum.replies')}</div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
