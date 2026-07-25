'use client';
import { useEffect, useRef } from 'react';

/** Matrix digital-rain canvas. Reads the accent color from CSS vars. */
export function MatrixRain({ opacity = 1, fontSize = 16 }: { opacity?: number; fontSize?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue('--accent').trim() || '#00ff70';
    const bg = styles.getPropertyValue('--bg-deep').trim() || '#02040a';

    const chars = 'アイウエオカキクケコサシスセソタチツテトナニヌネノﾊﾋﾌﾍﾎ0123456789<>=*+-/¦|ﾘツﾙﾝ'.split('');
    let width = 0;
    let height = 0;
    let columns = 0;
    let drops: number[] = [];

    const resize = () => {
      width = canvas.width = canvas.offsetWidth;
      height = canvas.height = canvas.offsetHeight;
      columns = Math.floor(width / fontSize);
      drops = Array.from({ length: columns }, () => Math.floor((Math.random() * height) / fontSize));
    };
    resize();
    window.addEventListener('resize', resize);

    const draw = () => {
      ctx.fillStyle = bg + '14'; // translucent fade -> trails
      ctx.fillRect(0, 0, width, height);
      ctx.font = `${fontSize}px var(--font-mono), monospace`;
      for (let i = 0; i < drops.length; i++) {
        const ch = chars[Math.floor(Math.random() * chars.length)] ?? '0';
        const x = i * fontSize;
        const y = (drops[i] ?? 0) * fontSize;
        // bright head, dim tail
        ctx.fillStyle = Math.random() > 0.975 ? '#ffffff' : accent;
        ctx.fillText(ch, x, y);
        if (y > height && Math.random() > 0.975) drops[i] = 0;
        drops[i] = (drops[i] ?? 0) + 1;
      }
    };
    const id = window.setInterval(draw, 45);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('resize', resize);
    };
  }, [fontSize]);

  return (
    <canvas
      ref={ref}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity, display: 'block' }}
    />
  );
}
