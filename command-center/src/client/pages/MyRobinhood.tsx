import { useState } from 'react';
import type { Nav } from '../App.js';
import { ClassBadge } from '../components/agent.js';
import { Banner, Button, Card, Field, inputClass, Row, Stat } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';
import { pct, pnlColor, price, signedUsd, timeAgo, usd } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';

export function MyRobinhood({ nav }: { nav: Nav }) {
  const p = useApi('/api/robinhood/portfolio', 60_000);
  const [form, setForm] = useState({ symbol: '', shares: '', cost: '' });
  const [cash, setCash] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const d = p.data;

  const save = async () => {
    try {
      await api('/api/robinhood/holdings', { method: 'PUT', body: { symbol: form.symbol, shares: Number(form.shares), costBasis: Number(form.cost) } });
      setForm({ symbol: '', shares: '', cost: '' });
      setMsg('Saved. Run a scan to get a recommendation for it.');
      p.reload();
    } catch (e) {
      setMsg((e as ApiError).message);
    }
  };
  const saveCash = async () => {
    try {
      await api('/api/robinhood/cash', { method: 'PUT', body: { amount: cash === '' ? null : Number(cash) } });
      setCash('');
      p.reload();
    } catch (e) {
      setMsg((e as ApiError).message);
    }
  };

  return (
    <>
      <h1 className="text-xl font-bold">My Robinhood</h1>
      <Banner tone="info" title="Real account — entered by you">The app cannot read your Robinhood account or place orders in it. Enter what you own; update it after each trade.</Banner>
      {p.error && <Banner tone="down" title="Problem">{p.error.message}</Banner>}
      {d && (
        <Card title="Portfolio">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Total value" value={usd(d.totalValue)} />
            <Stat label="Invested at" value={usd(d.costBasis)} />
            <Stat label="Profit / loss" value={signedUsd(d.pnl)} sub={pct(d.pnlPct)} className={pnlColor(d.pnl)} />
          </div>
          {d.quoteError && <p className="mt-2 text-xs text-warn">Live prices unavailable: {d.quoteError}</p>}
        </Card>
      )}
      {d?.holdings.map((h: any) => (
        <Card key={h.symbol} title={h.symbol} right={h.classification ? <ClassBadge c={h.classification} /> : <span className="text-[11px] text-dim">not scanned yet</span>}>
          <Row label="Shares (fractional)">{h.shares}</Row>
          <Row label="Price">{`${price(h.price)}${h.priceTime ? ` (${timeAgo(h.priceTime)})` : ''}`}</Row>
          <Row label="Market value">{usd(h.value)}</Row>
          <Row label="Cost basis">{usd(h.cost_basis)}</Row>
          <Row label="Profit / loss">
            <span className={pnlColor(h.pnl)}>{`${signedUsd(h.pnl)} (${pct(h.pnlPct)})`}</span>
          </Row>
          {h.exitLevel !== null && <Row label="Exit watch level (20-day low)">{price(h.exitLevel)}</Row>}
          {h.reasons.length > 0 && <p className="mt-2 text-xs text-ink/85">{h.reasons.join(' ')}</p>}
          <div className="mt-2 flex gap-2">
            <Button className="flex-1" onClick={() => nav.go('more', { more: 'stock', symbol: h.symbol })}>Analysis</Button>
            <Button className="flex-1" onClick={async () => {
              if (!confirm(`Remove ${h.symbol} from your recorded holdings? (This does not sell anything.)`)) return;
              await api(`/api/robinhood/holdings/${h.symbol}`, { method: 'DELETE' });
              p.reload();
            }}>Remove record</Button>
          </div>
        </Card>
      ))}
      <Card title="Cash available to trade">
        <p className="mb-2 text-xs text-dim">Currently: {d?.cash === null || d?.cash === undefined ? 'not entered (treated as $0)' : usd(d.cash)}. The agent never assumes you have more money than this.</p>
        <div className="flex gap-2">
          <input className={inputClass} inputMode="decimal" placeholder="e.g. 0.00" value={cash} onChange={(e) => setCash(e.target.value)} />
          <Button onClick={saveCash}>Save</Button>
        </div>
      </Card>
      <Card title="Add or update a holding">
        <div className="grid grid-cols-3 gap-2">
          <Field label="Ticker"><input className={inputClass} value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} autoCapitalize="characters" /></Field>
          <Field label="Shares"><input className={inputClass} inputMode="decimal" placeholder="0.013363" value={form.shares} onChange={(e) => setForm({ ...form, shares: e.target.value })} /></Field>
          <Field label="Total paid $"><input className={inputClass} inputMode="decimal" placeholder="5.00" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></Field>
        </div>
        <Button className="mt-2 w-full" tone="primary" onClick={save}>Save holding</Button>
        {msg && <p className="mt-2 text-xs text-info">{msg}</p>}
      </Card>
      <Card title="Connecting Robinhood">
        <p className="text-xs text-ink/85">Robinhood's official route for AI tools is its Trading MCP connector, signed in through Robinhood's own screen inside an AI app. This app is not connected to it and never asks for your password, codes or cookies.</p>
        <Button className="mt-2 w-full" onClick={() => nav.go('more', { more: 'robinhood' })}>What's verified & setup steps</Button>
      </Card>
    </>
  );
}
