import type { CSSProperties } from "react";

// All colors are CSS variables -> auto dark/light (see app/globals.css).
export const theme = {
  bg: "var(--bg)",
  surface: "var(--surface)",
  surface2: "var(--surface-2)",
  border: "var(--border)",
  text: "var(--text)",
  muted: "var(--muted)",
  accent: "var(--accent)",
  green: "var(--green)",
  amber: "var(--amber)",
  red: "var(--red)",
};

export const card: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: "16px 20px",
};

export const input: CSSProperties = {
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
  padding: "10px 12px",
  fontSize: 14,
  width: "100%",
  outline: "none",
};

export const button: CSSProperties = {
  background: "var(--accent)",
  border: "1px solid var(--accent)",
  borderRadius: 8,
  color: "var(--bg)",
  padding: "10px 16px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  letterSpacing: "0.03em",
  boxShadow: "var(--glow)",
};

/**
 * Outlined variant. Spreading `button` and overriding only `background` leaves
 * `color: var(--bg)` in place — dark text on a dark surface, i.e. a button that
 * renders as an empty box. Use this instead.
 */
export const buttonOutline: CSSProperties = {
  ...button,
  background: "transparent",
  color: "var(--accent)",
  boxShadow: "none",
};

export const ghostButton: CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
  padding: "8px 14px",
  fontSize: 14,
  cursor: "pointer",
};
