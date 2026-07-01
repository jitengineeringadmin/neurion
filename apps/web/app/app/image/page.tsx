'use client';
import { useEffect, useState } from 'react';
import { api, prodApi, isDesktop, getProdToken, streamSSE } from '../../../lib/api';
import { theme, card, button, input } from '../../../lib/ui';
import { useT } from '../../../lib/i18n';
import { NetworkConnect } from '../../../components/NetworkConnect';

interface GalleryItem { id: string; prompt: string; status: string; seed?: number; ts?: number; error?: string; model?: string; image?: string }
interface EngineStatus { engine: string; percent?: number; stage?: string; model?: { id: string; label: string } }
interface ModelItem { id: string; label: string; desc: string; sizeMb: number; recommended: boolean; installed: boolean }
interface ModelList { bin: boolean; custom: boolean; active: { id: string; label: string } | null; models: ModelItem[] }

type Mode = 'local' | 'network';
const CUSTOM = '__custom__';

export default function ImagePage() {
  const t = useT();
  const [st, setSt] = useState<EngineStatus>({ engine: '…' });
  const [ml, setMl] = useState<ModelList | null>(null);
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
  const [gallery, setGallery] = useState<GalleryItem[]>([]);

  const loadAll = () => {
    void api<EngineStatus>('/ai/image/status').then(setSt).catch(() => setSt({ engine: 'down' }));
    void api<ModelList>('/ai/image/models').then(setMl).catch(() => setMl(null));
  };
  const loadGallery = () => void api<{ items: GalleryItem[] }>('/ai/image/gallery').then((r) => setGallery(r.items || [])).catch(() => undefined);
  useEffect(() => {
    loadAll();
    loadGallery();
    if (typeof window !== 'undefined') { const m = localStorage.getItem('neurion_image_mode'); if (m === 'local' || m === 'network') setMode(m); }
  }, []);
  // While a generation is running server-side, poll the gallery so it updates even if
  // the user left and came back (the work continues + is remembered).
  useEffect(() => {
    if (!gallery.some((g) => g.status === 'running')) return;
    const id = setInterval(loadGallery, 2000);
    return () => clearInterval(id);
  }, [gallery]);
  const pickMode = (m: Mode) => { setMode(m); try { localStorage.setItem('neurion_image_mode', m); } catch {} };

  // Pick a curated model: downloads the engine + model if needed, then activates it.
  async function selectModel(id: string) {
    if (st.engine === 'installing') return;
    setErr(''); setSetupPct(0);
    setSt((s) => ({ ...s, engine: 'installing', percent: 0 }));
    try {
      await streamSSE('/ai/image/model/select', { id }, {
        onEvent: (event, d) => {
          if (event === 'progress') { setSetupPct(d.percent ?? 0); setSt((s) => ({ ...s, engine: 'installing', percent: d.percent, stage: d.stage })); }
          else if (event === 'done') loadAll();
          else if (event === 'error') { setErr(d.message || t('image.errFailed')); loadAll(); }
        },
      });
    } catch (e) { setErr((e as Error).message); loadAll(); }
  }

  // Use the user's own model file (native desktop picker).
  async function pickCustom() {
    const w = window as unknown as { neurion?: { pickModel?: () => Promise<{ path: string | null; name?: string }> } };
    if (!w.neurion?.pickModel) return;
    const r = await w.neurion.pickModel();
    if (!r?.path) return;
    setErr('');
    try {
      const res = await api<{ ok: boolean; error?: string }>('/ai/image/model/custom', { method: 'POST', body: JSON.stringify({ path: r.path, label: r.name }) });
      if (!res.ok) setErr(res.error || t('image.errFailed'));
      loadAll();
    } catch (e) { setErr((e as Error).message); }
  }

  function onModelChange(v: string) {
    if (v === CUSTOM) void pickCustom();
    else if (v) void selectModel(v);
  }

  const localRunning = gallery.some((g) => g.status === 'running');

  async function generate() {
    if (!prompt.trim()) return;
    if (mode === 'local' && localRunning) return;
    setErr('');
    if (mode === 'network') {
      setBusy(true); setStatus('');
      try { await generateNetwork(); } catch (e) { setErr((e as Error).message || t('image.errFailed')); } finally { setBusy(false); setStatus(''); }
    } else {
      await generateLocal();
    }
  }
  // Local: fire-and-forget — the server keeps generating + saves to the gallery, which
  // we then poll. So it survives navigating away.
  async function generateLocal() {
    try {
      const r = await api<{ ok: boolean; id?: string; error?: string }>('/ai/image', { method: 'POST', body: JSON.stringify({ prompt, negative, width: size, height: size, steps: advanced ? steps : undefined }) });
      if (r.ok) loadGallery(); else setErr(r.error || t('image.errFailed'));
    } catch (e) { setErr((e as Error).message); }
  }
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
      if (done.includes(j.status) && image) { setGallery((g) => [{ id: 'net-' + Date.now(), prompt, status: 'done', image, seed: j.outputJson?.result?.seed }, ...g]); return; }
    }
    setErr(t('image.errFailed'));
  }

  const ready = mode === 'network' || st.engine === 'ready';
  const formBlocked = busy || localRunning || !prompt.trim() || !ready;
  const installing = st.engine === 'installing';

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

      {/* Local: model picker (curated + your own file). */}
      {mode === 'local' && st.engine === 'unsupported' && (
        <div style={{ border: `1px solid ${theme.amber}`, borderRadius: 10, padding: 12, fontSize: 13, marginBottom: 16 }}>{t('image.unsupported')}</div>
      )}
      {mode === 'local' && st.engine !== 'unsupported' && st.engine !== 'unavailable' && (
        <div style={{ ...card, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12, color: theme.muted }}>{t('image.model')}</label>
            <select
              value={ml?.active?.id ?? ''}
              disabled={installing}
              onChange={(e) => onModelChange(e.target.value)}
              style={{ ...input, width: 'auto', minWidth: 200, padding: '6px 8px', cursor: installing ? 'default' : 'pointer' }}
            >
              {!ml?.active && <option value="">{t('image.chooseModel')}</option>}
              {ml?.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}{m.recommended ? ` · ${t('image.recommended')}` : ''}{m.installed ? ' ✓' : ` · ${Math.round(m.sizeMb / 100) / 10} GB`}
                </option>
              ))}
              {ml?.custom && <option value={CUSTOM}>{t('image.customFile')}</option>}
            </select>
            {ml?.active?.id === 'custom' && <span style={{ fontSize: 12, color: theme.muted }}>{ml.active.label}</span>}
          </div>
          {installing && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                <span>⏳ {st.stage === 'model' ? t('image.installModel') : t('image.installEngine')}…</span>
                <span style={{ color: theme.accent }}>{setupPct}%</span>
              </div>
              <div style={{ height: 8, background: theme.surface, borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.max(3, setupPct)}%`, background: theme.accent, transition: 'width .3s' }} />
              </div>
            </div>
          )}
          {!ml?.active && !installing && <div style={{ fontSize: 12, color: theme.muted, marginTop: 8 }}>{t('image.setupSub').replace('{size}', '~2000')}</div>}
        </div>
      )}

      <div style={{ ...card, marginBottom: 16 }}>
        <textarea style={{ ...input, minHeight: 84, resize: 'vertical', fontSize: 15 }} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('image.promptPlaceholder')} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 12 }}>
          <button onClick={() => void generate()} disabled={formBlocked} style={{ ...button, padding: '9px 22px', fontSize: 15, opacity: formBlocked ? 0.5 : 1 }}>
            {busy || localRunning ? t('image.generating') : `✨ ${t('image.generate')}`}
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
        {(busy || localRunning) && <div style={{ fontSize: 12, color: theme.muted, marginTop: 10 }}>⏳ {status || t('image.genNoteGpu')}</div>}
      </div>

      {err && <div style={{ color: '#e0533d', fontSize: 13, marginBottom: 12 }}>⚠ {err}</div>}

      {/* Gallery / history — persists server-side, so it survives navigating away. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {gallery.map((g) => (
          <div key={g.id} style={{ ...card }}>
            {g.status === 'running' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: theme.muted }}>
                <span className="flicker" style={{ color: theme.accent }}>●</span> {t('image.generating')} — <span style={{ color: theme.text }}>{g.prompt}</span>
              </div>
            ) : g.status === 'failed' ? (
              <div style={{ fontSize: 13, color: '#e0533d' }}>⚠ {g.prompt} — {g.error || t('image.errFailed')}</div>
            ) : g.image ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`data:image/png;base64,${g.image}`} alt={g.prompt} style={{ maxWidth: '100%', borderRadius: 8, display: 'block' }} />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, fontSize: 12, color: theme.muted, gap: 12 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.prompt}</span>
                  <a href={`data:image/png;base64,${g.image}`} download={`neurion-${g.id}.png`} style={{ ...button, padding: '6px 14px', textDecoration: 'none', flexShrink: 0 }}>⬇ {t('image.download')}</a>
                </div>
              </>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
