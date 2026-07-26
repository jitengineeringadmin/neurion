"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { theme, card, input, button } from "../../lib/ui";
import { useT } from "../../lib/i18n";
import { Avatar } from "../Avatar";

interface Author {
  id: string;
  name: string;
  avatarUrl: string | null;
}
interface Post {
  id: string;
  body: string;
  createdAt: string;
  author: Author;
}
interface Thread {
  id: string;
  section: { id: string; name: string; icon: string };
  title: string;
  body: string;
  pinned: boolean;
  locked: boolean;
  createdAt: string;
  author: Author;
  posts: Post[];
}

export function ForumThread({
  canPost,
  backHref,
  loginHref,
}: {
  canPost: boolean;
  backHref: string;
  loginHref: string;
}) {
  const t = useT();
  const { user } = useAuth();
  const router = useRouter();
  const { id } = useParams();
  const tid = String(id);
  const [th, setTh] = useState<Thread | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const isMod = user?.role === "ADMIN" || user?.role === "SUPER_ADMIN";

  const load = () =>
    api<Thread>(`/forum/threads/${tid}`)
      .then(setTh)
      .catch(() => setTh(null));
  useEffect(() => {
    void load();
  }, [tid]);

  async function sendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!reply.trim()) return;
    setBusy(true);
    try {
      await api(`/forum/threads/${tid}/posts`, {
        method: "POST",
        body: JSON.stringify({ body: reply }),
      });
      setReply("");
      await load();
    } finally {
      setBusy(false);
    }
  }
  const delPost = async (pid: string) => {
    await api(`/forum/posts/${pid}`, { method: "DELETE" }).catch(
      () => undefined,
    );
    await load();
  };
  const delThread = async () => {
    await api(`/forum/threads/${tid}`, { method: "DELETE" }).catch(
      () => undefined,
    );
    router.push(backHref);
  };
  const moderate = async (d: { pinned?: boolean; locked?: boolean }) => {
    await api(`/forum/threads/${tid}`, {
      method: "PATCH",
      body: JSON.stringify(d),
    }).catch(() => undefined);
    await load();
  };

  if (!th) return <div style={{ color: theme.muted, padding: 20 }}>…</div>;
  const canDelThread = canPost && (th.author.id === user?.id || isMod);
  const meta = (a: Author, date: string) => (
    <div
      style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 8 }}
    >
      <Avatar name={a.name} url={a.avatarUrl} size={32} />
      <div style={{ fontSize: 12, color: theme.muted }}>
        <b style={{ color: theme.accent }}>{a.name}</b> ·{" "}
        {new Date(date).toLocaleString()}
      </div>
    </div>
  );

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ fontSize: 13, color: theme.muted, marginBottom: 8 }}>
        <Link
          href={backHref}
          style={{ color: theme.accent, textDecoration: "none" }}
        >
          {t("forum.title")}
        </Link>
        {" · "}
        {th.section.icon} {th.section.name}
      </div>
      <h1 style={{ margin: "0 0 12px", fontSize: 22 }}>
        {th.pinned && "📌 "}
        {th.locked && "🔒 "}
        {th.title}
      </h1>

      <div style={card}>
        {meta(th.author, th.createdAt)}
        <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.6 }}>
          {th.body}
        </div>
      </div>

      {(canDelThread || (canPost && isMod)) && (
        <div style={{ display: "flex", gap: 8, margin: "10px 0" }}>
          {canPost && isMod && (
            <button
              onClick={() => void moderate({ pinned: !th.pinned })}
              style={ghost}
            >
              {th.pinned ? t("forum.unpin") : t("forum.pin")}
            </button>
          )}
          {canPost && isMod && (
            <button
              onClick={() => void moderate({ locked: !th.locked })}
              style={ghost}
            >
              {th.locked ? t("forum.unlock") : t("forum.lock")}
            </button>
          )}
          {canDelThread && (
            <button
              onClick={() => void delThread()}
              style={{ ...ghost, color: "#e0533d", borderColor: "#e0533d" }}
            >
              {t("forum.deleteThread")}
            </button>
          )}
        </div>
      )}

      <h3
        style={{
          fontSize: 14,
          color: theme.muted,
          textTransform: "uppercase",
          letterSpacing: ".08em",
          margin: "22px 0 8px",
        }}
      >
        {th.posts.length} {t("forum.replies")}
      </h3>
      {th.posts.map((p) => (
        <div key={p.id} style={{ ...card, marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            {meta(p.author, p.createdAt)}
            {canPost && (p.author.id === user?.id || isMod) && (
              <button
                onClick={() => void delPost(p.id)}
                title={t("forum.delete")}
                style={{
                  background: "transparent",
                  border: "none",
                  color: theme.muted,
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                ✕
              </button>
            )}
          </div>
          <div
            style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.6 }}
          >
            {p.body}
          </div>
        </div>
      ))}

      {canPost ? (
        th.locked ? (
          <div style={{ color: theme.muted, fontSize: 13, marginTop: 12 }}>
            🔒 {t("forum.lockedNotice")}
          </div>
        ) : (
          <form
            onSubmit={sendReply}
            style={{
              marginTop: 12,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <textarea
              style={{
                ...input,
                minHeight: 90,
                resize: "vertical",
                fontFamily: "inherit",
              }}
              placeholder={t("forum.replyPlaceholder")}
              value={reply}
              maxLength={5000}
              onChange={(e) => setReply(e.target.value)}
            />
            <div>
              <button
                type="submit"
                style={{ ...button, opacity: busy ? 0.6 : 1 }}
                disabled={busy}
              >
                {t("forum.reply")}
              </button>
            </div>
          </form>
        )
      ) : (
        <div
          style={{
            marginTop: 16,
            padding: 14,
            border: `1px dashed ${theme.border}`,
            borderRadius: 12,
            textAlign: "center",
          }}
        >
          <span style={{ color: theme.muted, fontSize: 13 }}>
            {t("forum.loginToReply")}{" "}
          </span>
          <Link
            href={loginHref}
            style={{
              color: theme.accent,
              fontSize: 13,
              textDecoration: "none",
            }}
          >
            {t("forum.participate")} →
          </Link>
        </div>
      )}
    </div>
  );
}

const ghost: React.CSSProperties = {
  background: "transparent",
  border: `1px solid ${theme.border}`,
  color: theme.text,
  borderRadius: 8,
  padding: "5px 12px",
  fontSize: 12,
  cursor: "pointer",
};
