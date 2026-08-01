import type { MetadataRoute } from 'next';

// PWA manifest (served by Next at /manifest.webmanifest).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Neurion AI',
    short_name: 'Neurion',
    description: 'AI that runs on your own computer — chat, coding agent and images, shared between people.',
    start_url: '/app/chat',
    scope: '/',
    display: 'standalone',
    background_color: '#04070a',
    theme_color: '#04070a',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
