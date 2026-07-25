'use client';
import type { ReactNode } from 'react';
import { theme } from '../../lib/ui';

// Mid-tone palette readable in both light and dark mode.
export const PALETTE = ['#3987e5', '#1d9e75', '#ba7517', '#7f77dd', '#d4537e', '#888780', '#d85a30', '#5dcaa5', '#e24b4a', '#4a3aa7'];

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ margin: '32px 0' }}>
      <h2 style={{ fontSize: 13, letterSpacing: '0.18em', textTransform: 'uppercase', color: theme.muted, margin: '0 0 14px' }}>{title}</h2>
      {children}
    </section>
  );
}

export function Grid({ children, min = 200 }: { children: ReactNode; min?: number }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 14 }}>{children}</div>;
}

export function Card({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 'var(--radius)', padding: '18px 20px', ...style }}>
      {children}
    </div>
  );
}

export function Stat({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent?: boolean }) {
  return (
    <Card>
      <div style={{ fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase', color: theme.muted, marginBottom: 8 }}>{label}</div>
      <div className="display" style={{ fontSize: 32, fontWeight: 800, lineHeight: 1, color: accent ? theme.accent : theme.text }}>{value}</div>
      {sub ? <div style={{ fontSize: 12, color: theme.muted, marginTop: 6 }}>{sub}</div> : null}
    </Card>
  );
}

export interface Slice {
  label: string;
  value: number;
  color: string;
}

export function Donut({ data, total, centerLabel }: { data: Slice[]; total?: number; centerLabel?: string }) {
  const size = 150;
  const thickness = 20;
  const sum = total ?? data.reduce((s, d) => s + d.value, 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let acc = 0;
  const denom = sum || 1;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={centerLabel ?? 'distribution'}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={theme.border} strokeWidth={thickness} opacity={0.4} />
          {data.map((d, i) => {
            const len = (d.value / denom) * c;
            const el = (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={d.color}
                strokeWidth={thickness}
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-acc}
                strokeLinecap="butt"
              />
            );
            acc += len;
            return el;
          })}
        </g>
        <text x="50%" y="46%" textAnchor="middle" dominantBaseline="central" fill={theme.text} fontSize={26} fontWeight={800}>{sum}</text>
        {centerLabel ? (
          <text x="50%" y="60%" textAnchor="middle" dominantBaseline="central" fill={theme.muted} fontSize={11}>{centerLabel}</text>
        ) : null}
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 120 }}>
        {data.map((d, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: d.color, flex: '0 0 auto' }} />
            <span style={{ color: theme.text, flex: 1 }}>{d.label}</span>
            <span style={{ color: theme.muted, fontVariantNumeric: 'tabular-nums' }}>{d.value}</span>
          </div>
        ))}
        {data.length === 0 ? <span style={{ color: theme.muted, fontSize: 13 }}>—</span> : null}
      </div>
    </div>
  );
}

export interface BarItem {
  label: string;
  value: number;
}

export function BarList({ items, suffix }: { items: BarItem[]; suffix?: string }) {
  const max = items.reduce((m, i) => Math.max(m, i.value), 0) || 1;
  if (items.length === 0) return <div style={{ color: theme.muted, fontSize: 13 }}>—</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 120, fontSize: 13, color: theme.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
          <div style={{ flex: 1, height: 10, background: theme.border, borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ width: `${(it.value / max) * 100}%`, height: '100%', background: theme.accent, borderRadius: 6 }} />
          </div>
          <span style={{ width: 56, textAlign: 'right', fontSize: 13, color: theme.muted, fontVariantNumeric: 'tabular-nums' }}>
            {it.value}
            {suffix ?? ''}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Progress({ pct, label, value }: { pct: number; label: string; value?: string }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
        <span style={{ color: theme.text }}>{label}</span>
        <span style={{ color: theme.muted, fontVariantNumeric: 'tabular-nums' }}>{value ?? `${p.toFixed(1)}%`}</span>
      </div>
      <div style={{ height: 10, background: theme.border, borderRadius: 6, overflow: 'hidden' }}>
        <div style={{ width: `${p}%`, height: '100%', background: theme.accent, borderRadius: 6 }} />
      </div>
    </div>
  );
}

export interface SparkPoint {
  t: number;
  value: number;
}

export function Sparkline({ points, label, height = 70, format }: { points: SparkPoint[]; label?: string; height?: number; format?: (v: number) => string }) {
  const w = 100;
  const valid = points.filter((p) => p.value != null);
  if (valid.length < 2) {
    return (
      <div>
        {label ? <div style={{ fontSize: 13, color: theme.text, marginBottom: 6 }}>{label}</div> : null}
        <div style={{ color: theme.muted, fontSize: 13, height, display: 'flex', alignItems: 'center' }}>—</div>
      </div>
    );
  }
  const vals = valid.map((p) => p.value);
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const range = max - min || 1;
  const n = valid.length;
  const x = (i: number) => (i / (n - 1)) * w;
  const y = (v: number) => height - ((v - min) / range) * (height - 8) - 4;
  const line = valid.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(p.value).toFixed(2)}`).join(' ');
  const area = `${line} L${w},${height} L0,${height} Z`;
  const last = valid[valid.length - 1].value;
  return (
    <div>
      {label ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
          <span style={{ color: theme.text }}>{label}</span>
          <span style={{ color: theme.muted, fontVariantNumeric: 'tabular-nums' }}>{format ? format(last) : last}</span>
        </div>
      ) : null}
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" width="100%" height={height} style={{ display: 'block' }} role="img" aria-label={label ?? 'trend'}>
        <path d={area} fill={theme.accent} opacity={0.12} />
        <path d={line} fill="none" stroke={theme.accent} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

export function ComingSoon({ title, note }: { title: string; note: string }) {
  return (
    <Card style={{ opacity: 0.7, borderStyle: 'dashed' }}>
      <div style={{ fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase', color: theme.muted, marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 14, color: theme.text, fontWeight: 600 }}>{note}</div>
    </Card>
  );
}
