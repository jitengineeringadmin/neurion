'use client';
import { useEffect, useState } from 'react';
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

  const load = () => {
    void api<any[]>('/chat/conversations').then(setConversations).catch(() => undefined);
    void api<any[]>('/projects').then(setProjects).catch(() => undefined);
  };
  useEffect(() => {
    load();
    const h = () => load();
    window.addEventListener('neurion:sessions-changed', h);
    return () => window.removeEventListener('neurion:sessions-changed', h);
  }, []);

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
    const name = prefillName || window.prompt(t('sessions.promptProjectName'));
    if (!name) return;
    let path: string | null = null;
    const initial = projects[0]?.path;
    const neurion = (window as any).neurion;
    if (neurion?.pickFolder) {
      try {
        path = (await neurion.pickFolder(initial))?.path ?? null;
      } catch {
        /* cancelled */
      }
    } else {
      try {
        path = (await api<{ path: string | null }>('/projects/pick-folder', { method: 'POST', body: JSON.stringify({ initial }) })).path;
      } catch {
        /* unavailable */
      }
    }
    if (!path) path = window.prompt(t('sessions.promptProjectFolder'));
    if (!path) return;
    await createProjectWithPath(name, path);
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
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: activeId === c.id ? theme.text : theme.muted }}>
        {c.title || t('sessions.newChatTitle')}
      </span>
      <span
        onClick={(e) => {
          e.stopPropagation();
          if (projects.length === 0) return void createProject();
          const list = projects.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
          const sel = window.prompt(t('sessions.promptAssignToProject') + '\n' + list);
          if (sel === null) return;
          void assignProject(c.id, projects[parseInt(sel, 10) - 1]?.id ?? null);
        }}
        title={t('sessions.assignProjectTooltip')}
        style={{ color: theme.muted, fontSize: 12 }}
      >
        📁
      </span>
      <span onClick={(e) => { e.stopPropagation(); void pinConv(c.id, !c.pinned); }} title={t('sessions.pinTooltip')} style={{ color: c.pinned ? theme.accent : theme.muted, fontSize: 12 }}>{c.pinned ? '★' : '☆'}</span>
      <span onClick={(e) => { e.stopPropagation(); void delConv(c.id); }} title={t('sessions.deleteTooltip')} style={{ color: theme.muted, fontSize: 12 }}>✕</span>
    </div>
  );

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0, paddingRight: 4, borderRadius: 8, background: dragOver ? theme.surface : 'transparent' }}
    >
      <button onClick={newSession} style={{ ...ghostButton, textAlign: 'left', marginBottom: 6 }}>＋ {t('sessions.newSessionButton')}</button>
      <button onClick={() => void createProject()} style={{ ...ghostButton, textAlign: 'left', marginBottom: 4, fontSize: 12 }}>＋ {t('sessions.newProjectFolderButton')}</button>
      <div style={{ fontSize: 10, color: dragOver ? theme.accent : theme.muted, marginBottom: 8, textAlign: 'center' }}>
        {dragOver ? t('sessions.dropFolderHint') : t('sessions.dragFolderHint')}
      </div>

      {pinned.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: theme.muted, textTransform: 'uppercase', margin: '8px 0 4px' }}>{t('sessions.pinnedHeading')}</div>
          {pinned.map(Item)}
        </>
      )}
      {projects.map((p) => {
        const items = conversations.filter((c) => !c.pinned && c.projectId === p.id);
        return (
          <div key={p.id}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '10px 0 4px', gap: 6 }}>
              <span title={p.path} style={{ fontSize: 11, color: theme.accent, textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📂 {p.name}</span>
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
      <div style={{ fontSize: 11, color: theme.muted, textTransform: 'uppercase', margin: '10px 0 4px' }}>{t('sessions.ungroupedHeading')}</div>
      {conversations.filter((c) => !c.pinned && !c.projectId).map(Item)}
      {conversations.length === 0 && <div style={{ fontSize: 12, color: theme.muted, padding: '4px 8px' }}>{t('sessions.noSessionsEmptyState')}</div>}
    </div>
  );
}
