import type { Nav } from '../App.js';
import { AlertItem } from '../components/AlertItem.js';
import { Badge, Banner, Button, Card, Stat } from '../components/ui.js';
import { clockTime, price, signedUsd, timeAgo, usd, pnlColor } from '../lib/format.js';
import { useApi, type ApiState } from '../lib/useApi.js';

const TREND_TONE: Record<string, 'up' | 'down' | 'dim'> = { uptrend: 'up', downtrend: 'down', sideways: 'dim', unknown: 'dim' };

export function HomePage({ dash, nav }: { dash: ApiState<any>; nav: Nav }) {
  const overview = useApi('/api/market/overview', 60_000);
  const d = dash.data;
  const o = overview.data;

  return (
    <>
      <Card
        title="Market overview"
        right={o?.clock ? <Badge tone={o.clock.isOpen ? 'up' : 'dim'}>{o.clock.isOpen ? 'Market open' : 'Market closed'}</Badge> : <Badge>status unknown</Badge>}
      >
        {overview.error && <p className="text-sm text-down">{overview.error.message}</p>}
        {o?.quoteError && <p className="mb-2 text-sm text-down">{o.quoteError}</p>}
        <div className="grid grid-cols-2 gap-2">
          {(o?.items ?? []).map((i: any) => (
            <button key={i.symbol} onClick={() => nav.go('analyze', { symbol: i.symbol })} className="rounded-lg border border-line bg-panel2 p-2 text-left">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{i.symbol}</span>
                {i.trend && <Badge tone={TREND_TONE[i.trend]}>{i.trend}</Badge>}
              </div>
              <div className="num text-lg font-semibold">{price(i.quote?.price)}</div>
              <div className={`num text-xs ${pnlColor(i.changePct)}`}>{i.changePct === null ? (i.error ? 'data unavailable' : '—') : `${i.changePct > 0 ? '+' : ''}${i.changePct.toFixed(2)}% vs last close`}</div>
              <div className="text-[10px] text-dim">{i.quote ? `trade ${timeAgo(i.quote.time)}` : ''}</div>
            </button>
          ))}
        </div>
        {o?.clock && <p className="mt-2 text-[11px] text-dim">{o.clock.isOpen ? `Closes ${clockTime(o.clock.nextClose)}` : `Opens ${clockTime(o.clock.nextOpen)}`}. Trend = daily chart.</p>}
      </Card>

      {d && (
        <Card title="Account risk (paper)" right={<Badge tone="paper">simulated</Badge>}>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Equity" value={usd(d.paper.equity)} sub={`started ${usd(d.paper.startingCapital, 0)}`} />
            <Stat label="Cash" value={usd(d.paper.cash)} />
            <Stat label="Today" value={signedUsd(d.paper.todayRealizedPnl)} className={pnlColor(d.paper.todayRealizedPnl)} />
            <Stat label="Open risk" value={usd(d.paper.openRiskUsd)} sub="if every stop hits" />
            <Stat label="Risk / trade" value={usd(d.guard.riskBudgetUsd)} />
            <Stat label="Unrealized" value={signedUsd(d.paper.unrealizedPnl)} className={pnlColor(d.paper.unrealizedPnl)} />
          </div>
          <div className="mt-3">
            {d.guard.allowed ? (
              <Banner tone="up" title="New paper trades allowed">No daily limit, cooldown or kill switch is active.</Banner>
            ) : (
              <Banner tone="warn" title="New trades blocked">
                <ul className="list-disc pl-4">
                  {d.guard.blocks.map((b: any) => (
                    <li key={b.code}>{b.message}</li>
                  ))}
                </ul>
              </Banner>
            )}
          </div>
          <div className="mt-3 flex gap-2">
            <Button className="flex-1" onClick={() => nav.go('trades')}>Positions</Button>
            <Button className="flex-1" onClick={() => nav.go('more', { more: 'risk' })}>Risk & kill switch</Button>
          </div>
        </Card>
      )}

      {d && (
        <Card title="Monitoring">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Last successful check" value={d.monitor.lastSuccessAt ? timeAgo(d.monitor.lastSuccessAt) : 'never'} sub={clockTime(d.monitor.lastSuccessAt)} />
            <Stat label="Next check" value={d.monitor.nextRunAt ? clockTime(d.monitor.nextRunAt) : '—'} sub={d.monitor.intervalSec ? `every ${d.monitor.intervalSec}s` : undefined} />
          </div>
          <p className="mt-2 text-xs text-dim">{d.monitor.message} Prices are checked on a schedule — between checks, price can move without the app seeing it.</p>
        </Card>
      )}

      {d && (
        <Card title="Recent alerts" right={<Button tone="ghost" onClick={() => nav.go('alerts')}>All</Button>}>
          {d.alerts.length === 0 ? <p className="text-sm text-dim">No alerts yet.</p> : <div className="space-y-2">{d.alerts.slice(0, 4).map((a: any) => <AlertItem key={a.id} a={a} />)}</div>}
        </Card>
      )}

      <C1Card nav={nav} />

      {d && d.live.capitalKnown && (
        <Card title="Real money (recorded by you)" right={<Badge tone="warn">real</Badge>}>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Equity" value={usd(d.live.equity)} />
            <Stat label="Realized" value={signedUsd(d.live.realizedPnl)} className={pnlColor(d.live.realizedPnl)} />
            <Stat label="Open" value={d.live.openPositions} />
          </div>
          <p className="mt-2 text-[11px] text-dim">Kept separate from paper results. Updated only from the trades you record.</p>
        </Card>
      )}
    </>
  );
}

function C1Card({ nav }: { nav: Nav }) {
  const c1 = useApi('/api/c1', 120_000);
  const d = c1.data;
  if (!d) return null;
  return (
    <Card title="C1 trend following" right={<Badge tone="warn">experimental</Badge>}>
      <p className="mb-2 text-xs font-semibold text-warn">{d.label} · paper only</p>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Pending signals" value={d.signals.pending.length} sub="not trades" />
        <Stat label="Open (simulated)" value={d.open.length} />
        <Stat label="Trades" value={`${d.protocol.closedTrades}/${d.protocol.minTrades}`} />
      </div>
      <p className="mt-2 text-[11px] text-dim">
        Processed through {d.status.lastProcessedDate ?? '—'} · updated {d.status.lastSuccessAt ? timeAgo(d.status.lastSuccessAt) : 'never'}
        {d.status.warnings.length > 0 && <span className="text-warn"> · {d.status.warnings.length} warning(s)</span>}
      </p>
      <Button className="mt-2 w-full" onClick={() => nav.go('more', { more: 'c1' })}>Open C1</Button>
    </Card>
  );
}
