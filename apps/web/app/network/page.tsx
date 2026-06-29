'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { publicApi } from '../../lib/api';
import { theme, button } from '../../lib/ui';
import { ThemeToggle } from '../../components/ThemeToggle';
import { LangToggle } from '../../components/LangToggle';
import { useT } from '../../lib/i18n';
import { Section, Grid, Card, Stat, Donut, BarList, Progress, Sparkline, ComingSoon, PALETTE, type Slice } from '../../components/network/Charts';

interface HistoryPoint {
  t: number;
  nodesOnline: number;
  jobsInFlight: number;
  jobsCompletedTotal: number;
  tps: number | null;
}

interface NetworkStats {
  generatedAt: string;
  overview: {
    nodesOnline: number;
    nodesActive: number;
    nodesTotal: number;
    jobsInFlight: number;
    jobsCompletedToday: number;
    jobsCompletedTotal: number;
    payoutsPending: number;
  };
  composition: {
    byStatus: Record<string, number>;
    byTrust: Record<string, number>;
    byOs: Record<string, number>;
    gpuNodes: number;
    cpuOnlyNodes: number;
    dockerNodes: number;
    realtimeNodes: number;
    gridNodes: number;
    totalCpuCores: number;
    models: { model: string; nodes: number }[];
  };
  health: {
    jobSuccessRate: number | null;
    verificationPassRate: number | null;
    jobsByType: { type: string; count: number }[];
    verifiedJobs: number;
    optimisticJobs: number;
  };
  economy: {
    emittedThisEpochNrn: number;
    epochBudgetNrn: number;
    epochPct: number;
    emittedLifetimeNrn: number;
    poolCapNrn: number;
    lifetimePct: number;
  };
  performance: {
    avgTokensPerSecond: number | null;
    avgFirstTokenMs: number | null;
    nodesReporting: number;
    gpuModels: { model: string; nodes: number }[];
  };
}

const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

function toSlices(rec: Record<string, number>, labeller: (k: string) => string): Slice[] {
  return Object.entries(rec)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v], i) => ({ label: labeller(k), value: v, color: PALETTE[i % PALETTE.length] }));
}

