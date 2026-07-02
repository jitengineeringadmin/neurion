'use client';
import { useState, useEffect, useRef } from 'react';
import { api, streamAgent, isDesktop, getProdToken, PROD_BASE } from '../../../lib/api';
import { theme, card, input, button, ghostButton } from '../../../lib/ui';
import { useT } from '../../../lib/i18n';
import { NetworkConnect } from '../../../components/NetworkConnect';
import { Markdown } from '../../../components/Markdown';

const FOLDER_KEY = 'neurion_agent_folder'; // last-opened working folder, restored across sessions
// Tools that create/modify a file — used to build the live "changed files" panel.
const WRITE_TOOLS: Record<string, string> = {
  write_file: '✏️', edit_file: '✏️', append_file: '✏️', apply_patch: '🩹',
  make_dir: '📁', move_path: '➡️', delete_path: '🗑️', create_project: '📁',
};

// Human-readable labels for tool calls: a normal user should read "Reading config.txt",
// not `read_file({"path":...})`. The raw JSON stays available behind a toggle.
const TOOL_META: Record<string, { icon: string; key: string; arg?: string[] }> = {
  read_file: { icon: '📖', key: 'agent.t.read_file', arg: ['path'] },
  write_file: { icon: '✏️', key: 'agent.t.write_file', arg: ['path'] },
  edit_file: { icon: '✏️', key: 'agent.t.edit_file', arg: ['path'] },
  apply_patch: { icon: '🩹', key: 'agent.t.apply_patch', arg: ['path'] },
  run_command: { icon: '⚡', key: 'agent.t.run_command', arg: ['command'] },
  list_dir: { icon: '📂', key: 'agent.t.list_dir', arg: ['path'] },
  find_files: { icon: '🔎', key: 'agent.t.find_files', arg: ['pattern', 'query'] },
  search_files: { icon: '🔎', key: 'agent.t.search_files', arg: ['pattern', 'query'] },
  create_project: { icon: '📁', key: 'agent.t.create_project', arg: ['name', 'path'] },
  spawn_agent: { icon: '🤖', key: 'agent.t.spawn_agent' },
  remember: { icon: '🧠', key: 'agent.t.remember' },
  recall: { icon: '🧠', key: 'agent.t.recall' },
  set_plan: { icon: '📋', key: 'agent.t.set_plan' },
  web_fetch: { icon: '🌐', key: 'agent.t.web_fetch', arg: ['url'] },
  create_grid_job: { icon: '🕸️', key: 'agent.t.create_grid_job' },
};
function humanTool(tool: string, args: Record<string, unknown> | undefined, t: (k: string, v?: Record<string, string | number>) => string): { icon: string; text: string } {
  const m = TOOL_META[tool];
  if (!m) return { icon: '⚙', text: tool };
  let v = '';
  if (m.arg && args) {
    for (const k of m.arg) { const x = args[k]; if (typeof x === 'string' && x) { v = x; break; } }
    if (!v) { const first = Object.values(args).find((x) => typeof x === 'string' && x); v = (first as string) || ''; }
  }
  if (v.length > 70) v = v.slice(0, 67) + '…';
  return { icon: m.icon, text: t(m.key, { v }) };
}

type Mode = 'ask' | 'auto' | 'local' | 'network';

interface Step {
  kind: 'goal' | 'start' | 'tool_call' | 'tool_result' | 'sub_start' | 'sub_end' | 'final' | 'error' | 'approval' | 'compute_ask' | 'note';
  depth: number;
  data: any;
}

// The code/content a write tool is about to put on disk — shown inline so you can
// watch the agent write, Claude-Code style.
function writeContent(tool: string, args: any): string | null {
  if (!args) return null;
  if (tool === 'apply_patch') return typeof args.patch === 'string' ? args.patch : null;
  const c = args.content ?? args.text ?? args.new_content ?? args.new_str ?? args.data;
  return typeof c === 'string' && c.length ? c : null;
}

