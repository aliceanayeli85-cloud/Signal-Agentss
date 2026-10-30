import { useState } from 'react';
import { Banner, Button, inputClass } from './components/ui.js';
import { setToken } from './lib/api.js';
import { timeAgo } from './lib/format.js';
import { useApi } from './lib/useApi.js';
import { AgentHome } from './pages/AgentHome.js';
import { IdeasPage } from './pages/Ideas.js';
import { MorePage } from './pages/More.js';
import { MyRobinhood } from './pages/MyRobinhood.js';
import { TradeCenter } from './pages/TradeCenter.js';

export type Tab = 'agent' | 'ideas' | 'robinhood' | 'trade' | 'more';

export interface Nav {
  go: (tab: Tab, opts?: { symbol?: string; more?: string }) => void;
  symbol: string;
  more: string;
}

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'agent', label: 'Agent', icon: '✦' },
  { id: 'ideas', label: 'Ideas', icon: '📈' },
  { id: 'robinhood', label: 'Robinhood', icon: '◉' },
  { id: 'trade', label: 'Trade', icon: '⇄' },
  { id: 'more', label: 'More', icon: '☰' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('agent');
  const [symbol, setSymbol] = useState('SPY');
  const [more, setMore] = useState('menu');
  const dash = useApi('/api/dashboard', 30_000);
  const nav: Nav = {
    go: (t, o) => {
      if (o?.symbol) setSymbol(o.symbol);
      if (o?.more) setMore(o.more);
      else if (t === 'more') setMore('menu');
      setTab(t);
      window.scrollTo(0, 0);
    },
    symbol,
    more,
  };

  if (dash.error?.status === 401) return <TokenGate onSaved={dash.reload} />;
  const d = dash.data;

  return (
    <div className="mx-auto min-h-dvh max-w-3xl pb-24">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/95 px-4 pt-[max(env(safe-area-inset-top),0.5rem)] pb-2 backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-bold">Trading Intelligence</div>
          <span className="rounded-md border border-paper/40 bg-paper/15 px-1.5 py-0.5 text-[11px] font-bold text-paper">NO AUTO-ORDERS</span>
        </div>
        {d && (
          <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-dim">
            <span>
              Monitor: <span className={d.monitor.state === 'ok' ? 'text-up' : 'text-warn'}>{d.monitor.state === 'ok' ? 'running' : d.monitor.state.replace('_', ' ')}</span>
              {d.monitor.lastSuccessAt && ` · last check ${timeAgo(d.monitor.lastSuccessAt)}`}
            </span>
            <span>Prices: {d.lastPriceUpdateAt ? `updated ${timeAgo(d.lastPriceUpdateAt)}` : 'none yet'}</span>
          </div>
        )}
      </header>

      <main className="space-y-3 px-4 pt-3">
        {dash.error && dash.error.status !== 401 && <Banner tone="down" title="Server unreachable">{dash.error.message}</Banner>}
        {d && !d.dataConfigured && (
          <Banner tone="warn" title="Market data is not connected">
            No prices can be shown until you add free Alpaca API keys. Nothing on this dashboard is made up. See More → Help & setup.
          </Banner>
        )}
        {d?.killSwitch.on && <Banner tone="down" title="KILL SWITCH ON">No new orders can be created. {d.killSwitch.reason}</Banner>}
        {d && d.monitor.state !== 'ok' && <Banner tone="warn" title="Monitoring warning">{d.monitor.message}</Banner>}
        {d?.guard.dailyShutdown && !d.killSwitch.on && <Banner tone="warn" title="Trading shut down for today">{d.guard.blocks.map((b: any) => b.message).join(' ')}</Banner>}

        {tab === 'agent' && <AgentHome nav={nav} />}
        {tab === 'ideas' && <IdeasPage nav={nav} />}
        {tab === 'robinhood' && <MyRobinhood nav={nav} />}
        {tab === 'trade' && <TradeCenter nav={nav} />}
        {tab === 'more' && <MorePage nav={nav} onChange={dash.reload} dash={dash} />}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <div className="mx-auto flex max-w-3xl">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => nav.go(t.id)} className={`relative flex min-h-14 flex-1 flex-col items-center justify-center text-[11px] ${tab === t.id ? 'text-info' : 'text-dim'}`}>
              <span className="text-lg leading-none">{t.icon}</span>
              {t.label}
              {t.id === 'more' && d?.unreadAlerts > 0 && <span className="absolute top-1.5 right-[28%] rounded-full bg-down px-1 text-[10px] font-bold text-bg">{d.unreadAlerts}</span>}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

function TokenGate({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="mx-auto max-w-sm space-y-3 p-6">
      <h1 className="text-lg font-bold">Access token required</h1>
      <p className="text-sm text-dim">This dashboard is protected. Enter the ACCESS_TOKEN you configured on the server.</p>
      <input className={inputClass} type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="current-password" />
      <Button tone="primary" className="w-full" onClick={() => (setToken(value), onSaved())}>
        Unlock
      </Button>
    </div>
  );
}
