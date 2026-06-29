'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { theme, card, input, button } from '../../../lib/ui';
import { useT } from '../../../lib/i18n';

const CATS = ['GENERAL', 'NODES', 'SUPPORT', 'IDEAS', 'ANNOUNCEMENTS'] as const;
type Cat = (typeof CATS)[number];
interface Thread {
  id: string; category: Cat; title: string; pinned: boolean; locked: boolean;
  createdAt: string; lastActivityAt: string; author: { id: string; name: string }; replies: number;
}

const catLabelKey: Record<Cat, string> = {
  GENERAL: 'forum.catGeneral', NODES: 'forum.catNodes', SUPPORT: 'forum.catSupport',
  IDEAS: 'forum.catIdeas', ANNOUNCEMENTS: 'forum.catAnnouncements',
};

export default function ForumPage() {
  const t = useT();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [filter, setFilter] = useState<Cat | 'ALL'>('ALL');
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState<Cat>('GENERAL');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const load = (f: Cat | 'ALL') =>
    api<Thread[]>(`/forum/threads${f !== 'ALL' ? `?category=${f}` : ''}`).then(setThreads).catch(() => setThreads([]));
  useEffect(() => { void load(filter); }, [filter]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (title.trim().length < 3 || !body.trim()) return;
    setBusy(true);
    try {
      await api('/forum/threads', { method: 'POST', body: JSON.stringify({ category: cat, title, body }) });
      setTitle(''); setBody(''); setOpen(false); await load(filter);
    } finally { setBusy(false); }
  }

  const chip = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
    border: `1px solid ${active ? theme.accent : theme.border}`,
    background: active ? theme.accent : 'transparent', color: active ? 'var(--bg)' : theme.muted,
  });

  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>{t('forum.title')}</h2>
        <button onClick={() => setOpen((o) => !o)} style={{ ...button, padding: '6px 14px' }}>{t('forum.newThread')}</button>
      </div>
      <p style={{ color: theme.muted, fontSize: 13, marginTop: 4 }}>{t('forum.subtitle')}</p>

      {open && (
        <form onSubmit={create} style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10, margin: '12px 0' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {CATS.map((c) => (
              <span key={c} onClick={() => setCat(c)} style={chip(cat === c)}>{t(catLabelKey[c])}</span>
            ))}
          </div>
          <input style={input} placeholder={t('forum.titlePlaceholder')} value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} />
          <textarea style={{ ...input, minHeight: 110, resize: 'vertical', fontFamily: 'inherit' }} placeholder={t('forum.bodyPlaceholder')} value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} />
          <div>
            <button type="submit" style={{ ...button, opacity: busy ? 0.6 : 1 }} disabled={busy}>{t('forum.post')}</button>
          </div>
        </form>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '14px 0' }}>
        <span onClick={() => setFilter('ALL')} style={chip(filter === 'ALL')}>{t('forum.all')}</span>
        {CATS.map((c) => <span key={c} onClick={() => setFilter(c)} style={chip(filter === c)}>{t(catLabelKey[c])}</span>)}
      </div>

      {threads.length === 0 && <div style={{ color: theme.muted, fontSize: 13 }}>{t('forum.empty')}</div>}
      {threads.map((th) => (
        <Link key={th.id} href={`/app/forum/${th.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderBottom: `1px solid ${theme.border}` }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, color: theme.text }}>
                {th.pinned && <span style={{ color: theme.accent }}>📌 </span>}
                {th.locked && <span title="locked">🔒 </span>}
                {th.title}
              </div>
              <div style={{ fontSize: 12, color: theme.muted, marginTop: 3 }}>
                {t(catLabelKey[th.category])} · {th.author.name} · {new Date(th.lastActivityAt).toLocaleDateString()}
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
  );
}
