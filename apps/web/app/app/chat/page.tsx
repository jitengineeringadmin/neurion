'use client';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, streamChat, streamAgent } from '../../../lib/api';
import { theme, input, button } from '../../../lib/ui';
import { useT } from '../../../lib/i18n';

interface Approval { id: string; tool: string; args: any; resolved: boolean | null }
interface Msg {
  role: 'user' | 'assistant';
  content: string;
  badge?: { lane: string; provider: string; model: string; effectivePrivacy: string; labeled?: boolean };
  cost?: number;
  agent?: boolean;
  trace?: string[];
  approval?: Approval | null;
}

function ChatInner() {
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
  const cParam = params.get('c') || undefined;

  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
  const [convId, setConvId] = useState<string | undefined>(cParam);
  const [cwd, setCwd] = useState<string | undefined>();
  const endRef = useRef<HTMLDivElement>(null);

  const refreshBalance = () => api<{ balance: number }>('/credits/balance').then((b) => setBalance(b.balance)).catch(() => undefined);

  useEffect(() => {
    void refreshBalance();
    void api<{ models: string[]; chatDefault: string | null }>('/ai/models')
      .then((r) => {
        setModels(r.models || []);
        const saved = typeof window !== 'undefined' ? localStorage.getItem('neurion_model') : null;
        setModel(saved || r.chatDefault || (r.models?.[0] ?? ''));
      })
      .catch(() => undefined);
  }, []);

  // load the conversation selected in the URL
  useEffect(() => {
    setConvId(cParam);
    if (!cParam) {
      setMessages([]);
      setCwd(undefined);
      return;
    }
    void (async () => {
      try {
        const [msgs, conv, projs] = await Promise.all([
          api<any[]>(`/chat/conversations/${cParam}/messages`),
          api<any>(`/chat/conversations/${cParam}`),
          api<any[]>('/projects'),
        ]);
        setMessages(msgs.filter((m) => m.role === 'USER' || m.role === 'ASSISTANT').map((m) => ({ role: m.role === 'ASSISTANT' ? 'assistant' : 'user', content: m.content })));
        setCwd(projs.find((p) => p.id === conv.projectId)?.path);
      } catch {
        setMessages([]);
      }
    })();
  }, [cParam]);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages]);

  function patch(idx: number, fn: (a: Msg) => void) {
    setMessages((m) => { const c = [...m]; if (c[idx]) fn(c[idx]); return c; });
  }
  function pickModel(v: string) {
    setModel(v);
    if (typeof window !== 'undefined') localStorage.setItem('neurion_model', v);
  }
  async function respond(idx: number, id: string, approved: boolean) {
    patch(idx, (a) => { if (a.approval?.id === id) a.approval = { ...a.approval, resolved: approved }; });
    await api('/agent/approve', { method: 'POST', body: JSON.stringify({ id, approved }) }).catch(() => undefined);
  }

  // Stream an agent run into the assistant message at `idx` (file/shell tools, project cwd).
  async function streamAgentInto(idx: number, goal: string) {
    await streamAgent(goal, {
      onEvent: (event, d) => patch(idx, (a) => {
        a.trace = a.trace ?? [];
        if (event === 'agent.plan') a.trace.push(t('chat.agentTracePlan') + d.steps.map((s: any) => s.text).join(' · '));
        else if (event === 'agent.tool_call') a.trace.push(`⚙ ${d.tool} ${JSON.stringify(d.args).slice(0, 80)}`);
        else if (event === 'agent.tool_result') a.trace.push(`⟵ ${String(d.result).slice(0, 110)}`);
        else if (event === 'agent.subagent.start') a.trace.push(t('chat.agentTraceSubAgent') + d.goal);
        else if (event === 'agent.approval_request') a.approval = { id: d.id, tool: d.tool, args: d.args, resolved: null };
        else if (event === 'agent.approval_result' && a.approval) a.approval = { ...a.approval, resolved: d.approved };
        else if (event === 'agent.final') a.content = d.text;
        else if (event === 'agent.error') a.content = t('chat.agentErrorPrefix', { message: d.message });
      }),
    }, model || undefined, cwd);
    void refreshBalance();
  }

  async function send() {
    const msg = text.trim();
    if (!msg || busy) return;
    setText('');
    setBusy(true);
    setMessages((m) => [...m, { role: 'user', content: msg }, { role: 'assistant', content: '', agent: agentMode, trace: [], approval: null }]);
    const idx = messages.length + 1;
    try {
      if (agentMode) {
        await streamAgentInto(idx, msg);
      } else {
        await streamChat({ message: msg, conversationId: convId, preferredModel: model || undefined }, {
          onEvent: (event, data) => patch(idx, (a) => {
            if (event === 'routing') a.badge = data;
            else if (event === 'token') a.content += data.text;
            else if (event === 'final') {
              a.cost = data.costCredits;
              if (data.conversationId && !convId) {
                setConvId(data.conversationId);
                router.replace(`/app/chat?c=${data.conversationId}`);
                window.dispatchEvent(new Event('neurion:sessions-changed'));
              }
              void refreshBalance();
            } else if (event === 'error') a.content = t('chat.chatErrorPrefix', { message: data.message });
          }),
        });
      }
    } catch (e) {
      patch(idx, (a) => (a.content = t('chat.chatErrorPrefix', { message: (e as Error).message })));
    } finally {
      setBusy(false);
    }
  }

  // Quick action: analyze the bound project folder. Plain chat can't read files,
  // so this forces Agent mode (read-only) and runs a folder-scoped goal.
  async function analyzeFolder() {
    if (!cwd || busy) return;
    setAgentMode(true);
    setBusy(true);
    const goal = t('chat.analyzeFolderGoal', { cwd });
    setMessages((m) => [...m, { role: 'user', content: t('chat.analyzeFolderUserMsg') }, { role: 'assistant', content: '', agent: true, trace: [], approval: null }]);
    const idx = messages.length + 1;
    try {
      await streamAgentInto(idx, goal);
    } catch (e) {
      patch(idx, (a) => (a.content = t('chat.chatErrorPrefix', { message: (e as Error).message })));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>{t('chat.headingChat')}{cwd ? <span style={{ fontSize: 12, color: theme.muted, marginLeft: 10 }}>📂 {cwd}</span> : null}</h2>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select value={model} onChange={(e) => pickModel(e.target.value)} style={{ ...input, width: 'auto', padding: '5px 8px', fontSize: 12 }}>
            {model && !models.includes(model) && <option value={model}>{model}</option>}
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          {cwd && (
            <button
              onClick={() => void analyzeFolder()}
              disabled={busy}
              title={t('chat.analyzeFolderButtonTitle', { cwd })}
              style={{ background: 'transparent', color: theme.accent, border: `1px solid ${theme.accent}`, borderRadius: 8, padding: '5px 10px', fontSize: 12, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}
            >
              {t('chat.analyzeFolderButton')}
            </button>
          )}
          <button onClick={() => setAgentMode((v) => !v)} style={{ background: agentMode ? theme.accent : 'transparent', color: agentMode ? 'var(--bg)' : theme.muted, border: `1px solid ${agentMode ? theme.accent : theme.border}`, borderRadius: 8, padding: '5px 10px', fontSize: 12, cursor: 'pointer' }}>{agentMode ? t('chat.agentToggleOn') : t('chat.agentToggleOff')}</button>
          <div style={{ fontSize: 13, color: theme.muted }}>{t('chat.creditsLabel')} <span style={{ color: theme.text }}>{balance ?? '…'}</span></div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, paddingRight: 8 }}>
        {messages.length === 0 && <div style={{ color: theme.muted, fontSize: 14 }}>{agentMode ? t('chat.emptyStateAgent') : t('chat.emptyStateChat')}</div>}
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '82%', width: m.agent ? '82%' : 'auto' }}>
            {m.agent && m.trace && m.trace.length > 0 && (
              <div style={{ fontSize: 11, color: theme.muted, marginBottom: 6, display: 'flex', flexDirection: 'column', gap: 2, fontFamily: 'var(--font-mono)' }}>
                {m.trace.map((t, j) => <div key={j} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{t}</div>)}
              </div>
            )}
            {m.approval && m.approval.resolved === null && (
              <div style={{ border: `1px solid ${theme.amber}`, borderRadius: 10, padding: '8px 12px', marginBottom: 6 }}>
                <div style={{ color: theme.amber, fontSize: 12, marginBottom: 6 }}>{t('chat.approvalPrompt', { tool: m.approval.tool })}</div>
                <div style={{ fontSize: 11, color: theme.muted, marginBottom: 8, wordBreak: 'break-word' }}>{JSON.stringify(m.approval.args)}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={{ ...button, padding: '4px 12px' }} onClick={() => void respond(i, m.approval!.id, true)}>{t('chat.approveButton')}</button>
                  <button style={{ background: 'transparent', border: `1px solid ${theme.border}`, borderRadius: 8, color: theme.text, padding: '4px 12px', fontSize: 13, cursor: 'pointer' }} onClick={() => void respond(i, m.approval!.id, false)}>{t('chat.denyButton')}</button>
                </div>
              </div>
            )}
            {(m.content || !m.agent) && (
              <div style={{ background: m.role === 'user' ? theme.accent : theme.surface, border: m.role === 'user' ? 'none' : `1px solid ${theme.border}`, color: m.role === 'user' ? 'var(--bg)' : theme.text, borderRadius: 12, padding: '10px 14px', fontSize: 14, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                {m.content || (m.role === 'assistant' && busy ? <Thinking label={t('chat.thinking')} /> : '')}
              </div>
            )}
            {m.badge && (
              <div style={{ fontSize: 11, color: theme.muted, marginTop: 4, display: 'flex', gap: 8 }}>
                <span style={{ color: m.badge.lane === 'FALLBACK' ? theme.muted : theme.accent }}>
                  {m.badge.lane === 'FALLBACK' ? `💻 ${t('chat.laneLocal')}` : `⚡ ${t('chat.laneNetwork')}`}
                </span>
                {m.badge.model && <span>{m.badge.model}</span>}
                {m.badge.labeled && <span>{t('chat.badgeMockSuffix')}</span>}
                {m.cost != null && m.cost > 0 && <span>{t('chat.badgeCostSuffix', { cost: m.cost })}</span>}
              </div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <input style={input} placeholder={agentMode ? t('chat.inputPlaceholderAgent') : t('chat.inputPlaceholderChat')} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void send(); }} />
        <button style={{ ...button, opacity: busy ? 0.6 : 1 }} onClick={() => void send()} disabled={busy}>{agentMode ? t('chat.sendButtonRun') : t('chat.sendButtonSend')}</button>
      </div>
    </div>
  );
}

// Animated "thinking" indicator: the label plus cycling dots, so it's obvious the
// assistant is working (instead of a static "…").
function Thinking({ label }: { label: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((v) => (v + 1) % 4), 400);
    return () => clearInterval(id);
  }, []);
  return (
    <span style={{ color: theme.muted, fontStyle: 'italic' }}>
      {label}
      {'.'.repeat(n)}
      <span style={{ opacity: 0 }}>{'.'.repeat(3 - n)}</span>
    </span>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatInner />
    </Suspense>
  );
}
