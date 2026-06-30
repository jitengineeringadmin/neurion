'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { theme, card, button, input } from '../../../lib/ui';
import { useT } from '../../../lib/i18n';

interface GenResult { ok: boolean; image?: string; error?: string; width?: number; height?: number; seed?: number }

export default function ImagePage() {
  const t = useT();
  const [engine, setEngine] = useState<'up' | 'down' | '…'>('…');
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [size, setSize] = useState(512);
  const [steps, setSteps] = useState(20);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [img, setImg] = useState<{ data: string; seed?: number } | null>(null);

  useEffect(() => {
    void api<{ engine: string }>('/ai/image/status')
      .then((s) => setEngine(s.engine === 'up' ? 'up' : 'down'))
      .catch(() => setEngine('down'));
  }, []);

  async function generate() {
    if (busy || !prompt.trim()) return;
    setErr('');
    setBusy(true);
    setImg(null);
    try {
      const r = await api<GenResult>('/ai/image', {
        method: 'POST',
        body: JSON.stringify({ prompt, negative, width: size, height: size, steps }),
      });
      if (r.ok && r.image) setImg({ data: r.image, seed: r.seed });
      else setErr(r.error || t('image.errFailed'));
    } catch (e) {
      setErr((e as Error).message || t('image.errFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 820 }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 20 }}>{t('image.pageTitle')} <span style={{ color: theme.muted, fontSize: 13 }}>{t('image.localBadge')}</span></h2>
      <p style={{ color: theme.muted, fontSize: 13, marginTop: 0 }}>{t('image.pageSubtitle')}</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, margin: '14px 0' }}>
        <span style={{ width: 9, height: 9, borderRadius: 9, background: engine === 'up' ? theme.accent : engine === 'down' ? '#e0533d' : theme.muted }} />
        <span style={{ color: theme.muted }}>{t('image.engineLabel')} <b style={{ color: theme.text }}>{engine === 'up' ? t('image.engineUp') : engine === 'down' ? t('image.engineDown') : '…'}</b></span>
      </div>

      {engine === 'down' && (() => {
        const parts = t('image.engineDownBanner').split('{link}');
        return (
          <div style={{ border: `1px solid ${theme.amber}`, borderRadius: 10, padding: 12, fontSize: 13, color: theme.text, marginBottom: 16 }}>
            {parts[0]}
            <a href="https://github.com/AUTOMATIC1111/stable-diffusion-webui" target="_blank" rel="noreferrer" style={{ color: theme.accent }}>{t('image.sdLinkText')}</a>
            {parts[1]}
          </div>
        );
      })()}

      <div style={{ ...card, marginBottom: 16 }}>
        <textarea
          style={{ ...input, minHeight: 70, resize: 'vertical' }}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t('image.promptPlaceholder')}
        />
        <textarea
          style={{ ...input, minHeight: 40, resize: 'vertical', marginTop: 8 }}
          value={negative}
          onChange={(e) => setNegative(e.target.value)}
          placeholder={t('image.negativePlaceholder')}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 10 }}>
          <label style={{ fontSize: 12, color: theme.muted, display: 'flex', alignItems: 'center', gap: 6 }}>
            {t('image.size')}
            <select value={size} onChange={(e) => setSize(Number(e.target.value))} style={{ ...input, width: 'auto', padding: '5px 8px', cursor: 'pointer' }}>
              {[256, 512, 768, 1024].map((s) => <option key={s} value={s}>{s}×{s}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 12, color: theme.muted, display: 'flex', alignItems: 'center', gap: 6 }}>
            {t('image.steps')}
            <input type="number" min={1} max={60} value={steps} onChange={(e) => setSteps(Number(e.target.value))} style={{ ...input, width: 64, padding: '5px 8px' }} />
          </label>
          <button onClick={() => void generate()} disabled={busy || engine !== 'up' || !prompt.trim()} style={{ ...button, opacity: busy || engine !== 'up' || !prompt.trim() ? 0.5 : 1 }}>
            {busy ? t('image.generating') : t('image.generate')}
          </button>
        </div>
        {busy && <div style={{ fontSize: 12, color: theme.muted, marginTop: 8 }}>⏳ {t('image.genNote')}</div>}
      </div>

      {err && <div style={{ color: '#e0533d', fontSize: 13, marginBottom: 12 }}>⚠ {err}</div>}

      {img && (
        <div style={{ ...card }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`data:image/png;base64,${img.data}`} alt={prompt} style={{ maxWidth: '100%', borderRadius: 8, display: 'block' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, fontSize: 12, color: theme.muted }}>
            <span>{img.seed != null && img.seed >= 0 ? `seed ${img.seed}` : ''}</span>
            <a
              href={`data:image/png;base64,${img.data}`}
              download={`neurion-${Date.now()}.png`}
              style={{ ...button, padding: '6px 14px', textDecoration: 'none' }}
            >
              ⬇ {t('image.download')}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
