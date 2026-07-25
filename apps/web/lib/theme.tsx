'use client';
import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

type Mode = 'dark' | 'light';
interface ThemeState {
  mode: Mode;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeState>({ mode: 'dark', toggle: () => undefined });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>('dark');

  useEffect(() => {
    const saved = (localStorage.getItem('neurion_theme') as Mode | null) ?? 'dark';
    setMode(saved);
    document.documentElement.setAttribute('data-theme', saved);
  }, []);

  function toggle(): void {
    setMode((m) => {
      const next: Mode = m === 'dark' ? 'light' : 'dark';
      localStorage.setItem('neurion_theme', next);
      document.documentElement.setAttribute('data-theme', next);
      return next;
    });
  }

  return <ThemeContext.Provider value={{ mode, toggle }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
