import { useState } from 'react';
import type { AiAnalysisResult, AnalysisReport, AssetClass, Timeframe } from '../../shared/types.js';
import { TIMEFRAMES } from '../../shared/types.js';
import { AiPanel, AlignmentPanel, RiskPanel, SetupScorePanel, SnapshotPanel, TradePlanPanel } from '../components/analysis.js';
import { PriceChart } from '../components/PriceChart.js';
import { Scanner, addToWatchlist } from '../components/Scanner.js';
import { TradeTicket } from '../components/TradeTicket.js';
import { Badge, Button, DataUnavailable, Freshness, Loading, Panel, WarningList } from '../components/primitives.js';
import { ApiError, api, qs } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';

export interface SelectedAsset {
  assetId: string;
  symbol: string;
  assetClass: AssetClass;
}

/**
 * The main desk: watchlist/scanner on the left, chart in the centre, analysis on
 * the right, trade ticket and data notes underneath.
 */
export function MemeDesk() {
  return <Desk defaultTimeframe="15m" title="Meme / on-chain desk" />;
}

export function Desk({
  defaultTimeframe,
  title,
  timeframes = TIMEFRAMES,
}: {
  defaultTimeframe: Timeframe;
  title: string;
  timeframes?: readonly Timeframe[];
}) {
  const [selected, setSelected] = useState<SelectedAsset | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>(defaultTimeframe);
  const [ai, setAi] = useState<AiAnalysisResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const analysisPath = selected
    ? `/api/market/analysis${qs({ assetId: selected.assetId, timeframe })}`
    : null;
  const analysis = useApi<AnalysisReport>(analysisPath);

  const runAi = async () => {
    if (!selected) return;
    setAiLoading(true);
    setAi(null);
    try {
      const result = await api.post<AiAnalysisResult>('/api/market/ai/analysis', {
        assetId: selected.assetId,
        timeframe,
      });
      setAi(result);
    } catch (error) {
      setAi({
        available: false,
        reason: error instanceof ApiError ? error.message : 'AI request failed.',
      });
    } finally {
      setAiLoading(false);
    }
  };

  const watch = async () => {
    if (!selected) return;
    try {
      await addToWatchlist({ ...selected, timeframe });
      setNotice(`${selected.symbol} added to the watchlist on ${timeframe}.`);
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : 'Could not add to watchlist.');
    }
  };

  const report = analysis.data;
  const chartUnavailable =
    report && report.candles.length === 0
      ? (report.dataNotes.find((note) => note.startsWith('Chart data unavailable')) ??
        'No chart data was returned for this market and timeframe.')
      : null;

  return (
    <div className="grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)_360px] gap-2 p-2">
      <div className="flex min-h-0 flex-col rounded border border-term-border bg-term-panel">
        <div className="border-b border-term-border px-3 py-2 text-[11px] font-semibold uppercase tracking-widest text-term-muted">
          {title}
        </div>
        <Scanner selectedId={selected?.assetId ?? null} onSelect={setSelected} />
      </div>

      <div className="flex min-h-0 flex-col gap-2 overflow-auto">
        <Panel
          title={selected ? `${selected.symbol} · ${timeframe}` : 'Chart'}
          subtitle={
            report ? (
              <Freshness fetchedAt={analysis.fetchedAt} source={report.candleSource} />
            ) : (
              'Select a market from the scanner'
            )
          }
          actions={
            <div className="flex items-center gap-1">
              {timeframes.map((entry) => (
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
              <Button onClick={() => analysis.reload()} variant="ghost">Refresh</Button>
              <Button onClick={watch} disabled={!selected}>Watch</Button>
            </div>
          }
        >
          {!selected ? (
            <p className="text-xs text-term-dim">
              Pick a market on the left. The chart marks support, resistance, supply and demand
              zones, identifiable liquidity sweeps, and — when a setup fires — the breakout, retest,
              confirmation, entry, stop and targets.
            </p>
          ) : analysis.loading && !report ? (
            <Loading label="Loading market" />
          ) : analysis.error ? (
            <DataUnavailable reason={analysis.error.message} />
          ) : report ? (
            <PriceChart
              candles={report.candles}
              annotations={report.annotations}
              unavailableReason={chartUnavailable}
            />
          ) : null}
        </Panel>

        {report ? (
          <div className="grid grid-cols-2 gap-2">
            <Panel title="Structure" explainKey={structureExplainKey(report.structure.label)}>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Badge
                    tone={
                      report.structure.bias === 'bullish'
                        ? 'up'
                        : report.structure.bias === 'bearish'
                          ? 'down'
                          : 'neutral'
                    }
                  >
                    {report.structure.label}
                  </Badge>
                  <span className="text-[11px] text-term-dim">{report.structure.bias}</span>
                </div>
                <ul className="space-y-1">
                  {report.structure.notes.map((note) => (
                    <li key={note} className="text-[11px] leading-relaxed text-term-muted">· {note}</li>
                  ))}
                </ul>
                <div className="pt-1">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-term-dim">
                    Detected setups
                  </div>
                  {report.detections.length === 0 ? (
                    <p className="text-[11px] text-term-muted">
                      None of the five defined strategies currently satisfies its conditions here.
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {report.detections.map((detection) => (
                        <li key={detection.strategy} className="rounded border border-term-border bg-term-panel-2 p-2">
                          <div className="flex items-center gap-2">
                            <Badge tone={detection.direction === 'long' ? 'up' : 'down'}>
                              {detection.direction}
                            </Badge>
                            <span className="text-[11px] font-semibold text-term-text">
                              {detection.strategyName}
                            </span>
                          </div>
                          <ul className="mt-1 space-y-0.5">
                            {detection.notes.map((note) => (
                              <li key={note} className="text-[10px] leading-relaxed text-term-dim">· {note}</li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </Panel>

            <Panel title="Multi-timeframe">
              <AlignmentPanel alignment={report.alignment} />
            </Panel>
          </div>
        ) : null}

        {report ? (
          <Panel
            title="AI analysis"
            subtitle="Structured reading of the measurements above — three cases, never a recommendation"
            actions={<Button onClick={runAi} disabled={aiLoading} variant="primary">Analyse</Button>}
          >
            <AiPanel analysis={ai} loading={aiLoading} />
          </Panel>
        ) : null}

        {report && report.dataNotes.length > 0 ? (
          <Panel title="Data notes">
            <WarningList warnings={report.dataNotes} />
          </Panel>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-col gap-2 overflow-auto">
        <Panel title="Setup score">
          <SetupScorePanel score={report?.setupScore ?? null} />
        </Panel>
        <Panel title="Risk score">
          <RiskPanel risk={report?.risk ?? null} />
        </Panel>
        <Panel title="Trade plan">
          {report ? (
            <TradePlanPanel plan={report.plan} />
          ) : (
            <p className="text-xs text-term-dim">Select a market to build a plan.</p>
          )}
        </Panel>
        <Panel title="Market data">
          {report ? <SnapshotPanel report={report} /> : <p className="text-xs text-term-dim">—</p>}
        </Panel>
        <Panel title="Paper trade ticket">
          {selected ? (
            <TradeTicket
              report={report}
              assetId={selected.assetId}
              symbol={selected.symbol}
              assetClass={selected.assetClass}
              timeframe={timeframe}
              onRecorded={() => setNotice('Paper trade recorded. Open the Journal tab to log the plan.')}
            />
          ) : (
            <p className="text-xs text-term-dim">Select a market to size and record a paper trade.</p>
          )}
        </Panel>
        {notice ? (
          <div className="rounded border border-term-info/40 bg-term-info/5 p-2.5 text-[11px] text-term-info">
            {notice}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function structureExplainKey(label: string): string {
  const known = [
    'higher-highs-higher-lows',
    'lower-highs-lower-lows',
    'consolidation',
    'reclaim',
    'failed-breakout',
  ];
  if (known.includes(label)) return label;
  if (label === 'breakout' || label === 'breakdown') return 'breakout';
  return 'consolidation';
}
