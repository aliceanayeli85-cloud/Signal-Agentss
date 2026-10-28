import { useEffect, useState } from 'react';
import { AlertItem } from '../components/AlertItem.js';
import { Badge, Button, Card, Field, inputClass, Segmented } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';
import { clockTime, price } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';

export function AlertsPage({ onChange }: { onChange: () => void }) {
  const events = useApi('/api/alerts/events', 30_000);
  const rules = useApi('/api/alerts/rules');
  const [form, setForm] = useState({ symbol: '', kind: 'price_above' as 'price_above' | 'price_below', price: '', note: '' });
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    // Opening this page marks alerts as read.
    api('/api/alerts/events/read', { body: {} }).then(onChange, () => null);
  }, [onChange]);

  const save = async () => {
    try {
      const r = await api('/api/alerts/rules', { body: { symbol: form.symbol, kind: form.kind, price: Number(form.price), note: form.note || undefined } });
      setMsg(r.duplicate ? 'That alert already exists.' : 'Alert saved. It fires once, the first time the monitor sees the price.');
      setForm({ ...form, price: '', note: '' });
      rules.reload();
    } catch (e) {
      setMsg((e as ApiError).message);
    }
  };

  return (
    <>
      <Card title="New price alert">
        <p className="mb-2 text-xs text-dim">A price alert only notifies you. It never buys or sells anything.</p>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Ticker"><input className={inputClass} value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} autoCapitalize="characters" /></Field>
          <Field label="Price"><input className={inputClass} inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></Field>
        </div>
        <div className="mt-2">
          <Segmented value={form.kind} options={[{ value: 'price_above', label: 'At or above' }, { value: 'price_below', label: 'At or below' }]} onChange={(kind) => setForm({ ...form, kind })} />
        </div>
        <div className="mt-2">
          <Field label="Note (optional)"><input className={inputClass} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
        </div>
        <Button className="mt-2 w-full" tone="primary" onClick={save}>Save alert</Button>
        {msg && <p className="mt-2 text-xs text-info">{msg}</p>}
      </Card>

      <Card title="Alert rules">
        {(rules.data?.rules ?? []).length === 0 && <p className="text-sm text-dim">No alert rules.</p>}
        {(rules.data?.rules ?? []).map((r: any) => (
          <div key={r.id} className="flex items-center justify-between border-b border-line/60 py-2 text-sm last:border-0">
            <div>
              <span className="font-semibold">{r.symbol}</span> {r.kind === 'price_above' ? '≥' : '≤'} {price(r.price)} <Badge tone={r.status === 'armed' ? 'info' : 'dim'}>{r.status}</Badge>
              <div className="text-[11px] text-dim">{r.note ?? ''} {r.triggered_at ? `· fired ${clockTime(r.triggered_at)}` : ''}</div>
            </div>
            {r.status === 'armed' && <Button onClick={async () => (await api(`/api/alerts/rules/${r.id}`, { method: 'DELETE' }), rules.reload())}>Remove</Button>}
          </div>
        ))}
      </Card>

      <Card title="Alert history">
        <p className="mb-2 text-[11px] text-dim">Every alert shows when it was recorded and the price and time that caused it.</p>
        {(events.data?.events ?? []).length === 0 && <p className="text-sm text-dim">No alerts yet.</p>}
        <div className="space-y-2">
          {(events.data?.events ?? []).map((a: any) => (
            <AlertItem key={a.id} a={a} />
          ))}
        </div>
      </Card>
    </>
  );
}
