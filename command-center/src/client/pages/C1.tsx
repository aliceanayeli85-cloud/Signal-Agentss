import { useState } from 'react';
import { Badge, Banner, Button, Card, Row, Stat } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';
import { clockTime, pct, pnlColor, price, shares, signedUsd, timeAgo, usd } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';

const n = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? '—' : x.toFixed(d));

export function C1Page() {
  const r = useApi('/api/c1', 60_000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const d = r.data;

  const processNow = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api('/api/c1/run', { body: {} });
      setMsg(res.run.error ? `Update failed: ${res.run.error}` : res.run.processed.length ? `Processed ${res.run.processed.length} new trading day(s).` : 'Up to date — no new completed trading day.');
      r.reload();
    } catch (e) {
      setMsg((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="rounded-xl border-2 border-warn bg-warn/10 p-3 text-center">
        <div className="text-base font-extrabold text-warn">{d?.label ?? 'EXPERIMENTAL — NOT PROVEN PROFITABLE'}</div>
        <div className="mt-1 text-xs text-ink/85">C1 trend following · PAPER ONLY · separate from the baseline paper account and from real money</div>
      </div>
      {r.error && <Banner tone="down" title="Problem">{r.error.message}</Banner>}
      {!d && !r.error && <p className="text-sm text-dim">Loading…</p>}
      {d && (
        <>
          <Card title="Status" right={<Button onClick={processNow} disabled={busy}>{busy ? 'Working…' : 'Process now'}</Button>}>
            <Row label="Processed through">{d.status.lastProcessedDate ?? 'nothing yet'}</Row>
            <Row label="Latest successful data update">{d.status.lastSuccessAt ? `${timeAgo(d.status.lastSuccessAt)} (${clockTime(d.status.lastSuccessAt)})` : 'never'}</Row>
            {d.status.lastError && <Row label="Last error">{`${d.status.lastError} (${clockTime(d.status.lastErrorAt)})`}</Row>}
            <p className="mt-2 text-[11px] text-dim">Uses completed daily candles only. Each trading day is processed once, after it closes. Simulated buys and sells use that day's official open (or the stop price), plus slippage — so a fill shows up after the session ends.</p>
            {msg && <p className="mt-2 text-xs text-info">{msg}</p>}
          </Card>
          {d.status.warnings.length > 0 && (
            <Banner tone="warn" title="Data-quality warnings">
              <ul className="list-disc pl-4">
                {d.status.warnings.map((w: string) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Banner>
          )}

          <Card title="Evaluation progress">
            <div className="flex items-end justify-between">
              <Stat label="Closed paper trades" value={`${d.protocol.closedTrades} / ${d.protocol.minTrades}`} />
              <span className="text-[11px] text-dim">started {d.protocol.startDate}</span>
            </div>
            <div className="mt-2 h-2 rounded-full bg-bg">
              <div className="h-2 rounded-full bg-paper" style={{ width: `${Math.min(100, (d.protocol.closedTrades / d.protocol.minTrades) * 100)}%` }} />
            </div>
            <p className="mt-2 text-xs text-dim">{d.protocol.feasibility.note}</p>
            <p className="mt-1 text-xs text-dim">Even 30 trades is not proof of profitability. Rules and benchmark stay frozen for the whole evaluation.</p>
          </Card>

          <Card title="Signals — not trades" right={<Badge tone="info">signal</Badge>}>
            {d.signals.pending.length === 0 && <p className="text-sm text-dim">No pending signals.</p>}
            {d.signals.pending.map((s: any) => (
              <div key={s.id} className="mb-2 rounded-lg border border-info/40 bg-info/10 p-2 text-sm">
                <div className="font-semibold">
                  {s.kind === 'entry' ? 'ENTRY' : 'EXIT'} SIGNAL · {s.symbol} · {s.signal_date}
                </div>
                <div className="text-xs text-ink/85">
                  {s.kind === 'entry'
                    ? `Closed ${price(s.signal_close)} above the 20-day high ${price(s.level)}. A simulated buy happens at the next open only if the risk rules allow it. Stop would be ${price(s.stop)}.`
                    : `Closed ${price(s.signal_close)} below the 10-day low ${price(s.level)}. Simulated sale at the next open.`}
                </div>
              </div>
            ))}
            {d.signals.recent.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-info">Recent resolved signals ({d.signals.recent.length})</summary>
                {d.signals.recent.map((s: any) => (
                  <div key={s.id} className="border-b border-line/60 py-1 text-xs last:border-0">
                    <Badge tone={s.status === 'executed' ? 'paper' : 'dim'}>{s.status}</Badge> {s.kind} {s.symbol} {s.signal_date} → {s.resolved_date}
                    {s.status_reason && <div className="text-dim">{s.status_reason}</div>}
                  </div>
                ))}
              </details>
            )}
          </Card>

          <Card title={`Open simulated positions (${d.open.length})`} right={<Badge tone="paper">simulated</Badge>}>
            {d.open.length === 0 && <p className="text-sm text-dim">None.</p>}
            {d.open.map((t: any) => {
              const w = d.watch?.find?.((x: any) => x.symbol === t.symbol);
              return (
                <div key={t.id} className="mb-2 rounded-lg border border-line bg-panel2 p-2">
                  <div className="flex justify-between">
                    <span className="font-semibold">{t.symbol}</span>
                    <span className={`num font-semibold ${pnlColor(t.unrealizedPnl)}`}>{signedUsd(t.unrealizedPnl)}</span>
                  </div>
                  <Row label="Bought (simulated)">{`${shares(t.shares)} sh at ${price(t.entry_fill)} on ${t.entry_date}`}</Row>
                  <Row label="Last close">{`${price(t.last_close)} (${t.last_close_date})`}</Row>
                  <Row label="Stop">{price(t.stop)}</Row>
                  <Row label="Planned risk">{`${usd(t.planned_risk)} — more if price gaps through the stop`}</Row>
                  <Row label="Worst / best so far (MAE / MFE)">{`${signedUsd(t.mae)} / ${signedUsd(t.mfe)}`}</Row>
                  <Row label="Days held">{t.bars_held} of 120</Row>
                  {w && <Row label="Exit if a close is below">{price(w.exitLevel)}</Row>}
                </div>
              );
            })}
          </Card>

          <Card title="Upcoming conditions (from the latest completed close)">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-dim">
                  <tr>
                    <th className="text-left">Ticker</th>
                    <th className="text-right">Close</th>
                    <th className="text-center">Above 100d avg</th>
                    <th className="text-right">Entry if close &gt;</th>
                    <th className="text-right">Exit if close &lt;</th>
                  </tr>
                </thead>
                <tbody className="num">
                  {(d.watch ?? []).map((w: any) => (
                    <tr key={w.symbol} className="border-t border-line/60">
                      <td className="py-1 font-semibold">{w.symbol}</td>
                      {w.available ? (
                        <>
                          <td className="text-right">{price(w.close)}</td>
                          <td className="text-center">{w.trendFilter ? '✓' : '✗'}</td>
                          <td className="text-right">{w.held ? <span className="text-dim">held</span> : `${price(w.entryLevel)} (${w.distanceToEntryPct > 0 ? '+' : ''}${n(w.distanceToEntryPct, 1)}%)`}</td>
                          <td className="text-right">{w.held ? price(w.exitLevel) : '—'}</td>
                        </>
                      ) : (
                        <td colSpan={4} className="text-dim">no data</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-[11px] text-dim">An entry also needs the trend filter (✓). These are conditions, not predictions.</p>
          </Card>

          <Card title="Paper P&L">
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Equity" value={usd(d.account.equity)} />
              <Stat label="Cash" value={usd(d.account.cash)} />
              <Stat label="Realized" value={signedUsd(d.account.realizedPnl)} className={pnlColor(d.account.realizedPnl)} />
              <Stat label="Unrealized (last close)" value={signedUsd(d.account.unrealizedPnl)} className={pnlColor(d.account.unrealizedPnl)} />
            </div>
          </Card>

          <Card title="Against the benchmark">
            <EquityChart points={d.comparison.equityCurve} />
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-dim">
                  <tr>
                    <th className="text-left" />
                    <th className="text-right">C1</th>
                    <th className="text-right">SPY buy & hold</th>
                    <th className="text-right">SPY same exposure</th>
                  </tr>
                </thead>
                <tbody className="num">
                  {[
                    ['Net return', (x: any) => (x.netReturnPct === null ? '—' : `${n(x.netReturnPct)}%`)],
                    ['Max drawdown', (x: any) => `${usd(x.maxDrawdownUsd)} (${n(x.maxDrawdownPct, 1)}%)`],
                    ['Volatility (yr)', (x: any) => (x.volatilityPct === null ? 'too few days' : `${n(x.volatilityPct, 1)}%`)],
                    ['Return ÷ volatility', (x: any) => (x.sharpeLike === null ? '< 60 days' : n(x.sharpeLike))],
                  ].map(([label, f]: any) => (
                    <tr key={label} className="border-t border-line/60">
                      <td className="py-1 text-dim">{label}</td>
                      <td className="text-right">{f(d.comparison.c1)}</td>
                      <td className="text-right">{f(d.comparison.buyAndHold)}</td>
                      <td className="text-right">{f(d.comparison.sameExposure)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-line/60">
                    <td className="py-1 text-dim">Market exposure</td>
                    <td className="text-right">{d.comparison.c1.exposureDaysPct === null ? '—' : `${n(d.comparison.c1.exposureDaysPct, 0)}% of days, avg ${n(d.comparison.c1.avgInvestedPct, 0)}% invested`}</td>
                    <td className="text-right">100%</td>
                    <td className="text-right">same as C1</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-dim">
              {d.benchmark.definitions.map((x: string) => (
                <li key={x}>{x}</li>
              ))}
              <li>{d.comparison.note}</li>
            </ul>
          </Card>

          <Card title={`Closed simulated trades (${d.metrics.trades})`}>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Net (after costs)" value={signedUsd(d.metrics.netPnl)} className={pnlColor(d.metrics.netPnl)} />
              <Stat label="Avg R" value={n(d.metrics.avgR)} />
              <Stat label="Profit factor" value={n(d.metrics.profitFactor)} />
              <Stat label="Win rate" value={pct(d.metrics.winRate, 0)} />
              <Stat label="Avg win / loss" value={`${usd(d.metrics.avgWin)} / ${usd(d.metrics.avgLoss)}`} />
              <Stat label="Gap stops" value={d.metrics.gapStops} sub={d.metrics.worstR !== null ? `worst ${n(d.metrics.worstR)}R` : undefined} />
              <Stat label="Slippage paid" value={usd(d.metrics.totalSlippage)} />
              <Stat label="Fees" value={usd(d.metrics.totalFees)} />
              <Stat label="Avg MAE / MFE" value={`${usd(d.metrics.avgMae)} / ${usd(d.metrics.avgMfe)}`} />
            </div>
            {d.byRegime.length > 0 && (
              <div className="mt-2 text-xs">
                <div className="font-semibold text-dim uppercase">By market condition at entry</div>
                {d.byRegime.map((g: any) => (
                  <Row key={g.regime} label={g.regime}>{`${g.trades} trades · avg ${n(g.avgR)}R · ${signedUsd(g.netPnl)}`}</Row>
                ))}
              </div>
            )}
            {d.closed.length > 0 && (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead className="text-dim">
                    <tr>
                      <th className="text-left">Ticker</th>
                      <th className="text-left">In → out</th>
                      <th className="text-right">Shares</th>
                      <th className="text-right">Entry → exit</th>
                      <th className="text-right">Risk</th>
                      <th className="text-right">P&L</th>
                      <th className="text-left">Exit reason</th>
                    </tr>
                  </thead>
                  <tbody className="num">
                    {d.closed.map((t: any) => (
                      <tr key={t.id} className="border-t border-line/60 align-top">
                        <td className="py-1 font-semibold">{t.symbol}</td>
                        <td>{t.entry_date} → {t.exit_date}</td>
                        <td className="text-right">{shares(t.shares)}</td>
                        <td className="text-right">{price(t.entry_fill)} → {price(t.exit_fill)}</td>
                        <td className="text-right">{usd(t.planned_risk)}</td>
                        <td className={`text-right ${pnlColor(t.pnl)}`}>{signedUsd(t.pnl)} ({n(t.r_multiple)}R)</td>
                        <td>{t.exit_reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Rules (pre-registered, frozen)">
            <ul className="list-disc space-y-0.5 pl-4 text-xs">
              {d.rules.map((x: string) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-dim">Universe: {d.universe.join(', ')}. Risk: $1 per trade (2% equity cap), $50 position cap, $2 max open risk, daily loss limit, kill switch — the same controls as the rest of the app. When more signals arrive than fit, they are taken in this fixed ticker order.</p>
          </Card>
        </>
      )}
    </>
  );
}

function EquityChart({ points }: { points: { date: string; c1: number; buyAndHold: number; sameExposure: number }[] }) {
  if (points.length < 2) return <p className="text-xs text-dim">The comparison chart appears after two processed trading days.</p>;
  const all = points.flatMap((p) => [p.c1, p.buyAndHold, p.sameExposure]);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const W = 320;
  const H = 120;
  const path = (k: 'c1' | 'buyAndHold' | 'sameExposure') =>
    points.map((p, i) => `${i ? 'L' : 'M'}${((i / (points.length - 1)) * W).toFixed(1)},${(H - ((p[k] - lo) / (hi - lo || 1)) * H).toFixed(1)}`).join(' ');
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-32 w-full" preserveAspectRatio="none" role="img" aria-label="Equity: C1 versus SPY benchmarks">
        <path d={path('buyAndHold')} fill="none" stroke="#4aa8ff" strokeWidth="1.5" />
        <path d={path('sameExposure')} fill="none" stroke="#8b98a9" strokeWidth="1.5" strokeDasharray="4 3" />
        <path d={path('c1')} fill="none" stroke="#8b5cf6" strokeWidth="2" />
      </svg>
      <div className="flex flex-wrap gap-3 text-[11px] text-dim">
        <span><span className="text-paper">━</span> C1</span>
        <span><span className="text-info">━</span> SPY buy & hold</span>
        <span>┄ SPY same exposure</span>
        <span>{points[0]!.date} → {points.at(-1)!.date}</span>
      </div>
    </div>
  );
}
