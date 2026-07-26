"use client";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { theme, card, input, button, ghostButton } from "../lib/ui";
import { useT } from "../lib/i18n";

interface Skill {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  body: string;
  enabled: boolean;
}

type Draft = {
  id?: string;
  name: string;
  description: string;
  triggers: string;
  body: string;
  enabled: boolean;
};
const EMPTY: Draft = {
  name: "",
  description: "",
  triggers: "",
  body: "",
  enabled: true,
};

/**
 * Skills manager (Settings): user-authored, modular instruction packs the agent applies
 * automatically when a task's request matches the skill's trigger words. Think of each as
 * a small reusable "how to do X" the local model loads only when relevant.
 */
export function SkillsManager() {
  const t = useT();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    void api<Skill[]>("/agent/skills")
      .then((r) => setSkills(Array.isArray(r) ? r : []))
      .catch(() => undefined);
  useEffect(() => {
    load();
  }, []);

  function editSkill(s: Skill) {
    setDraft({
      id: s.id,
      name: s.name,
      description: s.description,
      triggers: s.triggers.join(", "),
      body: s.body,
      enabled: s.enabled,
    });
  }

  async function save() {
    if (!draft || !draft.name.trim()) return;
    setBusy(true);
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      triggers: draft.triggers
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      body: draft.body,
      enabled: draft.enabled,
    };
    try {
      if (draft.id)
        await api(`/agent/skills/${draft.id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      else
        await api("/agent/skills", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      setDraft(null);
      load();
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }

  async function toggle(s: Skill) {
    setSkills((cur) =>
      cur.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)),
    ); // optimistic
    await api(`/agent/skills/${s.id}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: !s.enabled }),
    }).catch(() => undefined);
    load();
  }
  async function del(id: string) {
    await api(`/agent/skills/${id}`, { method: "DELETE" }).catch(
      () => undefined,
    );
    if (draft?.id === id) setDraft(null);
    load();
  }

  const bodyExample = t("skills.bodyPh");

  return (
    <div style={{ ...card }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>
          🧩 {t("skills.title")}
        </div>
        <span style={{ flex: 1 }} />
        {!draft && (
          <button
            onClick={() => setDraft({ ...EMPTY })}
            style={{ ...button, padding: "6px 14px", fontSize: 13 }}
          >
            + {t("skills.new")}
          </button>
        )}
      </div>
      <p
        style={{
          color: theme.muted,
          fontSize: 13,
          marginTop: 4,
          marginBottom: 12,
          lineHeight: 1.5,
        }}
      >
        {t("skills.sub")}
      </p>

      {/* Editor */}
      {draft && (
        <div
          style={{
            border: `1px solid ${theme.accent}`,
            borderRadius: 10,
            padding: 14,
            marginBottom: 14,
            background: theme.bg,
          }}
        >
          <label style={lbl}>{t("skills.name")}</label>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder={t("skills.namePh")}
            maxLength={80}
            style={{ ...input, marginBottom: 10 }}
          />

          <label style={lbl}>{t("skills.desc")}</label>
          <input
            value={draft.description}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
            placeholder={t("skills.descPh")}
            maxLength={300}
            style={{ ...input, marginBottom: 10 }}
          />

          <label style={lbl}>{t("skills.triggers")}</label>
          <input
            value={draft.triggers}
            onChange={(e) => setDraft({ ...draft, triggers: e.target.value })}
            placeholder={t("skills.triggersPh")}
            style={{ ...input, marginBottom: 4 }}
          />
          <div style={{ fontSize: 11, color: theme.muted, marginBottom: 10 }}>
            {t("skills.triggersHelp")}
          </div>

          <label style={lbl}>{t("skills.body")}</label>
          <textarea
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            placeholder={bodyExample}
            maxLength={8000}
            style={{
              ...input,
              minHeight: 160,
              resize: "vertical",
              fontFamily: "var(--font-mono), monospace",
              fontSize: 13,
              lineHeight: 1.55,
              marginBottom: 10,
            }}
          />

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              onClick={() => void save()}
              disabled={busy || !draft.name.trim()}
              style={{
                ...button,
                padding: "8px 18px",
                opacity: busy || !draft.name.trim() ? 0.5 : 1,
              }}
            >
              {busy ? "…" : t("skills.save")}
            </button>
            <button
              onClick={() => setDraft(null)}
              style={{ ...ghostButton, padding: "8px 16px" }}
            >
              {t("skills.cancel")}
            </button>
            <span style={{ flex: 1 }} />
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
                color: theme.muted,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) =>
                  setDraft({ ...draft, enabled: e.target.checked })
                }
              />
              {t("skills.enabled")}
            </label>
          </div>
        </div>
      )}

      {/* List */}
      {skills.length === 0 && !draft && (
        <div
          style={{
            fontSize: 13,
            color: theme.muted,
            padding: "4px 2px",
            lineHeight: 1.5,
          }}
        >
          {t("skills.empty")}
        </div>
      )}
      {skills.map((s) => (
        <div
          key={s.id}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: "10px 2px",
            borderTop: `1px solid ${theme.border}`,
          }}
        >
          <div style={{ flex: 1, minWidth: 0, opacity: s.enabled ? 1 : 0.5 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>
              {s.name}
            </div>
            {s.description && (
              <div
                style={{
                  fontSize: 12,
                  color: theme.muted,
                  marginTop: 2,
                  lineHeight: 1.4,
                }}
              >
                {s.description}
              </div>
            )}
            <div style={{ fontSize: 11, color: theme.muted, marginTop: 4 }}>
              {s.triggers.length > 0
                ? `⚡ ${s.triggers.join(", ")}`
                : `⚡ ${t("skills.always")}`}
            </div>
          </div>
          <button
            onClick={() => void toggle(s)}
            title={s.enabled ? t("skills.on") : t("skills.off")}
            style={{
              ...ghostButton,
              padding: "4px 10px",
              fontSize: 12,
              color: s.enabled ? theme.green : theme.muted,
              borderColor: s.enabled ? theme.green : theme.border,
            }}
          >
            {s.enabled ? t("skills.on") : t("skills.off")}
          </button>
          <button
            onClick={() => editSkill(s)}
            title={t("skills.edit")}
            style={{ ...ghostButton, padding: "4px 10px", fontSize: 12 }}
          >
            ✎
          </button>
          <button
            onClick={() => void del(s.id)}
            title={t("skills.delete")}
            style={{ ...ghostButton, padding: "4px 10px", fontSize: 12 }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

const lbl = {
  display: "block",
  fontSize: 12,
  color: theme.muted,
  marginBottom: 4,
  fontWeight: 600,
} as const;
