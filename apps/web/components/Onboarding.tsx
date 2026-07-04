'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, streamSSE } from '../lib/api';
import { theme, button } from '../lib/ui';
import { useT } from '../lib/i18n';

const RECOMMENDED_MODEL = 'qwen2.5:3b';
const DONE_KEY = 'neurion_onboarded';

type Step = 'welcome' | 'engine' | 'model' | 'done';

/**
 * First-run wizard: a new user should not have to DISCOVER that a model must be
 * downloaded before chat works. Shows once (per install) when the local engine has no
 * models yet: welcome → engine check → one-click recommended model → go chat.
 */
export function Onboarding() {
  const t = useT();
  const router = useRouter();
  const [step, setStep] = useState<Step | null>(null); // null = hidden
  const [engineUp, setEngineUp] = useState(false);
  const [pull, setPull] = useState<{ percent: number | null; status: string } | null>(null);
  const [err, setErr] = useState('');
  const [rec, setRec] = useState<{ ramGb: number; cores: number; model: { name: string; label: string; size: string; note: string } } | null>(null);
  const alive = useRef(true);

  // Decide once at mount whether to show: never onboarded AND no models installed.
  useEffect(() => {
    alive.current = true;
    if (typeof window === 'undefined' || localStorage.getItem(DONE_KEY) === '1') return;
    void api<{ engine: string; installed: unknown[] }>('/ai/models/installed')
      .then((r) => {
        if (!alive.current) return;
        if ((r.installed || []).length > 0) { localStorage.setItem(DONE_KEY, '1'); return; } // existing user
        setEngineUp(r.engine === 'up');
        setStep('welcome');
        // Detect the machine's RAM and pre-pick the best-fitting model, so the user
        // never has to answer "which model?" — the download button just uses this.
        void api<{ ramGb: number; cores: number; model: { name: string; label: string; size: string; note: string } }>('/ai/models/recommend')
          .then((rr) => { if (alive.current) setRec(rr); })
          .catch(() => undefined);
      })
      .catch(() => undefined); // API not reachable (online build etc.) — no wizard
    return () => { alive.current = false; };
  }, []);

  // While on the engine step, poll until ollama appears, then advance automatically.
  useEffect(() => {
    if (step !== 'engine') return;
    const id = setInterval(() => {
      void api<{ engine: string }>('/ai/models/installed')
        .then((r) => { if (r.engine === 'up') { setEngineUp(true); setStep('model'); } })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(id);
  }, [step]);

  if (!step) return null;

  function close(markDone: boolean) {
    if (markDone) try { localStorage.setItem(DONE_KEY, '1'); } catch { /* ignore */ }
    setStep(null);
  }

  async function download() {
    if (pull) return;
    setErr('');
    setPull({ percent: 0, status: '' });
    try {
      await streamSSE('/ai/models/pull', { name: rec?.model.name ?? RECOMMENDED_MODEL }, {
        onEvent: (event, d) => {
          if (event === 'progress') setPull({ percent: d.percent ?? null, status: d.status ?? '' });
          else if (event === 'done') { setPull(null); setStep('done'); }
          else if (event === 'error') { setErr(d.message || 'download failed'); setPull(null); }
        },
      });
    } catch (e) {
      setErr((e as Error).message);
      setPull(null);
    }
  }

  const overlay: React.CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'color-mix(in srgb, var(--bg) 72%, transparent)', backdropFilter: 'blur(4px)',
  };
  const panel: React.CSSProperties = {
    width: 460, maxWidth: '92vw', background: theme.surface, border: `1px solid ${theme.border}`,
    borderRadius: 16, padding: '28px 30px', boxShadow: '0 18px 60px rgba(0,0,0,.45)',
  };
  const h: React.CSSProperties = { margin: '0 0 6px', fontSize: 20 };
  const sub: React.CSSProperties = { color: theme.muted, fontSize: 13.5, lineHeight: 1.55, margin: '0 0 18px', fontFamily: 'var(--font-sans), sans-serif' };
  const skip = (
    <button onClick={() => close(true)} style={{ background: 'transparent', border: 'none', color: theme.muted, cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}>
      {t('ob.skip')}
    </button>
  );

  return (
    <div style={overlay}>
      <div style={panel}>
        {step === 'welcome' && (
          <>
            <h2 style={h}>{t('ob.title')}</h2>
            <p style={sub}>{t('ob.sub')}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 22, fontSize: 14, fontFamily: 'var(--font-sans), sans-serif' }}>
              <div>💬 {t('ob.b1')}</div>
              <div>🎨 {t('ob.b2')}</div>
              <div>⚡ {t('ob.b3')}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <button style={{ ...button, padding: '9px 22px' }} onClick={() => setStep(engineUp ? 'model' : 'engine')}>{t('ob.next')} →</button>
              {skip}
            </div>
          </>
        )}

        {step === 'engine' && (
          <>
            <h2 style={h}>{t('ob.engineTitle')}</h2>
            <p style={sub}>
              {t('ob.engineBody').split('{link}')[0]}
              <a href="https://ollama.com/download" target="_blank" rel="noreferrer" style={{ color: theme.accent }}>Ollama</a>
              {t('ob.engineBody').split('{link}')[1]}
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, fontSize: 13, color: theme.muted }}>
              <span className="flicker" style={{ color: theme.amber }}>●</span> {t('ob.engineWaiting')}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>{skip}</div>
          </>
        )}

        {step === 'model' && (
          <>
            <h2 style={h}>{t('ob.modelTitle')}</h2>
            <p style={sub}>{t('ob.modelBody')}</p>
            {rec && !pull && (
              <div style={{ border: `1px solid ${theme.border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 16, background: theme.bg }}>
                <div style={{ fontSize: 12, color: theme.muted, marginBottom: 5 }}>🖥 {rec.ramGb} GB RAM · {rec.cores} core → {t('ob.autoRec')}</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: theme.text }}>
                  {rec.model.label} <span style={{ color: theme.muted, fontWeight: 400, fontSize: 13 }}>({rec.model.size})</span>
                </div>
                <div style={{ fontSize: 12, color: theme.muted, marginTop: 2, fontFamily: 'var(--font-sans), sans-serif' }}>{rec.model.note}</div>
              </div>
            )}
            {pull ? (
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                  <span style={{ color: theme.muted }}>{pull.status || '…'}</span>
                  <span style={{ color: theme.accent }}>{pull.percent != null ? `${pull.percent}%` : ''}</span>
                </div>
                <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 6, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.max(3, pull.percent ?? 3)}%`, background: theme.accent, transition: 'width .3s' }} />
                </div>
              </div>
            ) : (
              <button style={{ ...button, padding: '10px 22px', marginBottom: 16 }} onClick={() => void download()}>
                ⬇ {t('ob.modelBtn')}
              </button>
            )}
            {err && <div style={{ color: '#e0533d', fontSize: 12, marginBottom: 10 }}>⚠ {err}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>{skip}</div>
          </>
        )}

        {step === 'done' && (
          <>
            <h2 style={h}>🎉 {t('ob.doneTitle')}</h2>
            <p style={sub}>{t('ob.doneBody')}</p>
            <button
              style={{ ...button, padding: '10px 24px' }}
              onClick={() => { close(true); router.push('/app/chat'); }}
            >
              {t('ob.doneBtn')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
