import { clockTime, pct, price, shares, usd } from '../lib/format.js';
import { Badge, Card, Explain, Row } from './ui.js';

const CLASS_STYLE: Record<string, string> = {
  'STRONG BUY SETUP': 'bg-up text-bg border-up',
  'BUY WATCHLIST': 'bg-up/15 text-up border-up/50',
  HOLD: 'bg-info/15 text-info border-info/50',
  'SELL WATCH': 'bg-warn/15 text-warn border-warn/50',
  AVOID: 'bg-down/15 text-down border-down/50',
  'NO TRADE': 'bg-panel2 text-dim border-line',
};

export function ClassBadge({ c }: { c: string }) {
  return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-bold whitespace-nowrap ${CLASS_STYLE[c] ?? CLASS_STYLE['NO TRADE']}`}>{c}</span>;
}

export function StanceBadge({ s }: { s: string }) {
  return <Badge tone={s === 'bullish' ? 'up' : s === 'bearish' ? 'down' : 'dim'}>{s}</Badge>;
}

export function RiskBadge({ r }: { r: string }) {
  return <Badge tone={r === 'LOW' ? 'up' : r === 'HIGH' ? 'down' : 'warn'}>{r} risk</Badge>;
}

const pp = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(0)}%`);
const ret = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);

/** Forecast table: real probabilities only when a horizon is validated; otherwise the reason and the base rate. */
export function ForecastPanel({ forecasts }: { forecasts: Record<string, any> }) {
  const hs = ['1', '5', '20'];
  const anyOk = hs.some((h) => forecasts[h]?.status === 'OK');
  return (
    <Card title={<>Probability forecast<Explain term="probability forecast">A probability is only shown if the model beat simple benchmarks on years of data it never saw. "Direction" is the chance the price is higher after N trading days; "target first" is the separate chance of reaching +2 ATR before falling 1 ATR — reaching a profit target is a different, usually smaller, probability.</Explain></>}>
      {!anyOk && (
        <div className="mb-2 rounded-lg border border-warn/50 bg-warn/10 p-2 text-center text-sm font-bold text-warn">INSUFFICIENT EVIDENCE — no validated probability</div>
      )}
      {!anyOk && (
        <div className="space-y-1 text-xs">
          {hs.map((h) => forecasts[h] && (
            <div key={h} className="flex justify-between border-b border-line/60 py-1 last:border-0">
              <span>{h} trading day{h === '1' ? '' : 's'}</span>
              <span className="font-semibold text-warn">{forecasts[h].status}</span>
            </div>
          ))}
        </div>
      )}
      {anyOk && <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-dim">
            <tr>
              <th className="text-left">Horizon</th>
              <th className="text-right">P(higher)</th>
              <th className="text-right">P(lower)</th>
              <th className="text-right">Exp. return</th>
              <th className="text-right">Downside (10%)</th>
              <th className="text-right">Target first</th>
            </tr>
          </thead>
          <tbody className="num">
            {hs.map((h) => {
              const f = forecasts[h];
              if (!f) return null;
              return f.status === 'OK' ? (
                <tr key={h} className="border-t border-line/60">
                  <td className="py-1">{h} day{h === '1' ? '' : 's'}</td>
                  <td className="text-right text-up">{pp(f.pUp)}</td>
                  <td className="text-right text-down">{pp(f.pDown)}</td>
                  <td className="text-right">{ret(f.expectedReturn)}</td>
                  <td className="text-right">{ret(f.downside)}</td>
                  <td className="text-right">{pp(f.targetFirst)}</td>
                </tr>
              ) : (
                <tr key={h} className="border-t border-line/60">
                  <td className="py-1">{h} day{h === '1' ? '' : 's'}</td>
                  <td colSpan={5} className="text-right text-warn">{f.status}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>}
      <ul className="mt-2 space-y-1 text-[11px] text-dim">
        {hs.map((h) => forecasts[h] && forecasts[h].status !== 'OK' && <li key={h}><b>{h}-day:</b> {forecasts[h].reason}</li>)}
        <li>
          Historical base rate (all stocks, not a forecast for this one): {hs.map((h) => `${h}d ${pp(forecasts[h]?.baseRate)}`).join(' · ')} of periods ended higher in training data.
        </li>
        {anyOk && hs.map((h) => forecasts[h]?.status === 'OK' && <li key={`n${h}`}>{h}-day: based on {forecasts[h].bucketSamples} similar validation cases; 90% interval {pp(forecasts[h].pUpCi?.[0])}–{pp(forecasts[h].pUpCi?.[1])}.</li>)}
      </ul>
    </Card>
  );
}

export function OpportunityCard({ o, onOpen }: { o: any; onOpen: () => void }) {
  const f = o.forecasts['20'];
  return (
    <button onClick={onOpen} className="block w-full rounded-xl border border-line bg-panel p-3 text-left active:bg-panel2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-dim">#{o.rank}</span>
            <span className="text-base font-bold">{o.symbol}</span>
            <span className="num text-sm">{price(o.price ?? o.technicals.close)}</span>
          </div>
          <div className="truncate text-[11px] text-dim">{o.name ?? o.sector}{o.source === 'screener' ? ' · found by screener' : ''}</div>
        </div>
        <ClassBadge c={o.classification} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <StanceBadge s={o.stance} />
        <RiskBadge r={o.risk} />
        {o.held && <Badge tone="info">you own</Badge>}
        {o.sizing && <Badge tone={o.sizing.fit === 'FITS' ? 'up' : 'dim'}>{o.sizing.fit === 'FITS' ? 'fits your cash' : o.sizing.fit.toLowerCase()}</Badge>}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-[10px] text-dim uppercase">P(up) 20d</div>
          <div className="num font-semibold">{f?.status === 'OK' ? pp(f.pUp) : <span className="text-warn">insufficient</span>}</div>
        </div>
        <div>
          <div className="text-[10px] text-dim uppercase">Entry</div>
          <div className="num font-semibold">{o.plan ? `${price(o.plan.entryLow)}–${price(o.plan.entryHigh)}` : '—'}</div>
        </div>
        <div>
          <div className="text-[10px] text-dim uppercase">Stop / R:R</div>
          <div className="num font-semibold">{o.plan ? `${price(o.plan.stop)} · ${o.plan.rewardRisk.toFixed(1)}` : '—'}</div>
        </div>
      </div>
      <p className="mt-2 line-clamp-2 text-xs text-ink/80">{o.classReasons[0]}</p>
    </button>
  );
}

/** The eight points the user asked every recommendation to answer. */
export function ExplanationCard({ o }: { o: any }) {
  const e = o.explanation;
  const items: [string, React.ReactNode][] = [
    ['1. What the opportunity is', e.what],
    ['2. Why it might rise', e.whyRise.length ? <ul className="list-disc pl-4">{e.whyRise.map((x: string) => <li key={x}>{x}</li>)}</ul> : 'No bullish evidence found.'],
    ['3. What could make it fall', <ul key="f" className="list-disc pl-4">{e.whyFall.map((x: string) => <li key={x}>{x}</li>)}</ul>],
    ['4. Entry conditions', <ul key="e" className="list-disc pl-4">{e.entry.map((x: string) => <li key={x}>{x}</li>)}</ul>],
    ['5. Capital needed', e.capital],
    ['6. How much could be lost', e.loss],
    ['7. Realistic targets (if the move happens)', e.targets],
    ['8. When it becomes invalid', e.invalidation],
  ];
  return (
    <Card title="Recommendation explained" right={<ClassBadge c={o.classification} />}>
      <p className="mb-2 text-sm">{o.classReasons.join(' ')}</p>
      <div className="space-y-2 text-sm">
        {items.map(([k, v]) => (
          <div key={k}>
            <div className="text-xs font-semibold text-dim">{k}</div>
            <div className="text-ink/90">{v}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 rounded-lg border border-line bg-panel2 p-2 text-[11px] text-dim">{o.evidence} Nothing here is a promise of profit.</p>
    </Card>
  );
}

export function PlanSizing({ o }: { o: any }) {
  if (!o.plan) return null;
  const s = o.sizing;
  return (
    <Card title="Entry & exit plan">
      <Row label="Setup">{o.plan.label}</Row>
      <Row label="Entry range">{`${price(o.plan.entryLow)} – ${price(o.plan.entryHigh)}`}</Row>
      <Row label="Stop-loss">{price(o.plan.stop)}</Row>
      <Row label="Target 1 / Target 2">{`${price(o.plan.tp1)} / ${price(o.plan.tp2)}`}</Row>
      <Row label="Reward-to-risk">{o.plan.rewardRisk.toFixed(2)}</Row>
      {s && (
        <>
          <Row label="Your risk budget">{`${usd(s.riskBudget)} (2% of your equity)`}</Row>
          <Row label="Position you could take">{s.shares > 0 ? `${shares(s.shares)} sh · ${usd(s.notional)}` : '—'}</Row>
          <Row label="Est. costs (spread, slippage, fees)">{s.shares > 0 ? usd(s.costs, 3) : '—'}</Row>
          <Row label="Full $1-risk size needs">{usd(s.capitalNeededForFullSize)}</Row>
          <p className={`mt-2 text-xs ${s.fit === 'FITS' ? 'text-up' : 'text-warn'}`}>{s.message}</p>
        </>
      )}
    </Card>
  );
}

export function NewsList({ items, title = 'News & catalysts' }: { items: any[]; title?: string }) {
  return (
    <Card title={title} right={<span className="text-[10px] text-dim">Benzinga via Alpaca</span>}>
      {items.length === 0 && <p className="text-sm text-dim">No news in the last few days.</p>}
      <ul className="space-y-2">
        {items.map((n) => (
          <li key={n.id} className="text-sm">
            {n.url ? <a href={n.url} target="_blank" rel="noreferrer" className="font-semibold text-info">{n.headline}</a> : <span className="font-semibold">{n.headline}</span>}
            <div className="text-[11px] text-dim">{n.source} · {clockTime(n.time)}</div>
            {n.summary && <div className="line-clamp-3 text-xs text-ink/80">{n.summary}</div>}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-dim">Headlines are shown as published. They are not used in the forecast. Earnings dates are not connected — check them before any trade.</p>
    </Card>
  );
}

export const fmtPct = pct;
