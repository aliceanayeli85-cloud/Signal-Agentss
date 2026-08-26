import { useState } from 'react';
import type { AssetClass, Level, Timeframe } from '../../shared/types.js';
import { Scanner } from '../components/Scanner.js';
import { Panel, DataUnavailable, Freshness, Loading, StatRow, Badge, WarningList, Explain } from '../components/primitives.js';
import { fmtPrice, fmtNum, fmtInt } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';
import { qs } from '../lib/api.js';

interface LevelsResponse {
  previousDayHigh: number | null;
  previousDayLow: number | null;
  previousDayClose: number | null;
  openPrice: number | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  vwap: number | null;
  relativeVolume: number | null;
  sessionVolume: number | null;
  premarketHigh: number | null;
  premarketLow: number | null;
  premarketNote: string;
  structure: string | null;
  levels: Level[];
  detections: { strategyName: string; direction: string; entry: number; stop: number }[];
  setupScore: { score: number } | null;
  plan: { available: boolean; reason?: string } | null;
  notes: string[];
  sources: { intraday: string; daily: string };
  fetchedAt: number;
}

const INTRADAY: Timeframe[] = ['1m', '5m', '15m', '1h'];

/**
 * DAY TRADE mode. Intraday reference levels plus the same structural analysis.
 *
 * Stock coverage depends on a key-gated provider; when none is configured the
 * scanner's Stocks tab says so rather than showing an empty table.
 */
export function DayTradeDesk() {
  const [selected, setSelected] = useState<{ assetId: string; symbol: string; assetClass: AssetClass } | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>('5m');

  const levels = useApi<LevelsResponse>(
    selected ? `/api/desk/daytrade/levels${qs({ assetId: selected.assetId, timeframe })}` : null,
  );

  return (
    <div className="grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)] gap-2 p-2">
      <div className="flex min-h-0 flex-col rounded border border-term-border bg-term-panel">
        <div className="border-b border-term-border px-3 py-2 text-[11px] font-semibold uppercase tracking-widest text-term-muted">
          Day trade · stocks, ETFs, crypto
        </div>
        {/* Crypto is the default here: it is the only day-tradable asset class
            that works without an API key. */}
        <Scanner selectedId={selected?.assetId ?? null} onSelect={setSelected} defaultTab="crypto" />
      </div>

      <div className="flex min-h-0 flex-col gap-2 overflow-auto">
        <Panel
          title={selected ? `${selected.symbol} · intraday levels` : 'Intraday levels'}
          subtitle={levels.data ? <Freshness fetchedAt={levels.fetchedAt} source={levels.data.sources.intraday} /> : undefined}
          actions={
            <div className="flex gap-1">
              {INTRADAY.map((entry) => (
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
            </div>
          }
        >
          {!selected ? (
            <p className="text-xs leading-relaxed text-term-dim">
              Day trading mode shows the reference levels intraday traders measure against: the
              previous day&apos;s high, low and close, the session open, session high and low, VWAP
              and relative volume. Stocks and ETFs need an API key — see Settings for which providers
              are connected. Crypto works without one.
            </p>
          ) : levels.loading && !levels.data ? (
            <Loading label="Loading levels" />
          ) : levels.error ? (
            <DataUnavailable reason={levels.error.message} />
          ) : levels.data ? (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <StatRow label="Previous day high" value={fmtPrice(levels.data.previousDayHigh)} />
                <StatRow label="Previous day low" value={fmtPrice(levels.data.previousDayLow)} />
                <StatRow label="Previous day close" value={fmtPrice(levels.data.previousDayClose)} />
                <StatRow label="Open" value={fmtPrice(levels.data.openPrice)} />
                <StatRow label="Session high" value={fmtPrice(levels.data.sessionHigh)} />
                <StatRow label="Session low" value={fmtPrice(levels.data.sessionLow)} />
              </div>
              <div>
                <StatRow label="VWAP" value={fmtPrice(levels.data.vwap)} explainKey="vwap" />
                <StatRow
                  label="Relative volume"
                  value={levels.data.relativeVolume === null ? '—' : `${fmtNum(levels.data.relativeVolume)}x`}
                  explainKey="relative-volume"
                />
                <StatRow label="Session volume" value={fmtInt(levels.data.sessionVolume)} />
                <StatRow label="Premarket high" value="Unavailable" tone="text-term-warn" />
                <StatRow label="Premarket low" value="Unavailable" tone="text-term-warn" />
                <StatRow
                  label="Structure"
                  value={levels.data.structure ?? '—'}
                  explainKey="consolidation"
                />
              </div>
            </div>
          ) : null}
        </Panel>

        {levels.data ? (
          <>
            <Panel title="Premarket coverage">
              <p className="text-[11px] leading-relaxed text-term-warn">{levels.data.premarketNote}</p>
            </Panel>

            <div className="grid grid-cols-2 gap-2">
              <Panel title="Levels in play" explainKey="support">
                {levels.data.levels.length === 0 ? (
                  <p className="text-[11px] text-term-dim">No levels identified from the bars available.</p>
                ) : (
                  <ul className="space-y-1">
                    {levels.data.levels.map((level) => (
                      <li
                        key={`${level.kind}-${level.price}`}
                        className="flex items-center justify-between gap-2 rounded border border-term-border bg-term-panel-2 px-2 py-1"
                      >
                        <Badge tone={level.kind === 'support' || level.kind === 'demand' ? 'up' : 'down'}>
                          {level.kind}
                        </Badge>
                        <span className="num text-[11px] text-term-text">{fmtPrice(level.price)}</span>
                        <span className="text-[10px] text-term-dim">{level.touches} touches</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <Panel title="Setups detected">
                <div className="space-y-2">
                  {levels.data.setupScore ? (
                    <div className="flex items-center gap-2">
                      <span className="num text-2xl font-bold text-term-text">
                        {levels.data.setupScore.score}
                      </span>
                      <span className="text-xs text-term-dim">/ 100 setup score</span>
                      <Explain termKey="setup-score" />
                    </div>
                  ) : null}
                  {levels.data.detections.length === 0 ? (
                    <p className="text-[11px] text-term-dim">
                      No predefined setup is firing on this timeframe right now.
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {levels.data.detections.map((detection) => (
                        <li key={detection.strategyName} className="rounded border border-term-border bg-term-panel-2 p-2">
                          <div className="flex items-center gap-2">
                            <Badge tone={detection.direction === 'long' ? 'up' : 'down'}>{detection.direction}</Badge>
                            <span className="text-[11px] font-semibold text-term-text">{detection.strategyName}</span>
                          </div>
                          <div className="num mt-1 text-[10px] text-term-dim">
                            Entry {fmtPrice(detection.entry)} · Stop {fmtPrice(detection.stop)}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {levels.data.plan && !levels.data.plan.available ? (
                    <p className="text-[11px] text-term-warn">{levels.data.plan.reason}</p>
                  ) : null}
                </div>
              </Panel>
            </div>

            {levels.data.notes.length > 0 ? (
              <Panel title="Data notes">
                <WarningList warnings={levels.data.notes} />
              </Panel>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
