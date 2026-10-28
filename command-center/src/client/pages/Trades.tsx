import { useState } from 'react';
import type { Nav } from '../App.js';
import { Badge, Banner, Button, Card, Field, inputClass, Row, Segmented } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';
import { clockTime, pnlColor, price, shares, signedUsd, timeAgo, usd } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';

export function TradesPage({ nav }: { nav: Nav }) {
  const [mode, setMode] = useState<'paper' | 'live'>('paper');
  const pos = useApi(`/api/positions?mode=${mode}`, 30_000);
  const orders = useApi('/api/orders', 30_000);
  const open = (pos.data?.positions ?? []).filter((p: any) => p.status === 'open');
  const closed = (pos.data?.positions ?? []).filter((p: any) => p.status === 'closed');
  const working = (orders.data?.orders ?? []).filter((o: any) => o.status === 'working' || o.status === 'preview');

  return (
    <>
      <Segmented value={mode} options={[{ value: 'paper', label: 'Paper (simulated)' }, { value: 'live', label: 'Real (recorded)' }]} onChange={setMode} />
      {mode === 'live' && (
        <Banner tone="warn" title="Real-money records">
          The app cannot see your Robinhood account. Record each real fill here so alerts, risk limits and P&L stay accurate. Real positions are never sold by the app.
        </Banner>
      )}
      {pos.data?.monitor && pos.data.monitor.state !== 'ok' && <Banner tone="warn" title="Positions are not being monitored">{pos.data.monitor.message}</Banner>}

      <Card title={`Open positions (${open.length})`} right={pos.updatedAt && <span className="text-[11px] text-dim">refreshed {timeAgo(pos.updatedAt)}</span>}>
        {open.length === 0 && <p className="text-sm text-dim">No open {mode === 'paper' ? 'paper' : 'real'} positions.</p>}
        <div className="space-y-3">
          {open.map((p: any) => (
            <PositionCard key={p.id} p={p} onChange={pos.reload} />
          ))}
        </div>
      </Card>

      {mode === 'paper' && working.length > 0 && (
        <Card title="Working paper orders">
          {working.map((o: any) => (
            <div key={o.id} className="mb-2 flex items-center justify-between gap-2 text-sm">
              <div>
                <span className="font-semibold">{o.symbol}</span> BUY {shares(o.qty)} {o.orderType === 'limit' ? `limit ${price(o.limitPrice)}` : 'market'} <Badge>{o.status}</Badge>
                <div className="text-[11px] text-dim">expires {clockTime(o.expiresAt)}</div>
              </div>
              <Button onClick={async () => (await api(`/api/orders/${o.id}/cancel`, { body: {} }), orders.reload())}>Cancel</Button>
            </div>
          ))}
        </Card>
      )}

      {mode === 'live' && <LiveForms onChange={pos.reload} nav={nav} />}

      <Card title={`Closed (${closed.length})`}>
        {closed.length === 0 && <p className="text-sm text-dim">Nothing closed yet.</p>}
        {closed.map((p: any) => (
          <div key={p.id} className="flex items-center justify-between border-b border-line/60 py-2 text-sm last:border-0">
            <div>
              <span className="font-semibold">{p.symbol}</span> <span className="text-dim">{p.exit_reason}</span>
              <div className="text-[11px] text-dim">
                {clockTime(p.opened_at)} → {clockTime(p.closed_at)} · entry {price(p.entry_price)}
              </div>
            </div>
            <span className={`num font-semibold ${pnlColor(p.realized_pnl)}`}>{signedUsd(p.realized_pnl)}</span>
          </div>
        ))}
      </Card>
    </>
  );
}

