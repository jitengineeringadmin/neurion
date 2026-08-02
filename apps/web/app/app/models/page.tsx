"use client";
import { useEffect, useState } from "react";
import { api, streamSSE, getProdToken } from "../../../lib/api";
import { theme, button, input, ghostButton } from "../../../lib/ui";
import { useT } from "../../../lib/i18n";
import { useAuth } from "../../../lib/auth";

interface Installed {
  name: string;
  sizeBytes: number | null;
}
interface Reco {
  name: string;
  label: string;
  size: string;
  note: string;
  group: string;
}
interface Quant {
  tag: string;
  hint: string;
}
interface Pulling {
  name: string;
  percent: number | null;
  status: string;
}
interface MemoryProfile {
  hardware: {
    gpu: { name: string; totalBytes: number; freeBytes: number } | null;
    ram: { totalBytes: number; freeBytes: number };
    disk: {
      path: string | null;
      totalBytes: number | null;
      freeBytes: number | null;
    };
  };
  plan: null | {
    mode: "gpu" | "hybrid_offload" | "cpu_mmap" | "not_recommended";
    reason: string;
    estimatedWorkingSetBytes: number;
    quantization: string;
    recommendedQuantization: string | null;
    runtimeHints: {
      memoryMap: boolean;
      gpuLayers: string;
      kvCacheType: string;
      suggestedContextTokens: number;
    };
  };
}
interface NodeApi {
  status: () => Promise<{
    running: boolean;
    registered: boolean;
    available: boolean;
  }>;
  start: (creds?: {
    email?: string;
    password?: string;
    token?: string;
  }) => Promise<{ ok: boolean; error?: string; running?: boolean }>;
  stop: () => Promise<{ ok: boolean }>;
}

const fmt = (b: number | null) => (b ? `${(b / 1e9).toFixed(1)} GB` : "");

