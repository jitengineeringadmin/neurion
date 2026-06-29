'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import { theme, card, input, button } from '../../../../lib/ui';
import { useT } from '../../../../lib/i18n';

interface Author { id: string; name: string }
interface Post { id: string; body: string; createdAt: string; author: Author }
interface Thread {
  id: string; category: string; title: string; body: string; pinned: boolean; locked: boolean;
  createdAt: string; author: Author; posts: Post[];
}

export default function ThreadPage() {
  const t = useT();
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const id = String(params.id);
  const [th, setTh] = useState<Thread | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const isMod = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';

  const load = () => api<Thread>(`/forum/threads/${id}`).then(setTh).catch(() => setTh(null));
  useEffect(() => { void load(); }, [id]);

  async function sendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!reply.trim()) return;
    setBusy(true);
    try { await api(`/forum/threads/${id}/posts`, { method: 'POST', body: JSON.stringify({ body: reply }) }); setReply(''); await load(); }
    finally { setBusy(false); }
  }
  const delPost = async (pid: string) => { await api(`/forum/posts/${pid}`, { method: 'DELETE' }).catch(() => undefined); await load(); };
  const delThread = async () => { await api(`/forum/threads/${id}`, { method: 'DELETE' }).catch(() => undefined); router.push('/app/forum'); };
  const moderate = async (data: { pinned?: boolean; locked?: boolean }) => { await api(`/forum/threads/${id}`, { method: 'PATCH', body: JSON.stringify(data) }).catch(() => undefined); await load(); };

  if (!th) return <div style={{ color: theme.muted, padding: 20 }}>…</div>;
  const canDelThread = th.author.id === user?.id || isMod;

  const meta = (a: Author, date: string) => (
    <div style={{ fontSize: 12, color: theme.muted, marginBottom: 6 }}>
      <b style={{ color: theme.accent }}>{a.name}</b> · {new Date(date).toLocaleString()}
    </div>
  );

  return (
    <div style={{ maxWidth: 760 }}>
      <Link href="/app/forum" style={{ color: theme.muted, fontSize: 13, textDecoration: 'none' }}>← {t('forum.back')}</Link>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginTop: 8 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>{th.pinned && '📌 '}{th.locked && '🔒 '}{th.title}</h2>
      </div>
      <div style={{ fontSize: 12, color: theme.muted, margin: '4px 0 14px' }}>{t(`forum.cat${th.category.charAt(0)}${th.category.slice(1).toLowerCase()}`)}</div>

      {/* original post */}
      <div style={card}>
        {meta(th.author, th.createdAt)}
        <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6 }}>{th.body}</div>
      </div>

      {/* moderation / author controls */}
      {(canDelThread || isMod) && (
        <div style={{ display: 'flex', gap: 8, margin: '10px 0' }}>
          {isMod && <button onClick={() => void moderate({ pinned: !th.pinned })} style={ghost}>{th.pinned ? t('forum.unpin') : t('forum.pin')}</button>}
          {isMod && <button onClick={() => void moderate({ locked: !th.locked })} style={ghost}>{th.locked ? t('forum.unlock') : t('forum.lock')}</button>}
          {canDelThread && <button onClick={() => void delThread()} style={{ ...ghost, color: '#e0533d', borderColor: '#e0533d' }}>{t('forum.deleteThread')}</button>}
        </div>
      )}

      {/* replies */}
      <h3 style={{ fontSize: 14, color: theme.muted, textTransform: 'uppercase', letterSpacing: '.08em', margin: '22px 0 8px' }}>
        {th.posts.length} {t('forum.replies')}
      </h3>
      {th.posts.map((p) => (
        <div key={p.id} style={{ ...card, marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            {meta(p.author, p.createdAt)}
            {(p.author.id === user?.id || isMod) && (
              <button onClick={() => void delPost(p.id)} title={t('forum.delete')} style={{ background: 'transparent', border: 'none', color: theme.muted, cursor: 'pointer', fontSize: 13 }}>✕</button>
            )}
          </div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6 }}>{p.body}</div>
        </div>
      ))}

      {/* reply box */}
      {th.locked ? (
        <div style={{ color: theme.muted, fontSize: 13, marginTop: 12 }}>🔒 {t('forum.lockedNotice')}</div>
      ) : (
        <form onSubmit={sendReply} style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea style={{ ...input, minHeight: 90, resize: 'vertical', fontFamily: 'inherit' }} placeholder={t('forum.replyPlaceholder')} value={reply} maxLength={5000} onChange={(e) => setReply(e.target.value)} />
          <div><button type="submit" style={{ ...button, opacity: busy ? 0.6 : 1 }} disabled={busy}>{t('forum.reply')}</button></div>
        </form>
      )}
    </div>
  );
}

const ghost: React.CSSProperties = { background: 'transparent', border: `1px solid ${theme.border}`, color: theme.text, borderRadius: 8, padding: '5px 12px', fontSize: 12, cursor: 'pointer' };
