import './globals.css';
import type { ReactNode } from 'react';
import { Share_Tech_Mono, Orbitron } from 'next/font/google';
import { AuthProvider } from '../lib/auth';
import { ThemeProvider } from '../lib/theme';
import { BootSplash } from '../components/BootSplash';

const mono = Share_Tech_Mono({ weight: '400', subsets: ['latin'], variable: '--font-mono', display: 'swap' });
const display = Orbitron({ subsets: ['latin'], weight: ['500', '700'], variable: '--font-display', display: 'swap' });

export const metadata = {
  title: 'Neurion AI',
  description: 'Distributed AI compute network — share idle power, access AI, earn NRN.',
};

const noFlash = `(function(){try{var t=localStorage.getItem('neurion_theme')||'dark';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={`${mono.variable} ${display.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlash }} />
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider>
            <BootSplash />
            {children}
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
