import type {
  AiAnalysisResult,
  AnalysisReport,
  RiskAssessment,
  SetupScore,
  TimeframeAlignment,
  TradePlanResult,
} from '../../shared/types.js';
import { fmtNum, fmtPct, fmtPrice } from '../lib/format.js';
import { Badge, DataUnavailable, Explain, Panel, StatRow, WarningList } from './primitives.js';

/**
 * SETUP SCORE panel.
 *
 * Shows the number, then immediately shows every factor that produced it -
 * including the ones that could not be evaluated. The whole point is that the
 * user can see WHY, so the breakdown is not hidden behind a toggle.
 */
export function SetupScorePanel({ score }: { score: SetupScore | null }) {
  if (!score) {
    return (
      <DataUnavailable reason="No setup score: none of the five predefined strategies currently satisfies its conditions on this timeframe. A score is only produced when there is a setup to score." />
    );
  }

  const tone = score.score >= 75 ? 'text-term-up' : score.score >= 50 ? 'text-term-warn' : 'text-term-down';

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-baseline gap-2">
          <span className={`num text-3xl font-bold ${tone}`}>{score.score}</span>
          <span className="text-sm text-term-dim">/ 100</span>
          <Explain termKey="setup-score" />
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-term-border">
          <div
            className={`h-full ${score.score >= 75 ? 'bg-term-up' : score.score >= 50 ? 'bg-term-warn' : 'bg-term-down'}`}
            style={{ width: `${Math.max(0, Math.min(100, score.score))}%` }}
          />
        </div>
        <p className="mt-1.5 text-[11px] text-term-dim">
          Counts satisfied conditions out of the {score.evaluatedMax} checklist points that could be
          evaluated with available data. This is not a prediction and not a probability.
        </p>
      </div>

      {score.reasons.length > 0 ? (
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-term-dim">
            Reasons
          </div>
          <ul className="space-y-1">
            {score.reasons.map((reason) => (
              <li key={reason} className="flex gap-2 text-[11px] text-term-up">
                <span aria-hidden>✓</span>
                <span className="text-term-text">{reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <WarningList warnings={score.warnings} />

      <details className="rounded border border-term-border">
        <summary className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-term-dim hover:text-term-text">
          Full factor breakdown ({score.factors.filter((f) => f.evaluated).length} evaluated,{' '}
          {score.factors.filter((f) => !f.evaluated).length} not evaluated)
        </summary>
        <div className="space-y-2 border-t border-term-border p-2.5">
          {score.factors.map((factor) => (
            <div key={factor.key}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-medium text-term-text">{factor.label}</span>
                <span className="num text-[11px] text-term-muted">
                  {factor.evaluated ? `${factor.points.toFixed(1)} / ${factor.max}` : 'NOT EVALUATED'}
                </span>
              </div>
              <div className="mt-0.5 h-1 w-full overflow-hidden rounded bg-term-border">
                <div
                  className={factor.evaluated ? 'h-full bg-term-info' : 'h-full bg-term-dim/30'}
                  style={{ width: factor.evaluated ? `${(factor.points / factor.max) * 100}%` : '100%' }}
                />
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-term-dim">{factor.detail}</p>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

/** RISK panel. Higher is worse, and the copy says so at every opportunity. */
export function RiskPanel({ risk }: { risk: RiskAssessment | null }) {
  if (!risk) {
    return <DataUnavailable reason="Risk could not be assessed: neither market data nor chart data was available for this asset." />;
  }

  const toneByBand: Record<RiskAssessment['band'], string> = {
    low: 'text-term-up',
    moderate: 'text-term-info',
    elevated: 'text-term-warn',
    high: 'text-term-down',
    extreme: 'text-term-down',
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-baseline gap-2">
          <span className={`num text-3xl font-bold ${toneByBand[risk.band]}`}>{risk.score}</span>
          <span className="text-sm text-term-dim">/ 100</span>
          <Badge tone={risk.band === 'low' ? 'up' : risk.band === 'moderate' ? 'info' : risk.band === 'elevated' ? 'warn' : 'down'}>
            {risk.band}
          </Badge>
          <Explain termKey="risk-score" />
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-term-border">
          <div
            className={risk.score >= 60 ? 'h-full bg-term-down' : risk.score >= 40 ? 'h-full bg-term-warn' : 'h-full bg-term-up'}
            style={{ width: `${Math.max(0, Math.min(100, risk.score))}%` }}
          />
        </div>
        <p className="mt-1.5 text-[11px] text-term-dim">
          Higher means more hazardous. Computed from the {risk.evaluatedMax} of 108 hazard points that
          had data. This is not a probability of loss, and it is not a scam detector.
        </p>
      </div>

      <WarningList warnings={risk.warnings} tone="down" />

      {risk.unavailable.length > 0 ? (
        <div className="rounded border border-term-border bg-term-panel-2 p-2.5">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-term-dim">
            Could not be assessed
          </div>
          <ul className="space-y-0.5">
            {risk.unavailable.map((item) => (
              <li key={item} className="text-[11px] text-term-muted">
                · {item}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <details className="rounded border border-term-border">
        <summary className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-term-dim hover:text-term-text">
          Full hazard breakdown
        </summary>
        <div className="space-y-2 border-t border-term-border p-2.5">
          {risk.factors.map((factor) => (
            <div key={factor.key}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-medium text-term-text">{factor.label}</span>
                <span className="num text-[11px] text-term-muted">
                  {factor.evaluated ? `${factor.points.toFixed(1)} / ${factor.max}` : 'NOT EVALUATED'}
                </span>
              </div>
              <p className="mt-0.5 text-[10px] leading-relaxed text-term-dim">{factor.detail}</p>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

/** TIMEFRAME ALIGNMENT ladder: 1D down to the entry timeframe. */
export function AlignmentPanel({ alignment }: { alignment: TimeframeAlignment }) {
  const tone =
    alignment.alignment === 'HIGH' ? 'up' : alignment.alignment === 'MODERATE' ? 'info' : 'warn';
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-term-dim">
          Alignment
        </span>
        <Badge tone={tone}>{alignment.alignment}</Badge>
        <Explain termKey="timeframe-alignment" />
      </div>
      <div className="space-y-1">
        {alignment.views.map((view) => (
          <div
            key={view.timeframe}
            className="flex items-center justify-between gap-2 rounded border border-term-border bg-term-panel-2 px-2 py-1"
          >
            <span className="num w-10 text-[11px] font-bold uppercase text-term-text">
              {view.timeframe}
            </span>
            {view.status === 'unavailable' ? (
              <span className="flex-1 text-right text-[10px] text-term-warn" title={view.reason}>
                DATA UNAVAILABLE
              </span>
            ) : (
              <>
                <span
                  className={`flex-1 text-right text-[11px] ${
                    view.bias === 'bullish'
                      ? 'text-term-up'
                      : view.bias === 'bearish'
                        ? 'text-term-down'
                        : 'text-term-muted'
                  }`}
                >
                  {view.bias}
                </span>
                <span className="w-40 text-right text-[10px] text-term-dim">{view.structure}</span>
              </>
            )}
          </div>
        ))}
      </div>
      <p className="text-[11px] leading-relaxed text-term-dim">{alignment.detail}</p>
    </div>
  );
}

/** TRADE PLAN panel. Shows a refusal, in full, when no valid plan exists. */
export function TradePlanPanel({ plan }: { plan: TradePlanResult }) {
  if (!plan.available) {
    return <DataUnavailable reason={plan.reason} />;
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Badge tone={plan.direction === 'long' ? 'up' : 'down'}>{plan.direction}</Badge>
        <span className="text-[11px] text-term-dim">
          Risk per unit {fmtPrice(plan.riskPerUnit)}
        </span>
      </div>
      <div>
        <StatRow label="Entry" value={fmtPrice(plan.entry)} tone="text-term-accent" />
        <StatRow label="Stop" value={fmtPrice(plan.stop)} tone="text-term-down" />
        <StatRow label="Invalidation" value={fmtPrice(plan.invalidation)} tone="text-term-down" />
        <StatRow
          label="TP1"
          value={`${fmtPrice(plan.targets.tp1)}  ·  ${fmtNum(plan.rr.tp1)}R`}
          tone="text-term-up"
          explainKey="r-multiple"
        />
        <StatRow label="TP2" value={`${fmtPrice(plan.targets.tp2)}  ·  ${fmtNum(plan.rr.tp2)}R`} tone="text-term-up" />
        <StatRow label="TP3" value={`${fmtPrice(plan.targets.tp3)}  ·  ${fmtNum(plan.rr.tp3)}R`} tone="text-term-up" />
      </div>
      <div className="rounded border border-term-down/40 bg-term-down/5 p-2.5">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-term-down">
          What invalidates this
        </div>
        <p className="text-[11px] leading-relaxed text-term-muted">{plan.invalidationReason}</p>
      </div>
      {plan.notes.length > 0 ? (
        <ul className="space-y-1">
          {plan.notes.map((note) => (
            <li key={note} className="text-[11px] leading-relaxed text-term-dim">
              · {note}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Market snapshot figures, each rendered as a dash when the provider omitted it. */
export function SnapshotPanel({ report }: { report: AnalysisReport }) {
  const snapshot = report.snapshot;
  if (!snapshot) {
    return <DataUnavailable reason="No market snapshot was returned for this asset." />;
  }
  const ageHours =
    snapshot.pairCreatedAt !== null ? (Date.now() - snapshot.pairCreatedAt) / 3_600_000 : null;

  return (
    <div>
      <StatRow label="Price" value={fmtPrice(snapshot.priceUsd)} />
      <StatRow label="Liquidity" value={fmtUsdOrDash(snapshot.liquidityUsd)} explainKey="liquidity" />
      <StatRow label="Market cap" value={fmtUsdOrDash(snapshot.marketCapUsd)} />
      <StatRow label="FDV" value={fmtUsdOrDash(snapshot.fdvUsd)} explainKey="fdv" />
      <StatRow label="Volume 24h" value={fmtUsdOrDash(snapshot.volume.h24)} />
      <StatRow label="Volume 1h" value={fmtUsdOrDash(snapshot.volume.h1)} />
      <StatRow
        label="Change 24h"
        value={fmtPct(snapshot.priceChangePct.h24)}
        tone={toneOf(snapshot.priceChangePct.h24)}
      />
      <StatRow
        label="Change 1h"
        value={fmtPct(snapshot.priceChangePct.h1)}
        tone={toneOf(snapshot.priceChangePct.h1)}
      />
      <StatRow
        label="Txns 1h"
        value={
          snapshot.txns.h1
            ? `${snapshot.txns.h1.buys} buy / ${snapshot.txns.h1.sells} sell`
            : '—'
        }
      />
      <StatRow
        label="Pair age"
        value={ageHours === null ? '—' : ageHours < 48 ? `${ageHours.toFixed(1)}h` : `${(ageHours / 24).toFixed(1)}d`}
        tone={ageHours !== null && ageHours < 24 ? 'text-term-warn' : undefined}
        explainKey="pair-age"
      />
      <StatRow label="Holder concentration" value="Unavailable" tone="text-term-warn" explainKey="holder-concentration" />
      <StatRow label="ATR(14)" value={fmtPrice(report.indicators.atr14)} explainKey="atr" />
      <StatRow label="RSI(14)" value={fmtNum(report.indicators.rsi14, 1)} explainKey="rsi" />
      <StatRow label="VWAP (session)" value={fmtPrice(report.indicators.vwapSession)} explainKey="vwap" />
      <StatRow
        label="Relative volume"
        value={report.indicators.relativeVolume === null ? '—' : `${fmtNum(report.indicators.relativeVolume)}x`}
        explainKey="relative-volume"
      />
    </div>
  );
}

/** AI panel. Renders three cases side by side, never a single verdict. */
export function AiPanel({ analysis, loading }: { analysis: AiAnalysisResult | null; loading: boolean }) {
  if (loading) {
    return <p className="text-xs text-term-dim">Asking the model to evaluate the measurements…</p>;
  }
  if (!analysis) {
    return (
      <p className="text-xs text-term-dim">
        Run the analysis to get a structured reading of the measured conditions. The model is asked to
        argue all three cases and to name what would invalidate them — never to predict direction.
      </p>
    );
  }
  if (!analysis.available) {
    return <DataUnavailable reason={analysis.reason} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="info">Setup quality {analysis.setupQuality}/100</Badge>
        <Badge tone={analysis.evidenceConfidence === 'high' ? 'up' : analysis.evidenceConfidence === 'medium' ? 'warn' : 'down'}>
          Evidence: {analysis.evidenceConfidence}
        </Badge>
        <span className="text-[10px] text-term-dim">{analysis.model}</span>
      </div>
      <p className="text-[11px] leading-relaxed text-term-dim">{analysis.evidenceConfidenceReason}</p>

      <Case title="Bull case" tone="up" summary={analysis.bullCase.summary} items={analysis.bullCase.requirements} itemsLabel="What would need to happen" />
      <Case title="Bear case" tone="down" summary={analysis.bearCase.summary} items={analysis.bearCase.invalidations} itemsLabel="What would invalidate it" />
      <Case title="Neutral case" tone="neutral" summary={analysis.neutralCase.summary} items={analysis.neutralCase.implications} itemsLabel="If it stays range-bound" />

      {analysis.keyRisks.length > 0 ? <WarningList warnings={analysis.keyRisks} /> : null}
      {analysis.missingData.length > 0 ? (
        <div className="rounded border border-term-border bg-term-panel-2 p-2.5">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-term-dim">
            Data the model did not have
          </div>
          <ul className="space-y-0.5">
            {analysis.missingData.map((item) => (
              <li key={item} className="text-[11px] text-term-muted">· {item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-[10px] leading-relaxed text-term-dim">{analysis.disclaimer}</p>
    </div>
  );
}

function Case({
  title,
  tone,
  summary,
  items,
  itemsLabel,
}: {
  title: string;
  tone: 'up' | 'down' | 'neutral';
  summary: string;
  items: string[];
  itemsLabel: string;
}) {
  const border =
    tone === 'up' ? 'border-term-up/40' : tone === 'down' ? 'border-term-down/40' : 'border-term-border';
  const text = tone === 'up' ? 'text-term-up' : tone === 'down' ? 'text-term-down' : 'text-term-muted';
  return (
    <div className={`rounded border ${border} bg-term-panel-2 p-2.5`}>
      <div className={`mb-1 text-[10px] font-bold uppercase tracking-widest ${text}`}>{title}</div>
      <p className="mb-2 text-[11px] leading-relaxed text-term-text">{summary}</p>
      {items.length > 0 ? (
        <>
          <div className="mb-1 text-[10px] uppercase tracking-widest text-term-dim">{itemsLabel}</div>
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item} className="text-[11px] leading-relaxed text-term-muted">· {item}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function fmtUsdOrDash(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function toneOf(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return value > 0 ? 'text-term-up' : value < 0 ? 'text-term-down' : undefined;
}

export { Panel };
