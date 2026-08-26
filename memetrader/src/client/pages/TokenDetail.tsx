import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type {
  AiAnalysisResult,
  BacktestResult,
  PaperTradeRecord,
  Timeframe,
  TokenReport,
} from '../../shared/types.js';
import { TIMEFRAMES } from '../../shared/types.js';
import { ApiError, api, qs } from '../lib/api.js';
import { fmtAgo, fmtDateTime, fmtNum, fmtPct, fmtPrice, fmtR, fmtUsd } from '../lib/format.js';
import { useApi, useNow } from '../lib/useApi.js';
import { AiPanel, AlignmentPanel, RiskPanel, SetupScorePanel, TradePlanPanel } from '../components/analysis.js';
import { PriceChart } from '../components/PriceChart.js';
import { TradeTicket } from '../components/TradeTicket.js';
import { Badge, Button, DataUnavailable, Explain, Loading, Panel, StatRow, WarningList } from '../components/primitives.js';

/**
 * Token detail page: chart, volume, liquidity, structure, indicators, setup
 * analysis, risk, entry plan, paper trade, this token's own trade history,
 * a backtest of the same rules on its bars, and the AI explanation.
 */
export function TokenDetail({
  address,
  timeframe: initialTimeframe,
  onBack,
}: {
  address: string;
  timeframe: Timeframe;
  onBack: () => void;
}) {
  const now = useNow(5000);
  const [timeframe, setTimeframe] = useState<Timeframe>(initialTimeframe);
  const [ai, setAi] = useState<AiAnalysisResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [backtest, setBacktest] = useState<BacktestResult | null>(null);
  const [backtestError, setBacktestError] = useState<string | null>(null);
  const [backtestRunning, setBacktestRunning] = useState(false);

  const report = useApi<TokenReport>(
    `/api/watchlist/tokens/${address}${qs({ timeframe, chain: 'solana' })}`,
    60_000,
  );
  const trades = useApi<{ trades: PaperTradeRecord[] }>('/api/trading/paper-trades');

  const data = report.data;

  const runAi = async () => {
    setAiLoading(true);
    setAi(null);
    try {
      setAi(await api.post<AiAnalysisResult>(`/api/watchlist/tokens/${address}/ai`, { timeframe }));
    } catch (error) {
      setAi({ available: false, reason: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setAiLoading(false);
    }
  };

  const runBacktest = async () => {
    if (!data?.assetId) return;
    setBacktestRunning(true);
    setBacktestError(null);
    setBacktest(null);
    try {
      setBacktest(
        await api.post<BacktestResult>('/api/backtest', {
          assetId: data.assetId,
          timeframe,
          strategies: ['breakout-retest', 'support-bounce', 'trend-continuation', 'range-breakout', 'failed-breakout'],
          stopRule: 'structure',
          atrMultiple: 1.5,
          targetR: 2,
          riskPct: 1,
          accountSize: 10_000,
          feesPct: 0.3,
          slippagePct: 0.5,
          trainFraction: 0.6,
          maxBarsInTrade: 60,
          bars: Math.max(120, data.candles.length),
        }),
      );
    } catch (error) {
      setBacktestError(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBacktestRunning(false);
    }
  };

  const tokenTrades = (trades.data?.trades ?? []).filter((t) => t.assetId === data?.assetId);

  const volumeSeries = (data?.candles ?? [])
    .slice(-80)
    .map((candle) => ({
      time: candle.time,
      volume: candle.volume ?? 0,
      up: candle.close >= candle.open,
    }));
  const hasVolume = (data?.candles ?? []).some((c) => c.volume !== null && c.volume > 0);

  return (
    <div className="h-full min-h-0 overflow-auto p-2">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Button onClick={onBack} variant="ghost">← Back to watchlist</Button>
        <span className="text-sm font-bold text-term-text">{data?.snapshot?.symbol ?? '…'}</span>
        <span className="text-[11px] text-term-muted">{data?.snapshot?.name ?? ''}</span>
        <span className="num text-[10px] text-term-dim">{address}</span>
        <div className="ml-auto flex items-center gap-1">
          {TIMEFRAMES.map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => setTimeframe(entry)}
              className={`num rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase transition ${
                timeframe === entry
                  ? 'border-term-accent/60 bg-term-accent/10 text-term-accent'
                  : 'border-term-border text-term-dim hover:text-term-text'
              }`}
            >
              {entry}
            </button>
          ))}
          <Button onClick={() => report.reload()} variant="ghost">Refresh</Button>
        </div>
      </div>

      {report.loading && !data ? (
        <Panel title="Loading"><Loading label="Building token report" /></Panel>
      ) : report.error ? (
        <Panel title="Token"><DataUnavailable reason={report.error.message} /></Panel>
      ) : !data ? null : !data.resolved ? (
        <Panel title="Token"><DataUnavailable reason={data.unavailableReason ?? 'Unresolved.'} /></Panel>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_380px] gap-2">
          <div className="flex min-w-0 flex-col gap-2">
            <Panel
              title="1 · Price chart"
              subtitle={`${data.candleSource} · ${data.candles.length} bars · newest bar ${fmtAgo(data.candleFetchedAt, now)}`}
            >
              <PriceChart
                candles={data.candles}
                annotations={data.annotations}
                unavailableReason={data.candles.length === 0 ? (data.candleReason ?? 'No bars stored for this timeframe yet — the background refresher collects them one series at a time.') : null}
              />
            </Panel>

            <Panel title="2 · Volume" explainKey="relative-volume">
              {!hasVolume || volumeSeries.length === 0 ? (
                <DataUnavailable reason="No usable volume was returned for this series." />
              ) : (
                <>
                  <div style={{ height: 150 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={volumeSeries} margin={{ top: 6, right: 6, bottom: 0, left: -12 }}>
                        <CartesianGrid stroke="#1c222c" strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="time" hide />
                        <YAxis stroke="#5a6474" fontSize={9} tickLine={false} width={54} />
                        <Tooltip
                          contentStyle={{ background: '#161b24', border: '1px solid #333d4e', fontSize: 11 }}
                          labelFormatter={(value) => fmtDateTime(Number(value) * 1000)}
                          formatter={(value) => [fmtUsd(Number(value ?? 0)), 'Volume']}
                        />
                        <Bar dataKey="volume">
                          {volumeSeries.map((entry) => (
                            <Cell key={entry.time} fill={entry.up ? '#2fd07a66' : '#ff5c5c66'} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-2">
                    <StatRow label="Relative volume" value={data.volume.relativeVolume === null ? '—' : `${fmtNum(data.volume.relativeVolume)}x`} />
                    <StatRow label="Acceleration" value={data.volume.acceleration === null ? '—' : `${fmtNum(data.volume.acceleration)}x`} />
                    <StatRow label="Trend" value={data.volume.trend} />
                    <StatRow
                      label="Price/volume divergence"
                      value={data.volume.priceVolumeDivergence === null ? '—' : fmtNum(data.volume.priceVolumeDivergence)}
                      tone={(data.volume.priceVolumeDivergence ?? 0) < 0 ? 'text-term-down' : 'text-term-up'}
                    />
                    <p
                      className={`mt-2 rounded border p-2 text-[11px] leading-relaxed ${
                        data.volume.flag === 'bullish-confirmation'
                          ? 'border-term-up/40 bg-term-up/5 text-term-up'
                          : data.volume.flag === 'warning'
                            ? 'border-term-down/40 bg-term-down/5 text-term-down'
                            : 'border-term-border text-term-muted'
                      }`}
                    >
                      {data.volume.headline}
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {data.volume.reasons.map((reason) => (
                        <li key={reason} className="text-[10px] leading-relaxed text-term-dim">· {reason}</li>
                      ))}
                    </ul>
                  </div>
                </>
              )}
            </Panel>

            <Panel title="3 · Liquidity" explainKey="liquidity">
              <StatRow label="Current pool" value={data.snapshot?.liquidityUsd === null || data.snapshot === null ? '—' : fmtUsd(data.snapshot.liquidityUsd)} />
              <StatRow
                label="Status"
                value={data.liquidity.label.replace('-', ' ').toUpperCase()}
                tone={data.liquidity.highRisk ? 'text-term-down' : data.liquidity.label === 'increasing' ? 'text-term-up' : undefined}
              />
              <StatRow label="Change" value={data.liquidity.changePct === null ? '—' : fmtPct(data.liquidity.changePct)} />
              <StatRow label="Observations" value={data.liquidity.observations} />
              <p className="mt-2 text-[11px] leading-relaxed text-term-muted">{data.liquidity.detail}</p>
              {data.liquidity.highRisk ? (
                <div className="mt-2">
                  <WarningList tone="down" warnings={['HIGH RISK — LIQUIDITY DETERIORATION. Entering is not recommended while liquidity is leaving this fast.']} />
                </div>
              ) : null}
            </Panel>

            <div className="grid grid-cols-2 gap-2">
              <Panel title="4 · Market structure">
                {!data.structure ? (
                  <DataUnavailable reason={data.candleReason ?? 'Not enough bars to classify structure.'} />
                ) : (
                  <div className="space-y-2">
                    <Badge tone={data.structure.bias === 'bullish' ? 'up' : data.structure.bias === 'bearish' ? 'down' : 'neutral'}>
                      {data.structure.label}
                    </Badge>
                    <ul className="space-y-1">
                      {data.structure.notes.map((note) => (
                        <li key={note} className="text-[11px] leading-relaxed text-term-muted">· {note}</li>
                      ))}
                    </ul>
                    <div className="pt-1">
                      <div className="mb-1 text-[10px] uppercase tracking-widest text-term-dim">Momentum ladder</div>
                      {data.momentum.readings.map((reading) => (
                        <StatRow
                          key={reading.timeframe}
                          label={reading.timeframe}
                          value={reading.status === 'ok' ? fmtPct(reading.changePct, 2) : reading.status.toUpperCase()}
                          tone={
                            reading.status !== 'ok'
                              ? 'text-term-warn'
                              : (reading.changePct ?? 0) > 0
                                ? 'text-term-up'
                                : 'text-term-down'
                          }
                          title={reading.reason}
                        />
                      ))}
                      <p className="mt-1 text-[10px] text-term-dim">{data.momentum.detail}</p>
                    </div>
                  </div>
                )}
              </Panel>

              <Panel title="5 · Technical indicators">
                <StatRow label="ATR(14)" value={fmtPrice(data.indicators.atr14)} explainKey="atr" />
                <StatRow label="RSI(14)" value={fmtNum(data.indicators.rsi14, 1)} explainKey="rsi" />
                <StatRow label="VWAP" value={fmtPrice(data.indicators.vwapSession)} explainKey="vwap" />
                <StatRow label="EMA20" value={fmtPrice(data.indicators.ema20)} />
                <StatRow label="EMA50" value={fmtPrice(data.indicators.ema50)} />
                <StatRow label="EMA200" value={fmtPrice(data.indicators.ema200)} />
                <div className="mt-2">
                  <AlignmentPanel alignment={data.alignment} />
                </div>
              </Panel>
            </div>

            <Panel title="10 · Historical trades on this token">
              {tokenTrades.length === 0 ? (
                <p className="text-[11px] text-term-dim">
                  No paper trades recorded on this token yet.
                </p>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-term-border text-[9px] uppercase tracking-widest text-term-dim">
                      <th className="px-1 py-1 text-left">#</th>
                      <th className="px-1 py-1 text-left">Strategy</th>
                      <th className="px-1 py-1 text-left">TF</th>
                      <th className="px-1 py-1 text-right">Entry</th>
                      <th className="px-1 py-1 text-right">Exit</th>
                      <th className="px-1 py-1 text-right">R</th>
                      <th className="px-1 py-1 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokenTrades.map((trade) => (
                      <tr key={trade.id} className="border-b border-term-border/40">
                        <td className="num px-1 py-1 text-[10px] text-term-dim">{trade.id}</td>
                        <td className="px-1 py-1 text-[10px] text-term-muted">{trade.strategy ?? '—'}</td>
                        <td className="num px-1 py-1 text-[10px] text-term-dim">{trade.timeframe}</td>
                        <td className="num px-1 py-1 text-right text-[10px]">{fmtPrice(trade.entry)}</td>
                        <td className="num px-1 py-1 text-right text-[10px]">{fmtPrice(trade.exitPrice)}</td>
                        <td className={`num px-1 py-1 text-right text-[10px] ${(trade.rMultiple ?? 0) >= 0 ? 'text-term-up' : 'text-term-down'}`}>
                          {fmtR(trade.rMultiple)}
                        </td>
                        <td className="px-1 py-1 text-[10px] text-term-dim">{trade.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            <Panel
              title="11 · Backtest on this token"
              subtitle="The same five strategies, run over the bars stored for this market"
              actions={
                <Button onClick={runBacktest} disabled={backtestRunning || data.candles.length < 80} variant="primary">
                  {backtestRunning ? 'Running…' : 'Run backtest'}
                </Button>
              }
            >
              {data.candles.length < 80 ? (
                <DataUnavailable reason={`Only ${data.candles.length} bars are stored for this market. A backtest needs at least 80 to mean anything, and its results would be noise below that.`} />
              ) : backtestError ? (
                <DataUnavailable reason={backtestError} />
              ) : !backtest ? (
                <p className="text-[11px] leading-relaxed text-term-dim">
                  Runs the strategies bar by bar over this token&apos;s stored history, filling entries at the next
                  bar&apos;s open and taking the stop whenever one bar spans both stop and target. Fees and slippage
                  default to meme-coin levels (0.3% per side, 0.5% slippage).
                </p>
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  {([['In-sample', backtest.inSample], ['Out-of-sample', backtest.outOfSample], ['Combined', backtest.combined]] as const).map(
                    ([label, metrics]) => (
                      <div key={label}>
                        <Badge tone={label === 'Out-of-sample' ? 'up' : 'neutral'}>{label}</Badge>
                        <StatRow label="Trades" value={metrics.trades} />
                        <StatRow label="Win rate" value={metrics.winRatePct === null ? '—' : fmtPct(metrics.winRatePct, 1)} />
                        <StatRow label="Expectancy" value={metrics.expectancyR === null ? '—' : `${metrics.expectancyR.toFixed(3)}R`} />
                        <StatRow label="Profit factor" value={metrics.profitFactor === null ? '—' : metrics.profitFactor.toFixed(2)} />
                        <StatRow label="Max drawdown" value={metrics.maxDrawdownR === null ? '—' : `${metrics.maxDrawdownR.toFixed(2)}R`} />
                      </div>
                    ),
                  )}
                  <div className="col-span-3">
                    <WarningList warnings={backtest.warnings} />
                    <p className="mt-2 rounded border border-term-warn/40 bg-term-warn/5 p-2 text-[11px] text-term-warn">
                      {backtest.disclaimer}
                    </p>
                  </div>
                </div>
              )}
            </Panel>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <Panel title="Status">
              <div className="space-y-2">
                <Badge
                  tone={
                    data.tradeStatus.status === 'ENTRY CONDITIONS MET'
                      ? 'up'
                      : data.tradeStatus.status === 'HIGH RISK' || data.tradeStatus.status === 'INVALIDATED'
                        ? 'down'
                        : data.tradeStatus.status === 'DATA UNAVAILABLE' || data.tradeStatus.status === 'NO TRADE'
                          ? 'warn'
                          : 'info'
                  }
                >
                  {data.tradeStatus.status}
                </Badge>
                <ul className="space-y-1">
                  {data.tradeStatus.reasons.map((reason) => (
                    <li key={reason} className="text-[11px] leading-relaxed text-term-muted">· {reason}</li>
                  ))}
                </ul>
              </div>
            </Panel>

            <Panel title="6 · Setup analysis">
              <SetupScorePanel score={data.setupScore} />
            </Panel>

            <Panel title="7 · Risk analysis">
              <RiskPanel risk={data.risk} />
              {data.tokenInfo ? (
                <div className="mt-3 border-t border-term-border pt-2">
                  <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-widest text-term-dim">
                    Contract &amp; holders
                    <Explain termKey="holder-concentration" />
                  </div>
                  <StatRow label="Holders" value={data.tokenInfo.holderCount?.toLocaleString('en-US') ?? 'Unavailable'} />
                  <StatRow label="Top 10 hold" value={data.tokenInfo.topTenPct === null ? 'Unavailable' : `${data.tokenInfo.topTenPct.toFixed(2)}%`} />
                  <StatRow label="Creator holds" value={data.tokenInfo.creatorHoldingPct === null ? 'Unavailable' : `${data.tokenInfo.creatorHoldingPct.toFixed(2)}%`} />
                  <StatRow label="Mint authority" value={data.tokenInfo.mintAuthority ?? 'Unavailable'} />
                  <StatRow label="Freeze authority" value={data.tokenInfo.freezeAuthority ?? 'Unavailable'} />
                  <StatRow label="Honeypot flag" value={data.tokenInfo.honeypot ?? 'Unavailable'} />
                  <StatRow label="Holder data age" value={fmtAgo(data.tokenInfo.holdersUpdatedAt, now)} />
                  <p className="mt-1 text-[10px] leading-relaxed text-term-dim">
                    These come from the data provider, not a security audit. There is no LP-lock check here.
                  </p>
                </div>
              ) : (
                <p className="mt-2 text-[11px] text-term-warn">
                  Holder and contract data unavailable: {data.tokenInfoReason}
                </p>
              )}
            </Panel>

            <Panel title="8 · Entry plan">
              <TradePlanPanel plan={data.plan} />
            </Panel>

            <Panel title="9 · Paper trade">
              {data.assetId && data.snapshot ? (
                <TradeTicket
                  report={null}
                  tokenReport={data}
                  assetId={data.assetId}
                  symbol={data.snapshot.symbol}
                  assetClass="meme"
                  timeframe={timeframe}
                  onRecorded={() => trades.reload()}
                />
              ) : (
                <DataUnavailable reason="No resolved pair, so a paper trade cannot be recorded." />
              )}
            </Panel>

            <Panel
              title="12 · AI explanation"
              actions={<Button onClick={runAi} disabled={aiLoading} variant="primary">Analyse</Button>}
            >
              <AiPanel analysis={ai} loading={aiLoading} />
            </Panel>

            {data.dataNotes.length > 0 ? (
              <Panel title="Data notes">
                <WarningList warnings={data.dataNotes} />
              </Panel>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
