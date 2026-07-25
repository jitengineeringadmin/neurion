'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { theme } from '../lib/ui';
import { useT } from '../lib/i18n';
import { AuthImage, downloadImage } from './AuthImage';

interface Item { id: string; status: string; prompt?: string; hasImage?: boolean; createdAt?: string }

/**
 * Image-tab sidebar: your generation history as thumbnails. Click downloads the image.
 * Polls lightly while something is running.
 */
export function GallerySidebar() {
  const t = useT();
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () => void api<{ items: Item[] }>('/ai/image/gallery').then((r) => { if (alive) setItems(r.items || []); }).catch(() => undefined);
    load();
    const id = setInterval(load, 6000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingRight: 4 }}>
      <div style={{ fontSize: 11, color: theme.muted, textTransform: 'uppercase', margin: '4px 0 8px' }}>{t('sidebar.galleryHeading')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {items.map((it) => (
          it.status === 'done' && it.hasImage ? (
            <div key={it.id} onClick={() => void downloadImage(it.id, `neurion-${it.id}.png`)} title={it.prompt || ''}
              style={{ display: 'block', borderRadius: 8, overflow: 'hidden', border: `1px solid ${theme.border}`, lineHeight: 0, cursor: 'pointer' }}>
              <AuthImage id={it.id} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }} />
            </div>
          ) : (
            <div key={it.id} title={it.prompt || ''}
              style={{ borderRadius: 8, border: `1px solid ${theme.border}`, aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: it.status === 'failed' ? '#e0533d' : theme.amber }}>
              {it.status === 'failed' ? '⚠' : <span className="flicker">●</span>}
            </div>
          )
        ))}
      </div>
      {items.length === 0 && <div style={{ fontSize: 12, color: theme.muted, padding: '4px 8px', lineHeight: 1.5 }}>{t('sidebar.galleryEmpty')}</div>}
    </div>
  );
}
