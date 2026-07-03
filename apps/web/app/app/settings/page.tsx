'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { theme, card, input, button } from '../../../lib/ui';
import { useT } from '../../../lib/i18n';
import { SkillsManager } from '../../../components/SkillsManager';

const AUTO_KEY = 'neurion_agent_auto';

export default function SettingsPage() {
  const t = useT();
  const [instructions, setInstructions] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoDefault, setAutoDefault] = useState(false);

  useEffect(() => {
    void api<{ instructions: string }>('/agent/settings').then((r) => { setInstructions(r.instructions || ''); setSaved(r.instructions || ''); }).catch(() => undefined);
    if (typeof window !== 'undefined') setAutoDefault(localStorage.getItem(AUTO_KEY) === '1');
  }, []);

  async function save() {
    setBusy(true);
    try {
      const r = await api<{ instructions: string }>('/agent/settings', { method: 'PUT', body: JSON.stringify({ instructions }) });
      setSaved(r.instructions);
    } catch { /* ignore */ } finally { setBusy(false); }
  }
  const dirty = saved !== null && instructions !== saved;

  const example = `# Le mie regole
- Rispondi e commenta il codice in italiano.
- Per i siti usa sempre Tailwind (CDN) e un look moderno e pulito.
- Palette: terracotta, crema, verde oliva.
- Non usare testo "lorem ipsum": inventa contenuti realistici.
- Meno spiegazioni, più codice. Chiudi appena il file è pronto.`;

  return (
    <div style={{ maxWidth: 760 }}>
      <h2 style={{ fontSize: 20, marginTop: 0 }}>{t('settings.title')}</h2>

      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>📋 {t('settings.instructionsTitle')}</div>
        <p style={{ color: theme.muted, fontSize: 13, marginTop: 0, lineHeight: 1.5 }}>{t('settings.instructionsSub')}</p>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={example}
          style={{ ...input, minHeight: 240, resize: 'vertical', fontFamily: 'var(--font-mono), monospace', fontSize: 13, lineHeight: 1.55 }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
          <button onClick={() => void save()} disabled={busy || !dirty} style={{ ...button, padding: '8px 18px', opacity: busy || !dirty ? 0.5 : 1 }}>
            {busy ? '…' : t('settings.save')}
          </button>
          {!dirty && saved !== null && saved.length > 0 && <span style={{ fontSize: 12, color: theme.green }}>✓ {t('settings.savedActive')}</span>}
          {dirty && <span style={{ fontSize: 12, color: theme.amber }}>{t('settings.unsaved')}</span>}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: theme.muted }}>{instructions.length}/20000</span>
        </div>
        <div style={{ fontSize: 12, color: theme.muted, marginTop: 8 }}>💡 {t('settings.tip')}</div>
      </div>

      <div style={{ ...card }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>⚙ {t('settings.behaviorTitle')}</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, cursor: 'pointer', marginTop: 8 }}>
          <input
            type="checkbox"
            checked={autoDefault}
            onChange={(e) => { setAutoDefault(e.target.checked); try { localStorage.setItem(AUTO_KEY, e.target.checked ? '1' : '0'); } catch { /* ignore */ } }}
          />
          {t('settings.autoDefault')}
        </label>
        <p style={{ color: theme.muted, fontSize: 12, margin: '4px 0 0 24px' }}>{t('settings.autoDefaultSub')}</p>
      </div>

      <div style={{ marginTop: 16 }}>
        <SkillsManager />
      </div>
    </div>
  );
}
