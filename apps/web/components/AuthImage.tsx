'use client';
import { useEffect, useState } from 'react';
import { API_BASE, getToken } from '../lib/api';

// id → object URL, module-level so re-renders (and the 2s gallery poll) reuse the blob
// instead of re-downloading. The gallery image endpoint is auth'd, so <img src> can't
// hit it directly — we fetch the blob once with the bearer token and cache it.
const cache = new Map<string, string>();

async function fetchBlob(id: string): Promise<string | null> {
  if (cache.has(id)) return cache.get(id) as string;
  try {
    const r = await fetch(`${API_BASE}/api/ai/image/file/${id}`, { headers: { authorization: `Bearer ${getToken() ?? ''}` } });
    if (!r.ok) return null;
    const url = URL.createObjectURL(await r.blob());
    cache.set(id, url);
    return url;
  } catch {
    return null;
  }
}

export function AuthImage({ id, alt, style }: { id: string; alt?: string; style?: React.CSSProperties }) {
  const [url, setUrl] = useState<string | null>(cache.get(id) ?? null);
  useEffect(() => {
    let alive = true;
    if (!cache.has(id)) void fetchBlob(id).then((u) => { if (alive && u) setUrl(u); });
    else setUrl(cache.get(id) as string);
    return () => { alive = false; };
  }, [id]);
  if (!url) return <div style={{ ...style, background: 'var(--surface-2)' }} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt ?? ''} style={style} />;
}

/** Download a gallery image (fetches the blob with auth, triggers a save). */
export async function downloadImage(id: string, name: string): Promise<void> {
  const url = await fetchBlob(id);
  if (!url) return;
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
