'use client';
import { useEffect, useState } from 'react';
import { api, streamSSE } from '../../../lib/api';
import { theme, button } from '../../../lib/ui';

interface Installed { name: string; sizeBytes: number | null }
interface Reco { name: string; label: string; size: string; note: string }
interface Pulling { name: string; percent: number | null; status: string }

const fmt = (b: number | null) => (b ? `${(b / 1e9).toFixed(1)} GB` : '');

export default function ModelsPage() {
  const [engine, setEngine] = useState<'up' | 'down' | '…'>('…');
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [reco, setReco] = useState<Reco[]>([]);
  const [pulling, setPulling] = useState<Pulling | null>(null);
  const [def, setDef] = useState<string>('');
  const [err, setErr] = useState('');

  const load = async () => {
    const inst = await api<{ engine: string; installed: Installed[] }>('/ai/models/installed').catch(() => ({ engine: 'down', installed: [] as Installed[] }));
    setEngine(inst.engine === 'up' ? 'up' : 'down');
    setInstalled(inst.installed);
  };
  useEffect(() => {
    void load();
    void api<{ recommended: Reco[] }>('/ai/models/recommended').then((r) => setReco(r.recommended)).catch(() => undefined);
    if (typeof window !== 'undefined') setDef(localStorage.getItem('neurion_model') || '');
  }, []);

  async function download(name: string) {
    if (pulling) return;
    setErr('');
    setPulling({ name, percent: 0, status: 'starting…' });
    try {
      await streamSSE('/ai/models/pull', { name }, {
        onEvent: (event, d) => {
          if (event === 'progress') setPulling({ name, percent: d.percent ?? null, status: d.status ?? '' });
          else if (event === 'done') { void load(); setPulling(null); }
          else if (event === 'error') { setErr(d.message || 'download failed'); setPulling(null); }
        },
      });
    } catch (e) {
      setErr((e as Error).message);
      setPulling(null);
    }
  }

  function makeDefault(name: string) {
    setDef(name);
    if (typeof window !== 'undefined') localStorage.setItem('neurion_model', name);
  }

  const has = (name: string) => installed.some((m) => m.name === name || m.name.startsWith(name + ':') || m.name === name + ':latest');

  return (
    <div style={{ maxWidth: 880 }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 20 }}>Modelli AI</h2>
      <p style={{ color: theme.muted, fontSize: 13, marginTop: 0 }}>Scarica un modello che gira sul tuo computer. Più grande = più bravo ma più lento.</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, margin: '14px 0' }}>
        <span style={{ width: 9, height: 9, borderRadius: 9, background: engine === 'up' ? theme.accent : engine === 'down' ? '#e0533d' : theme.muted }} />
        <span style={{ color: theme.muted }}>Motore locale: <b style={{ color: theme.text }}>{engine === 'up' ? 'attivo' : engine === 'down' ? 'non in esecuzione' : '…'}</b></span>
      </div>
      {engine === 'down' && (
        <div style={{ border: `1px solid ${theme.amber}`, borderRadius: 10, padding: 12, fontSize: 13, color: theme.text, marginBottom: 16 }}>
          Il motore AI locale (ollama) non risponde. Installalo da <a href="https://ollama.com/download" target="_blank" rel="noreferrer" style={{ color: theme.accent }}>ollama.com</a> e riapri questa pagina. (Sarà incluso nell'app a breve.)
        </div>
      )}
      {err && <div style={{ color: '#e0533d', fontSize: 13, marginBottom: 12 }}>⚠ {err}</div>}

      {pulling && (
        <div style={{ border: `1px solid ${theme.accent}`, borderRadius: 12, padding: 14, marginBottom: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 8 }}>
            <span>⬇ Scarico <b>{pulling.name}</b> — {pulling.status}</span>
            <span style={{ color: theme.accent }}>{pulling.percent != null ? pulling.percent + '%' : ''}</span>
          </div>
          <div style={{ height: 8, background: theme.surface, borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: (pulling.percent ?? 4) + '%', background: theme.accent, transition: 'width .3s' }} />
          </div>
        </div>
      )}

      <h3 style={{ fontSize: 14, color: theme.muted, textTransform: 'uppercase', letterSpacing: '.08em', margin: '8px 0' }}>Consigliati</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {reco.map((m) => (
          <div key={m.name} style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <b style={{ fontSize: 15 }}>{m.label}</b>
              <span style={{ fontSize: 11, color: theme.muted }}>{m.size}</span>
            </div>
            <div style={{ fontSize: 12, color: theme.muted, margin: '4px 0 12px' }}>{m.note}</div>
            {has(m.name) ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ fontSize: 12, color: theme.accent, alignSelf: 'center' }}>✓ installato</span>
                {def !== m.name && <button onClick={() => makeDefault(m.name)} style={ghost}>usa come default</button>}
              </div>
            ) : (
              <button onClick={() => void download(m.name)} disabled={!!pulling || engine !== 'up'} style={{ ...button, padding: '6px 14px', opacity: pulling || engine !== 'up' ? 0.5 : 1 }}>⬇ Scarica</button>
            )}
          </div>
        ))}
      </div>

      <h3 style={{ fontSize: 14, color: theme.muted, textTransform: 'uppercase', letterSpacing: '.08em', margin: '24px 0 8px' }}>Installati</h3>
      {installed.length === 0 && <div style={{ color: theme.muted, fontSize: 13 }}>Nessun modello ancora. Scaricane uno qui sopra.</div>}
      {installed.map((m) => (
        <div key={m.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderBottom: `1px solid ${theme.border}` }}>
          <span style={{ flex: 1, fontSize: 14 }}>{m.name} {def === m.name && <span style={{ color: theme.accent, fontSize: 11 }}>· default</span>}</span>
          <span style={{ fontSize: 12, color: theme.muted }}>{fmt(m.sizeBytes)}</span>
          {def !== m.name && <button onClick={() => makeDefault(m.name)} style={ghost}>default</button>}
        </div>
      ))}
    </div>
  );
}

const ghost: React.CSSProperties = { background: 'transparent', border: `1px solid ${theme.border}`, color: theme.text, borderRadius: 8, padding: '5px 12px', fontSize: 12, cursor: 'pointer' };