export default function NetworkPage() {
  const t = useT();
  const [stats, setStats] = useState<NetworkStats | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      publicApi<NetworkStats>('/network/stats')
        .then((s) => {
          if (alive) {
            setStats(s);
            setError(false);
          }
        })
        .catch(() => {
          if (alive) setError(true);
        });
      publicApi<HistoryPoint[]>('/network/history')
        .then((h) => {
          if (alive) setHistory(h);
        })
        .catch(() => undefined);
    };
    load();
    const id = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const stLabel = (k: string) => t(`network.st_${k.toLowerCase()}`);
  const trLabel = (k: string) => t(`network.tr_${k.toLowerCase()}`);
  const osLabel = (k: string) => (k === 'unknown' ? t('network.unknown') : k.charAt(0).toUpperCase() + k.slice(1));

  return (
    <main style={{ minHeight: '100vh' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 20px', borderBottom: `1px solid ${theme.border}` }}>
        <Link href="/" className="display neon" style={{ fontSize: 20, letterSpacing: '0.1em', color: theme.accent, textDecoration: 'none' }}>NEURION</Link>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <ThemeToggle />
          <LangToggle />
          <Link href="/login" style={{ ...button, padding: '6px 14px', textDecoration: 'none' }}>{t('network.openApp')}</Link>
        </div>
      </header>

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '28px 20px 64px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <h1 className="display" style={{ fontSize: 'clamp(28px,5vw,42px)', fontWeight: 800, margin: 0 }}>{t('network.title')}</h1>
          {stats ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: theme.muted, fontSize: 13 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: theme.green, boxShadow: `0 0 8px ${theme.green}` }} />
              {t('network.updated', { time: new Date(stats.generatedAt).toLocaleTimeString() })}
            </div>
          ) : null}
        </div>
        <p style={{ color: theme.muted, marginTop: 8, maxWidth: 620 }}>{t('network.subtitle')}</p>

        {error && !stats ? <Card style={{ marginTop: 24 }}>{t('network.error')}</Card> : null}
        {!stats && !error ? <Card style={{ marginTop: 24 }}>{t('network.loading')}</Card> : null}

        {stats ? (
          <>
            <Section title={t('network.secOverview')}>
              <Grid min={170}>
                <Stat label={t('network.nodesOnline')} value={num(stats.overview.nodesOnline)} accent sub={t('network.ofTotal', { n: num(stats.overview.nodesTotal) })} />
                <Stat label={t('network.nodesActive')} value={num(stats.overview.nodesActive)} />
                <Stat label={t('network.jobsInFlight')} value={num(stats.overview.jobsInFlight)} />
                <Stat label={t('network.jobsToday')} value={num(stats.overview.jobsCompletedToday)} />
                <Stat label={t('network.jobsTotal')} value={num(stats.overview.jobsCompletedTotal)} />
                <Stat label={t('network.cpuCores')} value={num(stats.composition.totalCpuCores)} />
                <Stat label={t('network.payoutsPending')} value={num(stats.overview.payoutsPending)} />
              </Grid>
            </Section>

            <Section title={t('network.secComposition')}>
              <Grid min={280}>
                <Card><div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: theme.muted, marginBottom: 12 }}>{t('network.byStatus')}</div><Donut data={toSlices(stats.composition.byStatus, stLabel)} centerLabel={t('network.nodes')} /></Card>
                <Card><div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: theme.muted, marginBottom: 12 }}>{t('network.byTrust')}</div><Donut data={toSlices(stats.composition.byTrust, trLabel)} centerLabel={t('network.nodes')} /></Card>
                <Card><div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: theme.muted, marginBottom: 12 }}>{t('network.byOs')}</div><Donut data={toSlices(stats.composition.byOs, osLabel)} centerLabel={t('network.nodes')} /></Card>
              </Grid>
              <Grid min={240}>
                <Card>
                  <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: theme.muted, marginBottom: 12 }}>{t('network.capabilities')}</div>
                  <BarList
                    items={[
                      { label: t('network.gpuNodes'), value: stats.composition.gpuNodes },
                      { label: t('network.cpuOnly'), value: stats.composition.cpuOnlyNodes },
                      { label: t('network.dockerNodes'), value: stats.composition.dockerNodes },
                      { label: t('network.realtimeNodes'), value: stats.composition.realtimeNodes },
                      { label: t('network.gridNodes'), value: stats.composition.gridNodes },
                    ]}
                  />
                </Card>
                <Card>
                  <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: theme.muted, marginBottom: 12 }}>{t('network.models')}</div>
                  <BarList items={stats.composition.models.map((m) => ({ label: m.model, value: m.nodes }))} />
                </Card>
              </Grid>
            </Section>

            <Section title={t('network.secHealth')}>
              <Grid min={240}>
                <Card>
                  <Progress pct={(stats.health.jobSuccessRate ?? 0) * 100} label={t('network.successRate')} value={stats.health.jobSuccessRate == null ? '—' : `${(stats.health.jobSuccessRate * 100).toFixed(1)}%`} />
                  <Progress pct={(stats.health.verificationPassRate ?? 0) * 100} label={t('network.verifyRate')} value={stats.health.verificationPassRate == null ? '—' : `${(stats.health.verificationPassRate * 100).toFixed(1)}%`} />
                </Card>
                <Card>
                  <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: theme.muted, marginBottom: 12 }}>{t('network.verifiedVsOpt')}</div>
                  <Donut
                    data={[
                      { label: t('network.verified'), value: stats.health.verifiedJobs, color: PALETTE[1] },
                      { label: t('network.optimistic'), value: stats.health.optimisticJobs, color: PALETTE[2] },
                    ]}
                  />
                </Card>
                <Card>
                  <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: theme.muted, marginBottom: 12 }}>{t('network.jobsByType')}</div>
                  <BarList items={stats.health.jobsByType.map((j) => ({ label: j.type, value: j.count }))} />
                </Card>
              </Grid>
            </Section>

            <Section title={t('network.secEconomy')}>
              <Card>
                <Progress pct={stats.economy.epochPct} label={t('network.epochEmission')} value={`${compact(stats.economy.emittedThisEpochNrn)} / ${compact(stats.economy.epochBudgetNrn)} NRN`} />
                <Progress pct={stats.economy.lifetimePct} label={t('network.lifetimeEmission')} value={`${compact(stats.economy.emittedLifetimeNrn)} / ${compact(stats.economy.poolCapNrn)} NRN`} />
              </Card>
            </Section>

            <Section title={t('network.secPerformance')}>
              {stats.performance.avgTokensPerSecond != null ? (
                <Grid min={200}>
                  <Stat label={t('network.tokensPerSec')} value={stats.performance.avgTokensPerSecond.toFixed(1)} accent sub={t('network.nodesReporting', { n: num(stats.performance.nodesReporting) })} />
                  <Stat label={t('network.firstToken')} value={stats.performance.avgFirstTokenMs == null ? '—' : `${num(stats.performance.avgFirstTokenMs)} ms`} />
                  <Card>
                    <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: theme.muted, marginBottom: 12 }}>{t('network.gpuModels')}</div>
                    <BarList items={stats.performance.gpuModels.map((g) => ({ label: g.model, value: g.nodes }))} />
                  </Card>
                </Grid>
              ) : (
                <Grid min={200}>
                  <ComingSoon title={t('network.tokensPerSec')} note={t('network.perfComingSoon')} />
                  <ComingSoon title={t('network.firstToken')} note={t('network.perfComingSoon')} />
                  <ComingSoon title={t('network.gpuLoad')} note={t('network.perfComingSoon')} />
                </Grid>
              )}
            </Section>

            <Section title={t('network.secHistory')}>
              <Grid min={240}>
                <Card><Sparkline label={t('network.histOnline')} points={history.map((h) => ({ t: h.t, value: h.nodesOnline }))} /></Card>
                <Card><Sparkline label={t('network.histJobs')} points={history.map((h) => ({ t: h.t, value: h.jobsCompletedTotal }))} /></Card>
                <Card><Sparkline label={t('network.histTps')} points={history.map((h) => ({ t: h.t, value: h.tps ?? 0 }))} format={(v) => v.toFixed(1)} /></Card>
              </Grid>
            </Section>
          </>
        ) : null}
      </div>
    </main>
  );
}
