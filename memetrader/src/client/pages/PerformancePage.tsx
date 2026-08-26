import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { GroupedPerformance, HistoricalSetupStats, PerformanceStats } from '../../shared/types.js';
import { qs } from '../lib/api.js';
import { fmtDuration, fmtNum, fmtPct, fmtR, fmtUsd } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';
import { Badge, DataUnavailable, Explain, Loading, Panel, Select, StatRow } from '../components/primitives.js';

interface PerformanceResponse extends PerformanceStats {
  bestStrategy: { best: GroupedPerformance | null; worst: GroupedPerformance | null; note: string };
  bestTimeframe: { best: GroupedPerformance | null; worst: GroupedPerformance | null; note: string };
  openTrades: number;
}

interface StatsResponse extends HistoricalSetupStats {
  minimumObservations: number;
  source: string;
}

const STRATEGIES = [
  { value: '', label: 'Any strategy' },
  { value: 'breakout-retest', label: 'Breakout + Retest' },
  { value: 'support-bounce', label: 'Support Bounce' },
  { value: 'trend-continuation', label: 'Trend Continuation' },
  { value: 'range-breakout', label: 'Range Breakout' },
  { value: 'failed-breakout', label: 'Failed Breakout' },
];

const TIMEFRAME_OPTIONS = [
  { value: '', label: 'Any timeframe' },
  { value: '1m', label: '1m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
  { value: '4h', label: '4h' },
  { value: '1d', label: '1d' },
];

export function PerformancePage() {
  const performance = useApi<PerformanceResponse>('/api/performance');
  const [strategy, setStrategy] = useState('');
  const [timeframe, setTimeframe] = useState('');
  const stats = useApi<StatsResponse>(`/api/performance/stats${qs({ strategy, timeframe })}`);

  if (performance.loading && !performance.data) {
    return <div className="p-2"><Panel title="Performance"><Loading /></Panel></div>;
  }
  if (performance.error) {
    return <div className="p-2"><Panel title="Performance"><DataUnavailable reason={performance.error.message} /></Panel></div>;
  }
  const data = performance.data;
  if (!data) return null;

  const confidenceTone =
    data.confidence === 'REASONABLE' ? 'up' : data.confidence === 'MODERATE' ? 'info' : 'warn';

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_380px] gap-2 overflow-auto p-2">
      <div className="flex min-h-0 flex-col gap-2">
        <Panel
          title="Trader performance"
          subtitle={`${data.sampleSize} closed trade(s), ${data.openTrades} open`}
        >
          {data.sampleSize === 0 ? (
            <p className="text-xs leading-relaxed text-term-dim">
              No closed paper trades yet. Every statistic on this page is computed from trades you
              actually recorded — nothing here is seeded or simulated.
            </p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-term-border bg-term-panel-2 p-2.5">
                <Badge tone={confidenceTone}>Confidence: {data.confidence}</Badge>
                <span className="text-[11px] text-term-muted">Sample: {data.sampleSize} trades</span>
                <p className="w-full text-[11px] leading-relaxed text-term-dim">{data.confidenceNote}</p>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <StatRow label="Total trades" value={data.sampleSize} />
                  <StatRow label="Wins" value={data.wins} tone="text-term-up" />
                  <StatRow label="Losses" value={data.losses} tone="text-term-down" />
                  <StatRow label="Break-even" value={data.breakEven} />
                  <StatRow label="Win rate" value={data.winRatePct === null ? '—' : fmtPct(data.winRatePct, 1)} />
                </div>
                <div>
                  <StatRow label="Average winner" value={data.averageWinner === null ? '—' : fmtUsd(data.averageWinner)} tone="text-term-up" />
                  <StatRow label="Average loser" value={data.averageLoser === null ? '—' : fmtUsd(data.averageLoser)} tone="text-term-down" />
                  <StatRow label="Expectancy" value={data.expectancyR === null ? '—' : fmtR(data.expectancyR)} explainKey="expectancy" />
                  <StatRow label="Profit factor" value={data.profitFactor === null ? '—' : fmtNum(data.profitFactor)} explainKey="profit-factor" />
                  <StatRow label="Average R" value={fmtR(data.averageR)} explainKey="r-multiple" />
                </div>
                <div>
                  <StatRow label="Median R" value={fmtR(data.medianR)} />
                  <StatRow label="Max drawdown" value={data.maxDrawdownR === null ? '—' : `${fmtNum(data.maxDrawdownR)}R`} explainKey="drawdown" />
                  <StatRow label="Consecutive wins" value={data.maxConsecutiveWins} />
                  <StatRow label="Consecutive losses" value={data.maxConsecutiveLosses} tone="text-term-down" />
                  <StatRow label="Average hold" value={fmtDuration(data.averageHoldingMinutes)} />
                  <StatRow label="Total P&L" value={fmtUsd(data.totalPnl)} tone={data.totalPnl >= 0 ? 'text-term-up' : 'text-term-down'} />
                </div>
              </div>
            </>
          )}
        </Panel>

        {data.equityCurveR.length > 0 ? (
          <Panel title="Equity curve (R)" explainKey="r-multiple">
            <div style={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.equityCurveR} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="#1c222c" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="index" stroke="#5a6474" fontSize={10} tickLine={false} />
                  <YAxis stroke="#5a6474" fontSize={10} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: '#161b24', border: '1px solid #333d4e', fontSize: 11 }}
                    labelStyle={{ color: '#7f8b9e' }}
                    formatter={(value) => [`${Number(value ?? 0).toFixed(2)}R`, 'Cumulative']}
                  />
                  <Line type="monotone" dataKey="cumulativeR" stroke="#8b5cf6" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <Panel title="By strategy" subtitle={data.bestStrategy.note}>
            <GroupTable groups={data.byStrategy} />
          </Panel>
          <Panel title="By timeframe" subtitle={data.bestTimeframe.note}>
            <GroupTable groups={data.byTimeframe} />
          </Panel>
        </div>
      </div>

      <div className="flex min-h-0 flex-col gap-2">
        <Panel
          title="Historical frequency"
          subtitle="What these rules did before — not what they will do next"
          explainKey="expectancy_vs_probability"
        >
          <div className="mb-3 grid grid-cols-2 gap-2">
            <Select value={strategy} onChange={setStrategy} options={STRATEGIES} />
            <Select value={timeframe} onChange={setTimeframe} options={TIMEFRAME_OPTIONS} />
          </div>

          {stats.loading && !stats.data ? (
            <Loading />
          ) : stats.error ? (
            <DataUnavailable reason={stats.error.message} />
          ) : stats.data ? (
            <div className="space-y-3">
              <p
                className={`rounded border p-2.5 text-[11px] leading-relaxed ${
                  stats.data.sufficient
                    ? 'border-term-info/40 bg-term-info/5 text-term-info'
                    : 'border-term-warn/40 bg-term-warn/5 text-term-warn'
                }`}
              >
                {stats.data.statement}
              </p>

              <div>
                <StatRow label="Matching setups" value={stats.data.matchingSetups} />
                <StatRow
                  label="Historical win rate"
                  value={stats.data.winRatePct === null ? 'Not published' : fmtPct(stats.data.winRatePct, 1)}
                />
                <StatRow label="Average outcome" value={stats.data.averageR === null ? 'Not published' : fmtR(stats.data.averageR)} />
                <StatRow label="Median outcome" value={stats.data.medianR === null ? 'Not published' : fmtR(stats.data.medianR)} />
                <StatRow label="Worst observed" value={stats.data.worstR === null ? '—' : fmtR(stats.data.worstR)} tone="text-term-down" />
                <StatRow label="Best observed" value={stats.data.bestR === null ? '—' : fmtR(stats.data.bestR)} tone="text-term-up" />
                <StatRow
                  label="Max drawdown"
                  value={stats.data.maxDrawdownR === null ? 'Not published' : `${fmtNum(stats.data.maxDrawdownR)}R`}
                />
              </div>

              <div>
                <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-term-dim">
                  Distribution of outcomes
                  <Explain termKey="expectancy" />
                </div>
                <div className="space-y-1">
                  {stats.data.distribution.map((bucket) => {
                    const max = Math.max(1, ...stats.data!.distribution.map((b) => b.count));
                    return (
                      <div key={bucket.bucket} className="flex items-center gap-2">
                        <span className="num w-24 text-[10px] text-term-dim">{bucket.bucket}</span>
                        <div className="h-2 flex-1 overflow-hidden rounded bg-term-border">
                          <div
                            className={bucket.bucket.startsWith('<') || bucket.bucket.startsWith('-') ? 'h-full bg-term-down' : 'h-full bg-term-up'}
                            style={{ width: `${(bucket.count / max) * 100}%` }}
                          />
                        </div>
                        <span className="num w-6 text-right text-[10px] text-term-muted">{bucket.count}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <p className="text-[10px] leading-relaxed text-term-dim">
                Source: {stats.data.source}. A win rate is published only at {stats.data.minimumObservations}+
                matching observations, because below that the number is dominated by chance.
              </p>
            </div>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}

function GroupTable({ groups }: { groups: GroupedPerformance[] }) {
  if (groups.length === 0) {
    return <p className="text-[11px] text-term-dim">No closed trades to group yet.</p>;
  }
  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-term-border text-[9px] uppercase tracking-widest text-term-dim">
          <th className="px-1 py-1 text-left">Group</th>
          <th className="px-1 py-1 text-right">Trades</th>
          <th className="px-1 py-1 text-right">Win %</th>
          <th className="px-1 py-1 text-right">Avg R</th>
          <th className="px-1 py-1 text-right">Total R</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <tr key={group.key} className="border-b border-term-border/40">
            <td className="px-1 py-1 text-[10px] text-term-text">{group.key}</td>
            <td className="num px-1 py-1 text-right text-[10px] text-term-muted">{group.trades}</td>
            <td className="num px-1 py-1 text-right text-[10px] text-term-muted">
              {group.winRatePct === null ? '—' : fmtPct(group.winRatePct, 0)}
            </td>
            <td className={`num px-1 py-1 text-right text-[10px] ${(group.averageR ?? 0) >= 0 ? 'text-term-up' : 'text-term-down'}`}>
              {fmtR(group.averageR)}
            </td>
            <td className={`num px-1 py-1 text-right text-[10px] ${group.totalR >= 0 ? 'text-term-up' : 'text-term-down'}`}>
              {fmtR(group.totalR)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
