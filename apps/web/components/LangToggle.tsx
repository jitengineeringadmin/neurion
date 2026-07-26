"use client";
import { useLang, LANGS, Lang } from "../lib/i18n";

export function LangToggle() {
  const { lang, setLang } = useLang();
  return (
    <select
      value={lang}
      onChange={(e) => setLang(e.target.value as Lang)}
      aria-label="language"
      title="Language"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        color: "var(--accent)",
        padding: "6px 8px",
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 500,
        fontFamily: "inherit",
      }}
    >
      {LANGS.map((l) => (
        <option
          key={l.code}
          value={l.code}
          style={{ background: "var(--surface)", color: "var(--text)" }}
        >
          {l.label}
        </option>
      ))}
    </select>
  );
}
