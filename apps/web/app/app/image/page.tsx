'use client';
import { useEffect, useRef, useState } from 'react';
import { api, prodApi, isDesktop, getProdToken, streamSSE } from '../../../lib/api';
import { theme, card, button, input } from '../../../lib/ui';
import { useT } from '../../../lib/i18n';
import { NetworkConnect } from '../../../components/NetworkConnect';

interface GenResult { ok: boolean; image?: string; error?: string; width?: number; height?: number; seed?: number }
interface EngineStatus { engine: string; backend?: string; percent?: number; stage?: string; sizeMb?: number }

type Mode = 'local' | 'network';

export default function ImagePage() {
  const t = useT();
  const [st, setSt] = useState<EngineStatus>({ engine: '…' });
  const [mode, setMode] = useState<Mode>('local');
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [size, setSize] = useState(512);
  const [steps, setSteps] = useState(20);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [setupPct, setSetupPct] = useState(0);
  const [status, setStatus] = useState('');
  const [err, setErr] = useState('');
  const [img, setImg] = useState<{ data: string; seed?: number } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = () =>
    api<EngineStatus>('/ai/image/status').then(setSt).catch(() => setSt({ engine: 'down' }));

  useEffect(() => {
    void loadStatus();
    if (typeof window !== 'undefined') {
      const m = localStorage.getItem('neurion_image_mode');
      if (m === 'local' || m === 'network') setMode(m);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);
  const pickMode = (m: Mode) => { setMode(m); try { localStorage.setItem('neurion_image_mode', m); } catch {} };

  // One-time engine install (download binary + model), with live progress.
  async function activate() {
    if (busy) return;
    setErr('');
    setSetupPct(0);
    setSt((s) => ({ ...s, engine: 'installing', percent: 0 }));
    try {
      await streamSSE('/ai/image/setup', {}, {
        onEvent: (event, d) => {
          if (event === 'progress') { setSetupPct(d.percent ?? 0); setSt((s) => ({ ...s, engine: 'installing', percent: d.percent, stage: d.stage })); }
          else if (event === 'done') { void loadStatus(); }
          else if (event === 'error') { setErr(d.message || t('image.errFailed')); void loadStatus(); }
        },
      });
    } catch (e) {
      setErr((e as Error).message);
      void loadStatus();
    }
  }

  async function generate() {
    if (busy || !prompt.trim()) return;
    setErr(''); setBusy(true); setImg(null); setStatus('');
    try {
      if (mode === 'network') await generateNetwork();
      else await generateLocal();
    } catch (e) {
      setErr((e as Error).message || t('image.errFailed'));
    } finally {
      setBusy(false); setStatus('');
    }
  }

  async function generateLocal() {
    const r = await api<GenResult>('/ai/image', {
      method: 'POST',
      body: JSON.stringify({ prompt, negative, width: size, height: size, steps }),
    });
    if (r.ok && r.image) setImg({ data: r.image, seed: r.seed });
    else setErr(r.error || t('image.errFailed'));
  }

  // Network: create an image.v1 GRID job, poll until a node returns the PNG. On the
  // desktop the shared pool is on the production API, so relay there with the prod session.
  async function generateNetwork() {
    const relay = isDesktop() && !!getProdToken();
    type Job = { id: string };
    type JobState = { status: string; outputJson?: { result?: { image?: string; seed?: number } }; errorMessage?: string };
    const createJob = (b: unknown) => (relay ? prodApi<Job>('/jobs', { method: 'POST', body: JSON.stringify(b) }) : api<Job>('/jobs', { method: 'POST', body: JSON.stringify(b) }));
    const getJob = (id: string) => (relay ? prodApi<JobState>(`/jobs/${id}`) : api<JobState>(`/jobs/${id}`));

    setStatus(t('image.queued'));
    const job = await createJob({ type: 'image.v1', inputJson: { prompt, negative, width: size, height: size, steps } });
    const done = ['COMPLETED', 'VERIFYING', 'VERIFIED', 'REWARDED'];
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const j = await getJob(job.id);
      if (j.status === 'FAILED' || j.status === 'CANCELLED') { setErr(j.errorMessage || t('image.errFailed')); return; }
      setStatus(`${t('image.networkStatus')} ${j.status.toLowerCase()}`);
      const image = j.outputJson?.result?.image;
      if (done.includes(j.status) && image) { setImg({ data: image, seed: j.outputJson?.result?.seed }); return; }
    }
    setErr(t('image.errFailed'));
  }

  const ready = mode === 'network' || st.engine === 'ready';
  const formBlocked = busy || !prompt.trim() || !ready;

  return (
    <div style={{ maxWidth: 820 }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 20 }}>{t('image.pageTitle')}</h2>
      <p style={{ color: theme.muted, fontSize: 13, marginTop: 0 }}>{t('image.pageSubtitle')}</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0' }}>
        <label style={{ fontSize: 12, color: theme.muted }}>{t('image.compute')}</label>
        <select value={mode} onChange={(e) => pickMode(e.target.value as Mode)} style={{ ...input, width: 'auto', padding: '5px 8px', cursor: 'pointer' }}>
          <option value="local">{t('image.modeLocal')}</option>
          <option value="network">{t('image.modeNetwork')}</option>
        </select>
        {mode === 'network' && <span style={{ fontSize: 12, color: theme.muted }}>⚡ {t('image.networkNote')}</span>}
      </div>

      {mode === 'network' && isDesktop() && <NetworkConnect />}

      {/* Local engine states — friendly, no technical jargon. */}
      {mode === 'local' && st.engine === 'needs_setup' && (
        <div style={{ ...card, borderLeft: `2px solid ${theme.accent}`, marginBottom: 16 }}>
          <div style={{ fontSize: 14, marginBottom: 4 }}>{t('image.setupPrompt')}</div>
          <div style={{ fontSize: 12, color: theme.muted, marginBottom: 12 }}>{t('image.setupSub').replace('{size}', String(st.sizeMb ?? 1800))}</div>
          <button onClick={() => void activate()} style={{ ...button }}>⬇ {t('image.setupBtn')}</button>
        </div>
      )}
      {mode === 'local' && st.engine === 'installing' && (
        <div style={{ ...card, borderLeft: `2px solid ${theme.accent}`, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 8 }}>
            <span>⏳ {t('image.installing')} {st.stage === 'model' ? `· ${t('image.installModel')}` : `· ${t('image.installEngine')}`}</span>
            <span style={{ color: theme.accent }}>{setupPct}%</span>
          </div>
          <div style={{ height: 8, background: theme.surface, borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.max(3, setupPct)}%`, background: theme.accent, transition: 'width .3s' }} />
          </div>
        </div>
      )}
      {mode === 'local' && st.engine === 'unsupported' && (
        <div style={{ border: `1px solid ${theme.amber}`, borderRadius: 10, padding: 12, fontSize: 13, marginBottom: 16 }}>{t('image.unsupported')}</div>
      )}

      <div style={{ ...card, marginBottom: 16 }}>
        <textarea style={{ ...input, minHeight: 84, resize: 'vertical', fontSize: 15 }} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('image.promptPlaceholder')} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 12 }}>
          <button onClick={() => void generate()} disabled={formBlocked} style={{ ...button, padding: '9px 22px', fontSize: 15, opacity: formBlocked ? 0.5 : 1 }}>
            {busy ? t('image.generating') : `✨ ${t('image.generate')}`}
          </button>
          <label style={{ fontSize: 12, color: theme.muted, display: 'flex', alignItems: 'center', gap: 6 }}>
            {t('image.size')}
            <select value={size} onChange={(e) => setSize(Number(e.target.value))} style={{ ...input, width: 'auto', padding: '5px 8px', cursor: 'pointer' }}>
              <option value={512}>{t('image.sizeSmall')}</option>
              <option value={768}>{t('image.sizeMedium')}</option>
              <option value={1024}>{t('image.sizeLarge')}</option>
            </select>
          </label>
          <button onClick={() => setAdvanced((v) => !v)} style={{ background: 'transparent', border: 'none', color: theme.muted, cursor: 'pointer', fontSize: 12, textDecoration: 'underline', marginLeft: 'auto' }}>
            {advanced ? '▾' : '▸'} {t('image.advanced')}
          </button>
        </div>
        {advanced && (
          <div style={{ marginTop: 12, borderTop: `1px solid ${theme.border}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <textarea style={{ ...input, minHeight: 40, resize: 'vertical' }} value={negative} onChange={(e) => setNegative(e.target.value)} placeholder={t('image.negativePlaceholder')} />
            <label style={{ fontSize: 12, color: theme.muted, display: 'flex', alignItems: 'center', gap: 6 }}>
              {t('image.steps')}
              <input type="number" min={1} max={40} value={steps} onChange={(e) => setSteps(Number(e.target.value))} style={{ ...input, width: 64, padding: '5px 8px' }} />
              <span style={{ fontSize: 11 }}>{t('image.stepsHint')}</span>
            </label>
          </div>
        )}
        {busy && <div style={{ fontSize: 12, color: theme.muted, marginTop: 10 }}>⏳ {status || t('image.genNoteGpu')}</div>}
      </div>

      {err && <div style={{ color: '#e0533d', fontSize: 13, marginBottom: 12 }}>⚠ {err}</div>}

      {img && (
        <div style={{ ...card }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`data:image/png;base64,${img.data}`} alt={prompt} style={{ maxWidth: '100%', borderRadius: 8, display: 'block' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, fontSize: 12, color: theme.muted }}>
            <span>{img.seed != null && img.seed >= 0 ? `seed ${img.seed}` : ''}</span>
            <a href={`data:image/png;base64,${img.data}`} download={`neurion-${Date.now()}.png`} style={{ ...button, padding: '6px 14px', textDecoration: 'none' }}>⬇ {t('image.download')}</a>
          </div>
        </div>
      )}
    </div>
  );
}
