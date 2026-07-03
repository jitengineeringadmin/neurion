'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { theme, ghostButton } from '../lib/ui';
import { useT } from '../lib/i18n';

const FOLDER_KEY = 'neurion_agent_folder';

/**
 * Agent-tab sidebar: the workspaces. Lists project folders; clicking one becomes the
 * agent's working folder (the page listens for 'neurion:agent-folder'). "+ Open folder"
 * both creates a project and selects it.
 */
export function AgentSidebar() {
  const t = useT();
  const [projects, setProjects] = useState<any[]>([]);
  const [active, setActive] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editName, setEditName] = useState('');

  const load = () => void api<any[]>('/projects').then(setProjects).catch(() => undefined);
  useEffect(() => {
    load();
    setActive(localStorage.getItem(FOLDER_KEY) || '');
    const h = () => { setActive(localStorage.getItem(FOLDER_KEY) || ''); load(); };
    window.addEventListener('neurion:agent-folder', h);
    return () => window.removeEventListener('neurion:agent-folder', h);
  }, []);

  function select(path: string) {
    const p = path.replace(/\\/g, '/');
    try { localStorage.setItem(FOLDER_KEY, p); } catch { /* ignore */ }
    setActive(p);
    window.dispatchEvent(new Event('neurion:agent-folder'));
  }

  async function openFolder() {
    try {
      const neurion = (window as any).neurion;
      let path: string | null = null;
      if (neurion?.pickFolder) path = (await neurion.pickFolder(active || undefined))?.path ?? null;
      else path = (await api<{ path: string | null }>('/projects/pick-folder', { method: 'POST', body: JSON.stringify({ initial: active || undefined }) })).path;
      if (!path) return;
      const p = path.replace(/\\/g, '/');
      const name = p.split('/').filter(Boolean).pop() || p;
      if (!projects.some((x) => String(x.path).replace(/\\/g, '/') === p)) {
        await api('/projects', { method: 'POST', body: JSON.stringify({ name, path: p }) }).catch(() => undefined);
        load();
      }
      select(p);
    } catch { /* cancelled */ }
  }

  async function del(id: string) {
    await api(`/projects/${id}`, { method: 'DELETE' }).catch(() => undefined);
    load();
  }
  function startRename(id: string, current: string) {
    setEditingId(id);
    setEditName(current);
  }
  async function commitRename(id: string, current: string) {
    const name = editName.trim();
    setEditingId('');
    if (!name || name === current) return;
    await api(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }).catch(() => undefined);
    load();
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingRight: 4 }}>
      <button onClick={() => void openFolder()} style={{ ...ghostButton, textAlign: 'left', marginBottom: 10, width: '100%' }}>📂 {t('sidebar.openFolder')}</button>
      <div style={{ fontSize: 12, letterSpacing: 0.4, color: theme.muted, textTransform: 'uppercase', margin: '6px 0 8px' }}>{t('sidebar.projectsHeading')}</div>
      {projects.map((p) => {
        const norm = String(p.path).replace(/\\/g, '/');
        const isActive = norm === active;
        return (
          <div key={p.id} onClick={() => select(p.path)} title={p.path}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 9px', borderRadius: 8, cursor: 'pointer', background: isActive ? theme.surface : 'transparent', borderLeft: `2px solid ${isActive ? theme.accent : 'transparent'}` }}>
            <span style={{ fontSize: 15 }}>📁</span>
            {editingId === p.id ? (
              <input autoFocus value={editName} onClick={(e) => e.stopPropagation()}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => void commitRename(p.id, p.name)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void commitRename(p.id, p.name); } else if (e.key === 'Escape') { setEditingId(''); } }}
                style={{ flex: 1, minWidth: 0, fontSize: 14.5, background: theme.bg, color: theme.text, border: `1px solid ${theme.accent}`, borderRadius: 6, padding: '3px 7px', outline: 'none' }} />
            ) : (
              <span onDoubleClick={(e) => { e.stopPropagation(); startRename(p.id, p.name); }} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14.5, color: isActive ? theme.text : theme.muted }}>{p.name}</span>
            )}
            <span onClick={(e) => { e.stopPropagation(); startRename(p.id, p.name); }} title={t('sidebar.rename')} style={{ color: theme.muted, fontSize: 14, cursor: 'pointer' }}>✎</span>
            <span onClick={(e) => { e.stopPropagation(); void del(p.id); }} title={t('gallery.delete')} style={{ color: theme.muted, fontSize: 14, cursor: 'pointer' }}>✕</span>
          </div>
        );
      })}
      {projects.length === 0 && <div style={{ fontSize: 13.5, color: theme.muted, padding: '4px 8px', lineHeight: 1.55 }}>{t('sidebar.noProjects')}</div>}
    </div>
  );
}
