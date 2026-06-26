'use client';
import { useState } from 'react';
import { api, streamAgent } from '../../../lib/api';
import { theme, card, input, button, ghostButton } from '../../../lib/ui';

interface Step {
  kind: 'start' | 'tool_call' | 'tool_result' | 'sub_start' | 'sub_end' | 'final' | 'error' | 'approval';
  depth: number;
  data: any;
}

export default function AgentPage() {
  const [goal, setGoal] = useState('Check my credits and online nodes, then run an echo job with text "hello" and summarise.');
  const [steps, setSteps] = useState<Step[]>([]);
  const [plan, setPlan] = useState<{ text: string; done: boolean }[] | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    if (running || !goal.trim()) return;
    setSteps([]);
    setPlan(null);
    setRunning(true);
    try {
      await streamAgent(goal, {
        onEvent: (event, d) => {
          if (event === 'agent.plan') {
            setPlan(d.steps);
            return;
          }
          if (event === 'agent.plan_update') {
            setPlan((p) => (p ? p.map((s, i) => (i === d.index ? { ...s, done: d.done } : s)) : p));
            return;
          }
          setSteps((s) => {
            if (event === 'agent.start') return [...s, { kind: 'start', depth: 0, data: d }];
            if (event === 'agent.tool_call') return [...s, { kind: 'tool_call', depth: d.depth, data: d }];
            if (event === 'agent.tool_result') return [...s, { kind: 'tool_result', depth: d.depth, data: d }];
            if (event === 'agent.subagent.start') return [...s, { kind: 'sub_start', depth: d.depth, data: d }];
            if (event === 'agent.subagent.end') return [...s, { kind: 'sub_end', depth: d.depth, data: d }];
            if (event === 'agent.approval_request') return [...s, { kind: 'approval', depth: d.depth, data: { ...d, resolved: null } }];
            if (event === 'agent.approval_result')
              return s.map((x) => (x.kind === 'approval' && x.data.id === d.id ? { ...x, data: { ...x.data, resolved: d.approved } } : x));
            if (event === 'agent.final') return [...s, { kind: 'final', depth: d.depth, data: d }];
            if (event === 'agent.error') return [...s, { kind: 'error', depth: 0, data: d }];
            return s;
          });
        },
      });
    } catch (e) {
      setSteps((s) => [...s, { kind: 'error', depth: 0, data: { message: (e as Error).message } }]);
    } finally {
      setRunning(false);
    }
  }

  async function respond(id: string, approved: boolean) {
    setSteps((s) => s.map((x) => (x.kind === 'approval' && x.data.id === id ? { ...x, data: { ...x.data, resolved: approved } } : x)));
    await api('/agent/approve', { method: 'POST', body: JSON.stringify({ id, approved }) }).catch(() => undefined);
  }

  return (
    <div>
      <h2 style={{ fontSize: 20, marginTop: 0 }}>Agent <span style={{ color: theme.muted, fontSize: 13 }}>multi-agent · ReAct</span></h2>
      <div style={{ ...card, marginBottom: 16 }}>
        <textarea
          style={{ ...input, minHeight: 64, resize: 'vertical' }}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Give the agent a goal…"
        />
        <div style={{ marginTop: 10 }}>
          <button style={{ ...button, opacity: running ? 0.6 : 1 }} onClick={() => void run()} disabled={running}>
            {running ? 'running…' : 'Run agent ▸'}
          </button>
        </div>
      </div>

      {plan && plan.length > 0 && (
        <div style={{ ...card, marginBottom: 14 }}>
          <div style={{ fontSize: 12, color: theme.muted, marginBottom: 8 }}>plan</div>
          {plan.map((s, i) => (
            <div key={i} style={{ fontSize: 13, display: 'flex', gap: 8, padding: '2px 0' }}>
              <span style={{ color: s.done ? theme.green : theme.muted }}>{s.done ? '☑' : '☐'}</span>
              <span style={{ textDecoration: s.done ? 'line-through' : 'none', opacity: s.done ? 0.7 : 1 }}>{s.text}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ marginLeft: s.depth * 22 }}>
            {s.kind === 'start' && <Dim>▸ goal: {s.data.goal}</Dim>}
            {s.kind === 'sub_start' && <div style={{ color: theme.accent, fontSize: 13 }}>↳ sub-agent: {s.data.goal}</div>}
            {s.kind === 'sub_end' && <Dim>↳ sub-agent done</Dim>}
            {s.kind === 'approval' && (
              <div style={{ ...card, borderLeft: `2px solid ${theme.amber}`, padding: '10px 14px' }}>
                <div style={{ color: theme.amber, fontSize: 12, marginBottom: 6 }}>⚠ approval required</div>
                <div style={{ fontSize: 13, marginBottom: 8, wordBreak: 'break-word' }}>
                  <span style={{ color: theme.accent }}>{s.data.tool}</span>
                  <span style={{ color: theme.muted }}> ({JSON.stringify(s.data.args)})</span>
                </div>
                {s.data.resolved === null ? (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button style={{ ...button, padding: '6px 14px' }} onClick={() => void respond(s.data.id, true)}>
                      Approve
                    </button>
                    <button style={ghostButton} onClick={() => void respond(s.data.id, false)}>
                      Deny
                    </button>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: s.data.resolved ? theme.green : theme.red }}>
                    {s.data.resolved ? '✓ approved' : '✗ denied'}
                  </div>
                )}
              </div>
            )}
            {s.kind === 'tool_call' && (
              <div style={{ ...card, padding: '8px 12px', borderLeft: `2px solid ${theme.accent}` }}>
                {s.data.thought && <div style={{ color: theme.muted, fontSize: 12, marginBottom: 4 }}>💭 {s.data.thought}</div>}
                <div style={{ fontSize: 13 }}>
                  <span style={{ color: theme.accent }}>⚙ {s.data.tool}</span>
                  <span style={{ color: theme.muted }}>({JSON.stringify(s.data.args)})</span>
                </div>
              </div>
            )}
            {s.kind === 'tool_result' && (
              <div style={{ fontSize: 12, color: theme.muted, whiteSpace: 'pre-wrap', padding: '4px 12px', wordBreak: 'break-word' }}>
                ⟵ {typeof s.data.result === 'string' ? s.data.result.slice(0, 600) : JSON.stringify(s.data.result)}
              </div>
            )}
            {s.kind === 'final' && s.depth === 0 && (
              <div style={{ ...card, borderLeft: `2px solid ${theme.green}`, marginTop: 6 }}>
                <div style={{ color: theme.green, fontSize: 12, marginBottom: 4 }}>✓ final</div>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{s.data.text}</div>
              </div>
            )}
            {s.kind === 'final' && s.depth > 0 && <Dim>↳ sub-answer: {String(s.data.text).slice(0, 200)}</Dim>}
            {s.kind === 'error' && <div style={{ color: theme.red, fontSize: 13 }}>⚠ {s.data.message}</div>}
          </div>
        ))}
        {running && <div style={{ color: theme.accent, fontSize: 13 }}>▌ thinking…</div>}
      </div>
    </div>
  );
}

function Dim({ children }: { children: React.ReactNode }) {
  return <div style={{ color: theme.muted, fontSize: 12 }}>{children}</div>;
}
