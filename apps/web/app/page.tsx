import Link from 'next/link';

export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '80px 24px' }}>
      <h1 style={{ fontSize: 44, letterSpacing: -1, marginBottom: 8 }}>
        Neurion <span style={{ color: '#3b82f6' }}>AI</span>
      </h1>
      <p style={{ opacity: 0.8, lineHeight: 1.6, fontSize: 18 }}>
        Share idle power. Access AI. Earn credits and utility tokens.
      </p>
      <p style={{ opacity: 0.6, lineHeight: 1.7 }}>
        Fast ChatGPT-like chat over a distributed grid of community nodes, with a Fast / Grid / Fallback router,
        internal credits and the NRN utility token.
      </p>
      <Link
        href="/login"
        style={{
          display: 'inline-block',
          marginTop: 20,
          background: '#3b82f6',
          color: '#fff',
          padding: '12px 22px',
          borderRadius: 8,
          textDecoration: 'none',
          fontWeight: 500,
        }}
      >
        Open app →
      </Link>
    </main>
  );
}