function PositionCard({ p, onChange }: { p: any; onChange: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const stop = p.tp1_done ? Math.max(p.stop, p.entry_price) : p.stop;
  return (
    <div className="rounded-lg border border-line bg-panel2 p-3">
      <div className="flex items-center justify-between">
        <div className="font-semibold">
          {p.symbol} <Badge tone={p.mode === 'paper' ? 'paper' : 'warn'}>{p.mode === 'paper' ? 'paper' : 'real'}</Badge> {p.tp1_done === 1 && <Badge tone="up">TP1 taken</Badge>}
        </div>
        <span className={`num font-semibold ${pnlColor(p.unrealizedPnl)}`}>{signedUsd(p.unrealizedPnl)}</span>
      </div>
      <Row label="Shares">{shares(p.qty_open)} of {shares(p.qty_initial)}</Row>
      <Row label="Entry → last">
        {price(p.entry_price)} → {price(p.last_price)} <span className="text-[11px] text-dim">({p.last_price_at ? timeAgo(p.last_price_at) : 'no update'})</span>
      </Row>
      <Row label="Stop">
        <span className="text-down">{price(stop)}</span> {p.tp1_done === 1 && <span className="text-[11px] text-dim">(breakeven)</span>}
      </Row>
      <Row label="TP1 / TP2">{price(p.tp1)} / {price(p.tp2)}</Row>
      {p.invalidation_price !== null && <Row label="Thesis invalid below">{price(p.invalidation_price)} (close)</Row>}
      <Row label="Planned risk">{usd(p.planned_loss)}</Row>
      <Row label="Realized so far">{signedUsd(p.realized_pnl)}</Row>
      {p.mode === 'paper' && (
        <Button
          className="mt-2 w-full"
          onClick={async () => {
            if (!confirm(`Close the paper ${p.symbol} position at the current price?`)) return;
            try {
              await api(`/api/positions/${p.id}/close`, { body: {} });
              onChange();
            } catch (e) {
              setMsg((e as ApiError).message);
            }
          }}
        >
          Close paper position now
        </Button>
      )}
      {p.mode === 'live' && <LiveExit p={p} onChange={onChange} />}
      {msg && <p className="mt-1 text-xs text-down">{msg}</p>}
    </div>
  );
}

function LiveExit({ p, onChange }: { p: any; onChange: () => void }) {
  const [qty, setQty] = useState(String(p.qty_open));
  const [px, setPx] = useState('');
  const [fees, setFees] = useState('0');
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-sm text-info">Record a real sale…</summary>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Field label="Shares"><input className={inputClass} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        <Field label="Fill price"><input className={inputClass} inputMode="decimal" value={px} onChange={(e) => setPx(e.target.value)} /></Field>
        <Field label="Fees"><input className={inputClass} inputMode="decimal" value={fees} onChange={(e) => setFees(e.target.value)} /></Field>
      </div>
      <Button
        className="mt-2 w-full"
        tone="primary"
        onClick={async () => {
          try {
            await api(`/api/live/positions/${p.id}/exit`, { body: { qty: Number(qty), price: Number(px), fees: Number(fees) } });
            onChange();
          } catch (e) {
            setMsg((e as ApiError).message);
          }
        }}
      >
        Save real sale
      </Button>
      {msg && <p className="mt-1 text-xs text-down">{msg}</p>}
    </details>
  );
}

function LiveForms({ onChange, nav }: { onChange: () => void; nav: Nav }) {
  const [f, setF] = useState({ symbol: '', qty: '', price: '', stop: '', tp1: '', tp2: '', timeframe: '1Day' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Card title="Record a real buy">
      <p className="mb-2 text-xs text-dim">After your order fills in Robinhood, copy the actual fill here. Use the plan's stop and targets.</p>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Ticker"><input className={inputClass} value={f.symbol} onChange={set('symbol')} autoCapitalize="characters" /></Field>
        <Field label="Shares filled"><input className={inputClass} inputMode="decimal" value={f.qty} onChange={set('qty')} /></Field>
        <Field label="Average fill price"><input className={inputClass} inputMode="decimal" value={f.price} onChange={set('price')} /></Field>
        <Field label="Stop-loss"><input className={inputClass} inputMode="decimal" value={f.stop} onChange={set('stop')} /></Field>
        <Field label="Take-profit 1"><input className={inputClass} inputMode="decimal" value={f.tp1} onChange={set('tp1')} /></Field>
        <Field label="Take-profit 2"><input className={inputClass} inputMode="decimal" value={f.tp2} onChange={set('tp2')} /></Field>
      </div>
      <Button
        className="mt-2 w-full"
        tone="primary"
        onClick={async () => {
          try {
            const r = await api('/api/live/positions', { body: { symbol: f.symbol, qty: Number(f.qty), price: Number(f.price), stop: Number(f.stop), tp1: Number(f.tp1), tp2: Number(f.tp2), timeframe: f.timeframe } });
            setMsg({ ok: r.warnings.length === 0, text: r.warnings.length ? `Saved. Warning — your rules said no: ${r.warnings.join(' ')}` : 'Saved. The monitor will alert you at the stop and targets.' });
            onChange();
          } catch (e) {
            setMsg({ ok: false, text: (e as ApiError).message });
          }
        }}
      >
        Save real buy
      </Button>
      {msg && <p className={`mt-2 text-xs ${msg.ok ? 'text-up' : 'text-warn'}`}>{msg.text}</p>}
      <Button tone="ghost" className="mt-1 w-full" onClick={() => nav.go('more', { more: 'risk' })}>
        Set your real starting capital
      </Button>
    </Card>
  );
}
