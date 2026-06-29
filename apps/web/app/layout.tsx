import './globals.css';
import type { ReactNode } from 'react';
import { Share_Tech_Mono, Orbitron } from 'next/font/google';
import { AuthProvider } from '../lib/auth';
import { ThemeProvider } from '../lib/theme';
import { LanguageProvider } from '../lib/i18n';
import { BootSplash } from '../components/BootSplash';
import { PWARegister } from '../components/PWARegister';

const mono = Share_Tech_Mono({ weight: '400', subsets: ['latin'], variable: '--font-mono', display: 'swap' });
const display = Orbitron({ subsets: ['latin'], weight: ['500', '700'], variable: '--font-display', display: 'swap' });

export const metadata = {
  title: 'Neurion AI',
  description: 'Distributed AI compute network — share idle power, access AI, earn NRN.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Neurion',
  appleWebApp: { capable: true, title: 'Neurion', statusBarStyle: 'black-translucent' as const },
  icons: { icon: '/icon.png', apple: '/apple-touch-icon.png' },
};

export const viewport = {
  themeColor: '#04070a',
};

const noFlash = `(function(){try{var t=localStorage.getItem('neurion_theme')||'dark';document.documentElement.setAttribute('data-theme',t);var l=localStorage.getItem('neurion_lang');if(l&&['en','it','fr','de','es','ru','zh'].indexOf(l)>=0)document.documentElement.setAttribute('lang',l);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={`${mono.variable} ${display.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlash }} />
      </head>
      <body>
        <ThemeProvider>
          <LanguageProvider>
            <AuthProvider>
              <PWARegister />
              <BootSplash />
              {children}
            </AuthProvider>
          </LanguageProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
