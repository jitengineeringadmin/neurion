'use client';
import { useState, useEffect } from 'react';
import { api, streamAgent, isDesktop, getProdToken, PROD_BASE } from '../../../lib/api';
import { theme, card, input, button, ghostButton } from '../../../lib/ui';
import { useT } from '../../../lib/i18n';
import { NetworkConnect } from '../../../components/NetworkConnect';

type Mode = 'ask' | 'auto' | 'local' | 'network';

interface Step {
  kind: 'start' | 'tool_call' | 'tool_result' | 'sub_start' | 'sub_end' | 'final' | 'error' | 'approval' | 'compute_ask' | 'note';
  depth: number;
  data: any;
}

export default function AgentPage() {
  const t = useT();
  const [goal, setGoal] = useState(t('agent.defaultGoal'));
  const [steps, setSteps] = useState<Step[]>([]);
  const [plan, setPlan] = useState<{ text: string; done: boolean }[] | null>(null);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<Mode>('ask');
  const [netModel, setNetModel] = useState('qwen2.5-coder:7b');
  const [compute, setCompute] = useState<{ lane: string; model: string; nodeId: string | null } | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const m = localStorage.getItem('neurion_compute');
    if (m === 'ask' || m === 'auto' || m === 'local' || m === 'network') setMode(m);
    const nm = localStorage.getItem('neurion_netmodel');
    if (nm) setNetModel(nm);
  }, []);
  const pickMode = (m: Mode) => { setMode(m); try { localStorage.setItem('neurion_compute', m); } catch {} };
  const pickNet = (v: string) => { setNetModel(v); try { localStorage.setItem('neurion_netmodel', v); } catch {} };

  async function run() {
    if (running || !goal.trim()) return;
    setSteps([]);
    setPlan(null);
    setCompute(null);
    setRunning(true);
    try {
      await streamAgent(goal, {
        onEvent: (event, d) => {
          if (event === 'agent.compute') { setCompute(d); return; }
          if (event === 'agent.compute_fallback') {
            setCompute((c) => (c ? { ...c, lane: 'local' } : c));
            setSteps((s) => [...s, { kind: 'note', depth: 0, data: { text: '⚡→💻 ' + t('agent.computeFallback') } }]);
            return;
          }
          if (event === 'agent.compute_billed') { return; }
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
            if (event === 'agent.compute_request') return [...s, { kind: 'compute_ask', depth: 0, data: { ...d, resolved: null } }];
            if (event === 'agent.final') return [...s, { kind: 'final', depth: d.depth, data: d }];
            if (event === 'agent.error') return [...s, { kind: 'error', depth: 0, data: d }];
            return s;
          });
        },
      }, undefined, undefined, {
        computeMode: mode,
        networkModel: netModel,
        // Desktop: relay the network LLM step to the production pool.
        ...(mode !== 'local' && isDesktop() && getProdToken() ? { relayBase: PROD_BASE, relayToken: getProdToken() as string } : {}),
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
      <h2 style={{ fontSize: 20, marginTop: 0 }}>{t('agent.heading')} <span style={{ color: theme.muted, fontSize: 13 }}>{t('agent.headingSubtitle')}</span></h2>
      <div style={{ ...card, marginBottom: 16 }}>
        <textarea
          style={{ ...input, minHeight: 64, resize: 'vertical' }}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder={t('agent.goalPlaceholder')}
        />
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button style={{ ...button, opacity: running ? 0.6 : 1 }} onClick={() => void run()} disabled={running}>
            {running ? t('agent.runningLabel') : t('agent.runAgentButton')}
          </button>
          <label style={{ fontSize: 12, color: theme.muted }}>{t('agent.compute')}</label>
          <select value={mode} onChange={(e) => pickMode(e.target.value as Mode)} style={{ ...input, width: 'auto', padding: '6px 8px', cursor: 'pointer' }}>
            <option value="ask">{t('agent.modeAsk')}</option>
            <option value="auto">{t('agent.modeAuto')}</option>
            <option value="local">{t('agent.modeLocal')}</option>
            <option value="network">{t('agent.modeNetwork')}</option>
          </select>
          {mode !== 'local' && (
            <input value={netModel} onChange={(e) => pickNet(e.target.value)} placeholder={t('agent.netModel')} title={t('agent.netModel')} style={{ ...input, width: 170, padding: '6px 8px' }} />
          )}
          {compute && (
            <span style={{ fontSize: 12, color: compute.lane === 'network' ? theme.accent : theme.muted }}>
              {compute.lane === 'network' ? '⚡' : '💻'} {compute.model}
            </span>
          )}
        </div>
        {mode !== 'local' && isDesktop() && (
          <div style={{ marginTop: 10 }}><NetworkConnect /></div>
        )}
      </div>

      {plan && plan.length > 0 && (
        <div style={{ ...card, marginBottom: 14 }}>
          <div style={{ fontSize: 12, color: theme.muted, marginBottom: 8 }}>{t('agent.planLabel')}</div>
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
            {s.kind === 'start' && <Dim>▸ {t('agent.goalPrefix')} {s.data.goal}</Dim>}
            {s.kind === 'sub_start' && <div style={{ color: theme.accent, fontSize: 13 }}>↳ {t('agent.subAgentPrefix')} {s.data.goal}</div>}
            {s.kind === 'sub_end' && <Dim>↳ {t('agent.subAgentDone')}</Dim>}
            {s.kind === 'approval' && (
              <div style={{ ...card, borderLeft: `2px solid ${theme.amber}`, padding: '10px 14px' }}>
                <div style={{ color: theme.amber, fontSize: 12, marginBottom: 6 }}>{t('agent.approvalRequired')}</div>
                <div style={{ fontSize: 13, marginBottom: 8, wordBreak: 'break-word' }}>
                  <span style={{ color: theme.accent }}>{s.data.tool}</span>
                  <span style={{ color: theme.muted }}> ({JSON.stringify(s.data.args)})</span>
                </div>
                {s.data.resolved === null ? (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button style={{ ...button, padding: '6px 14px' }} onClick={() => void respond(s.data.id, true)}>
                      {t('agent.approveButton')}
                    </button>
                    <button style={ghostButton} onClick={() => void respond(s.data.id, false)}>
                      {t('agent.denyButton')}
                    </button>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: s.data.resolved ? theme.green : theme.red }}>
                    {s.data.resolved ? t('agent.approvedStatus') : t('agent.deniedStatus')}
                  </div>
                )}
              </div>
            )}
            {s.kind === 'note' && <Dim>{s.data.text}</Dim>}
            {s.kind === 'compute_ask' && (
              <div style={{ ...card, borderLeft: `2px solid ${theme.accent}`, padding: '10px 14px' }}>
                <div style={{ fontSize: 13, marginBottom: 8 }}>{t('agent.computeAsk', { model: String(s.data.model) })}</div>
                {s.data.resolved === null ? (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button style={{ ...button, padding: '6px 14px' }} onClick={() => void respond(s.data.id, true)}>⚡ {t('agent.useNetwork')}</button>
                    <button style={ghostButton} onClick={() => void respond(s.data.id, false)}>💻 {t('agent.useLocal')}</button>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: s.data.resolved ? theme.accent : theme.muted }}>
                    {s.data.resolved ? '⚡ ' + t('agent.useNetwork') : '💻 ' + t('agent.useLocal')}
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
                <div style={{ color: theme.green, fontSize: 12, marginBottom: 4 }}>{t('agent.finalLabel')}</div>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{s.data.text}</div>
              </div>
            )}
            {s.kind === 'final' && s.depth > 0 && <Dim>↳ {t('agent.subAnswerPrefix')} {String(s.data.text).slice(0, 200)}</Dim>}
            {s.kind === 'error' && <div style={{ color: theme.red, fontSize: 13 }}>⚠ {s.data.message}</div>}
          </div>
        ))}
        {running && <div style={{ color: theme.accent, fontSize: 13 }}>{t('agent.thinkingStatus')}</div>}
      </div>
    </div>
  );
}

function Dim({ children }: { children: React.ReactNode }) {
  return <div style={{ color: theme.muted, fontSize: 12 }}>{children}</div>;
}
