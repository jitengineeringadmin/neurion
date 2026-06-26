'use client';
import { useTheme } from '../lib/theme';

export function ThemeToggle() {
  const { mode, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      aria-label="toggle theme"
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
      {mode === 'dark' ? '☀ light' : '☾ dark'}
    </button>
  );
}
