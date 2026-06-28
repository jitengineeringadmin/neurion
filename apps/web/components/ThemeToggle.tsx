'use client';
import { useTheme } from '../lib/theme';
import { useT } from '../lib/i18n';

export function ThemeToggle() {
  const t = useT();
  const { mode, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      aria-label={t('themetoggle.ariaToggleTheme')}
      style={{
        background: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 8,
        color: 'var(--accent)',
        padding: '6px 10px',
        cursor: 'pointer',
        fontSize: 12,
        letterSpacing: '0.05em',
      }}
    >
      {mode === 'dark' ? `☀ ${t('themetoggle.lightLabel')}` : `☾ ${t('themetoggle.darkLabel')}`}
    </button>
  );
}
