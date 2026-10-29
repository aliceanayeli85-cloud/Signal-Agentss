import type { Nav } from '../App.js';
import { Button, Card } from '../components/ui.js';
import { useApi } from '../lib/useApi.js';
import { BacktestPage } from './Backtest.js';
import { C1Page } from './C1.js';
import { JournalPage } from './Journal.js';
import { RiskPage } from './Risk.js';
import { RobinhoodPage } from './Robinhood.js';

const ITEMS = [
  { id: 'c1', label: 'C1 trend following — EXPERIMENTAL', hint: 'Separate paper-only portfolio. Not proven profitable. Signals, simulated trades, benchmark.' },
  { id: 'journal', label: 'Journal & P&L', hint: 'Write down what happened. Paper and real kept apart.' },
  { id: 'backtest', label: 'Backtest', hint: 'Test the rules on real history, with costs.' },
  { id: 'risk', label: 'Risk, limits & kill switch', hint: 'Your $1-per-trade rules and the emergency stop.' },
  { id: 'robinhood', label: 'Robinhood (real money)', hint: 'What the official integration can do, and order tickets.' },
  { id: 'help', label: 'Help & setup', hint: 'Data connection status and plain-English basics.' },
];

export function MorePage({ nav, onChange }: { nav: Nav; onChange: () => void }) {
  const back = <Button tone="ghost" onClick={() => nav.go('more')}>‹ Back</Button>;
  if (nav.more === 'c1') return <>{back}<C1Page /></>;
  if (nav.more === 'journal') return <>{back}<JournalPage /></>;
  if (nav.more === 'backtest') return <>{back}<BacktestPage symbol={nav.symbol} /></>;
  if (nav.more === 'risk') return <>{back}<RiskPage onChange={onChange} /></>;
  if (nav.more === 'robinhood') return <>{back}<RobinhoodPage symbol={nav.symbol} /></>;
  if (nav.more === 'help') return <>{back}<HelpPage /></>;
  return (
    <div className="space-y-2">
      {ITEMS.map((i) => (
        <button key={i.id} onClick={() => nav.go('more', { more: i.id })} className="block w-full rounded-xl border border-line bg-panel p-3 text-left active:bg-panel2">
          <div className="font-semibold">{i.label}</div>
          <div className="text-xs text-dim">{i.hint}</div>
        </button>
      ))}
    </div>
  );
}

const BASICS: [string, string][] = [
  ['Candlestick', 'One candle shows one period (a day, an hour…): where price opened, the highest and lowest it went, and where it closed. Green = closed higher than it opened.'],
  ['Completed vs forming candle', 'A candle is only final once its period ends. Until then it can still change shape, so the analysis ignores it.'],
  ['Trend', 'The general direction. Here: price relative to the 9 and 20 EMAs, and whether recent highs and lows are rising or falling.'],
  ['Support / resistance', 'Prices where buyers (support) or sellers (resistance) stepped in before. Not walls — they break regularly.'],
  ['Breakout / failed breakout', 'A close above resistance is a breakout. If price then falls back below, it failed — often a warning sign.'],
  ['Risk ("R")', 'The dollars you lose if the stop is hit. With $1 risk, a 2R win is $2.'],
  ['Why $1 per trade?', 'Small losses let you survive many mistakes while you learn. Twenty losses in a row would cost about $20, not your whole account.'],
  ['Paper trading', 'Pretend trades with real prices. It tests your rules and habits without risking money. It does not include real fills, emotions or every cost.'],
  ['Win rate is not everything', 'A strategy can win 40% of trades and still make money if wins are bigger than losses — or win 70% and lose money. Look at profit factor and drawdown too.'],
  ['About the $5,000 goal', 'Nothing here assumes you will reach it, or by when. Grow only by following the rules over many trades; never by raising risk to get there faster.'],
];

function HelpPage() {
  const h = useApi('/api/health');
  const d = h.data;
  return (
    <>
      <Card title="Connection status">
        {h.error && <p className="text-sm text-down">{h.error.message}</p>}
        {d && (
          <ul className="space-y-1 text-sm">
            <li>
              Market data ({d.dataSource.name}): <span className={d.dataSource.configured ? 'text-up' : 'text-warn'}>{d.dataSource.configured ? 'keys configured' : 'NOT connected'}</span>
            </li>
            <li>Order execution: <span className="text-paper">{d.execution}</span></li>
            <li>Monitor: {d.monitor.message}</li>
            {d.dataSource.notes.map((n: string) => (
              <li key={n} className="text-xs text-dim">{n}</li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Connect market data (free)">
        <ol className="list-decimal space-y-1 pl-4 text-sm">
          <li>Create a free account at alpaca.markets (no deposit needed for market data).</li>
          <li>In the Alpaca dashboard, generate API keys (the paper-trading keys work for data).</li>
          <li>Put them on the server as ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY (a .env file, or Replit Secrets), then restart.</li>
        </ol>
        <p className="mt-2 text-[11px] text-dim">This app only reads prices from Alpaca. It never sends orders there.</p>
      </Card>
      <Card title="Plain-English basics">
        <dl className="space-y-2 text-sm">
          {BASICS.map(([t, d]) => (
            <div key={t}>
              <dt className="font-semibold">{t}</dt>
              <dd className="text-ink/80">{d}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </>
  );
}
