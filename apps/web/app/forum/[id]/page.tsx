'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '../../../lib/api';
import { theme, card, button } from '../../../lib/ui';
import { ThemeToggle } from '../../../components/ThemeToggle';
import { LangToggle } from '../../../components/LangToggle';
import { useT } from '../../../lib/i18n';

interface Author { id: string; name: string }
interface Post { id: string; body: string; createdAt: string; author: Author }
interface Thread {
  id: string; category: string; title: string; body: string; pinned: boolean; locked: boolean;
  createdAt: string; author: Author; posts: Post[];
}

export default function PublicThread() {
  const t = useT();
  const { id } = useParams();
  const [th, setTh] = useState<Thread | null>(null);
  useEffect(() => { api<Thread>(`/forum/threads/${String(id)}`).then(setTh).catch(() => setTh(null)); }, [id]);

  const meta = (a: Author, date: string) => (
    <div style={{ fontSize: 12, color: theme.muted, marginBottom: 6 }}>
      <b style={{ color: theme.accent }}>{a.name}</b> · {new Date(date).toLocaleString()}
    </div>
  );

  return (
    <main style={{ minHeight: '100vh' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 20px', borderBottom: `1px solid ${theme.border}` }}>
        <Link href="/" className="display neon" style={{ fontSize: 20, letterSpacing: '0.1em', color: theme.accent, textDecoration: 'none' }}>NEURION</Link>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <ThemeToggle /><LangToggle />
          <Link href="/app/forum" style={{ ...button, padding: '6px 14px', textDecoration: 'none' }}>{t('forum.participate')}</Link>
        </div>
      </header>

      <div style={{ maxWidth: 760, margin: '0 auto', padding: '24px 20px' }}>
        <Link href="/forum" style={{ color: theme.muted, fontSize: 13, textDecoration: 'none' }}>← {t('forum.back')}</Link>
        {!th ? (
          <div style={{ color: theme.muted, padding: 20 }}>…</div>
        ) : (
          <>
            <h1 style={{ margin: '8px 0 4px', fontSize: 22 }}>{th.pinned && '📌 '}{th.locked && '🔒 '}{th.title}</h1>
            <div style={{ ...card, marginTop: 12 }}>
              {meta(th.author, th.createdAt)}
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6 }}>{th.body}</div>
            </div>
            <h3 style={{ fontSize: 14, color: theme.muted, textTransform: 'uppercase', letterSpacing: '.08em', margin: '20px 0 8px' }}>{th.posts.length} {t('forum.replies')}</h3>
            {th.posts.map((p) => (
              <div key={p.id} style={{ ...card, marginBottom: 10 }}>
                {meta(p.author, p.createdAt)}
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6 }}>{p.body}</div>
              </div>
            ))}
            <div style={{ marginTop: 16, padding: 14, border: `1px dashed ${theme.border}`, borderRadius: 12, textAlign: 'center' }}>
              <span style={{ color: theme.muted, fontSize: 13 }}>{t('forum.loginToReply')} </span>
              <Link href="/app/forum" style={{ color: theme.accent, fontSize: 13, textDecoration: 'none' }}>{t('forum.participate')} →</Link>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
