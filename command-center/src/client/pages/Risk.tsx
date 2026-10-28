import { useEffect, useState } from 'react';
import { Badge, Banner, Button, Card, Field, inputClass, Row } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';
import { clockTime, signedUsd, usd } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';

const FIELDS: { key: string; label: string; hint: string; money?: boolean }[] = [
  { key: 'riskPerTradeUsd', label: 'Risk per trade ($)', hint: 'Most you plan to lose on one trade. Capped at 2% of equity.', money: true },
  { key: 'maxDailyLossUsd', label: 'Max daily loss ($)', hint: 'Hit this and trading stops until the next day. Capped at 5% of equity.', money: true },
  { key: 'maxOpenRiskUsd', label: 'Max open risk ($)', hint: 'Total at stake across all open positions.', money: true },
  { key: 'maxPositionUsd', label: 'Max position size ($)', hint: 'Largest single position. Never more than equity (no borrowing).', money: true },
  { key: 'maxTradesPerDay', label: 'Max trades per day', hint: 'Fewer, better trades.' },
  { key: 'maxConsecutiveLosses', label: 'Stop after N losses in a row', hint: 'Shuts down for the day.' },
  { key: 'lossCooldownMinutes', label: 'Cooldown after a loss (min)', hint: 'Time to reset before the next trade.' },
  { key: 'minRewardRisk', label: 'Minimum reward-to-risk', hint: 'Target must be at least this many times the risk.' },
  { key: 'slippageBps', label: 'Slippage estimate (bps)', hint: '5 bps = 0.05% worse than the quote on every fill.' },
  { key: 'maxQuoteAgeSeconds', label: 'Max price age (s)', hint: 'Older prices are treated as stale.' },
];

export function RiskPage({ onChange }: { onChange: () => void }) {
  const risk = useApi('/api/risk', 30_000);
  const r = risk.data;
  const [form, setForm] = useState<Record<string, string>>({});
  const [fractional, setFractional] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [resume, setResume] = useState('');
  const [capital, setCapital] = useState('');

  useEffect(() => {
    if (!r) return;
    setForm(Object.fromEntries(FIELDS.map((f) => [f.key, String(r.settings[f.key])])));
    setFractional(r.settings.allowFractional);
  }, [r?.settings]);

  if (!r) return risk.error ? <Banner tone="down" title="Problem">{risk.error.message}</Banner> : <p className="text-sm text-dim">Loading…</p>;

  const save = async () => {
    try {
      const body: Record<string, unknown> = Object.fromEntries(FIELDS.map((f) => [f.key, Number(form[f.key])]));
      body.allowFractional = fractional;
      await api('/api/settings', { method: 'PUT', body });
      setMsg({ ok: true, text: 'Saved.' });
      risk.reload();
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: (e as ApiError).message });
    }
  };
  const kill = async (on: boolean) => {
    try {
      await api('/api/kill-switch', { body: on ? { on: true, reason: 'Turned on from the Risk page.' } : { on: false, confirm: resume } });
      setResume('');
      risk.reload();
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: (e as ApiError).message });
    }
  };

  return (
    <>
      <Card title="Kill switch">
        {r.killSwitch.on ? (
          <>
            <Banner tone="down" title="ON — all new orders blocked">Since {clockTime(r.killSwitch.at)}. {r.killSwitch.reason}</Banner>
            <Field label="Type RESUME to turn it off"><input className={inputClass} value={resume} onChange={(e) => setResume(e.target.value)} autoCapitalize="characters" /></Field>
            <Button className="mt-2 w-full" disabled={resume !== 'RESUME'} onClick={() => kill(false)}>Turn kill switch off</Button>
          </>
        ) : (
          <>
            <p className="mb-2 text-sm text-dim">Press if you feel the urge to chase, or anything seems wrong. It blocks new orders and cancels waiting paper orders. Open positions and alerts keep being monitored.</p>
            <Button tone="danger" className="w-full" onClick={() => kill(true)}>STOP ALL NEW TRADING</Button>
          </>
        )}
      </Card>

      {(['paper', 'live'] as const).map((m) => (
        <Card key={m} title={m === 'paper' ? 'Today · paper' : 'Today · real money'} right={<Badge tone={r[m].guard.allowed ? 'up' : 'warn'}>{r[m].guard.allowed ? 'trading allowed' : 'blocked'}</Badge>}>
          <Row label="Realized today">{signedUsd(r[m].state.todayRealizedPnl)} of −{usd(Math.min(r.settings.maxDailyLossUsd, r[m].state.equity * r.hardCaps.dailyLossPct))} limit</Row>
          <Row label="Trades today">{r[m].state.tradesToday} of {r.settings.maxTradesPerDay}</Row>
          <Row label="Losses in a row today">{r[m].state.consecutiveLossesToday} of {r.settings.maxConsecutiveLosses}</Row>
          <Row label="Open risk">{usd(r[m].state.openRiskUsd)} of {usd(r.settings.maxOpenRiskUsd)}</Row>
          <Row label="Risk budget per trade">{usd(r[m].guard.riskBudgetUsd)}</Row>
          {r[m].guard.blocks.map((b: any) => (
            <p key={b.code} className="mt-1 text-xs text-warn">{b.message}</p>
          ))}
          {m === 'live' && !r.live.summary.capitalKnown && (
            <div className="mt-2">
              <Field label="Real cash set aside for trading ($)" hint="Needed before the app can size real-money tickets. Use only money you can afford to lose.">
                <input className={inputClass} inputMode="decimal" value={capital} onChange={(e) => setCapital(e.target.value)} />
              </Field>
              <Button className="mt-2 w-full" onClick={async () => {
                try {
                  await api('/api/live/capital', { body: { amount: Number(capital) } });
                  risk.reload();
                } catch (e) {
                  setMsg({ ok: false, text: (e as ApiError).message });
                }
              }}>Save real capital</Button>
            </div>
          )}
        </Card>
      ))}

      <Card title="Risk rules">
        <p className="mb-2 text-xs text-dim">You can always LOWER risk. Raising it is refused after a loss, and hard caps apply no matter what.</p>
        <div className="grid grid-cols-2 gap-2">
          {FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <input className={inputClass} inputMode="decimal" value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
            </Field>
          ))}
        </div>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={fractional} onChange={(e) => setFractional(e.target.checked)} /> Allow fractional shares (Robinhood supports them for many stocks/ETFs; minimum ${r.settings.minOrderUsd})
        </label>
        <Button tone="primary" className="mt-2 w-full" onClick={save}>Save rules</Button>
        {msg && <p className={`mt-2 text-sm ${msg.ok ? 'text-up' : 'text-down'}`}>{msg.text}</p>}
        <p className="mt-2 text-[11px] text-dim">No leverage, margin, options or short selling exist in this app. Paper starting capital: {usd(r.settings.startingCapitalUsd, 0)}.</p>
      </Card>

      <Card title="Risk log">
        {r.events.length === 0 && <p className="text-sm text-dim">No risk events yet.</p>}
        {r.events.map((e: any) => (
          <div key={e.id} className="border-b border-line/60 py-1 text-xs last:border-0">
            <span className="text-dim">{clockTime(e.at)}</span> <Badge>{e.code}</Badge> {e.message}
          </div>
        ))}
      </Card>
    </>
  );
}
