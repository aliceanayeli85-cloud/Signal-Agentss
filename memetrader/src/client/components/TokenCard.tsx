import type { TokenReport } from '../../shared/types.js';
import { fmtAgo, fmtNum, fmtPct, fmtPrice, fmtUsd } from '../lib/format.js';
import { useNow } from '../lib/useApi.js';
import { Badge, DataUnavailable, Explain } from './primitives.js';

const STATUS_TONE: Record<string, 'up' | 'down' | 'warn' | 'info' | 'neutral'> = {
  'ENTRY CONDITIONS MET': 'up',
  'SETUP FORMING': 'info',
  'WAIT FOR RETEST': 'info',
  WATCH: 'neutral',
  'HIGH RISK': 'down',
  INVALIDATED: 'down',
  'NO TRADE': 'warn',
  'DATA UNAVAILABLE': 'warn',
};

/**
 * One token card.
 *
 * Every field renders a dash when the provider did not return it. The card never
 * hides a missing value behind a plausible-looking zero, which is why so many
 * cells are explicitly nullable.
 */
export function TokenCard({
  report,
  onOpen,
}: {
  report: TokenReport;
  onOpen: (address: string) => void;
}) {
  const now = useNow(5000);

  if (!report.resolved) {
    return (
      <div className="rounded border border-term-warn/40 bg-term-panel p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="num truncate text-[11px] text-term-muted">{report.requestedAddress}</span>
          <Badge tone="warn">DATA UNAVAILABLE</Badge>
        </div>
        <DataUnavailable reason={report.unavailableReason ?? 'This address could not be resolved.'} />
      </div>
    );
  }

  const s = report.snapshot;
  const info = report.tokenInfo;
  const tone = STATUS_TONE[report.tradeStatus.status] ?? 'neutral';

  return (
    <div className="flex flex-col rounded border border-term-border bg-term-panel">
      <header className="flex items-start justify-between gap-2 border-b border-term-border p-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-bold text-term-text">{s?.symbol ?? '—'}</span>
            <span className="truncate text-[11px] text-term-muted">{s?.name ?? '—'}</span>
          </div>
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(report.requestedAddress)}
            title="Copy contract address"
            className="num mt-0.5 block max-w-full truncate text-[10px] text-term-dim hover:text-term-info"
          >
            {report.requestedAddress}
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {report.chain ? <Badge>{report.chain}</Badge> : null}
            {report.dex ? <Badge>{report.dex}</Badge> : null}
            {report.candleStale ? <Badge tone="warn">CHART CATCHING UP</Badge> : null}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="num text-sm font-bold text-term-text">{fmtPrice(s?.priceUsd)}</div>
          <div className={`num text-[11px] ${(s?.priceChangePct.h24 ?? 0) >= 0 ? 'text-term-up' : 'text-term-down'}`}>
            {fmtPct(s?.priceChangePct.h24, 1)} 24h
          </div>
        </div>
      </header>

      <div className="border-b border-term-border p-3">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <Badge tone={tone}>{report.tradeStatus.status}</Badge>
          {report.setupScore ? (
            <span className="text-[10px] text-term-muted">
              Setup {report.setupScore.score}/100
            </span>
          ) : null}
          {report.risk ? (
            <span className="text-[10px] text-term-muted">Risk {report.risk.score}/100</span>
          ) : null}
        </div>
        <ul className="space-y-0.5">
          {report.tradeStatus.reasons.slice(0, 3).map((reason) => (
            <li key={reason} className="text-[10px] leading-relaxed text-term-dim">· {reason}</li>
          ))}
        </ul>
      </div>

      {report.chasing.triggered ? (
        <div className="border-b border-term-warn/40 bg-term-warn/5 px-3 py-2">
          <div className="text-[10px] font-bold uppercase tracking-widest text-term-warn">
            {report.chasing.headline}
          </div>
          <p className="mt-0.5 text-[10px] leading-relaxed text-term-warn">{report.chasing.message}</p>
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-x-3 gap-y-1.5 border-b border-term-border p-3">
        <Cell label="Market cap" value={fmtUsdOr(s?.marketCapUsd)} />
        <Cell label="Liquidity" value={fmtUsdOr(s?.liquidityUsd)} explainKey="liquidity" />
        <Cell label="FDV" value={fmtUsdOr(s?.fdvUsd)} explainKey="fdv" />
        <Cell label="Vol 5m" value={fmtUsdOr(s?.volume.m5)} />
        <Cell label="Vol 1h" value={fmtUsdOr(s?.volume.h1)} />
        <Cell label="Vol 24h" value={fmtUsdOr(s?.volume.h24)} />
        <Cell label="5m" value={fmtPct(s?.priceChangePct.m5, 1)} tone={toneOf(s?.priceChangePct.m5)} />
        <Cell label="1h" value={fmtPct(s?.priceChangePct.h1, 1)} tone={toneOf(s?.priceChangePct.h1)} />
        <Cell label="6h" value={fmtPct(s?.priceChangePct.h6, 1)} tone={toneOf(s?.priceChangePct.h6)} />
        <Cell label="24h" value={fmtPct(s?.priceChangePct.h24, 1)} tone={toneOf(s?.priceChangePct.h24)} />
        <Cell
          label="Buys / sells"
          value={s?.txns.h24 ? `${s.txns.h24.buys} / ${s.txns.h24.sells}` : '—'}
        />
        <Cell
          label="Buy/sell ratio"
          value={report.buySellRatio === null ? '—' : fmtNum(report.buySellRatio)}
          tone={report.buySellRatio !== null && report.buySellRatio < 0.8 ? 'text-term-down' : undefined}
        />
        <Cell
          label="Pair age"
          value={
            report.pairAgeHours === null
              ? '—'
              : report.pairAgeHours < 48
                ? `${report.pairAgeHours.toFixed(1)}h`
                : `${(report.pairAgeHours / 24).toFixed(1)}d`
          }
          tone={report.pairAgeHours !== null && report.pairAgeHours < 24 ? 'text-term-warn' : undefined}
          explainKey="pair-age"
        />
        <Cell
          label="Holders"
          value={info?.holderCount === null || info === null ? 'Unavailable' : info.holderCount.toLocaleString('en-US')}
          tone={info?.holderCount == null ? 'text-term-warn' : undefined}
        />
        <Cell
          label="Top 10 hold"
          value={info?.topTenPct == null ? 'Unavailable' : `${info.topTenPct.toFixed(1)}%`}
          tone={
            info?.topTenPct == null
              ? 'text-term-warn'
              : info.topTenPct > 40
                ? 'text-term-down'
                : undefined
          }
          explainKey="holder-concentration"
        />
        <Cell
          label="Creator holds"
          value={info?.creatorHoldingPct == null ? 'Unavailable' : `${info.creatorHoldingPct.toFixed(2)}%`}
          tone={
            info?.creatorHoldingPct == null
              ? 'text-term-warn'
              : info.creatorHoldingPct > 10
                ? 'text-term-down'
                : undefined
          }
        />
        <Cell
          label="Mint authority"
          value={info?.mintAuthority ?? 'Unavailable'}
          tone={info?.mintAuthority === 'yes' ? 'text-term-down' : info?.mintAuthority ? undefined : 'text-term-warn'}
        />
        <Cell
          label="Freeze authority"
          value={info?.freezeAuthority ?? 'Unavailable'}
          tone={info?.freezeAuthority === 'yes' ? 'text-term-down' : info?.freezeAuthority ? undefined : 'text-term-warn'}
        />
      </div>

      <div className="space-y-1.5 border-b border-term-border p-3">
        <Line
          label="Liquidity status"
          value={report.liquidity.label.replace('-', ' ')}
          tone={
            report.liquidity.highRisk
              ? 'text-term-down'
              : report.liquidity.label === 'increasing'
                ? 'text-term-up'
                : report.liquidity.label === 'insufficient-history'
                  ? 'text-term-warn'
                  : 'text-term-muted'
          }
          detail={report.liquidity.detail}
        />
        <Line
          label="Volume"
          value={report.volume.flag.replace('-', ' ')}
          tone={
            report.volume.flag === 'bullish-confirmation'
              ? 'text-term-up'
              : report.volume.flag === 'warning'
                ? 'text-term-down'
                : 'text-term-muted'
          }
          detail={report.volume.headline}
        />
        <Line
          label="Structure"
          value={report.structure?.label ?? 'unavailable'}
          tone={report.structure ? 'text-term-muted' : 'text-term-warn'}
          detail={report.structure?.notes[0] ?? report.candleReason ?? 'No chart data yet.'}
        />
        <div>
          <div className="text-[9px] uppercase tracking-widest text-term-dim">Momentum</div>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {report.momentum.readings.map((reading) => (
              <span
                key={reading.timeframe}
                title={reading.reason ?? ''}
                className={`num rounded border px-1 py-0.5 text-[9px] ${
                  reading.status !== 'ok'
                    ? 'border-term-border text-term-dim'
                    : (reading.changePct ?? 0) > 0
                      ? 'border-term-up/40 text-term-up'
                      : 'border-term-down/40 text-term-down'
                }`}
              >
                {reading.timeframe}{' '}
                {reading.status === 'ok' ? fmtPct(reading.changePct, 1) : reading.status === 'unavailable' ? 'n/a' : '—'}
              </span>
            ))}
          </div>
        </div>
      </div>

      <footer className="flex items-center justify-between gap-2 p-3">
        <span className="text-[10px] text-term-dim">
          Data {fmtAgo(s?.fetchedAt ?? null, now)}
          {report.candleFetchedAt !== null ? ` · newest bar ${fmtAgo(report.candleFetchedAt, now)}` : ''}
        </span>
        <button
          type="button"
          onClick={() => onOpen(report.requestedAddress)}
          className="rounded border border-term-info/60 bg-term-info/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-term-info transition hover:bg-term-info/20"
        >
          Open detail
        </button>
      </footer>
    </div>
  );
}

function Cell({
  label,
  value,
  tone,
  explainKey,
}: {
  label: string;
  value: string;
  tone?: string;
  explainKey?: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-1 text-[9px] uppercase tracking-widest text-term-dim">
        {label}
        {explainKey ? <Explain termKey={explainKey} /> : null}
      </div>
      <div className={`num text-[11px] ${tone ?? 'text-term-text'}`}>{value}</div>
    </div>
  );
}

function Line({
  label,
  value,
  tone,
  detail,
}: {
  label: string;
  value: string;
  tone: string;
  detail: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[9px] uppercase tracking-widest text-term-dim">{label}</span>
        <span className={`text-[10px] font-semibold uppercase ${tone}`}>{value}</span>
      </div>
      <p className="text-[10px] leading-relaxed text-term-dim">{detail}</p>
    </div>
  );
}

function fmtUsdOr(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : fmtUsd(value);
}

function toneOf(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return value > 0 ? 'text-term-up' : value < 0 ? 'text-term-down' : undefined;
}
