'use client';
import { useEffect, useRef, useState } from 'react';
import { api, streamChat } from '../../../lib/api';
import { theme, input, button } from '../../../lib/ui';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  badge?: { lane: string; provider: string; model: string; effectivePrivacy: string; labeled?: boolean };
  cost?: number;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [convId, setConvId] = useState<string | undefined>();
  const [balance, setBalance] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const refreshBalance = () =>
    api<{ balance: number }>('/credits/balance').then((b) => setBalance(b.balance)).catch(() => undefined);
  useEffect(() => {
    void refreshBalance();
  }, []);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages]);

  async function send() {
    const msg = text.trim();
    if (!msg || busy) return;
    setText('');
    setBusy(true);
    setMessages((m) => [...m, { role: 'user', content: msg }, { role: 'assistant', content: '' }]);
    const idx = messages.length + 1;
    try {
      await streamChat(
        { message: msg, conversationId: convId },
        {
          onEvent: (event, data) => {
            setMessages((m) => {
              const copy = [...m];
              const a = copy[idx];
              if (!a) return m;
              if (event === 'routing') a.badge = data;
              else if (event === 'token') a.content += data.text;
              else if (event === 'final') {
                a.cost = data.costCredits;
                if (data.conversationId) setConvId(data.conversationId);
                void refreshBalance();
              } else if (event === 'error') a.content = `⚠️ ${data.message}`;
              return copy;
            });
          },
        },
      );
    } catch (e) {
      setMessages((m) => {
        const copy = [...m];
        if (copy[idx]) copy[idx].content = `⚠️ ${(e as Error).message}`;
        return copy;
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 56px)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Chat</h2>
        <div style={{ fontSize: 13, color: theme.muted }}>
          credits: <span style={{ color: theme.text }}>{balance ?? '…'}</span>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, paddingRight: 8 }}>
        {messages.length === 0 && (
          <div style={{ color: theme.muted, fontSize: 14 }}>
            Ask anything. Routing, lane and credit cost are shown per answer.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '80%' }}>
            <div
              style={{
                background: m.role === 'user' ? theme.accent : theme.surface,
                border: m.role === 'user' ? 'none' : `1px solid ${theme.border}`,
                color: m.role === 'user' ? '#fff' : theme.text,
                borderRadius: 12,
                padding: '10px 14px',
                fontSize: 14,
                whiteSpace: 'pre-wrap',
                lineHeight: 1.5,
              }}
            >
              {m.content || (m.role === 'assistant' && busy ? '…' : '')}
            </div>
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
          placeholder="Message Neurion…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send();
          }}
        />
        <button style={{ ...button, opacity: busy ? 0.6 : 1 }} onClick={() => void send()} disabled={busy}>
          Send
        </button>
      </div>
    </div>
  );
}
