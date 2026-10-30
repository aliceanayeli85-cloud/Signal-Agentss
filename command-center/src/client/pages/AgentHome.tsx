import { useState } from 'react';
import type { Nav } from '../App.js';
import { AlertItem } from '../components/AlertItem.js';
import { OpportunityCard } from '../components/agent.js';
import { Badge, Banner, Button, Card, Stat } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';
import { clockTime, pct, pnlColor, price, signedUsd, timeAgo, usd } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';

export function AgentHome({ nav }: { nav: Nav }) {
  const a = useApi('/api/agent', 60_000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const d = a.data;
  const L = d?.latest;

  const scan = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api('/api/agent/run', { body: {} });
      setMsg(r.status === 'ok' ? `Scan finished: ${r.scanned} symbols analysed.` : r.error);
      a.reload();
    } catch (e) {
      setMsg((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const running = d && d.status.config.enabled && d.monitor.state === 'ok';
  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Trading Intelligence</h1>
          <p className="text-[11px] text-dim">Researches, ranks and explains. Never places orders.</p>
        </div>
        <Button tone="primary" onClick={scan} disabled={busy}>{busy ? 'Scanning…' : 'Scan now'}</Button>
      </div>
      {msg && <p className="text-xs text-info">{msg}</p>}
      {a.error && <Banner tone="down" title="Problem">{a.error.message}</Banner>}

      {d && (
        <Card title="Agent status" right={<Badge tone={running ? 'up' : 'warn'}>{running ? 'running on schedule' : 'not running automatically'}</Badge>}>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Last scan" value={d.status.lastSuccessfulRun ? timeAgo(d.status.lastSuccessfulRun.finished_at) : 'never'} sub={d.status.lastSuccessfulRun ? `data through ${d.status.lastSuccessfulRun.data_through}` : undefined} />
            <Stat label="Next scheduled scan" value={d.status.nextScheduledAt ? clockTime(d.status.nextScheduledAt) : 'off'} sub={`weekdays ${d.status.config.scheduleET.join(' & ')} New York`} />
          </div>
          {d.status.lastRun?.status === 'error' && <p className="mt-2 text-xs text-down">Last scan failed: {d.status.lastRun.error}</p>}
          <p className="mt-2 text-[11px] text-dim">
            {running
              ? 'Scheduled scans and holding checks happen while the server and its monitor are running. Checks are periodic, not continuous.'
              : `The monitor is ${d.monitor.state.replace('_', ' ')}: ${d.monitor.message} Scans only run when you press "Scan now".`}
          </p>
        </Card>
      )}

      {d && !L && <Banner tone="info" title="No scan yet">Press "Scan now" to research the market.</Banner>}

      {L && (
        <Card title={`Daily briefing · ${L.briefing.date}`}>
          <p className="text-sm font-semibold">{L.briefing.headline}</p>
          {L.briefing.sections.map((s: any) => (
            <details key={s.title} className="mt-2" open={s.title.startsWith('Best') || s.title.startsWith('Your')}>
              <summary className="cursor-pointer text-xs font-semibold text-dim uppercase">{s.title}</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-ink/85">
                {s.lines.map((l: string) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </details>
          ))}
        </Card>
      )}

      {L && (
        <Card title="Market conditions" right={<span className="text-[11px] text-dim">as of {L.market.asOf}</span>}>
          <p className="mb-2 text-sm font-semibold">{L.market.regime}</p>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="SPY" value={price(L.market.spy.close)} sub={`${L.market.spy.trend} · ${pct(L.market.spy.ret20)} 20d`} />
            <Stat label="Above 50-day" value={pct(L.market.breadth.above50, 0)} sub={`of ${L.market.breadth.scanned} scanned`} />
            <Stat label="SPY volatility" value={pct(L.market.spy.realizedVol20, 0)} sub="20d, annualised" />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            {Object.entries(L.counts).map(([k, v]) => (
              <span key={k} className="rounded-md border border-line px-1.5 py-0.5 text-dim">{k}: {String(v)}</span>
            ))}
          </div>
        </Card>
      )}

      {L && (
        <Card title="Best opportunities" right={<Button tone="ghost" onClick={() => nav.go('ideas')}>All ideas</Button>}>
          <div className="space-y-2">
            {L.top.filter((o: any) => o.classification === 'BUY WATCHLIST' || o.classification === 'STRONG BUY SETUP').slice(0, 3).map((o: any) => (
              <OpportunityCard key={o.symbol} o={o} onOpen={() => nav.go('more', { more: 'stock', symbol: o.symbol })} />
            ))}
            {L.top.filter((o: any) => o.classification === 'BUY WATCHLIST' || o.classification === 'STRONG BUY SETUP').length === 0 && <p className="text-sm text-dim">Nothing meets the rules. Keeping your money is the recommendation.</p>}
          </div>
        </Card>
      )}

      {d && (
        <Card title="My Robinhood" right={<Button tone="ghost" onClick={() => nav.go('robinhood')}>Open</Button>}>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Value" value={usd(d.portfolio.totalValue)} sub="holdings + cash" />
            <Stat label="P&L" value={signedUsd(d.portfolio.pnl)} className={pnlColor(d.portfolio.pnl)} sub={pct(d.portfolio.pnlPct)} />
            <Stat label="Cash" value={d.portfolio.cash === null ? 'not entered' : usd(d.portfolio.cash)} />
          </div>
          {d.portfolio.holdings.map((h: any) => (
            <div key={h.symbol} className="mt-2 flex items-center justify-between text-sm">
              <span className="font-semibold">{h.symbol} <span className="text-[11px] text-dim">{h.shares} sh</span></span>
              <span className="flex items-center gap-2">{h.classification && <span className="text-[11px] text-dim">{h.classification}</span>}<span className={`num ${pnlColor(h.pnl)}`}>{signedUsd(h.pnl)}</span></span>
            </div>
          ))}
        </Card>
      )}

      {d && (
        <Card title="Important alerts" right={<Button tone="ghost" onClick={() => nav.go('more', { more: 'alerts' })}>All</Button>}>
          {d.alerts.length === 0 ? <p className="text-sm text-dim">No alerts.</p> : <div className="space-y-2">{d.alerts.slice(0, 4).map((x: any) => <AlertItem key={x.id} a={x} />)}</div>}
        </Card>
      )}
    </>
  );
}
