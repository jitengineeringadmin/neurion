"use client";
import { useEffect, useState } from "react";
import { api, isDesktop } from "../../../lib/api";
import { NetworkConnect } from "../../../components/NetworkConnect";
import { theme, card } from "../../../lib/ui";
import { useT } from "../../../lib/i18n";

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ ...card, minWidth: 130 }}>
      <div style={{ fontSize: 12, color: theme.muted }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 500, marginTop: 4 }}>{value}</div>
    </div>
  );
}

export default function DashboardPage() {
  const t = useT();
  const [balance, setBalance] = useState<number | null>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [nodes, setNodes] = useState<any[]>([]);

  useEffect(() => {
    void api<{ balance: number }>("/credits/balance")
      .then((b) => setBalance(b.balance))
      .catch(() => undefined);
    void api<any[]>("/jobs")
      .then(setJobs)
      .catch(() => undefined);
    void api<any[]>("/nodes")
      .then(setNodes)
      .catch(() => undefined);
  }, []);

  const online = nodes.filter((n) => n.status === "ONLINE").length;
  const rewarded = jobs.filter((j) => j.status === "REWARDED").length;

  return (
    <div>
      <h2 style={{ fontSize: 20, marginTop: 0 }}>{t("dashboard.heading")}</h2>
      {/* The one place identity belongs. Working locally needs no account; an
          account is what lets this machine take part in the network, so the
          decision to connect lives next to what connecting is for. The header
          indicator links here. */}
      {isDesktop() && (
        <div style={{ ...card, marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {t("network.connectTitle")}
          </div>
          <div style={{ color: theme.muted, fontSize: 12, marginBottom: 10 }}>
            {t("network.connectBody")}
          </div>
          <NetworkConnect />
        </div>
      )}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Metric label={t("dashboard.metricCredits")} value={balance ?? "…"} />
        <Metric label={t("dashboard.metricJobs")} value={jobs.length} />
        <Metric label={t("dashboard.metricJobsRewarded")} value={rewarded} />
        <Metric label={t("dashboard.metricNodes")} value={nodes.length} />
        <Metric label={t("dashboard.metricNodesOnline")} value={online} />
      </div>
    </div>
  );
}