export default function ModelsPage() {
  const t = useT();
  const { user } = useAuth();
  const [engine, setEngine] = useState<"up" | "down" | "…">("…");
  // Neurion's own engine. Without this the page told a user with no ollama to
  // go and install one — while the app already ships an engine it can set up
  // itself.
  const [bundled, setBundled] = useState<{
    state: string;
    modelId?: string;
    label?: string;
    path?: string;
    models?: Array<{
      installed?: boolean;
      id: string;
      label: string;
      sizeBytes: number;
      description: string;
      recommended: boolean;
    }>;
  } | null>(null);
  const [bundledBusy, setBundledBusy] = useState<{
    stage: string;
    percent: number;
  } | null>(null);
  const [bundledErr, setBundledErr] = useState("");
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [reco, setReco] = useState<Reco[]>([]);
  const [quants, setQuants] = useState<Quant[]>([{ tag: "", hint: "" }]);
  const [quant, setQuant] = useState("");
  const [pulling, setPulling] = useState<Pulling | null>(null);
  const [def, setDef] = useState<string>("");
  const [sel, setSel] = useState("");
  const [search, setSearch] = useState("");
  const [err, setErr] = useState("");
  const [memory, setMemory] = useState<{
    name: string;
    profile: MemoryProfile;
  } | null>(null);
  const [memoryBusy, setMemoryBusy] = useState("");
  const nodeApi: NodeApi | null =
    typeof window !== "undefined"
      ? ((window as unknown as { neurion?: { node?: NodeApi } }).neurion
          ?.node ?? null)
      : null;
  const [nodeSt, setNodeSt] = useState<{
    running: boolean;
    registered: boolean;
    available: boolean;
  } | null>(null);
  const [nEmail, setNEmail] = useState("");
  const [nPass, setNPass] = useState("");
  const [nErr, setNErr] = useState("");
  const [nBusy, setNBusy] = useState(false);
  // "Take the model from this folder" — always reachable, never buried inside
  // an error state. askPath is the no-native-dialog fallback.
  const [askPath, setAskPath] = useState(false);
  // Only offered when the desktop shell can actually do it. In a browser there
  // is no way to start a local program, so the control must not appear.
  const [canStartOllama, setCanStartOllama] = useState(false);
  const [canOpenFolder, setCanOpenFolder] = useState(false);
  const [localFolders, setLocalFolders] = useState<string[]>([]);
  const [peerInfo, setPeerInfo] = useState<{
    enabled: boolean;
    sharing: number;
    offeredByPeers: number;
    served: number;
    me?: string;
    seeds?: string[];
    compute?: boolean;
    computed?: number;
    /** This machine's place in the distributed index. */
    index?: { nodes: number; records: number; joined: boolean };
    peers: Array<{ address: string; models: number }>;
  } | null>(null);
  const [localFound, setLocalFound] = useState<
    Array<{
      path: string;
      name: string;
      sizeBytes: number;
      inUse: boolean;
      split: boolean;
    }>
  >([]);
  const [startingOllama, setStartingOllama] = useState(false);
  const [localPath, setLocalPath] = useState("");

  // Either engine counts. Reporting only ollama told a user with Neurion's own
  // engine running that no engine was running.
  const anyEngineUp = engine === "up" || bundled?.state === "ready";

  const load = async () => {
    const inst = await api<{ engine: string; installed: Installed[] }>(
      "/ai/models/installed",
    ).catch(() => ({ engine: "down", installed: [] as Installed[] }));
    setEngine(inst.engine === "up" ? "up" : "down");
    setInstalled(inst.installed);
    // Asked for unconditionally. Gating this on "ollama is absent" meant that a
    // machine with ollama running could never be told that Neurion's own engine
    // was up, nor which model it had loaded.
    {
      setBundled(
        await api<{
          state: string;
          modelId?: string;
          label?: string;
          path?: string;
          models?: Array<{
            id: string;
            label: string;
            sizeBytes: number;
            description: string;
            recommended: boolean;
          }>;
        }>("/ai/engine/status").catch(() => null),
      );
    }
  };

  type LocalScan = {
    folders: string[];
    models: Array<{
      path: string;
      name: string;
      sizeBytes: number;
      inUse: boolean;
      split: boolean;
    }>;
  };
  const applyScan = (r: LocalScan | null): void => {
    if (!r) return;
    setLocalFolders(r.folders ?? []);
    setLocalFound(r.models ?? []);
  };

  /** Lend this machine's processor to other people, or stop. */
  async function setSharing(on: boolean) {
    setBundledErr("");
    try {
      await api("/ai/engine/sharing", {
        method: "POST",
        body: JSON.stringify({ enabled: on }),
      });
      await loadPeers();
    } catch (e) {
      setBundledErr((e as Error).message);
    }
  }

  async function setCompute(on: boolean) {
    setBundledErr("");
    try {
      await api("/ai/engine/compute", {
        method: "POST",
        body: JSON.stringify({ enabled: on }),
      });
      await loadPeers();
    } catch (e) {
      setBundledErr((e as Error).message);
    }
  }

  /** Add a peer by address — a friend on another network, with no registry. */
  async function addSeed() {
    const entry = window.prompt(t("models.addPeerPrompt"))?.trim();
    if (!entry) return;
    setBundledErr("");
    try {
      await api("/ai/engine/seeds", {
        method: "POST",
        body: JSON.stringify({ address: entry }),
      });
      await loadPeers();
    } catch (e) {
      setBundledErr((e as Error).message);
    }
  }

  /** Who else on this network is sharing, and what we are giving back. */
  async function loadPeers() {
    setPeerInfo(
      await api<{
        enabled: boolean;
        sharing: number;
        offeredByPeers: number;
        served: number;
        me?: string;
        seeds?: string[];
        compute?: boolean;
        computed?: number;
        index?: { nodes: number; records: number; joined: boolean };
        peers: Array<{ address: string; models: number }>;
      }>("/ai/engine/peers").catch(() => null),
    );
  }

  /** Everything Neurion can see across its own folder and the user's. */
  async function loadLocalModels() {
    applyScan(
      await api<LocalScan>("/ai/engine/local-models").catch(() => null),
    );
  }

  /** Point Neurion at a folder full of models, using the native picker. */
  async function addFolder() {
    const shell = (
      window as unknown as {
        neurion?: { pickFolder?: (i?: string) => Promise<{ path?: string }> };
      }
    ).neurion;
    setBundledErr("");
    let chosen = "";
    if (shell?.pickFolder) {
      const picked = await shell.pickFolder().catch(() => ({ path: "" }));
      chosen = picked?.path ?? "";
    } else {
      // No native dialog (a browser): fall back to typing the path, same as
      // the single-file case.
      chosen = window.prompt(t("models.addFolder")) ?? "";
    }
    if (!chosen.trim()) return;
    try {
      applyScan(
        await api<LocalScan>("/ai/engine/folders", {
          method: "POST",
          body: JSON.stringify({ path: chosen.trim() }),
        }),
      );
    } catch (e) {
      setBundledErr((e as Error).message);
    }
  }

  async function removeFolder(folder: string) {
    try {
      applyScan(
        await api<LocalScan>("/ai/engine/folders", {
          method: "DELETE",
          body: JSON.stringify({ path: folder }),
        }),
      );
    } catch (e) {
      setBundledErr((e as Error).message);
    }
  }

  /** Open Neurion's own models folder so files can be dropped in by hand. */
  async function openModelsFolder() {
    const shell = (
      window as unknown as {
        neurion?: { openModelsFolder?: () => Promise<unknown> };
      }
    ).neurion;
    await shell?.openModelsFolder?.();
  }

  /** Start a local ollama the user already installed, then let the poll notice. */
  async function startOllama() {
    const shell = (
      window as unknown as {
        neurion?: { startOllama?: () => Promise<{ ok: boolean }> };
      }
    ).neurion;
    if (!shell?.startOllama) return;
    setStartingOllama(true);
    try {
      await shell.startOllama();
      await load();
    } catch {
      /* the banner keeps saying what is wrong */
    } finally {
      setStartingOllama(false);
    }
  }

  /**
   * Run a GGUF the user already has. The desktop shell opens the file picker,
   * because a browser can hand back file contents but never a real path, and
   * the engine needs the path — nothing is copied.
   */
  async function useLocalModel(typedPath?: string) {
    const shell = (
      window as unknown as {
        neurion?: { pickModel?: () => Promise<{ path: string | null }> };
      }
    ).neurion;
    setBundledErr("");
    let chosen = typedPath?.trim() ?? "";
    if (!chosen) {
      // No native dialog (browser, or a shell without the handler): let the
      // path be typed instead of silently doing nothing.
      if (!shell?.pickModel) {
        setAskPath(true);
        return;
      }
      const picked = await shell.pickModel().catch(() => ({ path: null }));
      chosen = picked?.path ?? "";
    }
    if (!chosen) return;
    setAskPath(false);
    setBundledBusy({ stage: "starting", percent: 100 });
    try {
      await api("/ai/engine/use-local", {
        method: "POST",
        body: JSON.stringify({ path: chosen }),
      });
      await load();
      await loadLocalModels();
    } catch (e) {
      setBundledErr((e as Error).message);
    } finally {
      setBundledBusy(null);
    }
  }

  /** Install and start Neurion's own engine, reporting progress as it goes. */
  async function setupBundled(modelId: string) {
    if (bundledBusy) return;
    setBundledErr("");
    setBundledBusy({ stage: "engine", percent: 0 });
    try {
      await streamSSE(
        "/ai/engine/setup",
        { modelId },
        {
          onEvent: (event, d) => {
            if (event === "progress")
              setBundledBusy({
                stage: d.stage ?? "",
                percent: d.percent ?? 0,
              });
            else if (event === "done") {
              setBundledBusy(null);
              void load();
            } else if (event === "error") {
              setBundledErr(d.message || "setup failed");
              setBundledBusy(null);
            }
          },
        },
      );
    } catch (e) {
      setBundledErr((e as Error).message);
      setBundledBusy(null);
    }
  }
  // The engine state was read once, at mount, and never again. Start ollama a
  // minute later — or let the API restart — and this page went on insisting no
  // engine was running, with a Download button that could not work and no way to
  // ask again. Re-check while it looks down, and whenever the window is focused,
  // which is exactly the moment someone comes back from starting it.
  useEffect(() => {
    if (engine !== "down") return;
    const again = () => void load();
    const id = setInterval(again, 5000);
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  useEffect(() => {
    setCanStartOllama(
      typeof window !== "undefined" &&
        (window as unknown as { neurion?: { startOllama?: unknown } }).neurion
          ?.startOllama != null,
    );
    setCanOpenFolder(
      typeof window !== "undefined" &&
        (window as unknown as { neurion?: { openModelsFolder?: unknown } })
          .neurion?.openModelsFolder != null,
    );
    void loadLocalModels();
    void loadPeers();
    // Peers come and go — a laptop closing mid-transfer is the normal case.
    const id = setInterval(() => void loadPeers(), 15000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
    void api<{ recommended: Reco[]; quants?: Quant[] }>(
      "/ai/models/recommended",
    )
      .then((r) => {
        setReco(r.recommended);
        if (r.quants?.length) setQuants(r.quants);
      })
      .catch(() => undefined);
    if (typeof window !== "undefined")
      setDef(localStorage.getItem("neurion_model") || "");
    if (user?.email) setNEmail(user.email); // you're logged in — don't make you retype it
  }, [user?.email]);

  async function download(base: string, q: string) {
    if (pulling) return;
    setErr("");
    const name = q ? `${base}-${q}` : base;
    setPulling({ name, percent: 0, status: t("models.statusStarting") });
    try {
      await streamSSE(
        "/ai/models/pull",
        { name: base, quant: q },
        {
          onEvent: (event, d) => {
            if (event === "progress")
              setPulling({
                name,
                percent: d.percent ?? null,
                status: d.status ?? "",
              });
            else if (event === "done") {
              void load();
              setPulling(null);
            } else if (event === "error") {
              setErr(d.message || t("models.errDownloadFailed"));
              setPulling(null);
            }
          },
        },
      );
    } catch (e) {
      setErr((e as Error).message);
      setPulling(null);
    }
  }

  function makeDefault(name: string) {
    setDef(name);
    if (typeof window !== "undefined")
      localStorage.setItem("neurion_model", name);
  }

  async function inspectMemory(name: string) {
    setMemoryBusy(name);
    try {
      const profile = await api<MemoryProfile>(
        `/ai/models/memory-profile?name=${encodeURIComponent(name)}`,
      );
      setMemory({ name, profile });
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setMemoryBusy("");
    }
  }

  useEffect(() => {
    if (!nodeApi) return;
    let alive = true;
    const tick = () =>
      void nodeApi
        .status()
        .then((s) => alive && setNodeSt(s))
        .catch(() => undefined);
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function nodeStart() {
    if (!nodeApi) return;
    setNErr("");
    setNBusy(true);
    try {
      // Already registered → just start. Else prefer the signed-in token (no password
      // re-entry); fall back to the form only if there's no session.
      const creds = nodeSt?.registered
        ? undefined
        : getProdToken()
          ? { token: getProdToken() as string }
          : { email: nEmail, password: nPass };
      const r = await nodeApi.start(creds);
      if (!r.ok) setNErr(r.error || t("models.errDownloadFailed"));
      setNodeSt(await nodeApi.status());
    } catch (e) {
      setNErr((e as Error).message);
    } finally {
      setNBusy(false);
    }
  }
  async function nodeStop() {
    if (!nodeApi) return;
    setNBusy(true);
    try {
      await nodeApi.stop();
      setNodeSt(await nodeApi.status());
    } finally {
      setNBusy(false);
    }
  }

  const has = (name: string) =>
    installed.some(
      (m) =>
        m.name === name ||
        m.name.startsWith(name + ":") ||
        m.name === name + ":latest",
    );

  return (
    <div style={{ maxWidth: 880 }}>
      <h2 style={{ margin: "0 0 6px", fontSize: 20 }}>
        {t("models.pageTitle")}
      </h2>
      <p style={{ color: theme.muted, fontSize: 13, marginTop: 0 }}>
        {t("models.pageSubtitle")}
      </p>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 13,
          margin: "14px 0",
        }}
      >
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: 9,
            background: anyEngineUp
              ? theme.accent
              : engine === "down"
                ? "#e0533d"
                : theme.muted,
          }}
        />
        <span style={{ color: theme.muted }}>
          {t("models.localEngineLabel")}{" "}
          <b style={{ color: theme.text }}>
            {engine === "up"
              ? t("models.engineUp")
              : bundled?.state === "ready"
                ? t("models.engineUpBundled")
                : engine === "down"
                  ? t("models.engineDown")
                  : "…"}
          </b>
        </span>
      </div>
      {/* Neurion's own models. This is the answer to "what do I do on a PC that
          has never heard of ollama": everything here is downloaded and run by
          Neurion itself. It is shown whenever the bundled engine can run on this
          platform, not only while nothing is installed yet — otherwise the first
          model a user installs hides every other model they could get. */}
      {bundled &&
        bundled.state !== "unsupported" &&
        (bundled.models?.length ?? 0) > 0 && (
          <div style={{ marginBottom: 20 }}>
            <h3
              style={{
                fontSize: 14,
                color: theme.muted,
                textTransform: "uppercase",
                letterSpacing: ".08em",
                margin: "0 0 4px",
              }}
            >
              {t("models.neurionCatalogTitle")}
            </h3>
            <p
              style={{
                color: theme.muted,
                fontSize: 12,
                margin: "0 0 10px",
                lineHeight: 1.5,
              }}
            >
              {t("models.neurionCatalogBody")}
            </p>

            {bundledBusy ? (
              <div
                style={{
                  border: `1px solid ${theme.accent}`,
                  borderRadius: 10,
                  padding: 14,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 12,
                    marginBottom: 6,
                  }}
                >
                  <span style={{ color: theme.muted }}>
                    {bundledBusy.stage}
                  </span>
                  <span style={{ color: theme.accent }}>
                    {bundledBusy.percent}%
                  </span>
                </div>
                <div
                  style={{
                    height: 8,
                    background: "var(--surface-2)",
                    borderRadius: 6,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${Math.max(3, bundledBusy.percent)}%`,
                      background: theme.accent,
                      transition: "width .3s",
                    }}
                  />
                </div>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {bundled.models?.map((m) => {
                  const running =
                    bundled.state === "ready" && bundled.modelId === m.id;
                  return (
                    <div
                      key={m.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        border: `1px solid ${running ? theme.accent : theme.border}`,
                        borderRadius: 10,
                        padding: "10px 12px",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>
                          {m.label}
                          {m.recommended && (
                            <span
                              style={{
                                color: theme.accent,
                                fontSize: 11,
                                marginLeft: 8,
                              }}
                            >
                              ★ {t("models.recommendedTag")}
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            color: theme.muted,
                            fontSize: 12,
                            lineHeight: 1.45,
                          }}
                        >
                          {m.description}
                        </div>
                      </div>
                      <div
                        style={{
                          color: theme.muted,
                          fontSize: 12,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {fmt(m.sizeBytes)}
                      </div>
                      {running ? (
                        <span
                          style={{
                            color: theme.accent,
                            fontSize: 12,
                            whiteSpace: "nowrap",
                          }}
                        >
                          ✓ {t("models.inUse")}
                        </span>
                      ) : (
                        <button
                          style={{
                            ...(m.installed ? ghostButton : button),
                            padding: "7px 14px",
                            whiteSpace: "nowrap",
                          }}
                          onClick={() => void setupBundled(m.id)}
                        >
                          {m.installed
                            ? t("models.useThisOne")
                            : `⬇ ${t("models.downloadButton")}`}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {/* Sharing nobody can see is sharing nobody believes in. This is
                also the honest answer to "what happens if the servers go
                dark": these models came from, or can go to, the machine next
                door. */}
            {peerInfo?.enabled && (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 12,
                  color: theme.muted,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 7,
                    background:
                      peerInfo.peers.length > 0 ? theme.accent : theme.muted,
                    flex: "0 0 auto",
                  }}
                />
                <span>
                  {t("models.sharingCount").replace(
                    "{n}",
                    String(peerInfo.sharing),
                  )}
                </span>
                <span>·</span>
                <span>
                  {peerInfo.peers.length > 0
                    ? t("models.peersFound")
                        .replace("{n}", String(peerInfo.peers.length))
                        .replace("{m}", String(peerInfo.offeredByPeers))
                    : t("models.noPeers")}
                </span>
                {/* The only thing a volunteer gets back, and what has to stand
                    where a payment would have been. */}
                {peerInfo.served > 0 && (
                  <>
                    <span>·</span>
                    <span style={{ color: theme.accent }}>
                      {t("models.servedCount").replace(
                        "{n}",
                        String(peerInfo.served),
                      )}
                    </span>
                  </>
                )}
                {/* Reach beyond the neighbourhood. Worth showing separately
                    from the peer count: these are machines this one can route
                    to without ever having met them. */}
                {(peerInfo.index?.nodes ?? 0) > 0 && (
                  <>
                    <span>·</span>
                    <span>
                      {t("models.indexNodes").replace(
                        "{n}",
                        String(peerInfo.index!.nodes),
                      )}
                    </span>
                  </>
                )}
                <span>·</span>
                {/* Leaving this on lists this machine's address where people
                    look for models, which is more than it used to mean. That
                    makes it something a person has to be able to switch off in
                    one click, not only through an environment variable. */}
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    cursor: "pointer",
                  }}
                  title={t("models.shareWeightsHint")}
                >
                  <input
                    type="checkbox"
                    checked={peerInfo.enabled}
                    onChange={(e) => void setSharing(e.target.checked)}
                    style={{ cursor: "pointer" }}
                  />
                  {t("models.shareWeights")}
                </label>
                <span>·</span>
                {/* Passing on a file costs nothing; running somebody's prompt
                    takes this machine's processor and slows the owner's own
                    work. So it is a switch, not a default. */}
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!!peerInfo.compute}
                    onChange={(e) => void setCompute(e.target.checked)}
                    style={{ cursor: "pointer" }}
                  />
                  {t("models.lendCompute")}
                  {peerInfo.computed ? ` (${peerInfo.computed})` : ""}
                </label>
                <span>·</span>
                {/* Reaching somebody outside this network needs no registry and
                    no account — only their address, once. */}
                <button
                  onClick={() => void addSeed()}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: theme.muted,
                    cursor: "pointer",
                    fontSize: 12,
                    textDecoration: "underline",
                    padding: 0,
                  }}
                >
                  {t("models.addPeer")}
                  {peerInfo.seeds?.length ? ` (${peerInfo.seeds.length})` : ""}
                </button>
              </div>
            )}
            {bundledErr && (
              <div style={{ color: theme.red, fontSize: 12, marginTop: 10 }}>
                ⚠ {bundledErr}
              </div>
            )}
          </div>
        )}

      {/* Pointing Neurion at a model you already have is a first-class action,
          not a consolation prize for a missing ollama. It used to appear only
          inside the "no engine" banner, so anyone with a working setup could
          never reach it. */}
      <div
        style={{
          border: `1px solid ${theme.border}`,
          borderRadius: 10,
          padding: 14,
          fontSize: 13,
          marginBottom: 16,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          📂 {t("models.localFileTitle")}
        </div>
        <div style={{ color: theme.muted, marginBottom: 12 }}>
          {t("models.localFileBody")}
        </div>
        {bundled?.state === "ready" && bundled.modelId === "local" && (
          <div style={{ color: theme.accent, marginBottom: 10 }}>
            ✓ {t("models.localFileActive")}
            {bundled.label ? ` — ${bundled.label}` : ""}
            {/* The full path, small and quiet: enough to tell two files with
                the same name apart. */}
            {bundled.path && (
              <div
                style={{
                  color: theme.muted,
                  fontSize: 11,
                  marginTop: 2,
                  wordBreak: "break-all",
                }}
              >
                {bundled.path}
              </div>
            )}
          </div>
        )}
        {askPath ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              placeholder={t("models.localPathPlaceholder")}
              style={{ ...input, flex: "1 1 320px", minWidth: 0 }}
            />
            <button
              style={{ ...button, padding: "8px 16px" }}
              disabled={!localPath.trim() || !!bundledBusy}
              onClick={() => void useLocalModel(localPath)}
            >
              {t("models.useLocalConfirm")}
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              style={{ ...ghostButton, padding: "9px 18px" }}
              disabled={!!bundledBusy}
              onClick={() => void useLocalModel()}
            >
              {t("models.useLocalFile")}
            </button>
            {/* A whole folder, not one file: people keep several models
                together, and picking them one at a time is not how anyone
                organises a disk. */}
            <button
              style={{ ...ghostButton, padding: "9px 18px" }}
              disabled={!!bundledBusy}
              onClick={() => void addFolder()}
            >
              {t("models.addFolder")}
            </button>
            {canOpenFolder && (
              <button
                style={{ ...ghostButton, padding: "9px 18px" }}
                onClick={() => void openModelsFolder()}
              >
                {t("models.openModelsFolder")}
              </button>
            )}
          </div>
        )}
        {/* Folders the user pointed us at, and everything found inside them.
            Nothing is copied: a model is used where it already lies. */}
        {localFolders.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: theme.muted, marginBottom: 6 }}>
              {t("models.watchedFolders")}
            </div>
            <div style={{ display: "grid", gap: 4, marginBottom: 10 }}>
              {localFolders.map((f, i) => (
                <div
                  key={f}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 11,
                    color: theme.muted,
                    wordBreak: "break-all",
                  }}
                >
                  <span style={{ flex: 1 }}>{f}</span>
                  {i === 0 ? (
                    // Neurion's own folder: it holds the downloads, so it is not
                    // removable — but it IS the one to drop files into.
                    <span style={{ color: theme.accent, whiteSpace: "nowrap" }}>
                      {t("models.neurionFolder")}
                    </span>
                  ) : (
                    <button
                      onClick={() => void removeFolder(f)}
                      style={{
                        ...ghostButton,
                        padding: "2px 8px",
                        fontSize: 11,
                      }}
                    >
                      {t("models.removeFolder")}
                    </button>
                  )}
                </div>
              ))}
            </div>

            {localFound.length > 0 ? (
              <div style={{ display: "grid", gap: 6 }}>
                {localFound.map((m) => (
                  <div
                    key={m.path}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      border: `1px solid ${m.inUse ? theme.accent : theme.border}`,
                      borderRadius: 8,
                      padding: "8px 10px",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12 }}>{m.name}</div>
                      <div
                        style={{
                          fontSize: 10,
                          color: theme.muted,
                          wordBreak: "break-all",
                        }}
                      >
                        {m.path}
                      </div>
                    </div>
                    <span
                      style={{
                        fontSize: 11,
                        color: theme.muted,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {fmt(m.sizeBytes)}
                    </span>
                    {m.inUse ? (
                      <span
                        style={{
                          fontSize: 11,
                          color: theme.accent,
                          whiteSpace: "nowrap",
                        }}
                      >
                        ✓ {t("models.inUse")}
                      </span>
                    ) : m.split ? (
                      // A later part of a split model cannot be loaded alone.
                      <span
                        style={{
                          fontSize: 11,
                          color: theme.amber,
                          whiteSpace: "nowrap",
                        }}
                        title={t("models.splitModel")}
                      >
                        {t("models.splitModel")}
                      </span>
                    ) : (
                      <button
                        onClick={() => void useLocalModel(m.path)}
                        disabled={!!bundledBusy}
                        style={{
                          ...ghostButton,
                          padding: "5px 12px",
                          fontSize: 12,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {t("models.useThisOne")}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: theme.muted }}>
                {t("models.noModelsInFolders")}
              </div>
            )}
          </div>
        )}
        {bundledErr && (
          <div style={{ color: theme.red, fontSize: 12, marginTop: 10 }}>
            ⚠ {bundledErr}
          </div>
        )}
      </div>

      {/* No ollama, but Neurion can install its own engine: offer that instead
          of sending the user off to fetch a second program. */}
      {engine === "down" &&
        bundled &&
        bundled.state !== "ready" &&
        (() => {
          const pick =
            bundled.models?.find((m) => m.recommended) ?? bundled.models?.[0];
          return (
            <div
              style={{
                border: `1px solid ${theme.accent}`,
                borderRadius: 10,
                padding: 14,
                fontSize: 13,
                color: theme.text,
                marginBottom: 16,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                ⚡ {t("models.bundledTitle")}
              </div>
              <div style={{ color: theme.muted, marginBottom: 12 }}>
                {t("models.bundledBody")}
              </div>
              {bundledBusy ? (
                <div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 12,
                      marginBottom: 6,
                    }}
                  >
                    <span style={{ color: theme.muted }}>
                      {bundledBusy.stage}
                    </span>
                    <span style={{ color: theme.accent }}>
                      {bundledBusy.percent}%
                    </span>
                  </div>
                  <div
                    style={{
                      height: 8,
                      background: "var(--surface-2)",
                      borderRadius: 6,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${Math.max(3, bundledBusy.percent)}%`,
                        background: theme.accent,
                        transition: "width .3s",
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  {pick && (
                    <button
                      style={{ ...button, padding: "9px 18px" }}
                      onClick={() => void setupBundled(pick.id)}
                    >
                      ⬇ {pick.label} · {fmt(pick.sizeBytes)}
                    </button>
                  )}
                </div>
              )}
              {bundledErr && (
                <div style={{ color: theme.red, fontSize: 12, marginTop: 10 }}>
                  ⚠ {bundledErr}
                </div>
              )}
            </div>
          );
        })()}
      {/* Fallback for a build with no bundled engine (hosted, or an
          unsupported platform): the old prompt still applies there. */}
      {engine === "down" &&
        (!bundled || bundled.state === "unsupported") &&
        (() => {
          const parts = t("models.engineDownBanner").split("{link}");
          return (
            <div
              style={{
                border: `1px solid ${theme.amber}`,
                borderRadius: 10,
                padding: 12,
                fontSize: 13,
                color: theme.text,
                marginBottom: 16,
              }}
            >
              {parts[0]}
              <a
                href="https://ollama.com/download"
                target="_blank"
                rel="noreferrer"
                style={{ color: theme.accent }}
              >
                {t("models.ollamaLinkText")}
              </a>
              {parts[1]}
            </div>
          );
        })()}
      {err && (
        <div style={{ color: "#e0533d", fontSize: 13, marginBottom: 12 }}>
          ⚠ {err}
        </div>
      )}

      {pulling && (
        <div
          style={{
            border: `1px solid ${theme.accent}`,
            borderRadius: 12,
            padding: 14,
            marginBottom: 18,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 13,
              marginBottom: 8,
            }}
          >
            <span>
              ⬇ {t("models.downloadingPrefix")} <b>{pulling.name}</b> —{" "}
              {pulling.status}
            </span>
            <span style={{ color: theme.accent }}>
              {pulling.percent != null ? pulling.percent + "%" : ""}
            </span>
          </div>
          <div
            style={{
              height: 8,
              background: theme.surface,
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: (pulling.percent ?? 4) + "%",
                background: theme.accent,
                transition: "width .3s",
              }}
            />
          </div>
        </div>
      )}

      <h3
        style={{
          fontSize: 14,
          color: theme.muted,
          textTransform: "uppercase",
          letterSpacing: ".08em",
          margin: "8px 0",
        }}
      >
        {t("models.recommendedHeading")}
      </h3>
      {(() => {
        const groups = reco.reduce<string[]>(
          (acc, r) => (acc.includes(r.group) ? acc : [...acc, r.group]),
          [],
        );
        const selModel = reco.find((m) => m.name === sel) || null;
        const q = search.trim().toLowerCase();
        const matches = q
          ? reco.filter((m) =>
              (m.label + " " + m.name + " " + m.note + " " + m.group)
                .toLowerCase()
                .includes(q),
            )
          : [];
        return (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              maxWidth: 520,
            }}
          >
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("models.searchPlaceholder")}
              style={{ ...input }}
            />
            {q ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  maxHeight: 260,
                  overflowY: "auto",
                  border: `1px solid ${theme.border}`,
                  borderRadius: 10,
                  padding: 6,
                }}
              >
                {matches.length === 0 && (
                  <div style={{ fontSize: 13, color: theme.muted, padding: 8 }}>
                    {t("models.noMatch")}
                  </div>
                )}
                {matches.map((m) => (
                  <div
                    key={m.name}
                    onClick={() => {
                      setSel(m.name);
                      setSearch("");
                    }}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: "7px 8px",
                      borderRadius: 8,
                      cursor: "pointer",
                      background:
                        sel === m.name ? theme.surface : "transparent",
                    }}
                  >
                    <span style={{ fontSize: 13 }}>
                      {m.label}
                      {has(m.name) ? " ✓" : ""}{" "}
                      <span style={{ color: theme.muted, fontSize: 11 }}>
                        · {m.group}
                      </span>
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: theme.muted,
                        flexShrink: 0,
                      }}
                    >
                      {m.size}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <select
                value={sel}
                onChange={(e) => setSel(e.target.value)}
                style={{ ...input, cursor: "pointer" }}
              >
                <option value="">{t("models.choose")}</option>
                {groups.map((g) => (
                  <optgroup key={g} label={g}>
                    {reco
                      .filter((m) => m.group === g)
                      .map((m) => (
                        <option key={m.name} value={m.name}>
                          {m.label} — {m.size}
                          {has(m.name) ? " ✓" : ""}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            )}
            {selModel &&
              (() => {
                // Real installed name is base-infix-quant (e.g. qwen2.5:7b-instruct-q8_0),
                // so match loosely by base prefix + quant token rather than an exact guess.
                const inst = quant
                  ? installed.find(
                      (m) =>
                        m.name.startsWith(selModel.name + "-") &&
                        m.name.includes(quant),
                    )
                  : installed.find(
                      (m) =>
                        m.name === selModel.name ||
                        m.name.startsWith(selModel.name + ":") ||
                        m.name === selModel.name + ":latest",
                    );
                const targetInstalled = !!inst;
                const defName =
                  inst?.name ||
                  (quant ? `${selModel.name}-${quant}` : selModel.name);
                const selQuant = quants.find((q) => q.tag === quant);
                return (
                  <div
                    style={{
                      background: theme.surface,
                      border: `1px solid ${theme.border}`,
                      borderRadius: 12,
                      padding: 16,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "baseline",
                      }}
                    >
                      <b style={{ fontSize: 15 }}>{selModel.label}</b>
                      <span style={{ fontSize: 11, color: theme.muted }}>
                        {selModel.size}
                        {quant ? " · " + t("models.quantSizeVaries") : ""}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: theme.muted,
                        margin: "4px 0 12px",
                      }}
                    >
                      {selModel.note}
                    </div>
                    {quants.length > 1 && (
                      <div style={{ marginBottom: 12 }}>
                        <label
                          style={{
                            fontSize: 12,
                            color: theme.muted,
                            display: "block",
                            marginBottom: 4,
                          }}
                        >
                          {t("models.quantLabel")}
                        </label>
                        <select
                          value={quant}
                          onChange={(e) => setQuant(e.target.value)}
                          style={{ ...input, cursor: "pointer" }}
                        >
                          {quants.map((q) => (
                            <option key={q.tag || "default"} value={q.tag}>
                              {(q.tag || t("models.quantDefault")) +
                                (q.hint ? " — " + q.hint : "")}
                            </option>
                          ))}
                        </select>
                        <div
                          style={{
                            fontSize: 11,
                            color: theme.muted,
                            marginTop: 4,
                          }}
                        >
                          {t("models.quantHelp")}
                        </div>
                      </div>
                    )}
                    {targetInstalled ? (
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        <span style={{ fontSize: 12, color: theme.accent }}>
                          ✓ {t("models.installedBadge")}
                          {quant ? ` (${quant})` : ""}
                        </span>
                        {def !== defName && (
                          <button
                            onClick={() => makeDefault(defName)}
                            style={ghost}
                          >
                            {t("models.useAsDefault")}
                          </button>
                        )}
                      </div>
                    ) : (
                      <button
                        onClick={() => void download(selModel.name, quant)}
                        disabled={!!pulling || engine !== "up"}
                        // This catalogue is ollama's, so without ollama the
                        // button cannot work. It used to just sit there dead
                        // with no explanation.
                        title={
                          engine !== "up" ? t("models.needsOllama") : undefined
                        }
                        style={{
                          ...button,
                          padding: "6px 14px",
                          // A dimmed-but-still-green button reads as "click me".
                          // When it cannot work it must look inert, not merely
                          // faded: this is the control the user kept pressing.
                          ...(pulling || engine !== "up"
                            ? {
                                background: "transparent",
                                color: theme.muted,
                                border: `1px solid ${theme.border}`,
                                cursor: "not-allowed",
                                opacity: 1,
                              }
                            : null),
                        }}
                      >
                        ⬇ {t("models.downloadButton")}
                        {selQuant && quant ? ` · ${quant}` : ""}
                      </button>
                    )}
                    {/* A disabled button with no explanation reads as a broken
                        app. Say why it cannot work — and, when we can do
                        something about it, offer the action instead of a note. */}
                    {engine !== "up" && !pulling && (
                      <div
                        style={{
                          color: theme.muted,
                          fontSize: 12,
                          marginTop: 8,
                          lineHeight: 1.5,
                        }}
                      >
                        {t("models.needsOllama")}
                        {canStartOllama && (
                          <div style={{ marginTop: 8 }}>
                            <button
                              style={{ ...ghostButton, padding: "7px 14px" }}
                              disabled={startingOllama}
                              onClick={() => void startOllama()}
                            >
                              {startingOllama
                                ? t("models.startingOllama")
                                : t("models.startOllama")}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
          </div>
        );
      })()}

      <h3
        style={{
          fontSize: 14,
          color: theme.muted,
          textTransform: "uppercase",
          letterSpacing: ".08em",
          margin: "24px 0 8px",
        }}
      >
        {t("models.installedHeading")}
      </h3>
      {memory && (
        <div
          style={{
            padding: "12px 0",
            marginBottom: 6,
            borderTop: `1px solid ${theme.border}`,
            borderBottom: `1px solid ${theme.border}`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <b style={{ fontSize: 14 }}>{memory.name}</b>
            <span
              style={{
                fontSize: 12,
                color:
                  memory.profile.plan?.mode === "not_recommended"
                    ? "#e0533d"
                    : theme.accent,
              }}
            >
              {memory.profile.plan?.mode === "gpu"
                ? "GPU"
                : memory.profile.plan?.mode === "hybrid_offload"
                  ? "GPU + RAM"
                  : memory.profile.plan?.mode === "cpu_mmap"
                    ? "RAM + disco (lento)"
                    : "Non consigliato"}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              gap: 18,
              flexWrap: "wrap",
              marginTop: 7,
              fontSize: 12,
              color: theme.muted,
            }}
          >
            <span>
              VRAM libera:{" "}
              {memory.profile.hardware.gpu
                ? fmt(memory.profile.hardware.gpu.freeBytes)
                : "non rilevata"}
            </span>
            <span>
              RAM libera: {fmt(memory.profile.hardware.ram.freeBytes)}
            </span>
            <span>
              Disco libero: {fmt(memory.profile.hardware.disk.freeBytes)}
            </span>
            {memory.profile.plan && (
              <span>
                Working set: {fmt(memory.profile.plan.estimatedWorkingSetBytes)}
              </span>
            )}
          </div>
          {memory.profile.plan && (
            <div
              style={{
                marginTop: 7,
                fontSize: 12,
                color: theme.muted,
                lineHeight: 1.5,
              }}
            >
              {memory.profile.plan.reason} Quantizzazione:{" "}
              {memory.profile.plan.quantization}.
              {memory.profile.plan.recommendedQuantization
                ? ` Consigliata: ${memory.profile.plan.recommendedQuantization}.`
                : ""}
              {` KV cache: ${memory.profile.plan.runtimeHints.kvCacheType}; contesto: ${memory.profile.plan.runtimeHints.suggestedContextTokens} token.`}
            </div>
          )}
        </div>
      )}
      {installed.length === 0 && (
        <div style={{ color: theme.muted, fontSize: 13 }}>
          {t("models.emptyInstalled")}
        </div>
      )}
      {installed.map((m) => (
        <div
          key={m.name}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 12px",
            borderBottom: `1px solid ${theme.border}`,
          }}
        >
          <span style={{ flex: 1, fontSize: 14 }}>
            {m.name}{" "}
            {def === m.name && (
              <span style={{ color: theme.accent, fontSize: 11 }}>
                · {t("models.defaultBadge")}
              </span>
            )}
          </span>
          <span style={{ fontSize: 12, color: theme.muted }}>
            {fmt(m.sizeBytes)}
          </span>
          <button
            onClick={() => void inspectMemory(m.name)}
            disabled={memoryBusy === m.name}
            style={ghost}
          >
            {memoryBusy === m.name ? "..." : "Memoria"}
          </button>
          {def !== m.name && (
            <button onClick={() => makeDefault(m.name)} style={ghost}>
              {t("models.makeDefaultButton")}
            </button>
          )}
        </div>
      ))}

      {nodeApi && (
        <>
          <h3
            style={{
              fontSize: 14,
              color: theme.muted,
              textTransform: "uppercase",
              letterSpacing: ".08em",
              margin: "28px 0 8px",
            }}
          >
            {t("models.nodeHeading")}
          </h3>
          <div
            style={{
              background: theme.surface,
              border: `1px solid ${theme.border}`,
              borderRadius: 12,
              padding: 16,
              maxWidth: 520,
            }}
          >
            <p style={{ fontSize: 13, color: theme.muted, margin: "0 0 12px" }}>
              {t("models.nodeDesc")}
            </p>
            {nodeSt?.available === false ? (
              <div style={{ color: theme.muted, fontSize: 13 }}>
                {t("models.nodeUnavailable")}
              </div>
            ) : nodeSt?.running ? (
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ color: theme.accent, fontSize: 14 }}>
                  ● {t("models.nodeRunning")}
                </span>
                <button
                  onClick={() => void nodeStop()}
                  disabled={nBusy}
                  style={ghost}
                >
                  {t("models.nodeStop")}
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {!nodeSt?.registered &&
                  (getProdToken() ? (
                    <span style={{ fontSize: 12, color: theme.muted }}>
                      ✓ {user?.email}
                    </span>
                  ) : (
                    <>
                      <input
                        value={nEmail}
                        onChange={(e) => setNEmail(e.target.value)}
                        placeholder={t("models.nodeEmail")}
                        style={input}
                      />
                      <input
                        value={nPass}
                        onChange={(e) => setNPass(e.target.value)}
                        type="password"
                        placeholder={t("models.nodePass")}
                        style={input}
                      />
                    </>
                  ))}
                <button
                  onClick={() => void nodeStart()}
                  disabled={nBusy || engine !== "up"}
                  style={{
                    ...button,
                    padding: "8px 16px",
                    alignSelf: "flex-start",
                    opacity: nBusy || engine !== "up" ? 0.5 : 1,
                  }}
                >
                  {nBusy ? "…" : t("models.nodeStart")}
                </button>
                {engine !== "up" && (
                  <span style={{ fontSize: 12, color: theme.muted }}>
                    {t("models.nodeNeedsEngine")}
                  </span>
                )}
              </div>
            )}
            {nErr && (
              <div style={{ color: "#e0533d", fontSize: 12, marginTop: 8 }}>
                ⚠ {nErr}
              </div>
            )}
          </div>
        </>
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
