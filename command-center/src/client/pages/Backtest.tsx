import { useState } from 'react';
import { Banner, Button, Card, Field, inputClass, Row, Segmented, Stat } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';
import { clockTime, pct, pnlColor, signedUsd, usd } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';

export function BacktestPage({ symbol: initial }: { symbol: string }) {
  const [symbol, setSymbol] = useState(initial);
  const [tf, setTf] = useState<'1Day' | '1Hour'>('1Day');
  const [hold, setHold] = useState('20');
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const history = useApi('/api/backtest');

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setRes(await api('/api/backtest', { body: { symbol, timeframe: tf, maxHoldBars: Number(hold) } }));
      history.reload();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title="Backtest the rules">
        <p className="mb-2 text-xs text-dim">Replays real price history candle by candle with the same rules, costs and limits as the live plan. It cannot see the future.</p>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Ticker"><input className={inputClass} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} /></Field>
          <Field label="Max candles held"><input className={inputClass} inputMode="numeric" value={hold} onChange={(e) => setHold(e.target.value)} /></Field>
        </div>
        <div className="mt-2">
          <Segmented value={tf} options={[{ value: '1Day', label: 'Daily candles' }, { value: '1Hour', label: 'Hourly candles' }]} onChange={setTf} />
        </div>
        <Button className="mt-2 w-full" tone="primary" disabled={busy} onClick={run}>{busy ? 'Running…' : 'Run backtest'}</Button>
        {err && <p className="mt-2 text-sm text-down">{err}</p>}
      </Card>

      {res && (
        <>
          <Card title={`${res.symbol} · ${res.timeframe} · ${res.bars} candles`} right={<span className="text-[11px] text-dim">{res.source}</span>}>
            {res.warnings.map((w: string) => (
              <Banner key={w} tone="warn" title={w} />
            ))}
            <p className="mt-2 text-[11px] text-dim">{clockTime(res.firstBar)} → {clockTime(res.lastBar)}</p>
            <MetricsGrid m={res.all} />
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs font-semibold text-dim uppercase">First 70% (in-sample)</div>
                <Row label="Trades">{res.inSample.trades}</Row>
                <Row label="Win rate">{pct(res.inSample.winRate, 0)}</Row>
                <Row label="P&L">{signedUsd(res.inSample.totalPnl)}</Row>
              </div>
              <div>
                <div className="text-xs font-semibold text-dim uppercase">Last 30% (out-of-sample)</div>
                <Row label="Trades">{res.outOfSample.trades}</Row>
                <Row label="Win rate">{pct(res.outOfSample.winRate, 0)}</Row>
                <Row label="P&L">{signedUsd(res.outOfSample.totalPnl)}</Row>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-dim">If the later period looks much worse than the earlier one, the rules may only fit the past.</p>
          </Card>
          <Card title="Assumptions">
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-dim">
              {res.assumptions.map((a: string) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </Card>
          <Card title={`Trades (${res.trades.length})`}>
            {res.trades.slice(-40).reverse().map((t: any) => (
              <div key={t.signalTime} className="flex justify-between border-b border-line/60 py-1 text-xs last:border-0">
                <span>{clockTime(t.entryTime)} · {t.setupType} · {t.exitReason}</span>
                <span className={`num ${pnlColor(t.pnl)}`}>{signedUsd(t.pnl)} ({t.rMultiple.toFixed(2)}R)</span>
              </div>
            ))}
          </Card>
        </>
      )}

      {(history.data?.runs ?? []).length > 0 && (
        <Card title="Previous runs">
          {history.data.runs.map((r: any) => (
            <Row key={r.id} label={`${r.symbol} ${r.timeframe} · ${clockTime(r.createdAt)}`}>
              {r.trades} trades · {pct(r.winRate, 0)} · {signedUsd(r.totalPnl)}
            </Row>
          ))}
        </Card>
      )}
    </>
  );
}

function MetricsGrid({ m }: { m: any }) {
  return (
    <div className="mt-2 grid grid-cols-3 gap-3">
      <Stat label="Trades" value={m.trades} />
      <Stat label="Win rate" value={pct(m.winRate, 0)} />
      <Stat label="Profit factor" value={m.profitFactor?.toFixed(2) ?? '—'} sub="wins ÷ losses" />
      <Stat label="Avg gain" value={usd(m.avgGain)} />
      <Stat label="Avg loss" value={usd(m.avgLoss)} />
      <Stat label="Avg R" value={m.avgR?.toFixed(2) ?? '—'} />
      <Stat label="Total P&L" value={signedUsd(m.totalPnl)} className={pnlColor(m.totalPnl)} />
      <Stat label="Max drawdown" value={usd(m.maxDrawdownUsd)} sub={pct(m.maxDrawdownPct)} />
      <Stat label="Expectancy" value={usd(m.expectancy)} sub="avg per trade" />
    </div>
  );
}
