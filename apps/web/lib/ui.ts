export const theme = {
  bg: '#0b0d10',
  surface: '#14171c',
  surface2: '#1b1f26',
  border: '#262b33',
  text: '#e6e8eb',
  muted: '#8b929c',
  accent: '#3b82f6',
  green: '#22c55e',
  amber: '#f59e0b',
  red: '#ef4444',
};

export const card: React.CSSProperties = {
  background: theme.surface,
  border: `1px solid ${theme.border}`,
  borderRadius: 12,
  padding: '16px 20px',
};

export const input: React.CSSProperties = {
  background: theme.surface2,
  border: `1px solid ${theme.border}`,
  borderRadius: 8,
  color: theme.text,
  padding: '10px 12px',
  fontSize: 14,
  width: '100%',
  outline: 'none',
};

export const button: React.CSSProperties = {
  background: theme.accent,
  border: 'none',
  borderRadius: 8,
  color: '#fff',
  padding: '10px 16px',
  fontSize: 14,
  fontWeight: 500,
  cursor: 'pointer',
};

export const ghostButton: React.CSSProperties = {
  background: 'transparent',
  border: `1px solid ${theme.border}`,
  borderRadius: 8,
  color: theme.text,
  padding: '8px 14px',
  fontSize: 14,
  cursor: 'pointer',
};
