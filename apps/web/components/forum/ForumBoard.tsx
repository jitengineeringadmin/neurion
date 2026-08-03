"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { forumApi } from "../../lib/api";
import { theme, card, input, button } from "../../lib/ui";
import { useT } from "../../lib/i18n";
import { Avatar } from "../Avatar";

interface LastPost {
  threadId: string;
  title: string;
  author: string;
  authorAvatar: string | null;
  at: string;
}
interface Section {
  id: string;
  group: string;
  name: string;
  description: string;
  icon: string;
  threads: number;
  messages: number;
  lastPost: LastPost | null;
}
interface Latest {
  id: string;
  title: string;
  replies: number;
  author: string;
  authorAvatar: string | null;
  lastActivityAt: string;
  section: { id: string; name: string; icon: string };
}
interface Thread {
  id: string;
  section: { id: string; name: string; icon: string };
  title: string;
  pinned: boolean;
  locked: boolean;
  lastActivityAt: string;
  author: { id: string; name: string; avatarUrl: string | null };
  replies: number;
}

export function ForumBoard({
  canPost,
  threadHref,
  loginHref,
}: {
  canPost: boolean;
  threadHref: (id: string) => string;
  loginHref: string;
}) {
  const t = useT();
  const [sections, setSections] = useState<Section[]>([]);
  const [latest, setLatest] = useState<Latest[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [composing, setComposing] = useState(false);
  const [formSection, setFormSection] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const loadBoard = () => {
    void forumApi<Section[]>("/sections")
      .then(setSections)
      .catch(() => undefined);
    void forumApi<Latest[]>("/latest")
      .then(setLatest)
      .catch(() => undefined);
  };
  useEffect(loadBoard, []);
  useEffect(() => {
    if (sel)
      void forumApi<Thread[]>(`/threads?section=${sel}`)
        .then(setThreads)
        .catch(() => setThreads([]));
  }, [sel]);

  const groups = [...new Set(sections.map((s) => s.group))];
  const selSection = sections.find((s) => s.id === sel);

  function openComposer() {
    setFormSection(sel ?? sections[0]?.id ?? "");
    setComposing(true);
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (title.trim().length < 3 || !body.trim() || !formSection) return;
    setBusy(true);
    try {
      const r = await forumApi<{ id: string }>("/threads", {
        method: "POST",
        body: JSON.stringify({ sectionId: formSection, title, body }),
      });
      setTitle("");
      setBody("");
      setComposing(false);
      loadBoard();
      if (sel)
        await forumApi<Thread[]>(`/threads?section=${sel}`).then(setThreads);
      void r;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        gap: 24,
        alignItems: "flex-start",
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: "1 1 520px", minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 8,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 22 }}>
            {sel
              ? `${selSection?.icon ?? ""} ${selSection?.name ?? ""}`
              : t("forum.title")}
          </h2>
          {canPost ? (
            <button
              onClick={openComposer}
              style={{ ...button, padding: "6px 14px" }}
            >
              {t("forum.newThread")}
            </button>
          ) : (
            <Link
              href={loginHref}
              style={{ ...button, padding: "6px 14px", textDecoration: "none" }}
            >
              {t("forum.participate")}
            </Link>
          )}
        </div>
        {!sel && (
          <p style={{ color: theme.muted, fontSize: 14, marginTop: 0 }}>
            {t("forum.subtitle")}
          </p>
        )}
        {sel && (
          <div style={{ marginBottom: 10 }}>
            <span
              onClick={() => setSel(null)}
              style={{ color: theme.accent, fontSize: 13, cursor: "pointer" }}
            >
              ← {t("forum.allSections")}
            </span>
          </div>
        )}

        {composing && canPost && (
          <form
            onSubmit={create}
            style={{
              ...card,
              display: "flex",
              flexDirection: "column",
              gap: 10,
              marginBottom: 14,
            }}
          >
            <select
              value={formSection}
              onChange={(e) => setFormSection(e.target.value)}
              style={{ ...input, cursor: "pointer" }}
            >
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.icon} {s.name}
                </option>
              ))}
            </select>
            <input
              style={input}
              placeholder={t("forum.titlePlaceholder")}
              value={title}
              maxLength={140}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              style={{
                ...input,
                minHeight: 110,
                resize: "vertical",
                fontFamily: "inherit",
              }}
              placeholder={t("forum.bodyPlaceholder")}
              value={body}
              maxLength={5000}
              onChange={(e) => setBody(e.target.value)}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="submit"
                disabled={busy}
                style={{ ...button, opacity: busy ? 0.6 : 1 }}
              >
                {t("forum.post")}
              </button>
              <button
                type="button"
                onClick={() => setComposing(false)}
                style={{
                  background: "transparent",
                  border: `1px solid ${theme.border}`,
                  color: theme.text,
                  borderRadius: 8,
                  padding: "7px 16px",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                {t("auth.cancel")}
              </button>
            </div>
          </form>
        )}

        {/* BOARD: grouped sections */}
        {!sel &&
          groups.map((g) => (
            <div key={g} style={{ marginBottom: 18 }}>
              <div
                style={{
                  fontSize: 12,
                  color: theme.muted,
                  textTransform: "uppercase",
                  letterSpacing: ".08em",
                  margin: "6px 2px",
                }}
              >
                {g}
              </div>
              <div style={{ ...card, padding: 0, overflow: "hidden" }}>
                {sections
                  .filter((s) => s.group === g)
                  .map((s, i, arr) => (
                    <div
                      key={s.id}
                      onClick={() => setSel(s.id)}
                      style={{
                        display: "flex",
                        gap: 14,
                        alignItems: "center",
                        padding: "14px 16px",
                        cursor: "pointer",
                        borderBottom:
                          i < arr.length - 1
                            ? `1px solid ${theme.border}`
                            : "none",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 26,
                          width: 38,
                          textAlign: "center",
                          flexShrink: 0,
                        }}
                      >
                        {s.icon}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 15,
                            color: theme.text,
                            fontWeight: 600,
                          }}
                        >
                          {s.name}
                        </div>
                        <div style={{ fontSize: 12.5, color: theme.muted }}>
                          {s.description}
                        </div>
                      </div>
                      <div
                        style={{
                          textAlign: "center",
                          minWidth: 64,
                          fontSize: 11,
                          color: theme.muted,
                          flexShrink: 0,
                        }}
                      >
                        <div
                          style={{
                            color: theme.accent,
                            fontWeight: 600,
                            fontSize: 14,
                          }}
                        >
                          {s.messages}
                        </div>
                        {t("forum.messages")}
                      </div>
                      <div
                        style={{
                          width: 168,
                          fontSize: 11.5,
                          color: theme.muted,
                          flexShrink: 0,
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        {s.lastPost ? (
                          <>
                            <Avatar
                              name={s.lastPost.author}
                              url={s.lastPost.authorAvatar}
                              size={28}
                            />
                            <div style={{ minWidth: 0 }}>
                              <div
                                style={{
                                  color: theme.text,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {s.lastPost.title}
                              </div>
                              <div>
                                {s.lastPost.author} ·{" "}
                                {new Date(s.lastPost.at).toLocaleDateString()}
                              </div>
                            </div>
                          </>
                        ) : (
                          <span>—</span>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          ))}

        {/* SECTION: thread list */}
        {sel && threads.length === 0 && (
          <div style={{ color: theme.muted, fontSize: 13 }}>
            {t("forum.empty")}
          </div>
        )}
        {sel &&
          threads.map((th) => (
            <Link
              key={th.id}
              href={threadHref(th.id)}
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 14px",
                  borderBottom: `1px solid ${theme.border}`,
                }}
              >
                <Avatar
                  name={th.author.name}
                  url={th.author.avatarUrl}
                  size={34}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, color: theme.text }}>
                    {th.pinned && "📌 "}
                    {th.locked && "🔒 "}
                    {th.title}
                  </div>
                  <div
                    style={{ fontSize: 12, color: theme.muted, marginTop: 3 }}
                  >
                    {th.author.name} ·{" "}
                    {new Date(th.lastActivityAt).toLocaleDateString()}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: theme.muted,
                    textAlign: "center",
                    minWidth: 54,
                  }}
                >
                  <div style={{ color: theme.accent, fontWeight: 600 }}>
                    {th.replies}
                  </div>
                  <div style={{ fontSize: 11 }}>{t("forum.replies")}</div>
                </div>
              </div>
            </Link>
          ))}
      </div>

      {/* LATEST sidebar — always on the right, sticky while scrolling */}
      <aside
        style={{
          flex: "0 0 290px",
          maxWidth: "100%",
          position: "sticky",
          top: 12,
          alignSelf: "flex-start",
        }}
      >
        <div style={card}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 4,
              color: theme.text,
            }}
          >
            {t("forum.latest")}
          </div>
          {latest.length === 0 && (
            <div style={{ color: theme.muted, fontSize: 12, paddingTop: 8 }}>
              {t("forum.empty")}
            </div>
          )}
          {latest.map((l) => (
            <Link
              key={l.id}
              href={threadHref(l.id)}
              style={{
                textDecoration: "none",
                color: "inherit",
                display: "flex",
                gap: 9,
                alignItems: "center",
                padding: "9px 0",
                borderTop: `1px solid ${theme.border}`,
              }}
            >
              <Avatar name={l.author} url={l.authorAvatar} size={30} />
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    color: theme.text,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {l.section.icon} {l.title}
                </div>
                <div style={{ fontSize: 11, color: theme.muted, marginTop: 2 }}>
                  {l.author} · {l.replies} {t("forum.replies")}
                </div>
              </div>
            </Link>
          ))}
        </div>
      </aside>
    </div>
  );
}
