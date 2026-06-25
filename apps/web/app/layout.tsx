import type { ReactNode } from 'react';
import { AuthProvider } from '../lib/auth';

export const metadata = {
  title: 'Neurion',
  description: 'Distributed AI compute network',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: '#0b0d10',
          color: '#e6e8eb',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
