'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '../lib/api';
import { theme, ghostButton } from '../lib/ui';
import { useT } from '../lib/i18n';

export function SessionsSidebar() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const activeId = params.get('c');
  const [conversations, setConversations] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [assignFor, setAssignFor] = useState('');

  const alive = useRef(true);
  // Retry while the API is still booting (desktop cold start ~40s): auto-logged-in
  // users skip the login health-gate and can hit this before the API is up, which
  // would otherwise show an empty history until a manual refresh.
  const load = (retries = 30) => {
    api<any[]>('/chat/conversations')
      .then((r) => { if (alive.current) setConversations(Array.isArray(r) ? r : []); })
      .catch(() => { if (alive.current && retries > 0) setTimeout(() => load(retries - 1), 2000); });
    api<any[]>('/projects')
      .then((r) => { if (alive.current) setProjects(Array.isArray(r) ? r : []); })
      .catch(() => undefined);
  };
  useEffect(() => {
    alive.current = true;
    load();
    const h = () => load();
    window.addEventListener('neurion:sessions-changed', h);
    return () => { alive.current = false; window.removeEventListener('neurion:sessions-changed', h); };
  }, []);
  useEffect(() => {
    if (!assignFor) return;
    const close = () => setAssignFor('');
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [assignFor]);

  const open = (id: string) => router.push(`/app/chat?c=${id}`);
  const newSession = () => router.push('/app/chat?new=1'); // explicit: start empty, don't restore the last one

  async function pinConv(id: string, pinned: boolean) {
    await api(`/chat/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ pinned }) }).catch(() => undefined);
    load();
  }
  async function delConv(id: string) {
    await api(`/chat/conversations/${id}`, { method: 'DELETE' }).catch(() => undefined);
    if (activeId === id) newSession();
    load();
  }
  async function assignProject(id: string, projectId: string | null) {
    await api(`/chat/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ projectId }) }).catch(() => undefined);
    load();
  }
  async function createProjectWithPath(name: string, path: string) {
    await api('/projects', { method: 'POST', body: JSON.stringify({ name, path }) }).catch(() => undefined);
    load();
  }
  async function createProject(prefillName?: string) {
    // Pick the folder first; derive the project name from its basename (no window.prompt — unsupported in Electron).
    let path: string | null = null;
    const initial = projects[0]?.path;
    const neurion = (window as any).neurion;
    if (neurion?.pickFolder) {
      try { path = (await neurion.pickFolder(initial))?.path ?? null; } catch { /* cancelled */ }
    } else {
      try { path = (await api<{ path: string | null }>('/projects/pick-folder', { method: 'POST', body: JSON.stringify({ initial }) })).path; } catch { /* unavailable */ }
    }
    if (!path) return;
    const p = path.replace(/\\/g, '/');
    const name = prefillName || p.split('/').filter(Boolean).pop() || p;
    await createProjectWithPath(name, p);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0] as any;
    if (f?.path) {
      void createProjectWithPath(f.name || t('sessions.defaultProjectName'), String(f.path).replace(/\\/g, '/'));
      return;
    }
    const entry = (e.dataTransfer.items?.[0] as any)?.webkitGetAsEntry?.();
    void createProject(entry?.isDirectory ? entry.name : undefined);
  }

  const pinned = conversations.filter((c) => c.pinned);
  const Item = (c: any) => (
    <div
      key={c.id}
      onClick={() => open(c.id)}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 8, cursor: 'pointer', background: activeId === c.id ? theme.surface : 'transparent' }}
    >
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14.5, color: activeId === c.id ? theme.text : theme.muted }}>
        {c.title || t('sessions.newChatTitle')}
      </span>
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <span
          onClick={(e) => {
            e.stopPropagation();
            if (projects.length === 0) return void createProject();
            setAssignFor(assignFor === c.id ? '' : c.id);
          }}
          title={t('sessions.assignProjectTooltip')}
          style={{ color: theme.muted, fontSize: 14, cursor: 'pointer' }}
        >
          📁
        </span>
        {assignFor === c.id && (
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 30, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 8, padding: 4, minWidth: 150, maxHeight: 260, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
            {projects.map((p) => (
              <div key={p.id} onClick={() => { void assignProject(c.id, p.id); setAssignFor(''); }}
                style={{ padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: c.projectId === p.id ? theme.accent : theme.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.projectId === p.id ? '✓ ' : ''}{p.name}
              </div>
            ))}
            {c.projectId && (
              <div onClick={() => { void assignProject(c.id, null); setAssignFor(''); }}
                style={{ padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: theme.muted, borderTop: `1px solid ${theme.border}`, marginTop: 2 }}>
                ✕ {t('sessions.assignRemove')}
              </div>
            )}
          </div>
        )}
      </span>
      <span onClick={(e) => { e.stopPropagation(); void pinConv(c.id, !c.pinned); }} title={t('sessions.pinTooltip')} style={{ color: c.pinned ? theme.accent : theme.muted, fontSize: 14 }}>{c.pinned ? '★' : '☆'}</span>
      <span onClick={(e) => { e.stopPropagation(); void delConv(c.id); }} title={t('sessions.deleteTooltip')} style={{ color: theme.muted, fontSize: 14 }}>✕</span>
    </div>
  );

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0, paddingRight: 4, borderRadius: 8, background: dragOver ? theme.surface : 'transparent' }}
    >
      <button onClick={newSession} style={{ ...ghostButton, textAlign: 'left', marginBottom: 8 }}>＋ {t('sessions.newSessionButton')}</button>

      {pinned.length > 0 && (
        <>
          <div style={{ fontSize: 12, letterSpacing: 0.4, color: theme.muted, textTransform: 'uppercase', margin: '8px 0 4px' }}>{t('sessions.pinnedHeading')}</div>
          {pinned.map(Item)}
        </>
      )}
      {projects.map((p) => {
        const items = conversations.filter((c) => !c.pinned && c.projectId === p.id);
        return (
          <div key={p.id}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '10px 0 4px', gap: 6 }}>
              <span title={p.path} style={{ fontSize: 12, letterSpacing: 0.3, color: theme.accent, textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📂 {p.name}</span>
              <span
                onClick={async () => {
                  const conv = await api<any>('/chat/conversations', { method: 'POST', body: JSON.stringify({ title: t('sessions.newChatTitle') }) });
                  await api(`/chat/conversations/${conv.id}`, { method: 'PATCH', body: JSON.stringify({ projectId: p.id }) }).catch(() => undefined);
                  load();
                  open(conv.id);
                }}
                title={t('sessions.newSessionInProjectTooltip')}
                style={{ cursor: 'pointer', color: theme.muted, fontSize: 15 }}
              >
                +
              </span>
            </div>
            {items.map(Item)}
          </div>
        );
      })}
      <div style={{ fontSize: 12, letterSpacing: 0.4, color: theme.muted, textTransform: 'uppercase', margin: '10px 0 4px' }}>{t('sessions.ungroupedHeading')}</div>
      {conversations.filter((c) => !c.pinned && !c.projectId).map(Item)}
      {conversations.length === 0 && <div style={{ fontSize: 13.5, color: theme.muted, padding: '4px 8px' }}>{t('sessions.noSessionsEmptyState')}</div>}
    </div>
  );
}
