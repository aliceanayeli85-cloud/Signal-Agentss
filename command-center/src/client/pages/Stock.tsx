import { useState } from 'react';
import type { Nav } from '../App.js';
import { ExplanationCard, ForecastPanel, NewsList, PlanSizing, RiskBadge, StanceBadge } from '../components/agent.js';
import { Badge, Banner, Button, Card, inputClass, Row } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';
import { pct, price, timeAgo } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';
import { AnalyzePage } from './Analyze.js';

/** Stock analysis: the agent's view (forecast, signals, plan, explanation, news) above the interactive chart. */
export function StockPage({ nav }: { nav: Nav }) {
  const [q, setQ] = useState('');
  const sym = nav.symbol;
  const r = useApi(sym ? `/api/agent/stock/${sym}` : null);
  const [msg, setMsg] = useState<string | null>(null);
  const o = r.data?.opportunity;
  const t = o?.technicals;

  const ticket = async (side: 'buy' | 'sell') => {
    setMsg(null);
    try {
      await api('/api/agent/tickets', { body: { symbol: sym, side } });
      nav.go('trade');
    } catch (e) {
      setMsg((e as ApiError).message);
    }
  };

  return (
    <>
      <div className="flex gap-2">
        <input className={inputClass} placeholder="Any ticker, e.g. KO" value={q} onChange={(e) => setQ(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === 'Enter' && q && nav.go('more', { more: 'stock', symbol: q })} autoCapitalize="characters" />
        <Button tone="primary" onClick={() => q && nav.go('more', { more: 'stock', symbol: q })}>Analyse</Button>
      </div>
      {r.loading && !o && <p className="text-sm text-dim">Analysing {sym} with real market data…</p>}
      {r.error && <Banner tone="down" title="Problem">{r.error.message}</Banner>}
      {o && (
        <>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{o.symbol}</h1>
              <span className="num text-lg">{price(o.price ?? t.close)}</span>
            </div>
            <div className="text-xs text-dim">{o.name ?? ''} · {o.sector}{o.priceTime ? ` · last trade ${timeAgo(o.priceTime)}` : ''} · daily data through {o.dataThrough}</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <StanceBadge s={o.stance} />
              <RiskBadge r={o.risk} />
              <Badge>{t.trend} (weekly {t.weeklyTrend})</Badge>
              {r.data.fromRun ? <Badge tone="dim">from latest scan</Badge> : <Badge tone="info">analysed just now</Badge>}
            </div>
          </div>
          <ExplanationCard o={o} />
          <div className="flex gap-2">
            {(o.classification === 'BUY WATCHLIST' || o.classification === 'STRONG BUY SETUP') && o.sizing?.fit === 'FITS' && <Button className="flex-1" tone="primary" onClick={() => ticket('buy')}>Prepare buy ticket</Button>}
            {o.held && <Button className="flex-1" onClick={() => ticket('sell')}>Prepare sell ticket</Button>}
          </div>
          {(o.classification === 'BUY WATCHLIST' || o.classification === 'STRONG BUY SETUP') && o.sizing && o.sizing.fit !== 'FITS' && <Banner tone="warn" title="No buy ticket: this does not fit your account">{o.sizing.message}</Banner>}
          {msg && <p className="text-xs text-warn">{msg}</p>}
          <ForecastPanel forecasts={o.forecasts} />
          <PlanSizing o={o} />
          <Card title="Signals found (completed daily candles)">
            {o.signals.length === 0 && <p className="text-sm text-dim">No scanner signal is active.</p>}
            <ul className="space-y-1.5">
              {o.signals.map((s: any) => (
                <li key={s.id} className="text-xs">
                  <Badge tone={s.direction === 'bullish' ? 'up' : s.direction === 'bearish' ? 'down' : 'dim'}>{s.label}</Badge> <span className="text-ink/85">{s.detail}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Technical readings">
            <div className="grid grid-cols-2 gap-x-4">
              <Row label="RSI 14">{t.rsi14?.toFixed(0) ?? '—'}</Row>
              <Row label="MACD hist.">{t.macdHist?.toFixed(2) ?? '—'}</Row>
              <Row label="50 / 200-day">{`${price(t.sma50)} / ${price(t.sma200)}`}</Row>
              <Row label="Bollinger %B">{t.bbPctB !== null ? t.bbPctB.toFixed(2) : '—'}</Row>
              <Row label="Volatility (ATR)">{pct(t.atrPct)}</Row>
              <Row label="Rel. volume">{t.relVolume?.toFixed(2) ?? '—'}×</Row>
              <Row label="20d vs SPY">{pct(t.relStrength20)}</Row>
              <Row label="Session VWAP">{price(t.dailyVwap)}</Row>
              <Row label="Support">{price(t.support)}</Row>
              <Row label="Resistance">{price(t.resistance)}</Row>
            </div>
          </Card>
          <NewsList items={o.news} />
        </>
      )}
      {sym && (
        <div className="pt-2">
          <h2 className="mb-2 text-sm font-semibold text-dim uppercase">Interactive chart</h2>
          <AnalyzePage nav={nav} />
        </div>
      )}
    </>
  );
}
