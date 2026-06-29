'use client';

const COLORS = ['#00ff70', '#3da5ff', '#ff6b6b', '#ffb84d', '#b06bff', '#2dd4bf', '#f472b6', '#a3e635', '#fb923c', '#60a5fa'];
function colorFor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

export function Avatar({ name, url, size = 32 }: { name: string; url?: string | null; size?: number }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={name} width={size} height={size} style={{ borderRadius: size, objectFit: 'cover', flexShrink: 0, background: 'var(--surface)' }} />;
  }
  const c = colorFor(name || '?');
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <div style={{ width: size, height: size, borderRadius: size, background: c, color: '#04070a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: Math.round(size * 0.45), flexShrink: 0, lineHeight: 1 }}>
      {initial}
    </div>
  );
}
