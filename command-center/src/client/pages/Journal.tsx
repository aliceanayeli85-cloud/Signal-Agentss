import { useState } from 'react';
import { Badge, Banner, Button, Card, Field, inputClass, Segmented, Stat } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';
import { clockTime, pct, pnlColor, signedUsd, usd } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';

export function JournalPage() {
  const [mode, setMode] = useState<'paper' | 'live'>('paper');
  const pnl = useApi(`/api/pnl?mode=${mode}`);
  const journal = useApi(`/api/journal?mode=${mode}`);
  const p = pnl.data;
  return (
    <>
      <Segmented value={mode} options={[{ value: 'paper', label: 'Paper results' }, { value: 'live', label: 'Real results' }]} onChange={setMode} />
      {p && (
        <Card title={`Profit & loss · ${mode === 'paper' ? 'simulated' : 'real'}`}>
          {p.sampleWarning && <Banner tone="warn" title="Small sample">{p.sampleWarning}</Banner>}
          <div className="mt-2 grid grid-cols-3 gap-3">
            <Stat label="Equity" value={usd(p.summary.equity)} />
            <Stat label="Realized" value={signedUsd(p.summary.realizedPnl)} className={pnlColor(p.summary.realizedPnl)} />
            <Stat label="Unrealized" value={signedUsd(p.summary.unrealizedPnl)} className={pnlColor(p.summary.unrealizedPnl)} />
            <Stat label="Trades" value={p.metrics.trades} />
            <Stat label="Win rate" value={pct(p.metrics.winRate, 0)} />
            <Stat label="Profit factor" value={p.metrics.profitFactor?.toFixed(2) ?? '—'} />
            <Stat label="Avg gain" value={usd(p.metrics.avgGain)} />
            <Stat label="Avg loss" value={usd(p.metrics.avgLoss)} />
            <Stat label="Max drawdown" value={usd(p.metrics.maxDrawdownUsd)} sub={pct(p.metrics.maxDrawdownPct)} />
          </div>
        </Card>
      )}
      <Card title="Journal">
        {(journal.data?.entries ?? []).length === 0 && <p className="text-sm text-dim">An entry is created automatically for every trade.</p>}
        <div className="space-y-3">
          {(journal.data?.entries ?? []).map((e: any) => (
            <Entry key={e.id} e={e} onSaved={journal.reload} />
          ))}
        </div>
      </Card>
    </>
  );
}

function Entry({ e, onSaved }: { e: any; onSaved: () => void }) {
  const [f, setF] = useState({ why_entered: e.why_entered ?? '', followed_plan: e.followed_plan ?? '', what_happened: e.what_happened ?? '', lesson: e.lesson ?? '', emotion: e.emotion ?? '', grade: e.grade ?? '' });
  const [msg, setMsg] = useState<string | null>(null);
  const area = (k: keyof typeof f, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <textarea className={inputClass} rows={2} value={f[k]} onChange={(ev) => setF({ ...f, [k]: ev.target.value })} />
    </Field>
  );
  return (
    <details className="rounded-lg border border-line bg-panel2 p-3">
      <summary className="cursor-pointer">
        <span className="font-semibold">{e.symbol}</span> <span className="text-[11px] text-dim">{clockTime(e.created_at)}</span>{' '}
        {e.position_status === 'closed' ? <span className={`num text-sm ${pnlColor(e.realized_pnl)}`}>{signedUsd(e.realized_pnl)}</span> : <Badge tone="info">open</Badge>} {e.grade && <Badge>{e.grade}</Badge>}
      </summary>
      <p className="mt-2 text-xs text-dim">{e.plan_summary}</p>
      <div className="mt-2 space-y-2">
        {area('why_entered', 'Why did I take this trade?')}
        <Field label="Did I follow the plan?">
          <select className={inputClass} value={f.followed_plan} onChange={(ev) => setF({ ...f, followed_plan: ev.target.value })}>
            <option value="">—</option>
            <option value="yes">Yes, exactly</option>
            <option value="partly">Partly</option>
            <option value="no">No</option>
          </select>
        </Field>
        {area('what_happened', 'What happened?')}
        {area('emotion', 'How did I feel?', 'Fear, greed, boredom, revenge? Naming it helps you notice it next time.')}
        {area('lesson', 'One lesson')}
        <Field label="Grade the PROCESS, not the result" hint="A losing trade that followed the plan can be an A. A lucky win that broke the rules is an F.">
          <select className={inputClass} value={f.grade} onChange={(ev) => setF({ ...f, grade: ev.target.value })}>
            <option value="">—</option>
            {['A', 'B', 'C', 'D', 'F'].map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </Field>
        <Button
          tone="primary"
          className="w-full"
          onClick={async () => {
            try {
              const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
              await api(`/api/journal/${e.id}`, { method: 'PUT', body });
              setMsg('Saved.');
              onSaved();
            } catch (err) {
              setMsg((err as ApiError).message);
            }
          }}
        >
          Save entry
        </Button>
        {msg && <p className="text-xs text-info">{msg}</p>}
      </div>
    </details>
  );
}
