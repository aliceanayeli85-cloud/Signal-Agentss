import { useState } from 'react';
import type { BacktestMetrics, BacktestResult, StrategyId, Timeframe } from '../../shared/types.js';
import { TIMEFRAMES } from '../../shared/types.js';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ApiError, api } from '../lib/api.js';
import { fmtDateTime, fmtNum, fmtPct, fmtUsd } from '../lib/format.js';
import { Badge, Button, DataUnavailable, Explain, Field, Loading, Panel, Select, StatRow, TextInput, WarningList } from '../components/primitives.js';

const STRATEGY_OPTIONS: { id: StrategyId; label: string }[] = [
  { id: 'breakout-retest', label: 'Breakout + Retest' },
  { id: 'support-bounce', label: 'Support Bounce' },
  { id: 'trend-continuation', label: 'Trend Continuation' },
  { id: 'range-breakout', label: 'Range Breakout' },
  { id: 'failed-breakout', label: 'Failed Breakout' },
];

export function BacktestPage() {
  const [assetId, setAssetId] = useState('coinbase:BTC-USD');
  const [timeframe, setTimeframe] = useState<Timeframe>('1h');
  const [strategies, setStrategies] = useState<StrategyId[]>(STRATEGY_OPTIONS.map((s) => s.id));
  const [stopRule, setStopRule] = useState<'structure' | 'atr'>('structure');
  const [atrMultiple, setAtrMultiple] = useState('1.5');
  const [targetR, setTargetR] = useState('2');
  const [riskPct, setRiskPct] = useState('1');
  const [accountSize, setAccountSize] = useState('10000');
  const [feesPct, setFeesPct] = useState('0.1');
  const [slippagePct, setSlippagePct] = useState('0.05');
  const [trainFraction, setTrainFraction] = useState('0.6');
  const [maxBars, setMaxBars] = useState('60');
  const [bars, setBars] = useState('1000');

  const [result, setResult] = useState<BacktestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: StrategyId) => {
    setStrategies((current) =>
      current.includes(id) ? current.filter((s) => s !== id) : [...current, id],
    );
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const response = await api.post<BacktestResult>('/api/backtest', {
        assetId: assetId.trim(),
        timeframe,
        strategies,
        stopRule,
        atrMultiple: Number(atrMultiple),
        targetR: Number(targetR),
        riskPct: Number(riskPct),
        accountSize: Number(accountSize),
        feesPct: Number(feesPct),
        slippagePct: Number(slippagePct),
        trainFraction: Number(trainFraction),
        maxBarsInTrade: Number(maxBars),
        bars: Number(bars),
      });
      setResult(response);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const equity = result
    ? result.trades.reduce<{ index: number; cumulativeR: number; segment: string }[]>((acc, trade, index) => {
        const previous = acc[acc.length - 1]?.cumulativeR ?? 0;
        acc.push({ index: index + 1, cumulativeR: previous + trade.rMultiple, segment: trade.segment });
        return acc;
      }, [])
    : [];

  const distribution = result
    ? bucketise(result.trades.map((t) => t.rMultiple))
    : [];

  return (
    <div className="grid h-full min-h-0 grid-cols-[320px_minmax(0,1fr)] gap-2 p-2">
      <Panel title="Backtest configuration" className="min-h-0">
        <div className="space-y-2">
          <Field label="Asset id" hint="Copy the id from the scanner, e.g. coinbase:BTC-USD or dexscreener:solana:<pair>">
            <TextInput value={assetId} onChange={setAssetId} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Timeframe">
              <Select
                value={timeframe}
                onChange={(value) => setTimeframe(value as Timeframe)}
                options={TIMEFRAMES.map((tf) => ({ value: tf, label: tf }))}
              />
            </Field>
            <Field label="Bars to load">
              <TextInput type="number" value={bars} onChange={setBars} />
            </Field>
          </div>

          <div>
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-term-dim">
              Strategies
            </span>
            <div className="space-y-1">
              {STRATEGY_OPTIONS.map((option) => (
                <label key={option.id} className="flex cursor-pointer items-center gap-2 text-[11px] text-term-text">
                  <input
                    type="checkbox"
                    checked={strategies.includes(option.id)}
                    onChange={() => toggle(option.id)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Stop rule">
              <Select
                value={stopRule}
                onChange={(value) => setStopRule(value as 'structure' | 'atr')}
                options={[
                  { value: 'structure', label: 'Structure' },
                  { value: 'atr', label: 'ATR multiple' },
                ]}
              />
            </Field>
            <Field label="ATR multiple">
              <TextInput type="number" step="0.1" value={atrMultiple} onChange={setAtrMultiple} />
            </Field>
            <Field label="Target (R)">
              <TextInput type="number" step="0.25" value={targetR} onChange={setTargetR} />
            </Field>
            <Field label="Risk %">
              <TextInput type="number" step="0.25" value={riskPct} onChange={setRiskPct} />
            </Field>
            <Field label="Account size">
              <TextInput type="number" value={accountSize} onChange={setAccountSize} />
            </Field>
            <Field label="Max bars in trade">
              <TextInput type="number" value={maxBars} onChange={setMaxBars} />
            </Field>
            <Field label="Fees % per side">
              <TextInput type="number" step="0.01" value={feesPct} onChange={setFeesPct} />
            </Field>
            <Field label="Slippage %">
              <TextInput type="number" step="0.01" value={slippagePct} onChange={setSlippagePct} />
            </Field>
          </div>

          <Field
            label="In-sample fraction"
            hint="The first portion of the series is in-sample (where you experiment). The rest is out-of-sample and should be checked once."
          >
            <TextInput type="number" step="0.05" value={trainFraction} onChange={setTrainFraction} />
          </Field>

          <Button onClick={run} disabled={running || strategies.length === 0} variant="primary" className="w-full">
            {running ? 'Running…' : 'Run backtest'}
          </Button>

          <p className="text-[10px] leading-relaxed text-term-dim">
            Entries fill at the NEXT bar&apos;s open after a signal, never at the signal bar&apos;s
            close. When one bar contains both the stop and the target the stop is taken, because
            intrabar sequence is unknowable from OHLC data.
            <Explain termKey="look-ahead-bias" />
          </p>
        </div>
      </Panel>

      <div className="flex min-h-0 flex-col gap-2 overflow-auto">
        {running ? (
          <Panel title="Results"><Loading label="Running bar-by-bar simulation" /></Panel>
        ) : error ? (
          <Panel title="Results"><DataUnavailable reason={error} /></Panel>
        ) : !result ? (
          <Panel title="Results">
            <p className="text-xs leading-relaxed text-term-dim">
              Configure a backtest on the left and run it. Results are split into in-sample and
              out-of-sample so you can tell curve fitting from an edge that survived data the rules
              were not chosen on.
            </p>
          </Panel>
        ) : (
          <>
            <Panel
              title="Results"
              subtitle={`${result.config.symbol} · ${result.config.timeframe} · ${result.barsUsed} bars · ${fmtDateTime(result.firstBarTime ? result.firstBarTime * 1000 : null)} → ${fmtDateTime(result.lastBarTime ? result.lastBarTime * 1000 : null)}`}
            >
              <div className="grid grid-cols-3 gap-3">
                <MetricsColumn title="In-sample (training)" metrics={result.inSample} tone="info" />
                <MetricsColumn title="Out-of-sample" metrics={result.outOfSample} tone="up" />
                <MetricsColumn title="Combined" metrics={result.combined} tone="neutral" />
              </div>
              <div className="mt-3">
                <WarningList warnings={result.warnings} />
              </div>
              <p className="mt-3 rounded border border-term-warn/40 bg-term-warn/5 p-2.5 text-[11px] leading-relaxed text-term-warn">
                {result.disclaimer}
              </p>
            </Panel>

            {equity.length > 0 ? (
              <div className="grid grid-cols-2 gap-2">
                <Panel title="Equity curve (R)" explainKey="r-multiple">
                  <div style={{ height: 220 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={equity} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
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

                <Panel title="Outcome distribution" explainKey="expectancy">
                  <div style={{ height: 220 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={distribution} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
                        <CartesianGrid stroke="#1c222c" strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="bucket" stroke="#5a6474" fontSize={9} tickLine={false} interval={0} angle={-30} textAnchor="end" height={48} />
                        <YAxis stroke="#5a6474" fontSize={10} tickLine={false} allowDecimals={false} />
                        <Tooltip
                          contentStyle={{ background: '#161b24', border: '1px solid #333d4e', fontSize: 11 }}
                          labelStyle={{ color: '#7f8b9e' }}
                        />
                        <Bar dataKey="count">
                          {distribution.map((entry) => (
                            <Cell key={entry.bucket} fill={entry.bucket.startsWith('-') || entry.bucket.startsWith('<') ? '#ff5c5c' : '#2fd07a'} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Panel>
              </div>
            ) : null}

            <Panel title={`Trades (${result.trades.length})`}>
              {result.trades.length === 0 ? (
                <p className="text-[11px] text-term-dim">
                  No trades were generated. The rules never fired on this series — that is a result,
                  not an error.
                </p>
              ) : (
                <div className="overflow-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-term-border text-[9px] uppercase tracking-widest text-term-dim">
                        <th className="px-2 py-1 text-left">Strategy</th>
                        <th className="px-2 py-1 text-left">Dir</th>
                        <th className="px-2 py-1 text-left">Entry time</th>
                        <th className="px-2 py-1 text-right">Entry</th>
                        <th className="px-2 py-1 text-right">Exit</th>
                        <th className="px-2 py-1 text-left">Reason</th>
                        <th className="px-2 py-1 text-right">Bars</th>
                        <th className="px-2 py-1 text-right">R</th>
                        <th className="px-2 py-1 text-right">P&amp;L</th>
                        <th className="px-2 py-1 text-left">Segment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.trades.map((trade, index) => (
                        <tr key={`${trade.entryTime}-${index}`} className="border-b border-term-border/40">
                          <td className="px-2 py-1 text-[10px] text-term-text">{trade.strategy}</td>
                          <td className="px-2 py-1 text-[10px]">
                            <Badge tone={trade.direction === 'long' ? 'up' : 'down'}>{trade.direction}</Badge>
                          </td>
                          <td className="num px-2 py-1 text-[10px] text-term-dim">{fmtDateTime(trade.entryTime * 1000)}</td>
                          <td className="num px-2 py-1 text-right text-[10px] text-term-muted">{fmtNum(trade.entryPrice, 6)}</td>
                          <td className="num px-2 py-1 text-right text-[10px] text-term-muted">{fmtNum(trade.exitPrice, 6)}</td>
                          <td className="px-2 py-1 text-[10px] text-term-dim">{trade.exitReason}</td>
                          <td className="num px-2 py-1 text-right text-[10px] text-term-dim">{trade.barsHeld}</td>
                          <td className={`num px-2 py-1 text-right text-[10px] ${trade.rMultiple >= 0 ? 'text-term-up' : 'text-term-down'}`}>
                            {trade.rMultiple.toFixed(2)}
                          </td>
                          <td className={`num px-2 py-1 text-right text-[10px] ${trade.pnl >= 0 ? 'text-term-up' : 'text-term-down'}`}>
                            {fmtUsd(trade.pnl)}
                          </td>
                          <td className="px-2 py-1 text-[10px] text-term-dim">{trade.segment}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}

function MetricsColumn({
  title,
  metrics,
  tone,
}: {
  title: string;
  metrics: BacktestMetrics;
  tone: 'info' | 'up' | 'neutral';
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <Badge tone={tone}>{title}</Badge>
        {title.startsWith('Out') ? <Explain termKey="out-of-sample" /> : null}
      </div>
      <StatRow label="Trades" value={metrics.trades} />
      <StatRow label="Wins / losses" value={`${metrics.wins} / ${metrics.losses}`} />
      <StatRow label="Win rate" value={metrics.winRatePct === null ? '—' : fmtPct(metrics.winRatePct, 1)} />
      <StatRow label="Average return" value={metrics.averageReturnPct === null ? '—' : fmtPct(metrics.averageReturnPct)} />
      <StatRow label="Average R" value={metrics.averageR === null ? '—' : `${metrics.averageR.toFixed(3)}R`} />
      <StatRow label="Expectancy" value={metrics.expectancyR === null ? '—' : `${metrics.expectancyR.toFixed(3)}R`} explainKey="expectancy" />
      <StatRow label="Profit factor" value={metrics.profitFactor === null ? '—' : metrics.profitFactor.toFixed(2)} explainKey="profit-factor" />
      <StatRow label="Max drawdown" value={metrics.maxDrawdownR === null ? '—' : `${metrics.maxDrawdownR.toFixed(2)}R`} explainKey="drawdown" />
      <StatRow label="Largest win" value={metrics.largestWinR === null ? '—' : `${metrics.largestWinR.toFixed(2)}R`} />
      <StatRow label="Largest loss" value={metrics.largestLossR === null ? '—' : `${metrics.largestLossR.toFixed(2)}R`} />
      <StatRow label="Longest losing streak" value={metrics.longestLosingStreak} />
      <StatRow label="Total P&L" value={fmtUsd(metrics.totalPnl)} tone={metrics.totalPnl >= 0 ? 'text-term-up' : 'text-term-down'} />
      <StatRow
        label="Sharpe"
        value={metrics.sharpe === null ? 'Not reported' : metrics.sharpe.toFixed(2)}
        explainKey="sharpe"
        title={metrics.sharpeNote}
      />
      <p className="mt-1 text-[10px] leading-relaxed text-term-dim">{metrics.sharpeNote}</p>
    </div>
  );
}

function bucketise(rs: number[]): { bucket: string; count: number }[] {
  const buckets: { bucket: string; test: (r: number) => boolean }[] = [
    { bucket: '<= -1R', test: (r) => r <= -1 },
    { bucket: '-1 to -0.5', test: (r) => r > -1 && r <= -0.5 },
    { bucket: '-0.5 to 0', test: (r) => r > -0.5 && r < 0 },
    { bucket: '0 to +1', test: (r) => r >= 0 && r <= 1 },
    { bucket: '+1 to +2', test: (r) => r > 1 && r <= 2 },
    { bucket: '+2 to +3', test: (r) => r > 2 && r <= 3 },
    { bucket: '> +3R', test: (r) => r > 3 },
  ];
  return buckets.map((b) => ({ bucket: b.bucket, count: rs.filter(b.test).length }));
}