// Per-folder transcript history, so the Code conversation survives tab switches /
// reloads (like chat). Kept in localStorage keyed by the working folder.
const HIST_KEY = (f: string) => 'neurion_code_hist_' + f;
function loadHist(f: string): Step[] {
  if (!f || typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem(HIST_KEY(f)) || '[]') as Step[]; } catch { return []; }
}
function saveHist(f: string, s: Step[]): void {
  if (!f || typeof window === 'undefined' || s.length === 0) return; // never wipe with empty
  try {
    let arr = s.slice(-400);
    let str = JSON.stringify(arr);
    while (str.length > 2_000_000 && arr.length > 2) { arr = arr.slice(Math.ceil(arr.length / 3)); str = JSON.stringify(arr); }
    localStorage.setItem(HIST_KEY(f), str);
  } catch { /* quota — drop silently */ }
}

export default function AgentPage() {
  const t = useT();
  const [goal, setGoal] = useState('');
  const [steps, setSteps] = useState<Step[]>([]);
  const [autonomous, setAutonomous] = useState(false); // Claude-Code autonomous mode (no approvals)
  const endRef = useRef<HTMLDivElement>(null);
  const stepsFolderRef = useRef(''); // which folder the current `steps` belong to (for correct persistence)
  const [plan, setPlan] = useState<{ text: string; done: boolean }[] | null>(null);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<Mode>('ask');
  const [netModel, setNetModel] = useState('qwen2.5-coder:7b');
  const [compute, setCompute] = useState<{ lane: string; model: string; nodeId: string | null } | null>(null);
  const [folder, setFolder] = useState<string>(''); // working directory (Claude-Code style)
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState(''); // local-lane model (like the chat picker)
  const [touched, setTouched] = useState<{ path: string; icon: string }[]>([]); // files the run created/edited
  const [picking, setPicking] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [preview, setPreview] = useState<{ files: string[]; file: string | null; content: string | null }>({ files: [], file: null, content: null });
  const [rules, setRules] = useState<{ exists: boolean; content: string }>({ exists: false, content: '' });
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rulesDraft, setRulesDraft] = useState('');
  const [rulesBusy, setRulesBusy] = useState(false);

  const RULES_TEMPLATE = `# Regole del progetto\n- Stack: HTML + Tailwind (CDN).\n- Lingua dei contenuti: italiano. Commenti in italiano.\n- Palette: (scrivi i tuoi colori).\n- Niente lorem ipsum: contenuti realistici.\n- Chiudi appena il file è pronto, senza rifarlo.\n`;
  const loadRules = () => {
    if (!folder) { setRules({ exists: false, content: '' }); return; }
    void api<{ exists: boolean; content: string }>('/projects/rules', { method: 'POST', body: JSON.stringify({ dir: folder }) })
      .then((r) => setRules({ exists: r.exists, content: r.content })).catch(() => undefined);
  };
  async function saveRules() {
    if (!folder) return;
    setRulesBusy(true);
    try {
      const r = await api<{ exists: boolean; content: string }>('/projects/rules', { method: 'PUT', body: JSON.stringify({ dir: folder, content: rulesDraft }) });
      setRules({ exists: r.exists, content: r.content });
      setRulesOpen(false);
    } catch { /* ignore */ } finally { setRulesBusy(false); }
  }

  const loadPreview = (file?: string) => {
    if (!folder) return;
    void api<{ files: string[]; file: string | null; content: string | null }>('/projects/preview', { method: 'POST', body: JSON.stringify({ dir: folder, file }) })
      .then(setPreview).catch(() => undefined);
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const m = localStorage.getItem('neurion_compute');
    if (m === 'ask' || m === 'auto' || m === 'local' || m === 'network') setMode(m);
    const nm = localStorage.getItem('neurion_netmodel');
    if (nm) setNetModel(nm);
    setAutonomous(localStorage.getItem('neurion_agent_auto') === '1');
    const f = localStorage.getItem(FOLDER_KEY);
    if (f) { setFolder(f); setSteps(loadHist(f)); stepsFolderRef.current = f; } // restore this project's transcript
    // model picker, like chat: installed models + remembered choice
    void api<{ models: string[]; agentDefault: string | null }>('/ai/models')
      .then((r) => {
        setModels(r.models || []);
        const saved = localStorage.getItem('neurion_agent_model');
        setModel((saved && r.models?.includes(saved) ? saved : null) || r.agentDefault || (r.models?.[0] ?? ''));
      })
      .catch(() => undefined);
    // sidebar switched project → load that folder + its transcript
    const h = () => { const nf = localStorage.getItem(FOLDER_KEY) || ''; setFolder(nf); setSteps(loadHist(nf)); stepsFolderRef.current = nf; };
    window.addEventListener('neurion:agent-folder', h);
    return () => window.removeEventListener('neurion:agent-folder', h);
  }, []);
  // persist the transcript under the folder it belongs to (ref, not `folder`, to avoid
  // saving stale steps under a just-switched folder)
  useEffect(() => { saveHist(stepsFolderRef.current, steps); }, [steps]);
  // refresh the preview when it's opened or the folder changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (showPreview) loadPreview(); }, [showPreview, folder]);
  // check for a per-project rules file (NEURION.md) whenever the folder changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadRules(); }, [folder]);
  const pickLocalModel = (v: string) => { setModel(v); try { localStorage.setItem('neurion_agent_model', v); } catch { /* ignore */ } };
  const toggleAuto = () => setAutonomous((a) => { const n = !a; try { localStorage.setItem('neurion_agent_auto', n ? '1' : '0'); } catch { /* ignore */ } return n; });
  // auto-scroll the transcript as the agent works (chat-style)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [steps]);

  const shortFolder = folder ? folder.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/') : '';
  async function pickFolder() {
    if (picking) return;
    setPicking(true);
    try {
      const neurion = (window as any).neurion;
      let path: string | null = null;
      if (neurion?.pickFolder) path = (await neurion.pickFolder(folder || undefined))?.path ?? null;
      else path = (await api<{ path: string | null }>('/projects/pick-folder', { method: 'POST', body: JSON.stringify({ initial: folder || undefined }) })).path;
      if (path) {
        const p = path.replace(/\\/g, '/');
        setFolder(p);
        try { localStorage.setItem(FOLDER_KEY, p); } catch { /* ignore */ }
        // register it as a Project so the sidebar lists it (idempotent server-side check is cheap)
        const name = p.split('/').filter(Boolean).pop() || p;
        try {
          const list = await api<{ id: string; path: string }[]>('/projects');
          if (!list.some((x) => String(x.path).replace(/\\/g, '/') === p)) {
            await api('/projects', { method: 'POST', body: JSON.stringify({ name, path: p }) });
          }
        } catch { /* best effort */ }
        window.dispatchEvent(new Event('neurion:agent-folder')); // sidebar highlights + reloads
      }
    } catch { /* cancelled / unavailable */ } finally { setPicking(false); }
  }
  const pickMode = (m: Mode) => { setMode(m); try { localStorage.setItem('neurion_compute', m); } catch {} };
  const pickNet = (v: string) => { setNetModel(v); try { localStorage.setItem('neurion_netmodel', v); } catch {} };

  async function run() {
    const g = goal.trim();
    if (running || !g) return;
    setGoal(''); // clear the box; the goal becomes a bubble (chat-style)
    setSteps((s) => [...s, { kind: 'goal', depth: 0, data: { text: g } }]);
    setPlan(null);
    setCompute(null);
    setRunning(true);
    try {
      await streamAgent(g, {
        onEvent: (event, d) => {
          if (event === 'agent.compute') { setCompute(d); return; }
          if (event === 'agent.compute_fallback') {
            setCompute((c) => (c ? { ...c, lane: 'local' } : c));
            setSteps((s) => [...s, { kind: 'note', depth: 0, data: { text: '⚡→💻 ' + t('agent.computeFallback') } }]);
            return;
          }
          if (event === 'agent.compute_billed') { return; }
          if (event === 'agent.tool_call' && WRITE_TOOLS[d.tool]) {
            const p = d.args?.path || d.args?.to || d.args?.dest || d.args?.name;
            if (typeof p === 'string' && p) setTouched((prev) => (prev.some((x) => x.path === p) ? prev : [...prev, { path: p, icon: WRITE_TOOLS[d.tool] }]));
          }
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
      }, model || undefined, folder || undefined, {
        computeMode: mode,
        networkModel: netModel,
        confineToCwd: !!folder, // Claude-Code style: only touch files inside the opened folder
        autoApprove: autonomous, // autonomous mode = run write/shell tools without asking
        // Desktop: relay the network LLM step to the production pool.
        ...(mode !== 'local' && isDesktop() && getProdToken() ? { relayBase: PROD_BASE, relayToken: getProdToken() as string } : {}),
      });
    } catch (e) {
      setSteps((s) => [...s, { kind: 'error', depth: 0, data: { message: (e as Error).message } }]);
    } finally {
      setRunning(false);
      if (showPreview) setTimeout(() => loadPreview(preview.file ?? undefined), 300); // refresh preview after the run
    }
  }

  async function respond(id: string, approved: boolean) {
    setSteps((s) => s.map((x) => (x.kind === 'approval' && x.data.id === id ? { ...x, data: { ...x.data, resolved: approved } } : x)));
    await api('/agent/approve', { method: 'POST', body: JSON.stringify({ id, approved }) }).catch(() => undefined);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {rulesOpen && (
        <div onClick={() => setRulesOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'color-mix(in srgb, var(--bg) 70%, transparent)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: 620, maxWidth: '92vw' }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>📋 NEURION.md</div>
            <p style={{ color: theme.muted, fontSize: 12.5, marginTop: 4, lineHeight: 1.5 }}>{t('agent.rulesSub')}</p>
            <textarea value={rulesDraft} onChange={(e) => setRulesDraft(e.target.value)} style={{ ...input, minHeight: 260, resize: 'vertical', fontFamily: 'var(--font-mono), monospace', fontSize: 13, lineHeight: 1.55 }} />
            <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
              <button onClick={() => void saveRules()} disabled={rulesBusy} style={{ ...button, padding: '8px 18px', opacity: rulesBusy ? 0.5 : 1 }}>{rulesBusy ? '…' : t('agent.rulesSave')}</button>
              <button onClick={() => setRulesOpen(false)} style={ghostButton}>{t('agent.rulesClose')}</button>
            </div>
          </div>
        </div>
      )}
      <h2 style={{ fontSize: 20, marginTop: 0 }}>{t('agent.heading')} <span style={{ color: theme.muted, fontSize: 13 }}>{t('agent.headingSubtitle')}</span></h2>
      <div style={{ ...card, marginBottom: 16 }}>
        {/* Working folder — the agent creates/edits files inside it (Claude-Code style). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${theme.border}` }}>
          <span style={{ fontSize: 15 }}>📂</span>
          {folder ? (
            <>
              <span title={folder} style={{ fontSize: 13, color: theme.text, fontFamily: 'var(--font-mono), monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>…/{shortFolder}</span>
              <button onClick={() => { setRulesDraft(rules.content || RULES_TEMPLATE); setRulesOpen(true); }} title={t('agent.rulesHint')} style={{ ...ghostButton, borderColor: rules.exists ? theme.accent : undefined, color: rules.exists ? theme.accent : undefined }}>📋 NEURION.md{rules.exists ? ' ✓' : ''}</button>
              <button onClick={() => { setShowPreview((v) => !v); }} title={t('agent.previewHint')} style={{ ...ghostButton, borderColor: showPreview ? theme.accent : undefined, color: showPreview ? theme.accent : undefined }}>👁 {t('agent.preview')}</button>
              <button onClick={() => void pickFolder()} disabled={picking} style={ghostButton}>{t('agent.changeFolder')}</button>
            </>
          ) : (
            <>
              <span style={{ fontSize: 13, color: theme.muted, flex: 1 }}>{t('agent.noFolderHint')}</span>
              <button onClick={() => void pickFolder()} disabled={picking} style={{ ...button, padding: '6px 14px' }}>{picking ? '…' : t('agent.chooseFolder')}</button>
            </>
          )}
        </div>
      </div>

      {/* middle: transcript (+ optional collapsible live preview) */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 12 }}>
      <div style={{ flex: showPreview ? '1 1 52%' : 1, minWidth: 0, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
      {steps.length > 0 && !running && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <button
            onClick={() => { setSteps([]); setPlan(null); setTouched([]); try { if (folder) localStorage.removeItem(HIST_KEY(folder)); } catch { /* ignore */ } }}
            style={{ background: 'transparent', border: 'none', color: theme.muted, cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}
          >
            🗑 {t('agent.clearHist')}
          </button>
        </div>
      )}
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

      {touched.length > 0 && (
        <div style={{ ...card, marginBottom: 14, borderLeft: `2px solid ${theme.green}` }}>
          <div style={{ fontSize: 12, color: theme.muted, marginBottom: 8 }}>{t('agent.filesChanged')} · {touched.length}</div>
          {touched.map((f, i) => (
            <div key={i} style={{ fontSize: 13, fontFamily: 'var(--font-mono), monospace', padding: '2px 0', display: 'flex', gap: 8 }}>
              <span>{f.icon}</span><span style={{ wordBreak: 'break-all' }}>{f.path}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ marginLeft: s.depth * 22 }}>
            {s.kind === 'goal' && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '6px 0' }}>
                <div style={{ background: theme.accent, color: 'var(--bg)', borderRadius: 12, padding: '8px 14px', fontSize: 14, maxWidth: '80%', whiteSpace: 'pre-wrap' }}>{s.data.text}</div>
              </div>
            )}
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
            {s.kind === 'tool_call' && (() => {
              const h = humanTool(String(s.data.tool), s.data.args, t);
              return (
                <div style={{ ...card, padding: '8px 12px', borderLeft: `2px solid ${theme.accent}` }}>
                  {s.data.thought && <div style={{ color: theme.muted, fontSize: 12, marginBottom: 4 }}>💭 {s.data.thought}</div>}
                  <div style={{ fontSize: 13 }}>
                    <span>{h.icon} </span>
                    <span style={{ color: theme.text }}>{h.text}</span>
                  </div>
                  {(() => {
                    const code = writeContent(String(s.data.tool), s.data.args);
                    return code ? (
                      <pre style={{ fontSize: 12, lineHeight: 1.5, background: 'var(--bg-deep)', border: `1px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', margin: '6px 0 0', maxHeight: 260, overflow: 'auto', fontFamily: 'var(--font-mono), monospace' }}>{code}</pre>
                    ) : null;
                  })()}
                  <details style={{ marginTop: 4 }}>
                    <summary style={{ fontSize: 11, color: theme.muted, cursor: 'pointer', listStylePosition: 'inside' }}>{t('agent.details')}</summary>
                    <pre style={{ fontSize: 11, color: theme.muted, margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{s.data.tool}({JSON.stringify(s.data.args, null, 1)})</pre>
                  </details>
                </div>
              );
            })()}
            {s.kind === 'tool_result' && (
              <div style={{ fontSize: 12, color: theme.muted, whiteSpace: 'pre-wrap', padding: '4px 12px', wordBreak: 'break-word' }}>
                ⟵ {typeof s.data.result === 'string' ? s.data.result.slice(0, 600) : JSON.stringify(s.data.result)}
              </div>
            )}
            {s.kind === 'final' && s.depth === 0 && (
              <div style={{ ...card, borderLeft: `2px solid ${theme.green}`, marginTop: 6 }}>
                <div style={{ color: theme.green, fontSize: 12, marginBottom: 4 }}>{t('agent.finalLabel')}</div>
                <Markdown>{String(s.data.text ?? '')}</Markdown>
              </div>
            )}
            {s.kind === 'final' && s.depth > 0 && <Dim>↳ {t('agent.subAnswerPrefix')} {String(s.data.text).slice(0, 200)}</Dim>}
            {s.kind === 'error' && (
              <div style={{ color: theme.red, fontSize: 13 }}>
                ⚠ {/terminated|ECONNRESET|EPIPE|socket|connection/i.test(String(s.data.message)) ? t('agent.modelDied') : s.data.message}
                {/terminated|ECONNRESET|EPIPE|socket|connection/i.test(String(s.data.message)) && (
                  <details style={{ marginTop: 4 }}><summary style={{ fontSize: 11, color: theme.muted, cursor: 'pointer' }}>{t('agent.details')}</summary><span style={{ fontSize: 11, color: theme.muted }}>{s.data.message}</span></details>
                )}
              </div>
            )}
          </div>
        ))}
        {running && <div style={{ color: theme.accent, fontSize: 13 }}>{t('agent.thinkingStatus')}</div>}
        <div ref={endRef} />
      </div>
      </div>

      {/* collapsible live preview of the built page */}
      {showPreview && (
        <div style={{ flex: '1 1 48%', minWidth: 0, display: 'flex', flexDirection: 'column', border: `1px solid ${theme.border}`, borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: theme.surface, borderBottom: `1px solid ${theme.border}` }}>
            <span style={{ fontSize: 12, color: theme.muted }}>👁 {t('agent.preview')}</span>
            {preview.files.length > 1 && (
              <select value={preview.file ?? ''} onChange={(e) => loadPreview(e.target.value)} style={{ ...input, width: 'auto', padding: '3px 6px', fontSize: 12 }}>
                {preview.files.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            )}
            <span style={{ flex: 1 }} />
            <button onClick={() => loadPreview(preview.file ?? undefined)} title={t('agent.previewRefresh')} style={{ background: 'transparent', border: 'none', color: theme.muted, cursor: 'pointer', fontSize: 13 }}>↻</button>
            <button onClick={() => setShowPreview(false)} style={{ background: 'transparent', border: 'none', color: theme.muted, cursor: 'pointer', fontSize: 14 }}>✕</button>
          </div>
          {preview.content ? (
            <iframe title="preview" sandbox="allow-scripts allow-same-origin allow-popups" srcDoc={preview.content} style={{ flex: 1, width: '100%', border: 'none', background: '#fff' }} />
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>{t('agent.previewEmpty')}</div>
          )}
        </div>
      )}
      </div>

      {/* input pinned at the bottom, chat-style */}
      <div style={{ ...card, marginTop: 12, flexShrink: 0 }}>
        <textarea
          style={{ ...input, minHeight: 56, resize: 'vertical' }}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder={t('agent.goalPlaceholder')}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void run(); } }}
        />
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button style={{ ...button, opacity: running || !folder ? 0.6 : 1, cursor: running || !folder ? 'not-allowed' : 'pointer' }} onClick={() => void run()} disabled={running || !folder} title={!folder ? t('agent.chooseFolderFirst') : ''}>
            {running ? t('agent.runningLabel') : t('agent.runAgentButton')}
          </button>
          <label style={{ fontSize: 12, color: theme.muted }}>{t('agent.compute')}</label>
          <select value={mode} onChange={(e) => pickMode(e.target.value as Mode)} style={{ ...input, width: 'auto', padding: '6px 8px', cursor: 'pointer' }}>
            <option value="ask">{t('agent.modeAsk')}</option>
            <option value="auto">{t('agent.modeAuto')}</option>
            <option value="local">{t('agent.modeLocal')}</option>
            <option value="network">{t('agent.modeNetwork')}</option>
          </select>
          {models.length > 0 && (
            <select value={model} onChange={(e) => pickLocalModel(e.target.value)} title={t('agent.model')} style={{ ...input, width: 'auto', maxWidth: 190, padding: '6px 8px', cursor: 'pointer' }}>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
          {mode !== 'local' && (
            <input value={netModel} onChange={(e) => pickNet(e.target.value)} placeholder={t('agent.netModel')} title={t('agent.netModel')} style={{ ...input, width: 170, padding: '6px 8px' }} />
          )}
          <button
            onClick={toggleAuto}
            title={t('agent.autoHint')}
            style={{ fontSize: 12, padding: '6px 12px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${autonomous ? theme.accent : theme.border}`, background: autonomous ? theme.accent : 'transparent', color: autonomous ? 'var(--bg)' : theme.muted }}
          >
            {autonomous ? `🤖 ${t('agent.autoOn')}` : `✋ ${t('agent.autoOff')}`}
          </button>
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
    </div>
  );
}

function Dim({ children }: { children: React.ReactNode }) {
  return <div style={{ color: theme.muted, fontSize: 12 }}>{children}</div>;
}
