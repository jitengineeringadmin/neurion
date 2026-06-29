'use client';
import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import en from './i18n/locales/en';
import it from './i18n/locales/it';
import fr from './i18n/locales/fr';
import de from './i18n/locales/de';
import es from './i18n/locales/es';
import ru from './i18n/locales/ru';
import zh from './i18n/locales/zh';

export type Lang = 'en' | 'it' | 'fr' | 'de' | 'es' | 'ru' | 'zh';
type Dict = Record<string, string>;

const dict: Record<Lang, Dict> = { en, it, fr, de, es, ru, zh };

export const LANGS: { code: Lang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'it', label: 'Italiano' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'ru', label: 'Русский' },
  { code: 'zh', label: '中文' },
];
const CODES = LANGS.map((l) => l.code) as string[];

interface I18nState {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nState>({ lang: 'en', setLang: () => undefined, t: (k) => k });

function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : '{' + k + '}'));
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>('en');
  useEffect(() => {
    try {
      const saved = localStorage.getItem('neurion_lang');
      if (saved && CODES.includes(saved)) {
        setLangState(saved as Lang);
        document.documentElement.setAttribute('lang', saved);
      }
    } catch {}
  }, []);
  function setLang(l: Lang) {
    setLangState(l);
    try {
      localStorage.setItem('neurion_lang', l);
      document.documentElement.setAttribute('lang', l);
    } catch {}
  }
  const t = (key: string, vars?: Record<string, string | number>) =>
    interpolate(dict[lang][key] ?? dict.en[key] ?? key, vars);
  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>;
}

export const useT = () => useContext(I18nContext).t;
export const useLang = () => {
  const { lang, setLang } = useContext(I18nContext);
  return { lang, setLang };
};
