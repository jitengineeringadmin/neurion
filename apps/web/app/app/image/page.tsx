'use client';
import { useEffect, useState } from 'react';
import { api, prodApi, isDesktop, getProdToken, streamSSE, API_BASE, getToken } from '../../../lib/api';
import { theme, card, button, input } from '../../../lib/ui';
import { useT } from '../../../lib/i18n';
import { NetworkConnect } from '../../../components/NetworkConnect';

interface GalleryItem { id: string; prompt: string; status: string; seed?: number; ts?: number; error?: string; model?: string; image?: string }
interface EngineStatus { engine: string; percent?: number; stage?: string; model?: { id: string; label: string } }
interface ModelItem { id: string; label: string; desc: string; sizeMb: number; recommended: boolean; installed: boolean }
interface ModelList { bin: boolean; custom: boolean; active: { id: string; label: string } | null; models: ModelItem[] }

type Mode = 'local' | 'network';
type Kind = 'image' | 'video';
const CUSTOM = '__custom__';

interface VideoItem { id: string; prompt: string; status: string; progress?: string; etaS?: number; ts?: number; error?: string; model?: string }

// Live "how long has this been cooking" timer for running generations.
function Elapsed({ since }: { since?: number }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((v) => v + 1), 1000); return () => clearInterval(id); }, []);
  if (!since) return null;
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const txt = s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>⏱ {txt}</span>;
}

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
  const [kind, setKind] = useState<Kind>('image');
  const [vStatus, setVStatus] = useState('');
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [vSetupPct, setVSetupPct] = useState(-1); // -1 = not installing
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);
  const [vKind, setVKind] = useState<'clip' | 'ai'>('clip');
  const [audioMode, setAudioMode] = useState<'none' | 'music' | 'tts' | 'both' | 'gen'>('none');
  const [mood, setMood] = useState<'epic' | 'calm' | 'happy' | 'dark'>('epic');
  const [voiceText, setVoiceText] = useState('');
  const [musicPrompt, setMusicPrompt] = useState('');
  const [audioSt, setAudioSt] = useState<{ music: string; tts: string; gen: string } | null>(null);
  const [audioSetupPct, setAudioSetupPct] = useState(-1);
  const [aiInfo, setAiInfo] = useState<{ aiInstalled: boolean; requirements: { ramGb: number; freeDiskGb: number; minRamGb: number; minDiskGb: number; ramOk: boolean; diskOk: boolean } | null } | null>(null);
  const [aiSetupPct, setAiSetupPct] = useState(-1);

  const loadAll = () => {
    void api<EngineStatus>('/ai/image/status').then(setSt).catch(() => setSt({ engine: 'down' }));
    void api<ModelList>('/ai/image/models').then(setMl).catch(() => setMl(null));
  };
  const loadGallery = () => void api<{ items: GalleryItem[] }>('/ai/image/gallery').then((r) => setGallery(r.items || [])).catch(() => undefined);
  const loadVideoStatus = () => void api<{ status: string }>('/ai/video/status').then((r) => setVStatus(r.status)).catch(() => setVStatus('unavailable'));
  const loadAiInfo = () => void api<typeof aiInfo>('/ai/video/models').then(setAiInfo).catch(() => undefined);
  const loadAudioSt = () => void api<{ music: string; tts: string; gen: string }>('/ai/audio/status').then(setAudioSt).catch(() => undefined);

  // Which audio components the chosen mode needs, and whether they're installed.
  const audioNeeds: ('music' | 'tts' | 'gen')[] = audioMode === 'music' ? ['music'] : audioMode === 'tts' ? ['tts'] : audioMode === 'both' ? ['music', 'tts'] : audioMode === 'gen' ? ['gen'] : [];
  const audioMissing = audioNeeds.filter((w) => audioSt && audioSt[w] === 'needs_setup');
  const audioBlocked = audioNeeds.some((w) => !audioSt || audioSt[w] !== 'ready');

  async function setupAudio(what: 'music' | 'tts' | 'gen') {
    if (audioSetupPct >= 0) return;
    setErr(''); setAudioSetupPct(0);
    try {
      await streamSSE('/ai/audio/setup', { what }, {
        onEvent: (event, d) => {
          if (event === 'progress') setAudioSetupPct(d.percent ?? 0);
          else if (event === 'done') { setAudioSetupPct(-1); loadAudioSt(); }
          else if (event === 'error') { setErr(d.message || t('image.errFailed')); setAudioSetupPct(-1); }
        },
      });
    } catch (e) { setErr((e as Error).message); setAudioSetupPct(-1); }
  }
  const loadVideos = () => void api<{ items: VideoItem[] }>('/ai/video/gallery').then((r) => setVideos(r.items || [])).catch(() => undefined);
  useEffect(() => {
    loadAll();
    loadGallery();
    loadVideoStatus();
    loadVideos();
    loadAiInfo();
    loadAudioSt();
    if (typeof window !== 'undefined') { const m = localStorage.getItem('neurion_image_mode'); if (m === 'local' || m === 'network') setMode(m); }
  }, []);
  // While a generation is running server-side, poll the gallery so it updates even if
  // the user left and came back (the work continues + is remembered).
  useEffect(() => {
    if (!gallery.some((g) => g.status === 'running')) return;
    const id = setInterval(loadGallery, 2000);
    return () => clearInterval(id);
  }, [gallery]);
  useEffect(() => {
    if (!videos.some((v) => v.status === 'running')) return;
    const id = setInterval(() => { loadVideos(); }, 3000);
    return () => clearInterval(id);
  }, [videos]);

  // One-time ffmpeg setup (like the image engine): SSE progress.
  async function setupVideo() {
    if (vSetupPct >= 0) return;
    setErr(''); setVSetupPct(0);
    try {
      await streamSSE('/ai/video/setup', {}, {
        onEvent: (event, d) => {
          if (event === 'progress') setVSetupPct(d.percent ?? 0);
          else if (event === 'done') { setVSetupPct(-1); loadVideoStatus(); }
          else if (event === 'error') { setErr(d.message || t('image.errFailed')); setVSetupPct(-1); }
        },
      });
    } catch (e) { setErr((e as Error).message); setVSetupPct(-1); }
  }

  async function generateVideo() {
    try {
      const r = await api<{ ok: boolean; id?: string; error?: string }>('/ai/video', {
        method: 'POST',
        body: JSON.stringify({
          prompt, negative, mode: vKind,
          audioMode,
          ...(audioMode === 'music' || audioMode === 'both' ? { mood } : {}),
          ...(audioMode === 'tts' || audioMode === 'both' ? { voiceText: voiceText.trim() || undefined } : {}),
          ...(audioMode === 'gen' ? { musicPrompt: musicPrompt.trim() || undefined } : {}),
        }),
      });
      if (r.ok) { loadVideos(); loadVideoStatus(); } else setErr(r.error || t('image.errFailed'));
    } catch (e) { setErr((e as Error).message); }
  }

  // One-time AI-video bundle (~6.7GB) download with weighted progress.
  async function setupAi() {
    if (aiSetupPct >= 0) return;
    setErr(''); setAiSetupPct(0);
    try {
      await streamSSE('/ai/video/model/setup-ai', {}, {
        onEvent: (event, d) => {
          if (event === 'progress') setAiSetupPct(d.percent ?? 0);
          else if (event === 'done') { setAiSetupPct(-1); loadAiInfo(); }
          else if (event === 'error') { setErr(d.message || t('image.errFailed')); setAiSetupPct(-1); }
        },
      });
    } catch (e) { setErr((e as Error).message); setAiSetupPct(-1); }
  }

  async function delImage(id: string) {
    if (!window.confirm(t('gallery.confirmDelete'))) return;
    await api(`/ai/image/gallery/${id}`, { method: 'DELETE' }).catch(() => undefined);
    loadGallery();
  }
  async function delVideo(id: string) {
    if (!window.confirm(t('gallery.confirmDelete'))) return;
    if (playing?.id === id) { URL.revokeObjectURL(playing.url); setPlaying(null); }
    await api(`/ai/video/gallery/${id}`, { method: 'DELETE' }).catch(() => undefined);
    loadVideos();
  }

  // The MP4 endpoint needs the bearer header, which <video src> can't send — fetch a blob.
  async function watch(id: string) {
    try {
      const res = await fetch(`${API_BASE}/api/ai/video/file/${id}`, { headers: { authorization: `Bearer ${getToken() ?? ''}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      setPlaying((p) => { if (p) URL.revokeObjectURL(p.url); return { id, url }; });
    } catch (e) { setErr((e as Error).message); }
  }
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
    if (kind === 'video') { setErr(''); await generateVideo(); return; }
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

  const videoRunning = videos.some((v) => v.status === 'running');
  const req = aiInfo?.requirements ?? null;
  const reqOk = !req || (req.ramOk && req.diskOk);
  const aiReady = !!aiInfo?.aiInstalled && reqOk;
  const ready = kind === 'video'
    ? vStatus === 'ready' && (vKind === 'clip' || aiReady)
    : mode === 'network' || st.engine === 'ready';
  const formBlocked = kind === 'video'
    ? videoRunning || !prompt.trim() || !ready || audioBlocked
    : busy || localRunning || !prompt.trim() || !ready;
  const installing = st.engine === 'installing';
  const kindBtn = (k: Kind, label: string): React.CSSProperties => ({
    padding: '6px 16px', borderRadius: 8, fontSize: 13, cursor: 'pointer', border: 'none',
    background: kind === k ? theme.accent : 'transparent', color: kind === k ? 'var(--bg)' : theme.muted, fontWeight: kind === k ? 500 : 400,
  });

  return (
    <div style={{ maxWidth: 820 }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 20 }}>{t('image.pageTitle')}</h2>
      <p style={{ color: theme.muted, fontSize: 13, marginTop: 0 }}>{t('image.pageSubtitle')}</p>

      {/* what to create: a picture, or an animated clip built from AI keyframes */}
      <div style={{ display: 'inline-flex', gap: 4, background: 'var(--surface-2)', borderRadius: 10, padding: 3, margin: '10px 0' }}>
        <button style={kindBtn('image', '')} onClick={() => setKind('image')}>🖼 {t('image.kindImage')}</button>
        <button style={kindBtn('video', '')} onClick={() => setKind('video')}>🎬 {t('image.kindVideo')}</button>
      </div>

      {kind === 'image' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 14px' }}>
          <label style={{ fontSize: 12, color: theme.muted }}>{t('image.compute')}</label>
          <select value={mode} onChange={(e) => pickMode(e.target.value as Mode)} style={{ ...input, width: 'auto', padding: '5px 8px', cursor: 'pointer' }}>
            <option value="local">{t('image.modeLocal')}</option>
            <option value="network">{t('image.modeNetwork')}</option>
          </select>
          {mode === 'network' && <span style={{ fontSize: 12, color: theme.muted }}>⚡ {t('image.networkNote')}</span>}
        </div>
      )}

      {kind === 'image' && mode === 'network' && isDesktop() && <NetworkConnect />}

      {/* Video: needs the image engine (frames) + one-time ffmpeg setup (montage). */}
      {kind === 'video' && (
        <div style={{ ...card, marginBottom: 16 }}>
          {/* which kind of video: fast montage clip, or true (slow) text-to-video */}
          <div style={{ display: 'inline-flex', gap: 4, background: 'var(--surface-2)', borderRadius: 10, padding: 3, marginBottom: 10 }}>
            <button onClick={() => setVKind('clip')} style={{ padding: '5px 14px', borderRadius: 8, fontSize: 12, cursor: 'pointer', border: 'none', background: vKind === 'clip' ? theme.accent : 'transparent', color: vKind === 'clip' ? 'var(--bg)' : theme.muted }}>⚡ {t('video.kindClip')}</button>
            <button onClick={() => setVKind('ai')} style={{ padding: '5px 14px', borderRadius: 8, fontSize: 12, cursor: 'pointer', border: 'none', background: vKind === 'ai' ? theme.accent : 'transparent', color: vKind === 'ai' ? 'var(--bg)' : theme.muted }}>🧠 {t('video.kindAi')}</button>
          </div>
          <div style={{ fontSize: 12, color: theme.muted, marginBottom: 6 }}>{vKind === 'clip' ? t('video.note') : t('video.aiNote')}</div>
          {vStatus === 'engine_missing' && <div style={{ fontSize: 13, color: theme.amber }}>⚠ {t('video.engineMissing')}</div>}
          {vStatus === 'unsupported' && <div style={{ fontSize: 13, color: theme.amber }}>⚠ {t('video.unsupported')}</div>}
          {vStatus === 'needs_setup' && vSetupPct < 0 && (
            <button style={{ ...button, padding: '8px 18px' }} onClick={() => void setupVideo()}>⬇ {t('video.setupBtn')}</button>
          )}
          {vSetupPct >= 0 && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                <span>⏳ {t('video.installing')}…</span><span style={{ color: theme.accent }}>{vSetupPct}%</span>
              </div>
              <div style={{ height: 8, background: theme.surface, borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.max(3, vSetupPct)}%`, background: theme.accent, transition: 'width .3s' }} />
              </div>
            </div>
          )}
          {/* True AI video: minimum-requirements gate + one-time model bundle */}
          {vKind === 'ai' && vStatus !== 'engine_missing' && vStatus !== 'unavailable' && (
            <div style={{ marginTop: 8 }}>
              {req && !req.ramOk && (
                <div style={{ fontSize: 13, color: theme.amber, marginBottom: 8 }}>⚠ {t('video.reqRam', { have: req.ramGb, need: req.minRamGb })}</div>
              )}
              {req && req.ramOk && !req.diskOk && (
                <div style={{ fontSize: 13, color: theme.amber, marginBottom: 8 }}>⚠ {t('video.reqDisk', { have: req.freeDiskGb, need: req.minDiskGb })}</div>
              )}
              {reqOk && !aiInfo?.aiInstalled && aiSetupPct < 0 && (
                <button style={{ ...button, padding: '8px 18px' }} onClick={() => void setupAi()}>⬇ {t('video.aiSetupBtn')}</button>
              )}
              {aiSetupPct >= 0 && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                    <span>⏳ {t('video.aiInstalling')}…</span><span style={{ color: theme.accent }}>{aiSetupPct}%</span>
                  </div>
                  <div style={{ height: 8, background: theme.surface, borderRadius: 6, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.max(3, aiSetupPct)}%`, background: theme.accent, transition: 'width .3s' }} />
                  </div>
                </div>
              )}
              {aiReady && <div style={{ fontSize: 13, color: theme.green }}>✓ {t('video.aiReady')}</div>}
            </div>
          )}
          {vKind === 'clip' && vStatus === 'ready' && <div style={{ fontSize: 13, color: theme.green }}>✓ {t('video.ready')}</div>}

          {/* soundtrack: mood music / voice-over / both / AI music (experimental) */}
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${theme.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12, color: theme.muted }}>🔊 {t('audio.label')}</label>
              <select value={audioMode} onChange={(e) => setAudioMode(e.target.value as typeof audioMode)} style={{ ...input, width: 'auto', padding: '5px 8px', cursor: 'pointer' }}>
                <option value="none">{t('audio.none')}</option>
                <option value="music">🎵 {t('audio.music')}</option>
                <option value="tts">🎙 {t('audio.tts')}</option>
                <option value="both">🎵+🎙 {t('audio.both')}</option>
                <option value="gen">🧠 {t('audio.gen')}</option>
              </select>
              {(audioMode === 'music' || audioMode === 'both') && (
                <select value={mood} onChange={(e) => setMood(e.target.value as typeof mood)} style={{ ...input, width: 'auto', padding: '5px 8px', cursor: 'pointer' }}>
                  <option value="epic">{t('audio.moodEpic')}</option>
                  <option value="calm">{t('audio.moodCalm')}</option>
                  <option value="happy">{t('audio.moodHappy')}</option>
                  <option value="dark">{t('audio.moodDark')}</option>
                </select>
              )}
            </div>
            {(audioMode === 'tts' || audioMode === 'both') && (
              <input value={voiceText} onChange={(e) => setVoiceText(e.target.value)} placeholder={t('audio.voicePlaceholder')} style={{ ...input, marginTop: 8 }} />
            )}
            {audioMode === 'gen' && (
              <>
                <input value={musicPrompt} onChange={(e) => setMusicPrompt(e.target.value)} placeholder={t('audio.genPlaceholder')} style={{ ...input, marginTop: 8 }} />
                <div style={{ fontSize: 11, color: theme.muted, marginTop: 4 }}>{t('audio.genNote')}</div>
              </>
            )}
            {audioMissing.length > 0 && audioSetupPct < 0 && (
              <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {audioMissing.map((w) => (
                  <button key={w} style={{ ...button, padding: '7px 14px' }} onClick={() => void setupAudio(w)}>
                    ⬇ {w === 'music' ? t('audio.setupMusic') : w === 'tts' ? t('audio.setupTts') : t('audio.setupGen')}
                  </button>
                ))}
              </div>
            )}
            {audioSetupPct >= 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                  <span>⏳ {t('audio.installing')}…</span><span style={{ color: theme.accent }}>{audioSetupPct}%</span>
                </div>
                <div style={{ height: 8, background: theme.surface, borderRadius: 6, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.max(3, audioSetupPct)}%`, background: theme.accent, transition: 'width .3s' }} />
                </div>
              </div>
            )}
            {audioMode !== 'none' && audioSt?.tts === 'unsupported' && audioNeeds.includes('tts') && (
              <div style={{ fontSize: 12, color: theme.amber, marginTop: 6 }}>⚠ {t('audio.ttsUnsupported')}</div>
            )}
            {(audioMode === 'music' || audioMode === 'both') && (
              <div style={{ fontSize: 10, color: theme.muted, marginTop: 6 }}>{t('audio.credit')}</div>
            )}
            <div style={{ fontSize: 11, color: theme.muted, marginTop: 8 }}>🌐 {t('audio.foleyComing')}</div>
          </div>
        </div>
      )}

      {/* Local: model picker (curated + your own file). */}
      {kind === 'image' && mode === 'local' && st.engine === 'unsupported' && (
        <div style={{ border: `1px solid ${theme.amber}`, borderRadius: 10, padding: 12, fontSize: 13, marginBottom: 16 }}>{t('image.unsupported')}</div>
      )}
      {(kind === 'video' || mode === 'local') && st.engine !== 'unsupported' && st.engine !== 'unavailable' && (
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
            {kind === 'video'
              ? videoRunning ? t('image.generating') : `🎬 ${t('video.generate')}`
              : busy || localRunning ? t('image.generating') : `✨ ${t('image.generate')}`}
          </button>
          {kind === 'image' && (
            <label style={{ fontSize: 12, color: theme.muted, display: 'flex', alignItems: 'center', gap: 6 }}>
              {t('image.size')}
              <select value={size} onChange={(e) => setSize(Number(e.target.value))} style={{ ...input, width: 'auto', padding: '5px 8px', cursor: 'pointer' }}>
                <option value={512}>{t('image.sizeSmall')}</option>
                <option value={768}>{t('image.sizeMedium')}</option>
                <option value={1024}>{t('image.sizeLarge')}</option>
              </select>
            </label>
          )}
          {kind === 'video' && videoRunning && <span style={{ fontSize: 12, color: theme.muted }}>⏳ {t('video.takesAWhile')}</span>}
          {kind === 'image' && (
            <button onClick={() => setAdvanced((v) => !v)} style={{ background: 'transparent', border: 'none', color: theme.muted, cursor: 'pointer', fontSize: 12, textDecoration: 'underline', marginLeft: 'auto' }}>
              {advanced ? '▾' : '▸'} {t('image.advanced')}
            </button>
          )}
        </div>
        {kind === 'image' && advanced && (
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

      {/* Video history — same persistence model as images. */}
      {kind === 'video' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {videos.map((v) => (
            <div key={v.id} className={v.status === 'running' ? 'working-card' : undefined} style={{ ...card }}>
              {v.status === 'running' ? (() => {
                const sm = /^s(\d+)\/(\d+)$/.exec(v.progress || '');
                const cur = sm ? Number(sm[1]) : 0, tot = sm ? Number(sm[2]) : 0;
                const label = sm
                  ? t('video.step', { c: cur, t: tot }) + (v.etaS ? ` · ${t('video.left', { m: Math.max(1, Math.round(v.etaS / 60)) })}` : '')
                  : v.progress === 'ai' ? t('video.aiWorking')
                  : v.progress === 'montage' ? t('video.montage')
                  : v.progress === 'audio' ? t('audio.mixing')
                  : `${t('video.frame')} ${v.progress || ''}`;
                return (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: theme.muted, marginBottom: 10, flexWrap: 'wrap' }}>
                      <span className="flicker" style={{ color: theme.accent }}>●</span>
                      <span style={{ color: theme.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.prompt}</span>
                      <Elapsed since={v.ts} />
                    </div>
                    {sm && tot > 0 ? (
                      <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 6, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${Math.max(3, Math.round((cur / tot) * 100))}%`, background: theme.accent, transition: 'width .5s' }} />
                      </div>
                    ) : (
                      <div className="shimmer-track" />
                    )}
                    <div style={{ fontSize: 12, color: theme.muted, marginTop: 8 }}>{label}</div>
                  </div>
                );
              })() : v.status === 'failed' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 13, color: '#e0533d', flex: 1 }}>⚠ {v.prompt} — {v.error || t('image.errFailed')}</span>
                  <button onClick={() => void delVideo(v.id)} title={t('gallery.delete')} style={{ background: 'transparent', border: 'none', color: theme.muted, cursor: 'pointer', fontSize: 15 }}>🗑</button>
                </div>
              ) : (
                <>
                  {playing?.id === v.id ? (
                    <video src={playing.url} controls autoPlay loop style={{ maxWidth: '100%', borderRadius: 8, display: 'block' }} />
                  ) : (
                    <button onClick={() => void watch(v.id)} style={{ ...button, padding: '8px 18px' }}>▶ {t('video.watch')}</button>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                    <span style={{ flex: 1, fontSize: 12, color: theme.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>🎬 {v.prompt}</span>
                    <button onClick={() => void delVideo(v.id)} title={t('gallery.delete')} style={{ background: 'transparent', border: 'none', color: theme.muted, cursor: 'pointer', fontSize: 15 }}>🗑</button>
                  </div>
                </>
              )}
            </div>
          ))}
          {videos.length === 0 && <div style={{ fontSize: 13, color: theme.muted }}>{t('video.empty')}</div>}
        </div>
      )}

      {/* Gallery / history — persists server-side, so it survives navigating away. */}
      {kind === 'image' && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {gallery.map((g) => (
          <div key={g.id} className={g.status === 'running' ? 'working-card' : undefined} style={{ ...card }}>
            {g.status === 'running' ? (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: theme.muted, marginBottom: 10 }}>
                  <span className="flicker" style={{ color: theme.accent }}>●</span>
                  <span style={{ color: theme.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.prompt}</span>
                  <Elapsed since={g.ts} />
                </div>
                <div className="shimmer-track" />
                <div style={{ fontSize: 12, color: theme.muted, marginTop: 8 }}>{t('image.generating')}…</div>
              </div>
            ) : g.status === 'failed' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 13, color: '#e0533d', flex: 1 }}>⚠ {g.prompt} — {g.error || t('image.errFailed')}</span>
                <button onClick={() => void delImage(g.id)} title={t('gallery.delete')} style={{ background: 'transparent', border: 'none', color: theme.muted, cursor: 'pointer', fontSize: 15 }}>🗑</button>
              </div>
            ) : g.image ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`data:image/png;base64,${g.image}`} alt={g.prompt} style={{ maxWidth: '100%', borderRadius: 8, display: 'block' }} />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, fontSize: 12, color: theme.muted, gap: 12 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.prompt}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    <a href={`data:image/png;base64,${g.image}`} download={`neurion-${g.id}.png`} style={{ ...button, padding: '6px 14px', textDecoration: 'none' }}>⬇ {t('image.download')}</a>
                    <button onClick={() => void delImage(g.id)} title={t('gallery.delete')} style={{ background: 'transparent', border: 'none', color: theme.muted, cursor: 'pointer', fontSize: 15 }}>🗑</button>
                  </span>
                </div>
              </>
            ) : null}
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
