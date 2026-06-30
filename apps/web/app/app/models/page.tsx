'use client';
import { useEffect, useState } from 'react';
import { api, streamSSE } from '../../../lib/api';
import { theme, button, input } from '../../../lib/ui';
import { useT } from '../../../lib/i18n';

interface Installed { name: string; sizeBytes: number | null }
interface Reco { name: string; label: string; size: string; note: string; group: string }
interface Quant { tag: string; hint: string }
interface Pulling { name: string; percent: number | null; status: string }
interface NodeApi {
  status: () => Promise<{ running: boolean; registered: boolean; available: boolean }>;
  start: (creds?: { email: string; password: string }) => Promise<{ ok: boolean; error?: string; running?: boolean }>;
  stop: () => Promise<{ ok: boolean }>;
}

const fmt = (b: number | null) => (b ? `${(b / 1e9).toFixed(1)} GB` : '');

export default function ModelsPage() {
  const t = useT();
  const [engine, setEngine] = useState<'up' | 'down' | '…'>('…');
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [reco, setReco] = useState<Reco[]>([]);
  const [quants, setQuants] = useState<Quant[]>([{ tag: '', hint: '' }]);
  const [quant, setQuant] = useState('');
  const [pulling, setPulling] = useState<Pulling | null>(null);
  const [def, setDef] = useState<string>('');
  const [sel, setSel] = useState('');
  const [err, setErr] = useState('');
  const nodeApi: NodeApi | null =
    typeof window !== 'undefined' ? (window as unknown as { neurion?: { node?: NodeApi } }).neurion?.node ?? null : null;
  const [nodeSt, setNodeSt] = useState<{ running: boolean; registered: boolean; available: boolean } | null>(null);
  const [nEmail, setNEmail] = useState('');
  const [nPass, setNPass] = useState('');
  const [nErr, setNErr] = useState('');
  const [nBusy, setNBusy] = useState(false);

  const load = async () => {
    const inst = await api<{ engine: string; installed: Installed[] }>('/ai/models/installed').catch(() => ({ engine: 'down', installed: [] as Installed[] }));
    setEngine(inst.engine === 'up' ? 'up' : 'down');
    setInstalled(inst.installed);
  };
  useEffect(() => {
    void load();
    void api<{ recommended: Reco[]; quants?: Quant[] }>('/ai/models/recommended')
      .then((r) => { setReco(r.recommended); if (r.quants?.length) setQuants(r.quants); })
      .catch(() => undefined);
    if (typeof window !== 'undefined') setDef(localStorage.getItem('neurion_model') || '');
  }, []);

  async function download(base: string, q: string) {
    if (pulling) return;
    setErr('');
    const name = q ? `${base}-${q}` : base;
    setPulling({ name, percent: 0, status: t('models.statusStarting') });
    try {
      await streamSSE('/ai/models/pull', { name: base, quant: q }, {
        onEvent: (event, d) => {
          if (event === 'progress') setPulling({ name, percent: d.percent ?? null, status: d.status ?? '' });
          else if (event === 'done') { void load(); setPulling(null); }
          else if (event === 'error') { setErr(d.message || t('models.errDownloadFailed')); setPulling(null); }
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

  useEffect(() => {
    if (!nodeApi) return;
    let alive = true;
    const tick = () => void nodeApi.status().then((s) => alive && setNodeSt(s)).catch(() => undefined);
    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function nodeStart() {
    if (!nodeApi) return;
    setNErr(''); setNBusy(true);
    try {
      const r = await nodeApi.start(nodeSt?.registered ? undefined : { email: nEmail, password: nPass });
      if (!r.ok) setNErr(r.error || t('models.errDownloadFailed'));
      setNodeSt(await nodeApi.status());
    } catch (e) {
      setNErr((e as Error).message);
    } finally { setNBusy(false); }
  }
  async function nodeStop() {
    if (!nodeApi) return;
    setNBusy(true);
    try { await nodeApi.stop(); setNodeSt(await nodeApi.status()); } finally { setNBusy(false); }
  }

  const has = (name: string) => installed.some((m) => m.name === name || m.name.startsWith(name + ':') || m.name === name + ':latest');

  return (
    <div style={{ maxWidth: 880 }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 20 }}>{t('models.pageTitle')}</h2>
      <p style={{ color: theme.muted, fontSize: 13, marginTop: 0 }}>{t('models.pageSubtitle')}</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, margin: '14px 0' }}>
        <span style={{ width: 9, height: 9, borderRadius: 9, background: engine === 'up' ? theme.accent : engine === 'down' ? '#e0533d' : theme.muted }} />
        <span style={{ color: theme.muted }}>{t('models.localEngineLabel')} <b style={{ color: theme.text }}>{engine === 'up' ? t('models.engineUp') : engine === 'down' ? t('models.engineDown') : '…'}</b></span>
      </div>
      {engine === 'down' && (() => {
        const parts = t('models.engineDownBanner').split('{link}');
        return (
          <div style={{ border: `1px solid ${theme.amber}`, borderRadius: 10, padding: 12, fontSize: 13, color: theme.text, marginBottom: 16 }}>
            {parts[0]}
            <a href="https://ollama.com/download" target="_blank" rel="noreferrer" style={{ color: theme.accent }}>{t('models.ollamaLinkText')}</a>
            {parts[1]}
          </div>
        );
      })()}
      {err && <div style={{ color: '#e0533d', fontSize: 13, marginBottom: 12 }}>⚠ {err}</div>}

      {pulling && (
        <div style={{ border: `1px solid ${theme.accent}`, borderRadius: 12, padding: 14, marginBottom: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 8 }}>
            <span>⬇ {t('models.downloadingPrefix')} <b>{pulling.name}</b> — {pulling.status}</span>
            <span style={{ color: theme.accent }}>{pulling.percent != null ? pulling.percent + '%' : ''}</span>
          </div>
          <div style={{ height: 8, background: theme.surface, borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: (pulling.percent ?? 4) + '%', background: theme.accent, transition: 'width .3s' }} />
          </div>
        </div>
      )}

      <h3 style={{ fontSize: 14, color: theme.muted, textTransform: 'uppercase', letterSpacing: '.08em', margin: '8px 0' }}>{t('models.recommendedHeading')}</h3>
      {(() => {
        const groups = reco.reduce<string[]>((acc, r) => (acc.includes(r.group) ? acc : [...acc, r.group]), []);
        const selModel = reco.find((m) => m.name === sel) || null;
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}>
            <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ ...input, cursor: 'pointer' }}>
              <option value="">{t('models.choose')}</option>
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {reco.filter((m) => m.group === g).map((m) => (
                    <option key={m.name} value={m.name}>{m.label} — {m.size}{has(m.name) ? ' ✓' : ''}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            {selModel && (() => {
              // Real installed name is base-infix-quant (e.g. qwen2.5:7b-instruct-q8_0),
              // so match loosely by base prefix + quant token rather than an exact guess.
              const inst = quant
                ? installed.find((m) => m.name.startsWith(selModel.name + '-') && m.name.includes(quant))
                : installed.find((m) => m.name === selModel.name || m.name.startsWith(selModel.name + ':') || m.name === selModel.name + ':latest');
              const targetInstalled = !!inst;
              const defName = inst?.name || (quant ? `${selModel.name}-${quant}` : selModel.name);
              const selQuant = quants.find((q) => q.tag === quant);
              return (
              <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <b style={{ fontSize: 15 }}>{selModel.label}</b>
                  <span style={{ fontSize: 11, color: theme.muted }}>{selModel.size}{quant ? ' · ' + t('models.quantSizeVaries') : ''}</span>
                </div>
                <div style={{ fontSize: 12, color: theme.muted, margin: '4px 0 12px' }}>{selModel.note}</div>
                {quants.length > 1 && (
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ fontSize: 12, color: theme.muted, display: 'block', marginBottom: 4 }}>{t('models.quantLabel')}</label>
                    <select value={quant} onChange={(e) => setQuant(e.target.value)} style={{ ...input, cursor: 'pointer' }}>
                      {quants.map((q) => (
                        <option key={q.tag || 'default'} value={q.tag}>{(q.tag || t('models.quantDefault')) + (q.hint ? ' — ' + q.hint : '')}</option>
                      ))}
                    </select>
                    <div style={{ fontSize: 11, color: theme.muted, marginTop: 4 }}>{t('models.quantHelp')}</div>
                  </div>
                )}
                {targetInstalled ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: theme.accent }}>✓ {t('models.installedBadge')}{quant ? ` (${quant})` : ''}</span>
                    {def !== defName && <button onClick={() => makeDefault(defName)} style={ghost}>{t('models.useAsDefault')}</button>}
                  </div>
                ) : (
                  <button onClick={() => void download(selModel.name, quant)} disabled={!!pulling || engine !== 'up'} style={{ ...button, padding: '6px 14px', opacity: pulling || engine !== 'up' ? 0.5 : 1 }}>⬇ {t('models.downloadButton')}{selQuant && quant ? ` · ${quant}` : ''}</button>
                )}
              </div>
              );
            })()}
          </div>
        );
      })()}

      <h3 style={{ fontSize: 14, color: theme.muted, textTransform: 'uppercase', letterSpacing: '.08em', margin: '24px 0 8px' }}>{t('models.installedHeading')}</h3>
      {installed.length === 0 && <div style={{ color: theme.muted, fontSize: 13 }}>{t('models.emptyInstalled')}</div>}
      {installed.map((m) => (
        <div key={m.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderBottom: `1px solid ${theme.border}` }}>
          <span style={{ flex: 1, fontSize: 14 }}>{m.name} {def === m.name && <span style={{ color: theme.accent, fontSize: 11 }}>· {t('models.defaultBadge')}</span>}</span>
          <span style={{ fontSize: 12, color: theme.muted }}>{fmt(m.sizeBytes)}</span>
          {def !== m.name && <button onClick={() => makeDefault(m.name)} style={ghost}>{t('models.makeDefaultButton')}</button>}
        </div>
      ))}

      {nodeApi && (
        <>
          <h3 style={{ fontSize: 14, color: theme.muted, textTransform: 'uppercase', letterSpacing: '.08em', margin: '28px 0 8px' }}>{t('models.nodeHeading')}</h3>
          <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 16, maxWidth: 520 }}>
            <p style={{ fontSize: 13, color: theme.muted, margin: '0 0 12px' }}>{t('models.nodeDesc')}</p>
            {nodeSt?.available === false ? (
              <div style={{ color: theme.muted, fontSize: 13 }}>{t('models.nodeUnavailable')}</div>
            ) : nodeSt?.running ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ color: theme.accent, fontSize: 14 }}>● {t('models.nodeRunning')}</span>
                <button onClick={() => void nodeStop()} disabled={nBusy} style={ghost}>{t('models.nodeStop')}</button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {!nodeSt?.registered && (
                  <>
                    <input value={nEmail} onChange={(e) => setNEmail(e.target.value)} placeholder={t('models.nodeEmail')} style={input} />
                    <input value={nPass} onChange={(e) => setNPass(e.target.value)} type="password" placeholder={t('models.nodePass')} style={input} />
                  </>
                )}
                <button onClick={() => void nodeStart()} disabled={nBusy || engine !== 'up'} style={{ ...button, padding: '8px 16px', alignSelf: 'flex-start', opacity: nBusy || engine !== 'up' ? 0.5 : 1 }}>{nBusy ? '…' : t('models.nodeStart')}</button>
                {engine !== 'up' && <span style={{ fontSize: 12, color: theme.muted }}>{t('models.nodeNeedsEngine')}</span>}
              </div>
            )}
            {nErr && <div style={{ color: '#e0533d', fontSize: 12, marginTop: 8 }}>⚠ {nErr}</div>}
          </div>
        </>
      )}
    </div>
  );
}

const ghost: React.CSSProperties = { background: 'transparent', border: `1px solid ${theme.border}`, color: theme.text, borderRadius: 8, padding: '5px 12px', fontSize: 12, cursor: 'pointer' };
