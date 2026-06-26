'use client';
import { useEffect, useRef, useState } from 'react';
import { api, streamChat, streamAgent } from '../../../lib/api';
import { theme, input, button, ghostButton } from '../../../lib/ui';

interface Approval {
  id: string;
  tool: string;
  args: any;
  resolved: boolean | null;
}
interface Msg {
  role: 'user' | 'assistant';
  content: string;
  badge?: { lane: string; provider: string; model: string; effectivePrivacy: string; labeled?: boolean };
  cost?: number;
  agent?: boolean;
  trace?: string[];
  approval?: Approval | null;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [convId, setConvId] = useState<string | undefined>();
  const [balance, setBalance] = useState<number | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string>('');
  const [conversations, setConversations] = useState<any[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  const loadConversations = () =>
    api<any[]>('/chat/conversations').then(setConversations).catch(() => undefined);

  async function selectConversation(id: string) {
    setConvId(id);
    try {
      const msgs = await api<any[]>(`/chat/conversations/${id}/messages`);
      setMessages(
        msgs
          .filter((m) => m.role === 'USER' || m.role === 'ASSISTANT')
          .map((m) => ({ role: m.role === 'ASSISTANT' ? 'assistant' : 'user', content: m.content })),
      );
    } catch {
      setMessages([]);
    }
  }
  function newSession() {
    setConvId(undefined);
    setMessages([]);
  }
  async function pinConv(id: string, pinned: boolean) {
    await api(`/chat/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ pinned }) }).catch(() => undefined);
    void loadConversations();
  }
  async function delConv(id: string) {
    await api(`/chat/conversations/${id}`, { method: 'DELETE' }).catch(() => undefined);
    if (convId === id) newSession();
    void loadConversations();
  }

  const [projects, setProjects] = useState<any[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const loadProjects = () => api<any[]>('/projects').then(setProjects).catch(() => undefined);
  async function createProject(prefillName?: string) {
    const name = prefillName || window.prompt('Nome progetto?');
    if (!name) return;
    let path: string | null = null;
    try {
      const initial = projects[0]?.path; // open the picker near the last project
      const r = await api<{ path: string | null }>('/projects/pick-folder', { method: 'POST', body: JSON.stringify({ initial }) });
      path = r.path;
    } catch {
      /* dialog unavailable */
    }
    if (!path) path = window.prompt('Cartella del progetto (es. C:/Users/Giacomo/Desktop/mio-progetto)?');
    if (!path) return;
    await api('/projects', { method: 'POST', body: JSON.stringify({ name, path }) }).catch(() => undefined);
    void loadProjects();
  }

  function handleFolderDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    let name = '';
    const item = e.dataTransfer.items?.[0] as any;
    const entry = item?.webkitGetAsEntry?.();
    if (entry?.isDirectory) name = entry.name;
    else if (e.dataTransfer.files?.[0]) name = e.dataTransfer.files[0].name.replace(/\.[^.]+$/, '');
    void createProject(name || undefined);
  }
  async function newSessionInProject(projectId: string) {
    const conv = await api<any>('/chat/conversations', { method: 'POST', body: JSON.stringify({ title: 'Nuova chat' }) });
    await api(`/chat/conversations/${conv.id}`, { method: 'PATCH', body: JSON.stringify({ projectId }) }).catch(() => undefined);
    await loadConversations();
    void selectConversation(conv.id);
  }
  async function assignProject(id: string, projectId: string | null) {
    await api(`/chat/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ projectId }) }).catch(() => undefined);
    void loadConversations();
  }

  const refreshBalance = () =>
    api<{ balance: number }>('/credits/balance').then((b) => setBalance(b.balance)).catch(() => undefined);
  useEffect(() => {
    void refreshBalance();
    void loadConversations();
    void loadProjects();
    void api<{ models: string[]; chatDefault: string | null }>('/ai/models')
      .then((r) => {
        setModels(r.models);
        const saved = typeof window !== 'undefined' ? localStorage.getItem('neurion_model') : null;
        setModel(saved || r.chatDefault || r.models[0] || '');
      })
      .catch(() => undefined);
  }, []);

  function pickModel(m: string) {
    setModel(m);
    if (typeof window !== 'undefined') localStorage.setItem('neurion_model', m);
  }
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages]);

  function patch(idx: number, fn: (a: Msg) => void) {
    setMessages((m) => {
      const copy = [...m];
      const a = copy[idx];
      if (a) fn(a);
      return copy;
    });
  }

  async function respond(idx: number, id: string, approved: boolean) {
    patch(idx, (a) => {
      if (a.approval && a.approval.id === id) a.approval = { ...a.approval, resolved: approved };
    });
    await api('/agent/approve', { method: 'POST', body: JSON.stringify({ id, approved }) }).catch(() => undefined);
  }

  async function send() {
    const msg = text.trim();
    if (!msg || busy) return;
    setText('');
    setBusy(true);
    setMessages((m) => [...m, { role: 'user', content: msg }, { role: 'assistant', content: '', agent: agentMode, trace: [], approval: null }]);
    const idx = messages.length + 1;
    const activeConv = conversations.find((c) => c.id === convId);
    const cwd = projects.find((p) => p.id === activeConv?.projectId)?.path as string | undefined;
    try {
      if (agentMode) {
        await streamAgent(
          msg,
          {
          onEvent: (event, d) => {
            patch(idx, (a) => {
              a.trace = a.trace ?? [];
              if (event === 'agent.plan') a.trace.push('📋 ' + d.steps.map((s: any) => s.text).join(' · '));
              else if (event === 'agent.tool_call') a.trace.push(`⚙ ${d.tool} ${JSON.stringify(d.args).slice(0, 80)}`);
              else if (event === 'agent.tool_result') a.trace.push(`⟵ ${String(d.result).slice(0, 110)}`);
              else if (event === 'agent.subagent.start') a.trace.push('↳ sub-agent: ' + d.goal);
              else if (event === 'agent.approval_request') a.approval = { id: d.id, tool: d.tool, args: d.args, resolved: null };
              else if (event === 'agent.approval_result' && a.approval) a.approval = { ...a.approval, resolved: d.approved };
              else if (event === 'agent.final') a.content = d.text;
              else if (event === 'agent.error') a.content = `⚠️ ${d.message}`;
            });
          },
          },
          model || undefined,
          cwd,
        );
        void refreshBalance();
      } else {
        await streamChat(
          { message: msg, conversationId: convId, preferredModel: model || undefined },
          {
            onEvent: (event, data) => {
              patch(idx, (a) => {
                if (event === 'routing') a.badge = data;
                else if (event === 'token') a.content += data.text;
                else if (event === 'final') {
                  a.cost = data.costCredits;
                  if (data.conversationId) setConvId(data.conversationId);
                  void refreshBalance();
                } else if (event === 'error') a.content = `⚠️ ${data.message}`;
              });
            },
          },
        );
      }
    } catch (e) {
      patch(idx, (a) => (a.content = `⚠️ ${(e as Error).message}`));
    } finally {
      setBusy(false);
      void loadConversations();
    }
  }

  const pinned = conversations.filter((c) => c.pinned);
  const Item = (c: any) => (
    <div
      key={c.id}
      onClick={() => void selectConversation(c.id)}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 8, cursor: 'pointer', background: convId === c.id ? theme.surface : 'transparent' }}
    >
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: convId === c.id ? theme.text : theme.muted }}>
        {c.title || 'Nuova chat'}
      </span>
      <span
        onClick={(e) => {
          e.stopPropagation();
          if (projects.length === 0) {
            void createProject();
            return;
          }
          const list = projects.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
          const sel = window.prompt('Assegna a progetto (numero, vuoto = nessuno):\n' + list);
          if (sel === null) return;
          const idx = parseInt(sel, 10) - 1;
          void assignProject(c.id, projects[idx]?.id ?? null);
        }}
        title="assegna progetto"
        style={{ color: theme.muted, fontSize: 12 }}
      >
        📁
      </span>
      <span onClick={(e) => { e.stopPropagation(); void pinConv(c.id, !c.pinned); }} title="pin" style={{ color: c.pinned ? theme.accent : theme.muted, fontSize: 12 }}>{c.pinned ? '★' : '☆'}</span>
      <span onClick={(e) => { e.stopPropagation(); void delConv(c.id); }} title="delete" style={{ color: theme.muted, fontSize: 12 }}>✕</span>
    </div>
  );

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', gap: 14 }}>
      <aside
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleFolderDrop}
        style={{ width: 230, flexShrink: 0, borderRight: `1px solid ${dragOver ? theme.accent : theme.border}`, paddingRight: 12, overflowY: 'auto', display: 'flex', flexDirection: 'column', background: dragOver ? 'var(--surface)' : 'transparent' }}
      >
        <button onClick={newSession} style={{ ...ghostButton, textAlign: 'left', marginBottom: 6 }}>＋ Nuova sessione</button>
        <button onClick={() => void createProject()} style={{ ...ghostButton, textAlign: 'left', marginBottom: 4, fontSize: 12 }}>＋ Progetto (cartella)</button>
        <div style={{ fontSize: 10, color: dragOver ? theme.accent : theme.muted, marginBottom: 8, textAlign: 'center' }}>
          {dragOver ? '▼ rilascia la cartella' : 'o trascina una cartella qui'}
        </div>
        {pinned.length > 0 && (
          <>
            <div style={{ fontSize: 11, color: theme.muted, textTransform: 'uppercase', margin: '8px 0 4px' }}>Fissato</div>
            {pinned.map(Item)}
          </>
        )}
        {projects.map((p) => {
          const items = conversations.filter((c) => !c.pinned && c.projectId === p.id);
          return (
            <div key={p.id}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '10px 0 4px', gap: 6 }}>
                <span title={p.path} style={{ fontSize: 11, color: theme.accent, textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📂 {p.name}</span>
                <span onClick={() => void newSessionInProject(p.id)} title="nuova sessione nel progetto" style={{ cursor: 'pointer', color: theme.muted, fontSize: 15 }}>+</span>
              </div>
              {items.map(Item)}
            </div>
          );
        })}
        <div style={{ fontSize: 11, color: theme.muted, textTransform: 'uppercase', margin: '10px 0 4px' }}>Non raggruppato</div>
        {conversations.filter((c) => !c.pinned && !c.projectId).map(Item)}
        {conversations.length === 0 && <div style={{ fontSize: 12, color: theme.muted, padding: '4px 8px' }}>Nessuna sessione</div>}
      </aside>

      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Chat</h2>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          {models.length > 0 && (
            <select
              value={model}
              onChange={(e) => pickModel(e.target.value)}
              title="model"
              style={{
                background: 'var(--surface-2)',
                color: theme.text,
                border: `1px solid ${theme.border}`,
                borderRadius: 8,
                padding: '5px 8px',
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
                maxWidth: 180,
              }}
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => setAgentMode((v) => !v)}
            style={{
              background: agentMode ? theme.accent : 'transparent',
              color: agentMode ? 'var(--bg)' : theme.muted,
              border: `1px solid ${agentMode ? theme.accent : theme.border}`,
              borderRadius: 8,
              padding: '5px 10px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            🤖 Agent {agentMode ? 'on' : 'off'}
          </button>
          <div style={{ fontSize: 13, color: theme.muted }}>
            credits: <span style={{ color: theme.text }}>{balance ?? '…'}</span>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, paddingRight: 8 }}>
        {messages.length === 0 && (
          <div style={{ color: theme.muted, fontSize: 14 }}>
            {agentMode
              ? 'Agent mode: give a goal — the agent plans, uses tools and works on files (with approval).'
              : 'Ask anything. Routing, lane and credit cost are shown per answer.'}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '82%', width: m.agent ? '82%' : 'auto' }}>
            {m.agent && m.trace && m.trace.length > 0 && (
              <div style={{ fontSize: 11, color: theme.muted, marginBottom: 6, display: 'flex', flexDirection: 'column', gap: 2, fontFamily: 'var(--font-mono)' }}>
                {m.trace.map((t, j) => (
                  <div key={j} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{t}</div>
                ))}
              </div>
            )}
            {m.approval && m.approval.resolved === null && (
              <div style={{ border: `1px solid ${theme.amber}`, borderRadius: 10, padding: '8px 12px', marginBottom: 6 }}>
                <div style={{ color: theme.amber, fontSize: 12, marginBottom: 6 }}>⚠ approve {m.approval.tool}?</div>
                <div style={{ fontSize: 11, color: theme.muted, marginBottom: 8, wordBreak: 'break-word' }}>{JSON.stringify(m.approval.args)}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={{ ...button, padding: '4px 12px' }} onClick={() => void respond(i, m.approval!.id, true)}>Approve</button>
                  <button style={{ background: 'transparent', border: `1px solid ${theme.border}`, borderRadius: 8, color: theme.text, padding: '4px 12px', fontSize: 13, cursor: 'pointer' }} onClick={() => void respond(i, m.approval!.id, false)}>Deny</button>
                </div>
              </div>
            )}
            {(m.content || !m.agent) && (
              <div
                style={{
                  background: m.role === 'user' ? theme.accent : theme.surface,
                  border: m.role === 'user' ? 'none' : `1px solid ${theme.border}`,
                  color: m.role === 'user' ? 'var(--bg)' : theme.text,
                  borderRadius: 12,
                  padding: '10px 14px',
                  fontSize: 14,
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.5,
                }}
              >
                {m.content || (m.role === 'assistant' && busy ? '…' : '')}
              </div>
            )}
            {m.badge && (
              <div style={{ fontSize: 11, color: theme.muted, marginTop: 4, display: 'flex', gap: 8 }}>
                <span style={{ color: theme.accent }}>{m.badge.lane}</span>
                <span>{m.badge.provider}{m.badge.labeled ? ' (mock)' : ''}</span>
                <span>{m.badge.effectivePrivacy}</span>
                {m.cost != null && <span>· {m.cost} cr</span>}
              </div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <input
          style={input}
          placeholder={agentMode ? 'Give the agent a goal…' : 'Message Neurion…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send();
          }}
        />
        <button style={{ ...button, opacity: busy ? 0.6 : 1 }} onClick={() => void send()} disabled={busy}>
          {agentMode ? 'Run' : 'Send'}
        </button>
      </div>
      </div>
    </div>
  );
}
