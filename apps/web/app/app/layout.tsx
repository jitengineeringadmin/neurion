"use client";
import { ReactNode, Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "../../lib/auth";
import { publicApi, isDesktop, getProdEmail } from "../../lib/api";
import { theme } from "../../lib/ui";
import { ThemeToggle } from "../../components/ThemeToggle";
import { LangToggle } from "../../components/LangToggle";
import { SessionsSidebar } from "../../components/SessionsSidebar";
import { AgentSidebar } from "../../components/AgentSidebar";
import { GallerySidebar } from "../../components/GallerySidebar";
import { Onboarding } from "../../components/Onboarding";
import { useT } from "../../lib/i18n";

// [href, i18n key] — label resolved via t() in render (hooks can't run at module scope)
const TABS: [string, string][] = [
  ["/app/chat", "nav.tabChat"],
  ["/app/agent", "nav.tabAgent"],
  ["/app/image", "nav.tabImage"],
  ["/app/models", "nav.tabModels"],
  ["/app/forum", "nav.tabForum"],
  ["/app/dashboard", "nav.tabNetwork"],
];
const NETWORK: [string, string][] = [
  ["/app/dashboard", "nav.subnavDashboard"],
  ["/app/jobs", "nav.subnavJobs"],
  ["/app/nodes", "nav.subnavNodes"],
  ["/app/wallet", "nav.subnavWallet"],
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const t = useT();
  const { user, loading, logout, refresh } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  // Computed on the client: both read window/localStorage, and deciding this
  // during server rendering would produce markup the browser then disagrees with.
  const [desktop, setDesktop] = useState(false);
  const [netEmail, setNetEmail] = useState<string | null>(null);
  useEffect(() => {
    setDesktop(isDesktop());
    const sync = () => setNetEmail(getProdEmail());
    sync();
    // Connecting to the network happens on another page, so pick the change up
    // on the way back rather than leaving a stale "offline" in the header.
    window.addEventListener("focus", sync);
    const id = setInterval(sync, 4000);
    return () => {
      window.removeEventListener("focus", sync);
      clearInterval(id);
    };
  }, [pathname]);
  const [restricted, setRestricted] = useState(false);

  useEffect(() => {
    publicApi<{ restricted: boolean }>("/config")
      .then((c) => setRestricted(!!c.restricted))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (loading || user) return;
    // Never send a desktop user to a login form: there is no account behind it
    // to log back in with, so the redirect was a one-way door out of their own
    // program. The local session is claimed automatically; if it is momentarily
    // unavailable (the API still starting), keep asking rather than evicting.
    if (desktop) {
      const retry = setTimeout(() => void refresh(), 1500);
      return () => clearTimeout(retry);
    }
    router.replace("/login");
  }, [loading, user, router, desktop, refresh]);

  // Online build (no local AI engine): only account + forum are usable; send
  // chat/agent/compute routes back to the account page.
  useEffect(() => {
    if (loading || !user || !restricted) return;
    const ok =
      pathname.startsWith("/app/account") || pathname.startsWith("/app/forum");
    if (!ok) router.replace("/app/account");
  }, [loading, user, restricted, pathname, router]);

  if (loading || !user)
    return (
      <div style={{ padding: 40, color: theme.muted }}>{t("nav.loading")}</div>
    );

  const isNetwork = [
    "/app/dashboard",
    "/app/jobs",
    "/app/nodes",
    "/app/wallet",
    "/app/admin",
  ].some((p) => pathname.startsWith(p));
  const activeTab = pathname.startsWith("/app/agent")
    ? "/app/agent"
    : pathname.startsWith("/app/image")
      ? "/app/image"
      : pathname.startsWith("/app/models")
        ? "/app/models"
        : pathname.startsWith("/app/forum")
          ? "/app/forum"
          : isNetwork
            ? "/app/dashboard"
            : "/app/chat";

  const tab = (href: string, label: string) => {
    const active = href === activeTab;
    return (
      <Link
        key={href}
        href={href}
        style={{
          padding: "6px 16px",
          borderRadius: 8,
          fontSize: 13,
          textDecoration: "none",
          color: active ? "var(--bg)" : theme.muted,
          background: active ? theme.accent : "transparent",
          fontWeight: active ? 500 : 400,
        }}
      >
        {label}
      </Link>
    );
  };

  return (
    <div
      className="app-shell"
      style={{ display: "flex", flexDirection: "column", height: "100vh" }}
    >
      {/* first-run wizard: guides a new user to a working model (skips itself otherwise) */}
      {!restricted && <Onboarding />}
      {/* top bar: logo + segmented tabs + account (account lives here so tabs without
          a sidebar keep theme/lang/logout) */}
      <header
        className="app-header"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 24,
          padding: "10px 16px",
          borderBottom: `1px solid ${theme.border}`,
        }}
      >
        <div
          className="app-logo display neon"
          style={{ fontSize: 18, letterSpacing: "0.1em", color: theme.accent }}
        >
          NEURION
        </div>
        <div
          className="app-tabs"
          style={{
            display: "flex",
            gap: 4,
            background: "var(--surface-2)",
            borderRadius: 10,
            padding: 3,
          }}
        >
          {(restricted ? TABS.filter(([h]) => h === "/app/forum") : TABS).map(
            ([h, l]) => tab(h, t(l)),
          )}
        </div>
        <div
          className="app-account"
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {/* On the desktop there is no account to show. The app belongs to
              whoever is sitting at the computer, and local work needs no
              identity at all — surfacing the internal owner account here only
              invited people to sign out of a session that has no way back in.
              What matters is whether this machine is connected to the network,
              which is the only thing an identity is actually for. */}
          {desktop ? (
            <Link
              className="app-account-email"
              href="/app/dashboard"
              title={t("network.headerHint")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                color: theme.muted,
                maxWidth: 220,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                textDecoration: "none",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 7,
                  background: netEmail ? theme.accent : theme.muted,
                  flex: "0 0 auto",
                }}
              />
              {netEmail ?? t("network.offline")}
            </Link>
          ) : (
            <Link
              className="app-account-email"
              href="/app/account"
              title="Account"
              style={{
                fontSize: 11,
                color: theme.muted,
                maxWidth: 160,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                textDecoration: "none",
              }}
            >
              {user.email}
            </Link>
          )}
          <Link
            href="/app/settings"
            title={t("settings.title")}
            style={{
              fontSize: 22,
              lineHeight: 1,
              textDecoration: "none",
              color: pathname.startsWith("/app/settings")
                ? theme.accent
                : theme.muted,
            }}
          >
            ⚙
          </Link>
          <ThemeToggle />
          <LangToggle />
          {/* No sign-out on the desktop: there is no sign-in to come back
              through. Disconnecting from the NETWORK lives on the network page,
              where connecting to it does. */}
          {!desktop && (
            <button
              onClick={() => void logout().then(() => router.replace("/login"))}
              style={{
                background: "transparent",
                border: `1px solid ${theme.border}`,
                borderRadius: 8,
                color: theme.text,
                padding: "6px 8px",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {t("nav.logout")}
            </button>
          )}
        </div>
      </header>

      <div
        className="app-body"
        style={{ display: "flex", flex: 1, minHeight: 0 }}
      >
        {/* contextual left sidebar: chat → sessions, agent → project folders,
            image → generation history; other tabs get the full width */}
        {(activeTab === "/app/chat" ||
          activeTab === "/app/agent" ||
          activeTab === "/app/image") &&
          !restricted && (
            <aside
              className="app-sidebar"
              style={{
                width: 250,
                flexShrink: 0,
                borderRight: `1px solid ${theme.border}`,
                padding: 12,
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
              }}
            >
              <Suspense
                fallback={
                  <div style={{ color: theme.muted, fontSize: 12 }}>…</div>
                }
              >
                {activeTab === "/app/chat" ? (
                  <SessionsSidebar />
                ) : activeTab === "/app/agent" ? (
                  <AgentSidebar />
                ) : (
                  <GallerySidebar />
                )}
              </Suspense>
            </aside>
          )}

        {/* main */}
        <main
          className="app-main"
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {isNetwork && (
            <div
              style={{
                display: "flex",
                gap: 6,
                padding: "8px 20px",
                borderBottom: `1px solid ${theme.border}`,
              }}
            >
              {NETWORK.map(([h, l]) => (
                <Link
                  key={h}
                  href={h}
                  style={{
                    fontSize: 12,
                    padding: "4px 10px",
                    borderRadius: 6,
                    textDecoration: "none",
                    color: pathname.startsWith(h) ? theme.text : theme.muted,
                    background: pathname.startsWith(h)
                      ? theme.surface
                      : "transparent",
                  }}
                >
                  {t(l)}
                </Link>
              ))}
              {(user.role === "ADMIN" || user.role === "SUPER_ADMIN") && (
                <Link
                  href="/app/admin"
                  style={{
                    fontSize: 12,
                    padding: "4px 10px",
                    borderRadius: 6,
                    textDecoration: "none",
                    color: pathname.startsWith("/app/admin")
                      ? theme.text
                      : theme.muted,
                  }}
                >
                  {t("nav.adminLink")}
                </Link>
              )}
            </div>
          )}
          <div
            className="app-content"
            style={{ flex: 1, minHeight: 0, padding: 20, overflowY: "auto" }}
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
