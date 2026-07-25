"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, streamChat, streamAgent } from "../../../lib/api";
import { theme, input, button } from "../../../lib/ui";
import { useT } from "../../../lib/i18n";
import { Markdown } from "../../../components/Markdown";

const ACTIVE_KEY = "neurion_active_conv"; // last-open conversation, restored across tab switches

interface Approval {
  id: string;
  tool: string;
  args: any;
  resolved: boolean | null;
}
interface Msg {
  role: "user" | "assistant";
  content: string;
  badge?: {
    lane: string;
    provider: string;
    model: string;
    effectivePrivacy: string;
    labeled?: boolean;
  };
  cost?: number;
  agent?: boolean;
  trace?: string[];
  approval?: Approval | null;
  image?: string; // base64 data URL shown in the user bubble (vision)
  fileName?: string;
  knowledge?: {
    mode: "indexed" | "retrieved";
    documents: number;
    totalChunks: number;
    selectedChunks: number;
  };
}

interface PendingFile {
  name: string;
  type: string;
  size: number;
  content: string;
  data?: string;
  chunks?: string[];
  truncated?: boolean;
}

function ChatInner() {
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
  const cParam = params.get("c") || undefined;
  const isNew = params.get("new");

  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [convId, setConvId] = useState<string | undefined>(cParam);
  const [cwd, setCwd] = useState<string | undefined>();
  const [image, setImage] = useState<string | null>(null); // attached image (base64 data URL) for vision
  const [file, setFile] = useState<PendingFile | null>(null);
  const [fileError, setFileError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const refreshBalance = () =>
    api<{ balance: number }>("/credits/balance")
      .then((b) => setBalance(b.balance))
      .catch(() => undefined);

  useEffect(() => {
    void refreshBalance();
    void api<{ models: string[]; chatDefault: string | null }>("/ai/models")
      .then((r) => {
        setModels(r.models || []);
        const saved =
          typeof window !== "undefined"
            ? localStorage.getItem("neurion_model")
            : null;
        setModel(saved || r.chatDefault || (r.models?.[0] ?? ""));
      })
      .catch(() => undefined);
  }, []);

  // Restore the last-open conversation when arriving at /app/chat with no ?c (e.g. the
  // top-nav Chat tab). Chat is persisted server-side, so we just re-point the URL —
  // switching to Agent and back no longer looks like the conversation was lost.
  // "?new" (New session button) explicitly opts out and starts empty.
  useEffect(() => {
    if (isNew) {
      try {
        localStorage.removeItem(ACTIVE_KEY);
      } catch {
        /* ignore */
      }
      setConvId(undefined);
      setMessages([]);
      setCwd(undefined);
      router.replace("/app/chat");
      return;
    }
    if (!cParam) {
      const last =
        typeof window !== "undefined" ? localStorage.getItem(ACTIVE_KEY) : null;
      if (last) router.replace(`/app/chat?c=${last}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, cParam]);

  // load the conversation selected in the URL
  useEffect(() => {
    setConvId(cParam);
    if (!cParam) {
      setMessages([]);
      setCwd(undefined);
      return;
    }
    try {
      localStorage.setItem(ACTIVE_KEY, cParam);
    } catch {
      /* ignore */
    }
    void (async () => {
      try {
        const [msgs, conv, projs] = await Promise.all([
          api<any[]>(`/chat/conversations/${cParam}/messages`),
          api<any>(`/chat/conversations/${cParam}`),
          api<any[]>("/projects"),
        ]);
        setMessages(
          msgs
            .filter((m) => m.role === "USER" || m.role === "ASSISTANT")
            .map((m) => ({
              role: m.role === "ASSISTANT" ? "assistant" : "user",
              content: m.content,
            })),
        );
        setCwd(projs.find((p) => p.id === conv.projectId)?.path);
      } catch {
        // conversation gone (deleted elsewhere) — drop the stale pointer, show empty
        try {
          localStorage.removeItem(ACTIVE_KEY);
        } catch {
          /* ignore */
        }
        setMessages([]);
      }
    })();
  }, [cParam]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function patch(idx: number, fn: (a: Msg) => void) {
    setMessages((m) => {
      const c = [...m];
      if (c[idx]) fn(c[idx]);
      return c;
    });
  }
  function pickModel(v: string) {
    setModel(v);
    if (typeof window !== "undefined") localStorage.setItem("neurion_model", v);
  }
  async function respond(idx: number, id: string, approved: boolean) {
    patch(idx, (a) => {
      if (a.approval?.id === id)
        a.approval = { ...a.approval, resolved: approved };
    });
    await api("/agent/approve", {
      method: "POST",
      body: JSON.stringify({ id, approved }),
    }).catch(() => undefined);
  }

  // Stream an agent run into the assistant message at `idx` (file/shell tools, project cwd).
  async function streamAgentInto(idx: number, goal: string) {
    await streamAgent(
      goal,
      {
        onEvent: (event, d) =>
          patch(idx, (a) => {
            a.trace = a.trace ?? [];
            if (event === "agent.plan")
              a.trace.push(
                t("chat.agentTracePlan") +
                  d.steps.map((s: any) => s.text).join(" · "),
              );
            else if (event === "agent.tool_call")
              a.trace.push(
                `⚙ ${d.tool} ${JSON.stringify(d.args).slice(0, 80)}`,
              );
            else if (event === "agent.tool_result")
              a.trace.push(`⟵ ${String(d.result).slice(0, 110)}`);
            else if (event === "agent.subagent.start")
              a.trace.push(t("chat.agentTraceSubAgent") + d.goal);
            else if (event === "agent.approval_request")
              a.approval = {
                id: d.id,
                tool: d.tool,
                args: d.args,
                resolved: null,
              };
            else if (event === "agent.approval_result" && a.approval)
              a.approval = { ...a.approval, resolved: d.approved };
            else if (event === "agent.final") a.content = d.text;
            else if (event === "agent.error")
              a.content = t("chat.agentErrorPrefix", { message: d.message });
          }),
      },
      model || undefined,
      cwd,
    );
    void refreshBalance();
  }

  // Downscale to ≤1024px JPEG so vision payloads (and llava) stay fast + small.
  function pickImage(file: File) {
    setFile(null);
    setFileError("");
    const reader = new FileReader();
    reader.onload = () => {
      const img = new window.Image();
      img.onload = () => {
        const max = 1024;
        let w = img.width,
          h = img.height;
        if (w > max || h > max) {
          const s = max / Math.max(w, h);
          w = Math.round(w * s);
          h = Math.round(h * s);
        }
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d")?.drawImage(img, 0, 0, w, h);
        try {
          setImage(c.toDataURL("image/jpeg", 0.85));
        } catch {
          setImage(reader.result as string);
        }
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  }

  async function pickFile(selected: File) {
    setImage(null);
    setFileError("");
    const maxBytes = 5_000_000;
    if (selected.size > maxBytes) {
      setFileError(t("chat.fileTooLarge"));
      return;
    }
    const pdf =
      selected.type === "application/pdf" || /\.pdf$/i.test(selected.name);
    const textLike =
      /^text\//.test(selected.type) ||
      /\.(txt|md|csv|tsv|json|ya?ml|xml|html?|css|scss|js|jsx|ts|tsx|py|java|c|cpp|h|hpp|cs|go|rs|php|rb|sh|ps1|sql|log|ini|conf|toml)$/i.test(
        selected.name,
      );
    if (!pdf && !textLike) {
      setFileError(t("chat.fileUnsupported"));
      return;
    }
    try {
      if (pdf) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ""));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(selected);
        });
        setFile({
          name: selected.name,
          type: "application/pdf",
          size: selected.size,
          content: "",
          data,
        });
        return;
      }
      const raw = await selected.text();
      const chunkChars = 24_000;
      const maxChunks = 240;
      const capped = raw.slice(0, chunkChars * maxChunks);
      const chunks: string[] = [];
      for (let i = 0; i < capped.length; i += chunkChars)
        chunks.push(capped.slice(i, i + chunkChars));
      setFile({
        name: selected.name,
        type: selected.type || "text/plain",
        size: selected.size,
        content: chunks[0] ?? "",
        chunks: chunks.length > 1 ? chunks : undefined,
        truncated: raw.length > capped.length,
      });
    } catch {
      setFileError(t("chat.fileReadError"));
    }
  }

  async function send() {
    const msg = text.trim();
    if ((!msg && !image && !file) || busy) return;
    const img = image;
    const attached = file;
    setText("");
    setImage(null);
    setFile(null);
    setFileError("");
    setBusy(true);
    setMessages((m) => [
      ...m,
      {
        role: "user",
        content: msg || (attached ? t("chat.defaultFilePrompt") : ""),
        image: img ?? undefined,
        fileName: attached?.name,
      },
      {
        role: "assistant",
        content: "",
        agent: agentMode && !img && !attached,
        trace: [],
        approval: null,
      },
    ]);
    const idx = messages.length + 1;
    try {
      if (agentMode && !img && !attached) {
        await streamAgentInto(idx, msg);
      } else {
        await streamChat(
          {
            message:
              msg ||
              (attached
                ? t("chat.defaultFilePrompt")
                : "Descrivi questa immagine."),
            conversationId: convId,
            preferredModel: model || undefined,
            ...(img ? { image: img } : {}),
            ...(attached ? { file: attached } : {}),
          },
          {
            onEvent: (event, data) =>
              patch(idx, (a) => {
                if (event === "routing") a.badge = data;
                else if (event === "knowledge") a.knowledge = data;
                else if (event === "token") a.content += data.text;
                else if (event === "final") {
                  a.cost = data.costCredits;
                  if (data.conversationId && !convId) {
                    setConvId(data.conversationId);
                    try {
                      localStorage.setItem(ACTIVE_KEY, data.conversationId);
                    } catch {
                      /* ignore */
                    }
                    router.replace(`/app/chat?c=${data.conversationId}`);
                    window.dispatchEvent(new Event("neurion:sessions-changed"));
                  }
                  void refreshBalance();
                } else if (event === "error")
                  a.content = t("chat.chatErrorPrefix", {
                    message: data.message,
                  });
              }),
          },
        );
      }
    } catch (e) {
      patch(
        idx,
        (a) =>
          (a.content = t("chat.chatErrorPrefix", {
            message: (e as Error).message,
          })),
      );
    } finally {
      setBusy(false);
    }
  }

  // Quick action: analyze the bound project folder. Plain chat can't read files,
  // so this forces Agent mode (read-only) and runs a folder-scoped goal.
  async function analyzeFolder() {
    if (!cwd || busy) return;
    setAgentMode(true);
    setBusy(true);
    const goal = t("chat.analyzeFolderGoal", { cwd });
    setMessages((m) => [
      ...m,
      { role: "user", content: t("chat.analyzeFolderUserMsg") },
      {
        role: "assistant",
        content: "",
        agent: true,
        trace: [],
        approval: null,
      },
    ]);
    const idx = messages.length + 1;
    try {
      await streamAgentInto(idx, goal);
    } catch (e) {
      patch(
        idx,
        (a) =>
          (a.content = t("chat.chatErrorPrefix", {
            message: (e as Error).message,
          })),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 20 }}>
          {t("chat.headingChat")}
          {cwd ? (
            <span style={{ fontSize: 12, color: theme.muted, marginLeft: 10 }}>
              📂 {cwd}
            </span>
          ) : null}
        </h2>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <select
            value={model}
            onChange={(e) => pickModel(e.target.value)}
            style={{
              ...input,
              width: "auto",
              padding: "5px 8px",
              fontSize: 12,
            }}
          >
            {model && !models.includes(model) && (
              <option value={model}>{model}</option>
            )}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {cwd && (
            <button
              onClick={() => void analyzeFolder()}
              disabled={busy}
              title={t("chat.analyzeFolderButtonTitle", { cwd })}
              style={{
                background: "transparent",
                color: theme.accent,
                border: `1px solid ${theme.accent}`,
                borderRadius: 8,
                padding: "5px 10px",
                fontSize: 12,
                cursor: busy ? "default" : "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {t("chat.analyzeFolderButton")}
            </button>
          )}
          <button
            onClick={() => setAgentMode((v) => !v)}
            style={{
              background: agentMode ? theme.accent : "transparent",
              color: agentMode ? "var(--bg)" : theme.muted,
              border: `1px solid ${agentMode ? theme.accent : theme.border}`,
              borderRadius: 8,
              padding: "5px 10px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {agentMode ? t("chat.agentToggleOn") : t("chat.agentToggleOff")}
          </button>
          <div style={{ fontSize: 13, color: theme.muted }}>
            {t("chat.creditsLabel")}{" "}
            <span style={{ color: theme.text }}>{balance ?? "…"}</span>
          </div>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          paddingRight: 8,
        }}
      >
        {messages.length === 0 && (
          <div style={{ color: theme.muted, fontSize: 14 }}>
            {agentMode ? t("chat.emptyStateAgent") : t("chat.emptyStateChat")}
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "82%",
              width: m.agent ? "82%" : "auto",
            }}
          >
            {m.agent && m.trace && m.trace.length > 0 && (
              <div
                style={{
                  fontSize: 11,
                  color: theme.muted,
                  marginBottom: 6,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {m.trace.map((t, j) => (
                  <div
                    key={j}
                    style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                  >
                    {t}
                  </div>
                ))}
              </div>
            )}
            {m.approval && m.approval.resolved === null && (
              <div
                style={{
                  border: `1px solid ${theme.amber}`,
                  borderRadius: 10,
                  padding: "8px 12px",
                  marginBottom: 6,
                }}
              >
                <div
                  style={{ color: theme.amber, fontSize: 12, marginBottom: 6 }}
                >
                  {t("chat.approvalPrompt", { tool: m.approval.tool })}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: theme.muted,
                    marginBottom: 8,
                    wordBreak: "break-word",
                  }}
                >
                  {JSON.stringify(m.approval.args)}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    style={{ ...button, padding: "4px 12px" }}
                    onClick={() => void respond(i, m.approval!.id, true)}
                  >
                    {t("chat.approveButton")}
                  </button>
                  <button
                    style={{
                      background: "transparent",
                      border: `1px solid ${theme.border}`,
                      borderRadius: 8,
                      color: theme.text,
                      padding: "4px 12px",
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                    onClick={() => void respond(i, m.approval!.id, false)}
                  >
                    {t("chat.denyButton")}
                  </button>
                </div>
              </div>
            )}
            {(m.content || !m.agent) && (
              <div
                style={{
                  background: m.role === "user" ? theme.accent : theme.surface,
                  border:
                    m.role === "user" ? "none" : `1px solid ${theme.border}`,
                  color: m.role === "user" ? "var(--bg)" : theme.text,
                  borderRadius: 12,
                  padding: "10px 14px",
                  fontSize: m.role === "user" ? 14 : 15,
                  whiteSpace: m.role === "user" ? "pre-wrap" : "normal",
                  lineHeight: 1.5,
                }}
              >
                {m.fileName && (
                  <div
                    style={{
                      fontSize: 12,
                      fontFamily: "var(--font-mono)",
                      marginBottom: m.content ? 6 : 0,
                    }}
                  >
                    + {m.fileName}
                  </div>
                )}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {m.image && (
                  <img
                    src={m.image}
                    alt=""
                    style={{
                      maxWidth: 240,
                      borderRadius: 8,
                      display: "block",
                      marginBottom: m.content ? 8 : 0,
                    }}
                  />
                )}
                {m.content ? (
                  m.role === "assistant" ? (
                    <Markdown>{m.content}</Markdown>
                  ) : (
                    m.content
                  )
                ) : m.role === "assistant" && busy ? (
                  <Thinking label={t("chat.thinking")} />
                ) : (
                  ""
                )}
              </div>
            )}
            {m.badge && (
              <div
                style={{
                  fontSize: 11,
                  color: theme.muted,
                  marginTop: 4,
                  display: "flex",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    color:
                      m.badge.lane === "FALLBACK" ? theme.muted : theme.accent,
                  }}
                >
                  {m.badge.lane === "FALLBACK"
                    ? `💻 ${t("chat.laneLocal")}`
                    : `⚡ ${t("chat.laneNetwork")}`}
                </span>
                {m.badge.model && <span>{m.badge.model}</span>}
                {m.badge.labeled && <span>{t("chat.badgeMockSuffix")}</span>}
                {m.cost != null && m.cost > 0 && (
                  <span>{t("chat.badgeCostSuffix", { cost: m.cost })}</span>
                )}
              </div>
            )}
            {m.knowledge && (
              <div
                style={{
                  fontSize: 11,
                  color: theme.accent,
                  marginTop: 4,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {m.knowledge.mode === "retrieved"
                  ? t("chat.knowledgeLoaded", {
                      selected: m.knowledge.selectedChunks,
                      total: m.knowledge.totalChunks,
                    })
                  : t("chat.knowledgeIndexed", {
                      total: m.knowledge.totalChunks,
                    })}
              </div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {image && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 10,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image}
            alt=""
            style={{
              height: 56,
              borderRadius: 8,
              border: `1px solid ${theme.border}`,
            }}
          />
          <span style={{ fontSize: 12, color: theme.muted }}>
            {t("chat.imageAttached")}
          </span>
          <button
            onClick={() => setImage(null)}
            style={{
              background: "transparent",
              border: "none",
              color: theme.muted,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            ✕
          </button>
        </div>
      )}
      {file && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 10,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: 13,
              color: theme.text,
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            + {file.name}
          </span>
          <span style={{ fontSize: 12, color: theme.muted }}>
            {(file.size / 1_000_000).toFixed(1)} MB
            {file.truncated ? ` - ${t("chat.fileTruncated")}` : ""}
          </span>
          <button
            onClick={() => setFile(null)}
            title="Remove file"
            style={{
              background: "transparent",
              border: "none",
              color: theme.muted,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            x
          </button>
        </div>
      )}
      {fileError && (
        <div style={{ color: "#e0533d", fontSize: 12, marginTop: 8 }}>
          {fileError}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        {!agentMode && (
          <label
            title={t("chat.attachImage")}
            style={{
              ...button,
              background: "transparent",
              color: theme.muted,
              border: `1px solid ${theme.border}`,
              padding: "0 12px",
              display: "flex",
              alignItems: "center",
              cursor: "pointer",
              fontSize: 18,
            }}
          >
            🖼
            <input
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickImage(f);
                e.currentTarget.value = "";
              }}
            />
          </label>
        )}
        {!agentMode && (
          <label
            title={t("chat.attachFile")}
            style={{
              ...button,
              background: "transparent",
              color: theme.muted,
              border: `1px solid ${theme.border}`,
              padding: "0 12px",
              display: "flex",
              alignItems: "center",
              cursor: "pointer",
              fontSize: 18,
            }}
          >
            +
            <input
              type="file"
              accept=".pdf,text/*,.md,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.css,.scss,.js,.jsx,.ts,.tsx,.py,.java,.c,.cpp,.h,.hpp,.cs,.go,.rs,.php,.rb,.sh,.ps1,.sql,.log,.ini,.conf,.toml"
              style={{ display: "none" }}
              onChange={(e) => {
                const selected = e.target.files?.[0];
                if (selected) void pickFile(selected);
                e.currentTarget.value = "";
              }}
            />
          </label>
        )}
        <input
          style={input}
          placeholder={
            file
              ? t("chat.filePromptPlaceholder")
              : image
                ? t("chat.imagePromptPlaceholder")
                : agentMode
                  ? t("chat.inputPlaceholderAgent")
                  : t("chat.inputPlaceholderChat")
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
        />
        <button
          style={{ ...button, opacity: busy ? 0.6 : 1 }}
          onClick={() => void send()}
          disabled={busy}
        >
          {agentMode && !image && !file
            ? t("chat.sendButtonRun")
            : t("chat.sendButtonSend")}
        </button>
      </div>
    </div>
  );
}

// Animated "thinking" indicator: the label plus cycling dots, so it's obvious the
// assistant is working (instead of a static "…").
function Thinking({ label }: { label: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((v) => (v + 1) % 4), 400);
    return () => clearInterval(id);
  }, []);
  return (
    <span style={{ color: theme.muted, fontStyle: "italic" }}>
      {label}
      {".".repeat(n)}
      <span style={{ opacity: 0 }}>{".".repeat(3 - n)}</span>
    </span>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatInner />
    </Suspense>
  );
}
