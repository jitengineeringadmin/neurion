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
  async function rename(id: string, current: string) {
    const name = window.prompt(t('sidebar.renamePrompt'), current);
    if (name === null || !name.trim() || name.trim() === current) return;
    await api(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) }).catch(() => undefined);
    load();
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingRight: 4 }}>
      <button onClick={() => void openFolder()} style={{ ...ghostButton, textAlign: 'left', marginBottom: 10, width: '100%' }}>📂 {t('sidebar.openFolder')}</button>
      <div style={{ fontSize: 11, color: theme.muted, textTransform: 'uppercase', margin: '4px 0 6px' }}>{t('sidebar.projectsHeading')}</div>
      {projects.map((p) => {
        const norm = String(p.path).replace(/\\/g, '/');
        const isActive = norm === active;
        return (
          <div key={p.id} onClick={() => select(p.path)} title={p.path}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 8px', borderRadius: 8, cursor: 'pointer', background: isActive ? theme.surface : 'transparent', borderLeft: `2px solid ${isActive ? theme.accent : 'transparent'}` }}>
            <span style={{ fontSize: 13 }}>📁</span>
            <span onDoubleClick={(e) => { e.stopPropagation(); void rename(p.id, p.name); }} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: isActive ? theme.text : theme.muted }}>{p.name}</span>
            <span onClick={(e) => { e.stopPropagation(); void rename(p.id, p.name); }} title={t('sidebar.rename')} style={{ color: theme.muted, fontSize: 12, cursor: 'pointer' }}>✎</span>
            <span onClick={(e) => { e.stopPropagation(); void del(p.id); }} title={t('gallery.delete')} style={{ color: theme.muted, fontSize: 12, cursor: 'pointer' }}>✕</span>
          </div>
        );
      })}
      {projects.length === 0 && <div style={{ fontSize: 12, color: theme.muted, padding: '4px 8px', lineHeight: 1.5 }}>{t('sidebar.noProjects')}</div>}
    </div>
  );
}
