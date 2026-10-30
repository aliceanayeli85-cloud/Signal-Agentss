import { useMemo, useState } from 'react';
import type { Nav } from '../App.js';
import { PriceChart, type ChartLine } from '../components/Chart.js';
import { PlanCard } from '../components/PlanCard.js';
import { Badge, Banner, Button, Card, ErrorBox, Explain, inputClass, Row, Segmented } from '../components/ui.js';
import { api, ApiError, newIdempotencyKey } from '../lib/api.js';
import { clockTime, price, shares, timeAgo, usd } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';

const TFS = [
  { value: '1Day', label: 'Daily' },
  { value: '1Hour', label: '1 hour' },
  { value: '15Min', label: '15 min' },
  { value: '5Min', label: '5 min' },
] as const;
type Tf = (typeof TFS)[number]['value'];

const TREND_TONE: Record<string, 'up' | 'down' | 'dim'> = { uptrend: 'up', downtrend: 'down', sideways: 'dim', unknown: 'dim' };

export function AnalyzePage({ nav }: { nav: Nav }) {
  const [tf, setTf] = useState<Tf>('1Day');
  const [input, setInput] = useState('');
  const symbol = nav.symbol;
  const watch = useApi('/api/watchlist', 60_000);
  const report = useApi(`/api/analysis/${symbol}?tf=${tf}`, 60_000);
  const r = report.data;

  const lines = useMemo<ChartLine[]>(() => {
    const out: ChartLine[] = [];
    const p = r?.plan;
    if (p?.plannedEntry != null) {
      out.push({ price: p.entryHigh, label: 'Entry', color: '#8b5cf6' });
      out.push({ price: p.stop, label: 'Stop', color: '#ff5c5c' });
      out.push({ price: p.tp1.price, label: 'TP1', color: '#2fd07a', dashed: true });
      out.push({ price: p.tp2.price, label: 'TP2', color: '#2fd07a', dashed: true });
    }
    if (r?.analysis?.support) out.push({ price: r.analysis.support.price, label: 'Support', color: '#2fd07a88', dashed: true });
    if (r?.analysis?.resistance) out.push({ price: r.analysis.resistance.price, label: 'Resistance', color: '#ff5c5c88', dashed: true });
    return out;
  }, [r]);

  const add = async () => {
    const s = input.trim().toUpperCase();
    if (!s) return;
    try {
      await api('/api/watchlist', { body: { symbol: s } });
      setInput('');
      watch.reload();
      nav.go('more', { more: nav.more === 'chart' ? 'chart' : 'stock', symbol: s });
    } catch (e) {
      alert((e as ApiError).message);
    }
  };

  return (
    <>
      <Card title="Watchlist">
        <div className="flex gap-2">
          <input className={inputClass} placeholder="Add ticker, e.g. AAPL" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} autoCapitalize="characters" />
          <Button tone="primary" onClick={add}>Add</Button>
        </div>
        {watch.data?.error && <p className="mt-2 text-xs text-down">{watch.data.error}</p>}
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {(watch.data?.symbols ?? []).map((w: any) => (
            <button key={w.symbol} onClick={() => nav.go('more', { more: nav.more === 'chart' ? 'chart' : 'stock', symbol: w.symbol })} className={`shrink-0 rounded-lg border px-3 py-1.5 text-left ${w.symbol === symbol ? 'border-info bg-info/10' : 'border-line bg-panel2'}`}>
              <div className="text-sm font-semibold">{w.symbol}</div>
              <div className="num text-xs">{price(w.quote?.price)}</div>
              <div className="text-[10px] text-dim">{w.quote ? timeAgo(w.quote.time) : 'no price'}</div>
            </button>
          ))}
        </div>
        {symbol && (watch.data?.symbols ?? []).some((w: any) => w.symbol === symbol) && (
          <button className="mt-1 text-[11px] text-dim underline" onClick={async () => (await api(`/api/watchlist/${symbol}`, { method: 'DELETE' }), watch.reload())}>
            Remove {symbol} from watchlist
          </button>
        )}
      </Card>

      <div className="flex items-center gap-2">
        <h1 className="text-xl font-bold">{symbol}</h1>
        <span className="num text-lg">{price(r?.quote?.price)}</span>
        {r?.quote && <span className="text-[11px] text-dim">last trade {timeAgo(r.quote.time)}</span>}
      </div>
      <Segmented value={tf} options={[...TFS]} onChange={setTf} />

      <ErrorBox error={report.error} />
      {report.loading && !r && <p className="text-sm text-dim">Loading real market data…</p>}
      {r?.quoteError && <Banner tone="warn" title="No current price">{r.quoteError}</Banner>}
      {r?.analysisError && <Banner tone="down" title="Chart data unavailable">{r.analysisError}</Banner>}

      {r && r.candles.length > 0 && (
        <Card title={`Chart · ${tf}`} right={<span className="text-[11px] text-dim">{r.quote?.source ?? ''}</span>}>
          <PriceChart candles={r.candles} ema9={r.overlays.ema9} ema20={r.overlays.ema20} vwap={r.overlays.vwap} lines={lines} />
          {r.formingCandle && (
            <p className="mt-2 text-[11px] text-warn">
              Forming candle (started {clockTime(r.formingCandle.t)}): O {price(r.formingCandle.o)} H {price(r.formingCandle.h)} L {price(r.formingCandle.l)} C {price(r.formingCandle.c)} — can still change; not used in the analysis.
            </p>
          )}
        </Card>
      )}

      {r?.analysis && <AnalysisCard r={r} />}

      {r?.multiTimeframe && (
        <Card title="Multiple timeframes">
          {r.multiTimeframe.map((m: any) => (
            <Row key={m.timeframe} label={m.timeframe}>
              {m.trend ? <Badge tone={TREND_TONE[m.trend]}>{m.trend}</Badge> : <span className="text-xs text-dim">{m.error ?? 'unavailable'}</span>}
            </Row>
          ))}
          <p className="mt-1 text-[11px] text-dim">Agreement across timeframes is stronger evidence than one chart alone. Disagreement is a reason for caution.</p>
        </Card>
      )}

      {r?.plan && (
        <>
          <PlanCard plan={r.plan} />
          <OrderActions plan={r.plan} timeframe={tf} nav={nav} onDone={report.reload} />
        </>
      )}

      {r?.dataNotes?.length > 0 && (
        <Card title="About this data">
          <ul className="list-disc space-y-1 pl-4 text-xs text-dim">
            {r.dataNotes.map((n: string) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-dim">Report generated {clockTime(r.generatedAt)}.</p>
        </Card>
      )}
    </>
  );
}

function AnalysisCard({ r }: { r: any }) {
  const a = r.analysis;
  return (
    <Card title="What the chart suggests" right={<span className="text-[11px] text-dim">{a.candlesUsed} completed candles</span>}>
      <ul className="list-disc space-y-1 pl-4 text-sm">
        {a.summary.map((s: string) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <div className="mt-3 grid grid-cols-2 gap-x-4">
        <Row label={<>RSI 14<Explain term="RSI">Relative Strength Index, 0–100. It measures how strong recent up-moves were versus down-moves. Above 70 = stretched up; below 30 = stretched down. Not a buy/sell signal on its own.</Explain></>}>{a.rsi14?.toFixed(1) ?? '—'}</Row>
        <Row label={<>ATR 14<Explain term="ATR">Average True Range: the typical size of one candle. Used to set stops that are not too tight for normal movement.</Explain></>}>{usd(a.atr14)}</Row>
        <Row label={<>EMA 9<Explain term="EMA">Exponential moving average: the average price, weighted toward recent candles. 9 is fast, 20 is slower. Price above both, with 9 above 20, is typical of an uptrend.</Explain></>}>{price(a.ema9)}</Row>
        <Row label="EMA 20">{price(a.ema20)}</Row>
        <Row label={<>VWAP<Explain term="VWAP">Volume-weighted average price for today's session. Above it, the average buyer today is in profit. Only meaningful on intraday charts.</Explain></>}>{a.vwap === null ? 'n/a' : price(a.vwap)}</Row>
        <Row label={<>Rel. volume<Explain term="relative volume">The last candle's volume compared with the average of the previous 20. Above 1.5x means unusual interest.</Explain></>}>{a.relativeVolume?.toFixed(2) ?? '—'}x</Row>
      </div>
      {a.patterns.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-semibold text-dim uppercase">Candlestick patterns (last 3 completed candles)</div>
          {a.patterns.map((p: any) => (
            <div key={`${p.name}-${p.time}`} className="mb-1 text-xs">
              <Badge tone={p.bias === 'bullish' ? 'up' : p.bias === 'bearish' ? 'down' : 'dim'}>{p.name}</Badge> <span className="text-dim">{clockTime(p.time)}</span>
              <div className="text-ink/80">{p.explanation}</div>
            </div>
          ))}
          <p className="text-[11px] text-dim">A pattern is evidence, never a guarantee.</p>
        </div>
      )}
      <div className="mt-3">
        <div className="mb-1 text-xs font-semibold text-warn uppercase">Evidence that is missing</div>
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-dim">
          {a.missingEvidence.map((m: string) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function OrderActions({ plan, timeframe, nav, onDone }: { plan: any; timeframe: string; nav: Nav; onDone: () => void }) {
  const [orderType, setOrderType] = useState<'limit' | 'market'>('limit');
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'up' | 'down' | 'info'; text: string } | null>(null);
  // One key per intended order: re-sending the same request can never create a second order.
  const [key, setKey] = useState(newIdempotencyKey);
  const reset = () => {
    setPreview(null);
    setKey(newIdempotencyKey());
  };

  if (plan.status !== 'TRADE_PLAN') return null;

  if (plan.entryStatus === 'waiting_for_trigger') {
    return (
      <Card title="Next step">
        <p className="text-sm">Confirmation has not happened. Instead of buying early, set an alert at the trigger price.</p>
        {msg && <p className={`mt-2 text-sm ${msg.tone === 'up' ? 'text-up' : 'text-down'}`}>{msg.text}</p>}
        <Button
          className="mt-2 w-full"
          tone="primary"
          onClick={async () => {
            try {
              const r = await api('/api/alerts/rules', { body: { symbol: plan.symbol, kind: 'price_above', price: Math.round(plan.entryLow * 100) / 100, note: `${plan.setupLabel} trigger` } });
              setMsg({ tone: 'up', text: r.duplicate ? 'That alert already exists.' : `Alert set: ${plan.symbol} ≥ ${price(plan.entryLow)}. This is an alert, not an order.` });
            } catch (e) {
              setMsg({ tone: 'down', text: (e as ApiError).message });
            }
          }}
        >
          Alert me at {price(plan.entryLow)}
        </Button>
      </Card>
    );
  }

  const createPreview = async () => {
    setBusy(true);
    setMsg(null);
    try {
      setPreview(await api('/api/orders/preview', { body: { symbol: plan.symbol, timeframe, orderType, idempotencyKey: `${key}-${orderType}` } }));
    } catch (e) {
      setMsg({ tone: 'down', text: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  };
  const approve = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/orders/${preview.id}/approve`, { body: { confirm: true } });
      setMsg({ tone: 'up', text: r.message });
      reset();
      onDone();
    } catch (e) {
      setMsg({ tone: 'down', text: (e as ApiError).message });
      reset();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Paper order" right={<Badge tone="paper">simulated</Badge>}>
      {!preview && (
        <>
          <Segmented value={orderType} options={[{ value: 'limit', label: 'Limit (recommended)' }, { value: 'market', label: 'Market' }]} onChange={setOrderType} />
          <p className="mt-2 text-[11px] text-dim">
            {orderType === 'limit' ? 'A limit order only buys at your price or better. If price runs away, it simply does not fill.' : 'A market order buys at whatever the price is. You may pay more than you see.'}
          </p>
          <Button className="mt-2 w-full" tone="primary" disabled={busy} onClick={createPreview}>
            Review paper order
          </Button>
          <Button className="mt-2 w-full" onClick={() => nav.go('more', { more: 'robinhood', symbol: plan.symbol })}>
            Real-money ticket for Robinhood…
          </Button>
        </>
      )}
      {preview && (
        <div className="space-y-2">
          <Banner tone="paper" title="Order preview — nothing has been bought yet">Check every line. Approval is required.</Banner>
          <Row label="Ticker">{preview.symbol}</Row>
          <Row label="Side">BUY</Row>
          <Row label="Quantity">{shares(preview.qty)} shares</Row>
          <Row label="Order type">{preview.orderType === 'limit' ? `Limit ${price(preview.limitPrice)}` : 'Market'}</Row>
          <Row label="Estimated price">{price(preview.estimatedPrice)}</Row>
          <Row label="Estimated value">{usd(preview.estimatedValue)}</Row>
          <Row label="Stop / TP1 / TP2">{price(preview.stop)} / {price(preview.tp1)} / {price(preview.tp2)}</Row>
          <Row label="Planned risk">{usd(preview.plannedRisk)}</Row>
          <p className="text-xs text-down">{preview.potentialLoss}</p>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-dim">
            {[...preview.protectiveOrders, ...preview.warnings].map((w: string) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <p className="text-[11px] text-dim">Preview expires {clockTime(preview.expiresAt)}.</p>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={async () => (await api(`/api/orders/${preview.id}/cancel`, { body: {} }).catch(() => null), reset())}>
              Cancel
            </Button>
            <Button className="flex-1" tone="primary" disabled={busy} onClick={approve}>
              Approve paper order
            </Button>
          </div>
        </div>
      )}
      {msg && <p className={`mt-2 text-sm ${msg.tone === 'up' ? 'text-up' : msg.tone === 'down' ? 'text-down' : 'text-info'}`}>{msg.text}</p>}
    </Card>
  );
}
