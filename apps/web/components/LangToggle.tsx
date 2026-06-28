'use client';
import { useLang } from '../lib/i18n';

export function LangToggle() {
  const { lang, setLang } = useLang();
  return (
    <button
      onClick={() => setLang(lang === 'en' ? 'it' : 'en')}
      aria-label="language"
      title={lang === 'en' ? 'Switch to Italian' : 'Passa all’inglese'}
      style={{
        background: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 8,
        color: 'var(--accent)',
        padding: '6px 10px',
        cursor: 'pointer',
        fontSize: 12,
        letterSpacing: '0.08em',
        fontWeight: 500,
      }}
    >
      {lang === 'en' ? 'EN' : 'IT'}
    </button>
  );
}
